// Threads: commands grouped into conversations the user can come back to.
// Stored in storage.local so they survive restarting the browser. Only the
// background worker writes them; the popup reads them through the worker.
import type { EarlierTurn } from '@/ai/agents/interactive/browser_command/agent';
import type { RunState } from './run';

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}

export interface Thread extends ThreadSummary {
  /** Finished commands, oldest first, as the popup renders them. */
  turns: RunState[];
}

const INDEX_KEY = 'threadIndex';
const ACTIVE_KEY = 'activeThreadId';
const threadKey = (id: string) => `thread:${id}`;
// Oldest threads beyond this are dropped when a new one is created.
const MAX_THREADS = 100;
const TITLE_CHARS = 60;

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

export async function createThread(firstCommand: string): Promise<Thread> {
  const now = Date.now();
  const title = firstCommand.length > TITLE_CHARS ? `${firstCommand.slice(0, TITLE_CHARS - 1)}…` : firstCommand;
  const thread: Thread = { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now, turnCount: 0, turns: [] };
  await writeThread(thread);
  return thread;
}

/** Appends a finished command to its thread. The snapshot text is dropped: it is large and stale. */
export async function appendTurn(threadId: string, run: RunState): Promise<Thread | undefined> {
  const thread = await getThread(threadId);
  if (!thread) return undefined;
  const turn: RunState = run.snapshot ? { ...run, snapshot: { ...run.snapshot, text: '' } } : run;
  const turns = [...thread.turns.filter((t) => t.id !== run.id), turn];
  const next: Thread = { ...thread, turns, turnCount: turns.length, updatedAt: Date.now() };
  await writeThread(next);
  return next;
}

export async function deleteThread(id: string): Promise<void> {
  const index = (await listThreads()).filter((t) => t.id !== id);
  await browser.storage.local.set({ [INDEX_KEY]: index });
  await browser.storage.local.remove(threadKey(id));
  if ((await getActiveThreadId()) === id) await setActiveThreadId(null);
}

/** A finished command as the agent is told about it in later commands. */
export function toEarlierTurn(run: RunState): EarlierTurn {
  const parts = run.messages[1]?.parts ?? [];
  const actions: EarlierTurn['actions'] = [];
  for (const part of parts) {
    if (part.type !== 'dynamic-tool') continue;
    if (part.state === 'output-available') actions.push({ tool: part.toolName, input: part.input, outcome: 'ok', result: String(part.output) });
    else if (part.state === 'output-error') actions.push({ tool: part.toolName, input: part.input, outcome: 'error', result: part.errorText });
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
    answer: answer || undefined,
    error: run.error,
  };
}
