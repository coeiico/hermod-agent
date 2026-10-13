// What a run knows about how far it may go and how to reach the user: the run
// context.

export interface Limits {
  /** Model calls that may use tools; one more, without tools, forces a final answer. */
  maxTurns: number;
  /** Wall-clock time for the whole run, confirmations included. */
  runTimeoutMs: number;
  /** Per tool call, unless the tool sets its own. */
  toolTimeoutMs: number;
  /** How long a confirmation waits for the user before counting as "no". */
  confirmTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxTurns: 10,
  runTimeoutMs: 5 * 60_000,
  toolTimeoutMs: 30_000,
  confirmTimeoutMs: 2 * 60_000,
};

/**
 * When the user is asked before a tool runs. `ask`: before anything that changes
 * the browser. `auto`: only when a tool's own check asks (closing many tabs, a
 * form submit). `never`: only for calls that always ask (deleting bookmarks or
 * history, downloads, sending or deleting something in a page). `bypass`: never.
 * Page guardrail refusals still apply in every mode; they are not questions.
 */
export type ApprovalMode = 'ask' | 'auto' | 'never' | 'bypass';

export interface ConfirmationRequest {
  callId: string;
  toolName: string;
  question: string;
  /** Aborts when the run stops or the confirmation times out; the answer must then resolve to false. */
  signal: AbortSignal;
}

/** A message the user sent into a run while it works: a steer. */
export interface SteeringMessage {
  id: string;
  /** The text as the model should read it, already saying who it is from. */
  text: string;
}

/**
 * Steers waiting for a run. The caller pushes; the runner takes them before its
 * next model call, and a tool that waits a long time can wake on one.
 */
export class SteeringInbox {
  private waiting: SteeringMessage[] = [];
  private listeners = new Set<() => void>();

  push(message: SteeringMessage): void {
    this.waiting.push(message);
    for (const listener of [...this.listeners]) listener();
  }

  /** Takes every waiting message, oldest first. */
  take(): SteeringMessage[] {
    return this.waiting.splice(0);
  }

  get size(): number {
    return this.waiting.length;
  }

  /** Resolves once a message is waiting (at once if one already is); rejects when `signal` aborts. */
  waitForMessage(signal: AbortSignal): Promise<void> {
    if (this.waiting.length) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        this.listeners.delete(done);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.listeners.delete(done);
        reject(signal.reason);
      };
      if (signal.aborted) return onAbort();
      this.listeners.add(done);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * Runs this run starts and waits on, such as a web task. The caller wires up
 * which agent they run; tools reach them through the run context.
 */
export interface ChildRuns {
  /** Starts a child run from the tool call `parentCallId` and returns its ID. Throws when `input` is invalid. */
  start(input: unknown, parentCallId: string): Promise<string>;
  /** The child's report once it ends. Rejects when `signal` aborts. */
  wait(id: string, signal: AbortSignal): Promise<string>;
  steer(id: string, text: string): void;
  stop(id: string): void;
}

export interface RunContext {
  limits: Limits;
  /** Set by the caller to stop the run. */
  cancel: AbortSignal;
  /** Aborts on cancel or when the run passes its deadline. Every wait in the run uses it. */
  signal: AbortSignal;
  /** Which tool calls need the user's approval: the mode now, read at each call, as the user can switch it mid-run. */
  approval: () => ApprovalMode;
  /** Asks the user before a tool with a confirmation question runs. */
  confirm: (request: ConfirmationRequest) => Promise<boolean>;
  /** Messages the user sends while the run works. */
  steering?: SteeringInbox;
  /** Child runs this run may start. */
  children?: ChildRuns;
}

export class RunCancelled extends Error {
  override name = 'RunCancelled';
}

export class RunDeadlineExceeded extends Error {
  override name = 'RunDeadlineExceeded';
}

export function createRunContext(options: {
  cancel: AbortSignal;
  approval: () => ApprovalMode;
  confirm: RunContext['confirm'];
  limits?: Partial<Limits>;
  steering?: SteeringInbox;
  children?: ChildRuns;
}): RunContext {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  return {
    limits,
    cancel: options.cancel,
    signal: AbortSignal.any([options.cancel, AbortSignal.timeout(limits.runTimeoutMs)]),
    approval: options.approval,
    confirm: options.confirm,
    steering: options.steering,
    children: options.children,
  };
}

/** Throws when the run has been cancelled or has passed its deadline. */
export function throwIfStopped(ctx: RunContext): void {
  if (ctx.cancel.aborted) throw new RunCancelled('Stopped by the user.');
  if (ctx.signal.aborted) throw new RunDeadlineExceeded(`The command passed its ${Math.round(ctx.limits.runTimeoutMs / 1000)}s time limit.`);
}
