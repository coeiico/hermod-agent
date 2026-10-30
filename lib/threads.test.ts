import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { applyUpdate, newRun, type RunState } from './run';
import * as threads from './threads';

/** A finished run: one successful tool call, one declined, then an answer. */
function finishedRun(command: string): RunState {
  let run = newRun(crypto.randomUUID(), command, 'claude-haiku-5-5');
  const steps: Parameters<typeof applyUpdate>[1][] = [
    { type: 'snapshot', snapshot: { text: 'W1 focused …', windows: 1, tabs: 3, displays: 1 } },
    { type: 'tool-input-start', toolCallId: 't1', toolName: 'move_tabs', title: 'Move tabs' },
    { type: 'tool-input-available', toolCallId: 't1', input: { tabIds: [5], windowId: 1 } },
    { type: 'tool-output', toolCallId: 't1', output: 'Moved 1 tab to W1.' },
    { type: 'tool-input-start', toolCallId: 't2', toolName: 'close_tabs', title: 'Close tabs' },
    { type: 'tool-input-available', toolCallId: 't2', input: { tabIds: [6, 7, 8, 9] } },
    { type: 'tool-approval-request', toolCallId: 't2', approvalId: 'a1', reason: 'Close 4 tabs?' },
    { type: 'tool-approval-response', toolCallId: 't2', approved: false },
    { type: 'text-start', index: 2 },
    { type: 'delta', index: 2, delta: 'Moved it; left the others open.' },
    { type: 'run-end', status: 'done' },
  ];
  for (const step of steps) run = applyUpdate(run, step);
  return run;
}

beforeEach(() => fakeBrowser.reset());

describe('thread store', () => {
  it('creates a thread, appends turns without snapshot text, and lists newest first', async () => {
    const first = await threads.createThread('put my youtube tabs in a new window');
    const second = await threads.createThread('x'.repeat(80));
    const run = finishedRun('close those');
    const saved = await threads.appendTurn(first.id, run);

    expect(saved?.turns).toHaveLength(1);
    expect(saved?.turns[0]?.snapshot).toEqual({ text: '', windows: 1, tabs: 3, displays: 1 });
    const list = await threads.listThreads();
    expect(list.map((t) => t.id)).toEqual([first.id, second.id]);
    expect(list[0]?.turnCount).toBe(1);
    expect(list[1]?.title).toHaveLength(60);
  });

  it('deleting the open thread clears it', async () => {
    const t = await threads.createThread('a');
    await threads.setActiveThreadId(t.id);
    await threads.deleteThread(t.id);
    expect(await threads.getThread(t.id)).toBeUndefined();
    expect(await threads.getActiveThreadId()).toBeNull();
    expect(await threads.listThreads()).toEqual([]);
  });
});

describe('thread store writes', () => {
  it('keeps both turns when two commands finish at once', async () => {
    const a = await threads.createThread('a');
    const b = await threads.createThread('b');
    await Promise.all([threads.appendTurn(a.id, finishedRun('one')), threads.appendTurn(b.id, finishedRun('two'))]);
    const list = await threads.listThreads();
    expect(list.map((t) => t.turnCount).sort()).toEqual([1, 1]);
    expect(list.every((t) => t.lastStatus === 'done' && t.lastEndedAt)).toBe(true);
  });

  it('clears the threads it is not told to keep, and the open thread with them', async () => {
    const keep = await threads.createThread('keep me');
    const drop = await threads.createThread('drop me');
    await threads.setActiveThreadId(drop.id);
    const cleared = await threads.clearThreads((t) => t.id === keep.id);
    expect(cleared).toEqual([drop.id]);
    expect((await threads.listThreads()).map((t) => t.id)).toEqual([keep.id]);
    expect(await threads.getThread(drop.id)).toBeUndefined();
    expect(await threads.getActiveThreadId()).toBeNull();
  });

  it('marks a thread viewed after its command ends', async () => {
    const t = await threads.createThread('a');
    await threads.appendTurn(t.id, finishedRun('one'));
    const [before] = await threads.listThreads();
    await new Promise((r) => setTimeout(r, 2));
    await threads.markViewed(t.id);
    const [after] = await threads.listThreads();
    expect(after!.lastViewedAt!).toBeGreaterThan(before!.lastEndedAt!);
  });

  it('keeps a guess at the next command until the next turn, and drops one that guessed after an older turn', async () => {
    const t = await threads.createThread('a');
    const first = finishedRun('one');
    await threads.appendTurn(t.id, first);
    expect((await threads.setNextCommand(t.id, first.id, 'close those'))?.nextCommand).toBe('close those');
    expect((await threads.getThread(t.id))?.nextCommand).toBe('close those');

    await threads.appendTurn(t.id, finishedRun('two'));
    expect((await threads.getThread(t.id))?.nextCommand).toBeUndefined();
    expect(await threads.setNextCommand(t.id, first.id, 'stale guess')).toBeUndefined();
    expect((await threads.getThread(t.id))?.nextCommand).toBeUndefined();
  });
});

describe('toEarlierTurn', () => {
  it('keeps each action with its outcome, and the answer', () => {
    expect(threads.toEarlierTurn(finishedRun('tidy up'))).toMatchObject({
      command: 'tidy up',
      status: 'done',
      actions: [
        { tool: 'move_tabs', input: { tabIds: [5], windowId: 1 }, outcome: 'ok', result: 'Moved 1 tab to W1.' },
        { tool: 'close_tabs', outcome: 'declined' },
      ],
      answer: 'Moved it; left the others open.',
    });
  });

  it("keeps the user's steers and a web task's ending", () => {
    let run = newRun('r1', 'add this to my cart', 'claude-haiku-5-5');
    const task = applyUpdate(newRun('k1', 'Add it', 'claude-sonnet-5-5'), { type: 'run-end', status: 'done', summary: 'Added it.' });
    const steps: Parameters<typeof applyUpdate>[1][] = [
      { type: 'tool-input-start', toolCallId: 't1', toolName: 'start_web_task', title: 'Start web task' },
      { type: 'tool-input-available', toolCallId: 't1', input: { goal: 'Add it' } },
      { type: 'task-start', task: 't1', run: newRun('k1', 'Add it', 'claude-sonnet-5-5') },
      { type: 'task-update', task: 't1', update: { type: 'run-end', status: 'done', summary: 'Added it.' } },
      { type: 'tool-output', toolCallId: 't1', output: 'Started web task K1.' },
      { type: 'steer', id: 's1', text: 'make it two' },
      { type: 'steer-state', ids: ['s1'], state: 'read' },
      { type: 'run-end', status: 'done' },
    ];
    for (const step of steps) run = applyUpdate(run, step);
    expect(run.tasks?.t1?.summary).toBe(task.summary);
    const turn = threads.toEarlierTurn(run);
    expect(turn.steering).toEqual(['make it two']);
    expect(turn.actions[0]?.result).toBe('Started web task K1.\nThe web task finished: Added it.');
  });
});
