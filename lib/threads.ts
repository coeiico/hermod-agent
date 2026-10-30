// Threads: commands grouped into conversations the user can come back to.
// Stored in storage.local so they survive restarting the browser. Only the
// background worker writes them; the popup reads them through the worker.
import type { EarlierTurn } from '@/ai/agents/interactive/browser_command/agent';
import { steerOf, type RunState, type RunStatus } from './run';

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  /** How the latest command ended, and when. */
  lastStatus?: RunStatus;
  lastEndedAt?: number;
  /** When the user last had the thread open. A command that ended after it is unread. */
  lastViewedAt?: number;
}

export interface Thread extends ThreadSummary {
  /** Finished commands, oldest first, as the popup renders them. */
  turns: RunState[];
  /** A guess at the user's next command, made after the last turn: the prompt's hint, which Tab fills in. */
  nextCommand?: string;
}

const INDEX_KEY = 'threadIndex';
const ACTIVE_KEY = 'activeThreadId';
const threadKey = (id: string) => `thread:${id}`;
// Oldest threads beyond this are dropped when a new one is created.
const MAX_THREADS = 100;
const TITLE_CHARS = 60;
// A web task's page outlines are large and only useful while it runs.
const MAX_TASK_OUTPUT_CHARS = 1_500;

// Writes read the index, change it and write it back. Several commands can
// finish at once, so every write waits for the one before.
let writes: Promise<unknown> = Promise.resolve();
function serialized<T>(write: () => Promise<T>): Promise<T> {
  const next = writes.then(write);
  writes = next.catch(() => undefined);
  return next;
}

export async function listThreads(): Promise<ThreadSummary[]> {
  const stored = await browser.storage.local.get(INDEX_KEY);
  return (stored[INDEX_KEY] as ThreadSummary[] | undefined) ?? [];
}

export async function getThread(id: string): Promise<Thread | undefined> {
  const stored = await browser.storage.local.get(threadKey(id));
  return stored[threadKey(id)] as Thread | undefined;
}

export async function getActiveThreadId(): Promise<string | null> {
  const stored = await browser.storage.local.get(ACTIVE_KEY);
  return (stored[ACTIVE_KEY] as string | undefined) ?? null;
}

export async function setActiveThreadId(id: string | null): Promise<void> {
  if (id) await browser.storage.local.set({ [ACTIVE_KEY]: id });
  else await browser.storage.local.remove(ACTIVE_KEY);
}

function summarize(thread: Thread): ThreadSummary {
  const { turns, ...summary } = thread;
  return { ...summary, turnCount: turns.length };
}

async function writeThread(thread: Thread): Promise<void> {
  const index = (await listThreads()).filter((t) => t.id !== thread.id);
  index.unshift(summarize(thread));
  const dropped = index.splice(MAX_THREADS);
  await browser.storage.local.set({ [threadKey(thread.id)]: thread, [INDEX_KEY]: index });
  if (dropped.length) await browser.storage.local.remove(dropped.map((t) => threadKey(t.id)));
}

export function createThread(firstCommand: string): Promise<Thread> {
  return serialized(async () => {
    const now = Date.now();
    const title = firstCommand.length > TITLE_CHARS ? `${firstCommand.slice(0, TITLE_CHARS - 1)}…` : firstCommand;
    const thread: Thread = { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now, turnCount: 0, turns: [], lastViewedAt: now };
    await writeThread(thread);
    return thread;
  });
}

/** A web task as saved: its long tool results trimmed. */
function compactTask(task: RunState): RunState {
  const [user, assistant] = task.messages;
  if (!user || !assistant) return task;
  const parts = assistant.parts.map((p) =>
    p.type === 'dynamic-tool' && p.state === 'output-available' && typeof p.output === 'string' && p.output.length > MAX_TASK_OUTPUT_CHARS
      ? { ...p, output: `${p.output.slice(0, MAX_TASK_OUTPUT_CHARS)}… (trimmed)` }
      : p,
  );
  return { ...task, messages: [user, { ...assistant, parts }] };
}

/**
 * Appends a finished command to its thread. The snapshot text is dropped (it
 * is large and stale), and so are its web tasks' long tool results.
 */
export function appendTurn(threadId: string, run: RunState): Promise<Thread | undefined> {
  return serialized(async () => {
    const thread = await getThread(threadId);
    if (!thread) return undefined;
    let turn: RunState = run.snapshot ? { ...run, snapshot: { ...run.snapshot, text: '' } } : run;
    if (turn.tasks) turn = { ...turn, tasks: Object.fromEntries(Object.entries(turn.tasks).map(([id, task]) => [id, compactTask(task)])) };
    const turns = [...thread.turns.filter((t) => t.id !== run.id), turn];
    // A guess made after the previous turn no longer follows.
    const { nextCommand: _, ...rest } = thread;
    const next: Thread = { ...rest, turns, turnCount: turns.length, updatedAt: Date.now(), lastStatus: run.status, lastEndedAt: run.endedAt ?? Date.now() };
    await writeThread(next);
    return next;
  });
}

/** Saves a guess at the next command, unless another turn has finished since the one it follows. */
export function setNextCommand(threadId: string, afterTurnId: string, command: string): Promise<Thread | undefined> {
  return serialized(async () => {
    const thread = await getThread(threadId);
    if (!thread || thread.turns.at(-1)?.id !== afterTurnId) return undefined;
    const next: Thread = { ...thread, nextCommand: command };
    await browser.storage.local.set({ [threadKey(threadId)]: next });
    return next;
  });
}

/** Records that the user has seen the thread as it is now, which clears its unread dot. */
export function markViewed(threadId: string): Promise<void> {
  return serialized(async () => {
    const index = await listThreads();
    const summary = index.find((t) => t.id === threadId);
    if (!summary) return;
    summary.lastViewedAt = Date.now();
    const thread = await getThread(threadId);
    await browser.storage.local.set({ [INDEX_KEY]: index, ...(thread ? { [threadKey(threadId)]: { ...thread, lastViewedAt: summary.lastViewedAt } } : {}) });
  });
}

/** Deletes every thread `keep` doesn't keep, and returns the IDs it deleted. */
export function clearThreads(keep: (thread: ThreadSummary) => boolean): Promise<string[]> {
  return serialized(async () => {
    const index = await listThreads();
    const cleared = index.filter((t) => !keep(t)).map((t) => t.id);
    if (!cleared.length) return [];
    await browser.storage.local.set({ [INDEX_KEY]: index.filter((t) => keep(t)) });
    await browser.storage.local.remove(cleared.map(threadKey));
    const activeId = await getActiveThreadId();
    if (activeId && cleared.includes(activeId)) await setActiveThreadId(null);
    return cleared;
  });
}

export function deleteThread(id: string): Promise<void> {
  return serialized(async () => {
    const index = (await listThreads()).filter((t) => t.id !== id);
    await browser.storage.local.set({ [INDEX_KEY]: index });
    await browser.storage.local.remove(threadKey(id));
    if ((await getActiveThreadId()) === id) await setActiveThreadId(null);
  });
}

/** How a web task ended, for the start_web_task action that began it. */
function taskEnding(task: RunState): string {
  const ending = task.status === 'error' ? `failed: ${task.error ?? ''}` : task.status === 'done' ? `finished: ${task.summary ?? ''}` : task.status;
  const steps = (task.messages[1]?.parts ?? []).filter((p) => p.type === 'dynamic-tool');
  const last = steps.slice(-3).map((p) => `${p.toolName} ${JSON.stringify(p.input ?? {})} (${p.state === 'output-available' ? 'ok' : p.state})`);
  return `\nThe web task ${ending.trim()}${last.length ? `\nIts last steps: ${last.join('; ')}` : ''}`;
}

/** A finished command as the agent is told about it in later commands. */
export function toEarlierTurn(run: RunState): EarlierTurn {
  const parts = run.messages[1]?.parts ?? [];
  const actions: EarlierTurn['actions'] = [];
  const steering: string[] = [];
  for (const part of parts) {
    const steer = steerOf(part);
    if (steer) steering.push(steer.text);
    if (part.type !== 'dynamic-tool') continue;
    const task = run.tasks?.[part.toolCallId];
    if (part.state === 'output-available') {
      actions.push({ tool: part.toolName, input: part.input, outcome: 'ok', result: String(part.output) + (task ? taskEnding(task) : '') });
    } else if (part.state === 'output-error') actions.push({ tool: part.toolName, input: part.input, outcome: 'error', result: part.errorText });
    else if (part.state === 'output-denied') actions.push({ tool: part.toolName, input: part.input, outcome: 'declined' });
    else actions.push({ tool: part.toolName, input: part.input, outcome: 'not run' });
  }
  const answer = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
  return {
    command: run.command,
    resumed: run.resumed,
    startedAt: run.startedAt,
    status: run.status === 'running' ? 'interrupted' : run.status,
    actions,
    ...(steering.length ? { steering } : {}),
    answer: answer || undefined,
    error: run.error,
  };
}
