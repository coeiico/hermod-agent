// Commands waiting to run, per thread. A thread runs one command at a time, so
// anything sent while one runs waits here, in order; across threads, up to a
// fixed number run at once. Plain data, so the worker can persist it.
import type { QueuedCommand } from './run';

export class CommandQueue {
  private queues = new Map<string, QueuedCommand[]>();

  constructor(saved: Record<string, QueuedCommand[]> = {}) {
    for (const [threadId, list] of Object.entries(saved)) if (list.length) this.queues.set(threadId, list);
  }

  list(threadId: string | undefined): QueuedCommand[] {
    return threadId ? (this.queues.get(threadId) ?? []) : [];
  }

  /** Queues a command; `front` puts it before the rest (a steer that arrived too late). */
  add(threadId: string, text: string, options: { resume?: boolean; front?: boolean; paused?: boolean; id?: string } = {}): QueuedCommand {
    const command: QueuedCommand = {
      id: options.id ?? crypto.randomUUID(),
      text,
      queuedAt: Date.now(),
      ...(options.resume ? { resume: true } : {}),
      ...(options.paused ? { paused: true } : {}),
    };
    const list = this.list(threadId).slice();
    if (options.front) list.unshift(command);
    else list.push(command);
    this.queues.set(threadId, list);
    return command;
  }

  /** Takes a queued command out, if it is there. */
  remove(threadId: string, id: string): QueuedCommand | undefined {
    const list = this.list(threadId);
    const command = list.find((c) => c.id === id);
    if (!command) return undefined;
    const rest = list.filter((c) => c.id !== id);
    if (rest.length) this.queues.set(threadId, rest);
    else this.queues.delete(threadId);
    return command;
  }

  unpause(threadId: string, id: string): void {
    this.queues.set(threadId, this.list(threadId).map((c) => (c.id === id ? { ...c, paused: undefined } : c)));
  }

  /** Holds every queued command until the user runs it (after the worker restarted). */
  pauseAll(): void {
    for (const threadId of this.queues.keys()) this.pauseThread(threadId);
  }

  /** Holds a thread's queued commands until the user runs them (after they stopped its command). */
  pauseThread(threadId: string): void {
    const list = this.queues.get(threadId);
    if (list) this.queues.set(threadId, list.map((c) => ({ ...c, paused: true })));
  }

  deleteThread(threadId: string): void {
    this.queues.delete(threadId);
  }

  /**
   * Takes the commands that may start now: the first of each idle thread whose
   * head isn't paused, oldest first, up to `slots`.
   */
  takeStartable(isRunning: (threadId: string) => boolean, slots: number): { threadId: string; command: QueuedCommand }[] {
    const heads = [...this.queues.entries()]
      .filter(([threadId, list]) => !isRunning(threadId) && list[0] && !list[0].paused)
      .map(([threadId, list]) => ({ threadId, command: list[0]! }))
      .sort((a, b) => a.command.queuedAt - b.command.queuedAt)
      .slice(0, Math.max(0, slots));
    for (const { threadId, command } of heads) this.remove(threadId, command.id);
    return heads;
  }

  toJSON(): Record<string, QueuedCommand[]> {
    return Object.fromEntries(this.queues);
  }
}
