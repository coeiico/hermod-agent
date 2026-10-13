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
 * the browser. `auto`: only when a destructive tool's own check asks (closing
 * many tabs, say). `never`: not at all.
 */
export type ApprovalMode = 'ask' | 'auto' | 'never';

export interface ConfirmationRequest {
  callId: string;
  toolName: string;
  question: string;
  /** Aborts when the run stops or the confirmation times out; the answer must then resolve to false. */
  signal: AbortSignal;
}

export interface RunContext {
  limits: Limits;
  /** Set by the caller to stop the run. */
  cancel: AbortSignal;
  /** Aborts on cancel or when the run passes its deadline. Every wait in the run uses it. */
  signal: AbortSignal;
  /** Which tool calls need the user's approval. */
  approval: ApprovalMode;
  /** Asks the user before a tool with a confirmation question runs. */
  confirm: (request: ConfirmationRequest) => Promise<boolean>;
}

export class RunCancelled extends Error {
  override name = 'RunCancelled';
}

export class RunDeadlineExceeded extends Error {
  override name = 'RunDeadlineExceeded';
}

export function createRunContext(options: {
  cancel: AbortSignal;
  approval: ApprovalMode;
  confirm: RunContext['confirm'];
  limits?: Partial<Limits>;
}): RunContext {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  return {
    limits,
    cancel: options.cancel,
    signal: AbortSignal.any([options.cancel, AbortSignal.timeout(limits.runTimeoutMs)]),
    approval: options.approval,
    confirm: options.confirm,
  };
}

/** Throws when the run has been cancelled or has passed its deadline. */
export function throwIfStopped(ctx: RunContext): void {
  if (ctx.cancel.aborted) throw new RunCancelled('Stopped by the user.');
  if (ctx.signal.aborted) throw new RunDeadlineExceeded(`The command passed its ${Math.round(ctx.limits.runTimeoutMs / 1000)}s time limit.`);
}
