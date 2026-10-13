// The web tasks one command starts: the worker's side of ChildRuns. Each task
// gets its own run context (stopped with its command), steering inbox, scope
// (its own window, or the tab its brief named) and controller, whose updates
// show nested under the tool call that started it.
import {
  formatReport,
  streamWebTask,
  WebTaskBrief,
  webTaskAgent,
  WebTaskReport,
  type WebTaskInput,
  type WebTaskOutcome,
} from '@/ai/agents/delegated/web_task/agent';
import { createRunContext, SteeringInbox, type ApprovalMode, type ChildRuns, type Limits, type RunContext } from '@/ai/runtime/context';
import type { CacheTtl } from '@/ai/runtime/definition';
import type { Model } from '@/ai/runtime/model';
import { getTab } from '@/ai/tools/resolve';
import { bindScope, openInScope, releaseScope, TaskScope } from '@/ai/tools/scope';
import { shortUrl } from '@/ai/tools/snapshot';
import type { RunController } from './run-controller';

export const WEB_TASK_LIMITS: Partial<Limits> = {
  maxTurns: 60,
  runTimeoutMs: 20 * 60_000,
  // A task in the background may wait on a user who is busy in another thread.
  confirmTimeoutMs: 10 * 60_000,
};

const LAST_ACTIONS = 5;

interface Task {
  id: string;
  abort: AbortController;
  inbox: SteeringInbox;
  /** Settles with the report the main agent reads; never rejects. */
  report: Promise<string>;
  ended: boolean;
}

export interface WebTaskHost {
  /** Stops the command, and with it every task. */
  cancel: AbortSignal;
  ctrl: RunController;
  /** The user's command, word for word. */
  command: string;
  /** What the user has said into the command so far, word for word. */
  steering: () => readonly string[];
  approval: ApprovalMode;
  model: Model;
  cacheTtl: CacheTtl;
}

function now(): string {
  return new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
}

export class WebTasks implements ChildRuns {
  private tasks = new Map<string, Task>();
  private next = 1;

  constructor(private host: WebTaskHost) {}

  async start(input: unknown, parentCallId: string): Promise<string> {
    const parsed = WebTaskBrief.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid brief: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const brief = parsed.data;
    const id = `K${this.next++}`;
    const scope = new TaskScope(id);

    let start: string;
    if ('tabId' in brief.start) {
      // Resolving refuses web panels, Hermod's own tabs and tabs another task holds.
      const tab = await getTab(brief.start.tabId);
      scope.tabIds.add(tab.id!);
      start = `T${tab.id} "${tab.title ?? ''}" ${shortUrl(tab.url, 160)}: the user's own tab, in their window. Work in it, and leave the rest of their window alone; open_page opens anything else in your own window.`;
    } else {
      const tab = await openInScope(scope, brief.start.url);
      start = `T${tab.id}, a new tab in your own window, opened at ${brief.start.url}.`;
    }

    const abort = new AbortController();
    const inbox = new SteeringInbox();
    const ctrl = this.host.ctrl.startTask(parentCallId, brief.goal, webTaskAgent.config.model);
    const ctx = createRunContext({
      cancel: AbortSignal.any([this.host.cancel, abort.signal]),
      approval: this.host.approval,
      confirm: (request) => ctrl.requestApproval(request.callId, request.question, request.signal),
      limits: WEB_TASK_LIMITS,
      steering: inbox,
    });
    bindScope(ctx, scope);

    const task: Task = { id, abort, inbox, ended: false, report: Promise.resolve('') };
    task.report = this.run(task, scope, ctrl, ctx, {
      brief,
      userCommand: this.host.command,
      steering: this.host.steering(),
      start,
      approval: this.host.approval,
      now: now(),
    });
    this.tasks.set(id, task);
    return id;
  }

  private async run(
    task: Task,
    scope: TaskScope,
    ctrl: RunController,
    ctx: RunContext,
    input: WebTaskInput,
  ): Promise<string> {
    let report: WebTaskReport | undefined;
    let finalText: string | undefined;
    let outcome: WebTaskOutcome;
    let error: string | undefined;
    try {
      const events = streamWebTask(ctx, input, { model: this.host.model, overrides: { cache_ttl: this.host.cacheTtl } });
      for await (const event of events) {
        if (event.type === 'tool-call-started' && event.name === 'report_result') {
          const parsed = WebTaskReport.safeParse(event.input);
          if (parsed.success) report = parsed.data;
        }
        if (event.type === 'run-finished') {
          finalText = event.result.text;
          // The task's card shows the report rather than its closing line.
          if (report) {
            const summary = report.leftForUser ? `${report.summary}\n\nLeft for you: ${report.leftForUser}` : report.summary;
            if (report.status === 'failed') ctrl.end('error', { error: summary });
            else ctrl.end('done', { summary, needsUser: report.status === 'needs_user' });
            continue;
          }
        }
        ctrl.handle(event);
      }
      outcome = report?.status ?? 'done';
    } catch (err) {
      const stoppedByUser = this.host.cancel.aborted;
      outcome = task.abort.signal.aborted || stoppedByUser ? 'stopped' : 'error';
      error = outcome === 'stopped' ? (stoppedByUser ? 'The user stopped the command.' : 'Stopped by the main agent.') : err instanceof Error ? err.message : String(err);
      ctrl.failDanglingTools(outcome === 'stopped' ? 'the task was stopped' : 'the task failed');
      if (outcome === 'stopped') ctrl.end('stopped', { summary: 'Stopped.' });
      else ctrl.end('error', { error });
    } finally {
      task.ended = true;
      releaseScope(scope);
    }
    await this.closeUnusedWindow(scope, outcome, report);
    return formatReport(task.id, {
      outcome,
      report,
      finalText,
      error,
      lastActions: outcome === 'done' || outcome === 'needs_user' ? undefined : lastActions(ctrl),
      unreadSteering: task.inbox.take().map((m) => m.text),
    });
  }

  /** A finished task's own window closes unless its report points at a page in it. */
  private async closeUnusedWindow(scope: TaskScope, outcome: WebTaskOutcome, report: WebTaskReport | undefined): Promise<void> {
    if (scope.windowId === undefined || outcome !== 'done') return;
    const shown = await Promise.all((report?.tabIds ?? []).map((t) => browser.tabs.get(t).catch(() => undefined)));
    if (shown.some((t) => t?.windowId === scope.windowId)) return;
    await browser.windows.remove(scope.windowId).catch(() => {});
  }

  private task(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`No web task ${id} in this command. Its ID comes from start_web_task.`);
    return task;
  }

  wait(id: string, signal: AbortSignal): Promise<string> {
    const task = this.task(id);
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      void task.report.then((report) => {
        signal.removeEventListener('abort', onAbort);
        resolve(report);
      });
    });
  }

  steer(id: string, text: string): void {
    const task = this.task(id);
    if (task.ended) throw new Error(`Web task ${id} has already ended. Call wait_for_web_task for its report.`);
    task.inbox.push({ id: crypto.randomUUID(), text });
  }

  stop(id: string): void {
    this.task(id).abort.abort();
  }

  /** Stops every task still running and waits until each has filed how it ended. */
  async stopAll(): Promise<void> {
    for (const task of this.tasks.values()) if (!task.ended) task.abort.abort();
    await Promise.all([...this.tasks.values()].map((t) => t.report));
  }
}

/** The task's last few actions and how each went, for a report on a task that didn't finish. */
function lastActions(ctrl: RunController): string[] {
  const parts = ctrl.state.messages[1]?.parts ?? [];
  return parts
    .filter((p) => p.type === 'dynamic-tool')
    .slice(-LAST_ACTIONS)
    .map((p) => {
      const outcome = p.state === 'output-available' ? 'ok' : p.state === 'output-error' ? `error: ${p.errorText}` : p.state === 'output-denied' ? 'declined' : 'not finished';
      return `${p.toolName} ${JSON.stringify(p.input ?? {})} → ${outcome}`.slice(0, 300);
    });
}
