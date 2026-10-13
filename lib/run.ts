// Shared run model. The worker emits RunUpdates; both the worker and the popup
// fold them into a RunState with applyUpdate(), so the popup can attach at any
// point (it gets the current state, then live updates) and render the same
// UIMessage-shaped data with AI Elements.
import type { Snapshot } from '@/ai/tools/snapshot';
import type { Thread } from './threads';
import type { DynamicToolUIPart, UIMessage } from 'ai';

export type RunStatus = 'running' | 'done' | 'error' | 'stopped' | 'interrupted';

export interface RunUsage {
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Prompt size of the latest round (uncached + cached), for the context meter. */
  contextTokens: number;
  costUSD: number;
}

export const EMPTY_USAGE: RunUsage = {
  rounds: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  contextTokens: 0,
  costUSD: 0,
};

export type SnapshotInfo = Snapshot;

export interface RunState {
  id: string;
  command: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  error?: string;
  summary?: string;
  /** A web task stopped at a step only the user can take. */
  needsUser?: boolean;
  snapshot?: SnapshotInfo;
  /** Carries on the thread's previous command, which was stopped, interrupted or failed. */
  resumed?: boolean;
  /** [user command, assistant activity]. Steers sent into the run are `data-steer` parts of the activity. */
  messages: UIMessage[];
  usage: RunUsage;
  /** Web tasks this command started, by the ID of the tool call that started each. */
  tasks?: Record<string, RunState>;
}

/** `sent`: waiting for the agent; `read`: the agent has it; `queued`: it came too late and runs as the next command. */
export type SteerState = 'sent' | 'read' | 'queued';

export interface SteerData {
  text: string;
  state: SteerState;
}

type Part = UIMessage['parts'][number];

export function steerOf(part: Part): SteerData | undefined {
  return part.type === 'data-steer' ? (part.data as SteerData) : undefined;
}

/** A message sent to a thread while its command ran, waiting to run next. */
export interface QueuedCommand {
  id: string;
  text: string;
  queuedAt: number;
  /** Carries on the thread's last command (a resume) instead of starting a new one. */
  resume?: boolean;
  /** Held after the worker restarted, until the user runs it. */
  paused?: boolean;
}

/**
 * What a thread is doing, for the dots on the thread list and toolbar icon:
 * working, waiting on a confirmation, or finished since the user last opened it.
 */
export type ThreadActivity = 'running' | 'waiting' | 'done' | 'failed';

export type RunUpdate =
  | { type: 'snapshot'; snapshot: SnapshotInfo }
  | { type: 'step-start' }
  | { type: 'reasoning-start'; index: number }
  | { type: 'text-start'; index: number }
  | { type: 'delta'; index: number; delta: string }
  | { type: 'part-end'; index: number }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string; title: string }
  | { type: 'tool-input-delta'; toolCallId: string; rawInput: string; input?: unknown }
  | { type: 'tool-input-available'; toolCallId: string; input: unknown }
  | { type: 'tool-approval-request'; toolCallId: string; approvalId: string; reason: string }
  | { type: 'tool-approval-response'; toolCallId: string; approved: boolean }
  | { type: 'tool-output'; toolCallId: string; output: string }
  | { type: 'tool-error'; toolCallId: string; errorText: string }
  | { type: 'usage'; usage: RunUsage }
  | { type: 'run-end'; status: RunStatus; summary?: string; error?: string; needsUser?: boolean }
  | { type: 'steer'; id: string; text: string }
  | { type: 'steer-state'; ids: string[]; state: SteerState }
  | { type: 'task-start'; task: string; run: RunState }
  | { type: 'task-update'; task: string; update: RunUpdate };

// Popup -> worker, over the long-lived port.
export type PortRequest =
  /** Runs in the open thread, or queues while its command runs. */
  | { type: 'run'; command: string }
  /** Carries on the open thread's last command when it was stopped, interrupted or failed. */
  | { type: 'resume' }
  | { type: 'approve'; approvalId: string; approved: boolean }
  /** Stops the open thread's command. */
  | { type: 'stop' }
  /** Sends a queued message of the open thread into its running command. */
  | { type: 'steer'; queuedId: string }
  | { type: 'unqueue'; queuedId: string }
  /** Runs a queued message that was held after a restart. */
  | { type: 'run-queued'; queuedId: string }
  | { type: 'open-thread'; threadId: string }
  | { type: 'new-thread' }
  | { type: 'delete-thread'; threadId: string };

// Worker -> popup, over the long-lived port.
export type PortMessage =
  /**
   * The open thread's finished turns, its command in progress (if any) and its
   * queue. Null thread: a new, empty one. `activity`: every thread that is
   * running or has news, by ID.
   */
  | { type: 'state'; thread: Thread | null; run: RunState | null; queue: QueuedCommand[]; activity: Record<string, ThreadActivity> }
  | { type: 'update'; runId: string; update: RunUpdate }
  | { type: 'needs-unlock' }
  | { type: 'error'; error: string };

export const PORT_NAME = 'hermod-popup';

/** Whether a finished command can be carried on with a resume. */
export function canResume(run: RunState): boolean {
  return run.status === 'stopped' || run.status === 'interrupted' || run.status === 'error';
}

export function newRun(id: string, command: string, model: string, resumed = false): RunState {
  return {
    id,
    command,
    model,
    startedAt: Date.now(),
    status: 'running',
    ...(resumed ? { resumed } : {}),
    messages: [
      { id: `${id}-user`, role: 'user', parts: [{ type: 'text', text: command }] },
      { id: `${id}-assistant`, role: 'assistant', parts: [] },
    ],
    usage: EMPTY_USAGE,
  };
}

function updateAssistant(run: RunState, update: (parts: Part[]) => Part[]): RunState {
  const [user, assistant] = run.messages;
  if (!user || !assistant) return run;
  return { ...run, messages: [user, { ...assistant, parts: update(assistant.parts) }] };
}

function replaceAt(parts: Part[], index: number, update: (part: Part) => Part): Part[] {
  const part = parts[index];
  if (!part) return parts;
  const next = parts.slice();
  next[index] = update(part);
  return next;
}

function updateTool(
  run: RunState,
  toolCallId: string,
  update: (part: DynamicToolUIPart) => DynamicToolUIPart,
): RunState {
  return updateAssistant(run, (parts) =>
    parts.map((p) => (p.type === 'dynamic-tool' && p.toolCallId === toolCallId ? update(p) : p)),
  );
}

export function applyUpdate(run: RunState, event: RunUpdate): RunState {
  switch (event.type) {
    case 'snapshot':
      return { ...run, snapshot: event.snapshot };
    case 'step-start':
      return updateAssistant(run, (parts) => [...parts, { type: 'step-start' }]);
    case 'reasoning-start':
      return updateAssistant(run, (parts) => {
        const next = parts.slice();
        next[event.index] = { type: 'reasoning', text: '', state: 'streaming' };
        return next;
      });
    case 'text-start':
      return updateAssistant(run, (parts) => {
        const next = parts.slice();
        next[event.index] = { type: 'text', text: '', state: 'streaming' };
        return next;
      });
    case 'delta':
      return updateAssistant(run, (parts) =>
        replaceAt(parts, event.index, (p) =>
          p.type === 'text' || p.type === 'reasoning' ? { ...p, text: p.text + event.delta } : p,
        ),
      );
    case 'part-end':
      return updateAssistant(run, (parts) =>
        replaceAt(parts, event.index, (p) =>
          p.type === 'text' || p.type === 'reasoning' ? { ...p, state: 'done' } : p,
        ),
      );
    case 'tool-input-start':
      return updateAssistant(run, (parts) => [
        ...parts,
        {
          type: 'dynamic-tool',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          title: event.title,
          state: 'input-streaming',
          input: undefined,
        },
      ]);
    case 'tool-input-delta':
      return updateTool(run, event.toolCallId, (p) =>
        p.state === 'input-streaming' ? { ...p, rawInput: event.rawInput, input: event.input ?? p.input } : p,
      );
    case 'tool-input-available':
      return updateTool(run, event.toolCallId, (p) => ({
        type: p.type,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        title: p.title,
        state: 'input-available',
        input: event.input,
      }));
    case 'tool-approval-request':
      return updateTool(run, event.toolCallId, (p) => ({
        type: p.type,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        title: p.title,
        state: 'approval-requested',
        input: p.input,
        approval: { id: event.approvalId, requestReason: event.reason },
      }));
    case 'tool-approval-response':
      return updateTool(run, event.toolCallId, (p) => {
        if (p.state !== 'approval-requested') return p;
        const approval = { ...p.approval, approved: event.approved };
        return event.approved
          ? { ...p, state: 'approval-responded', approval }
          : { ...p, state: 'output-denied', approval: { ...approval, approved: false } };
      });
    case 'tool-output':
      return updateTool(run, event.toolCallId, (p) => ({
        type: p.type,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        title: p.title,
        state: 'output-available',
        input: p.input,
        output: event.output,
        ...(p.approval?.approved ? { approval: { ...p.approval, approved: true as const } } : {}),
      }));
    case 'tool-error':
      return updateTool(run, event.toolCallId, (p) => ({
        type: p.type,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        title: p.title,
        state: 'output-error',
        input: p.input,
        errorText: event.errorText,
      }));
    case 'usage':
      return { ...run, usage: event.usage };
    case 'steer':
      return updateAssistant(run, (parts) => [...parts, { type: 'data-steer', id: event.id, data: { text: event.text, state: 'sent' } satisfies SteerData }]);
    case 'steer-state':
      return updateAssistant(run, (parts) =>
        parts.map((p) => {
          const steer = steerOf(p);
          return steer && p.type === 'data-steer' && p.id && event.ids.includes(p.id) ? { ...p, data: { ...steer, state: event.state } } : p;
        }),
      );
    case 'task-start':
      return { ...run, tasks: { ...run.tasks, [event.task]: event.run } };
    case 'task-update': {
      const task = run.tasks?.[event.task];
      return task ? { ...run, tasks: { ...run.tasks, [event.task]: applyUpdate(task, event.update) } } : run;
    }
    case 'run-end':
      return {
        ...updateAssistant(run, (parts) =>
          parts.map((p) =>
            (p.type === 'text' || p.type === 'reasoning') && p.state === 'streaming'
              ? { ...p, state: 'done' }
              : p,
          ),
        ),
        status: event.status,
        summary: event.summary,
        error: event.error,
        ...(event.needsUser ? { needsUser: true } : {}),
        endedAt: Date.now(),
      };
  }
}
