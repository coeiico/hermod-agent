// Works inside web pages for the main agent, which starts it with a brief and
// waits for its report. The brief is what the main agent writes; the caller
// attaches what the model must not be trusted to copy (the user's own words,
// their steering, the approval mode).
import { z } from 'zod';
import type { ApprovalMode, RunContext } from '@/ai/runtime/context';
import { defineAgent, type ConfigOverrides } from '@/ai/runtime/definition';
import type { Model } from '@/ai/runtime/model';
import { streamRun } from '@/ai/runtime/runner';
import { defineTool } from '@/ai/runtime/tools';
import { WEB_TASK_TOOLS } from '@/ai/tools/catalog';
import configYaml from './config.yaml?raw';
import instructions from './instructions.md?raw';
import system from './system.md?raw';
import task from './task.md?raw';

/** The brief the main agent writes when it starts a web task. */
export const WebTaskBrief = z.object({
  goal: z.string().min(1).describe("The outcome to reach, in one or two sentences, from the user's point of view."),
  context: z
    .string()
    .default('')
    .describe('Every fact from the thread and snapshot the task needs: names, quantities, preferences, earlier results.'),
  doneWhen: z.string().min(1).describe('How the task knows it has finished, and what it should report back.'),
  constraints: z.string().default('').describe('What not to do, and any limits ("Stop before checkout").'),
  start: z
    .union([
      z.object({ tabId: z.number().int().describe('An existing tab, when the command is about that page.') }),
      z.object({ url: z.url({ protocol: /^https?$/ }).describe("A page to open in the task's own window.") }),
    ])
    .describe('Where to start: a tab from the snapshot, or a URL to open.'),
});
export type WebTaskBrief = z.infer<typeof WebTaskBrief>;

/** What the task reports with report_result. */
export const WebTaskReport = z.object({
  status: z.enum(['done', 'needs_user', 'failed']),
  summary: z.string().min(1).describe('What you did and found, in a few plain sentences.'),
  leftForUser: z.string().optional().describe('For needs_user: the exact step left for the user.'),
  tabIds: z.array(z.number().int()).default([]).describe('Pages worth showing the user.'),
  data: z.string().optional().describe('What done_when asked you to report.'),
});
export type WebTaskReport = z.infer<typeof WebTaskReport>;

export const reportResult = defineTool({
  name: 'report_result',
  title: 'Report result',
  effect: 'read',
  description: 'Report how the task went. Call it once, at the end, then finish with one short line.',
  input: WebTaskReport,
  async run() {
    return 'Reported. End your turn now with one short line.';
  },
});

export const webTaskAgent = defineAgent({ configYaml, system, instructions, task, tools: [...WEB_TASK_TOOLS, reportResult] });

export interface WebTaskInput {
  brief: WebTaskBrief;
  /** The user's command, word for word. */
  userCommand: string;
  /** What the user said while the main agent worked, word for word, oldest first. */
  steering: readonly string[];
  /** Where it starts, as the model should read it: the tab's line, or the URL. */
  start: string;
  approval: ApprovalMode;
  now: string;
}

export function streamWebTask(ctx: RunContext, input: WebTaskInput, options: { model: Model; overrides?: ConfigOverrides }) {
  const { brief } = input;
  return streamRun(webTaskAgent, ctx, {
    model: options.model,
    overrides: options.overrides,
    variables: {
      goal: brief.goal.trim(),
      done_when: brief.doneWhen.trim(),
      context: brief.context.trim() || 'None given.',
      constraints: brief.constraints.trim() || 'None given.',
      user_command: input.userCommand.trim(),
      steering: input.steering.length ? input.steering.map((s, i) => `${i + 1}. ${s}`).join('\n') : 'None.',
      start: input.start,
      approval: input.approval,
      now: input.now,
    },
  });
}

/** How a web task ended, from its run: `done`, `needs_user` and `failed` come from its report. */
export type WebTaskOutcome = WebTaskReport['status'] | 'stopped' | 'interrupted' | 'error';

/** The task's ending as the main agent reads it, from wait_for_web_task. */
export function formatReport(
  id: string,
  ending: { outcome: WebTaskOutcome; report?: WebTaskReport; finalText?: string; error?: string; lastActions?: readonly string[]; unreadSteering?: readonly string[] },
): string {
  const lines = [`Web task ${id} ended: ${ending.outcome}.`];
  if (ending.report) {
    lines.push(`Summary: ${ending.report.summary}`);
    if (ending.report.leftForUser) lines.push(`Left for the user: ${ending.report.leftForUser}`);
    if (ending.report.data) lines.push(`Data: ${ending.report.data}`);
    if (ending.report.tabIds.length) lines.push(`Pages to show: ${ending.report.tabIds.map((t) => `T${t}`).join(', ')}`);
  } else if (ending.finalText) {
    lines.push(`It ended without a report. Its last words: ${ending.finalText}`);
  }
  if (ending.error) lines.push(`Error: ${ending.error}`);
  if (ending.lastActions?.length) lines.push('Its last actions, oldest first:', ...ending.lastActions.map((a) => `- ${a}`));
  if (ending.unreadSteering?.length) {
    lines.push('Steering that reached it too late to act on:', ...ending.unreadSteering.map((s) => `- ${s}`));
  }
  return lines.join('\n');
}
