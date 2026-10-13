// How the main agent hands work inside web pages to a web task, and steers or
// stops it. Starting and waiting are separate calls so that waiting is a step
// a user's steer can interrupt: the main agent then decides where it goes.
import { z } from 'zod';
import type { ChildRuns } from '@/ai/runtime/context';
import { defineTool, type ToolRunContext } from '@/ai/runtime/tools';
import { WebTaskBrief } from '@/ai/agents/delegated/web_task/agent';

// A web task can run for 20 minutes; waiting on it must not time out first.
const WAIT_TIMEOUT_MS = 21 * 60_000;

const taskId = z.string().min(1).describe('The web task ID from start_web_task, like K1.');

function children(ctx: ToolRunContext): ChildRuns {
  if (!ctx.run.children) throw new Error('Web tasks are not available in this run.');
  return ctx.run.children;
}

export const startWebTask = defineTool({
  name: 'start_web_task',
  title: 'Start web task',
  effect: 'write',
  description:
    "Hand work inside web pages (clicking, typing, searching or reading through a site) to a web task, which works in its own window and reports back. Write the brief so that it needs nothing else: the task can't see this conversation or the snapshot. Returns at once with the task's ID; then call wait_for_web_task.",
  input: WebTaskBrief,
  confirm: ({ goal }) => ({ question: `Start a web task: ${goal}`, when: 'ask' }),
  async run(brief, ctx) {
    const id = await children(ctx).start(brief, ctx.callId);
    return `Started web task ${id}. Call wait_for_web_task with taskId "${id}" for its report.`;
  },
});

export const waitForWebTask = defineTool({
  name: 'wait_for_web_task',
  title: 'Wait for web task',
  effect: 'read',
  description:
    "Wait for a web task to finish and get its report. Returns early when the user sends you a message while you wait, so you can decide what to do with it; the task keeps running.",
  input: z.object({ taskId }),
  timeoutMs: WAIT_TIMEOUT_MS,
  async run({ taskId }, ctx) {
    const stopWaiting = new AbortController();
    const signal = AbortSignal.any([ctx.signal, stopWaiting.signal]);
    try {
      const finished = children(ctx).wait(taskId, signal).then((report) => ({ report }));
      const steered = ctx.run.steering ? [ctx.run.steering.waitForMessage(signal).then(() => ({ report: undefined }))] : [];
      const { report } = await Promise.race([finished, ...steered]);
      if (report !== undefined) return report;
      return `Web task ${taskId} is still running. The user has sent you a message, which follows these results. Decide whether it changes your own work, the web task's, or both: pass it on with steer_web_task, stop the task with stop_web_task, or act on it yourself. Then call wait_for_web_task again.`;
    } finally {
      stopWaiting.abort();
    }
  },
});

export const steerWebTask = defineTool({
  name: 'steer_web_task',
  title: 'Steer web task',
  effect: 'read',
  description:
    "Pass the user's message on to a running web task, which reads it at its next step and follows it over its brief. Quote the user's words exactly in `message`; add anything the task needs to act on them in `note`.",
  input: z.object({
    taskId,
    message: z.string().min(1).describe("The user's words, exactly as they wrote them."),
    note: z.string().optional().describe('What the task should do about it, if that needs saying.'),
  }),
  async run({ taskId, message, note }, ctx) {
    const text = `The user says: "${message}"${note ? `\nThe main agent adds: ${note}` : ''}`;
    children(ctx).steer(taskId, text);
    return `Passed it on to web task ${taskId}. Call wait_for_web_task to keep waiting.`;
  },
});

export const stopWebTask = defineTool({
  name: 'stop_web_task',
  title: 'Stop web task',
  effect: 'read',
  description: 'Stop a running web task, for example when the user changed their mind. Then call wait_for_web_task for its final report.',
  input: z.object({ taskId }),
  async run({ taskId }, ctx) {
    children(ctx).stop(taskId);
    return `Stopping web task ${taskId}. Call wait_for_web_task for its final report.`;
  },
});

export const DELEGATION_TOOLS = [startWebTask, waitForWebTask, steerWebTask, stopWebTask];
