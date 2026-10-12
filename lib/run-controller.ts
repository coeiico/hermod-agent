// Worker-side owner of the current run. Every change goes through emit(),
// which folds the event into the state (same reducer as the popup) and
// broadcasts it to any connected popup.
import { applyEvent, newRun, type RunEvent, type RunState, type RunStatus, type RunUsage, type SnapshotInfo } from './run';

export class RunController {
  state: RunState;
  private approvals = new Map<string, (approved: boolean) => void>();

  constructor(
    command: string,
    model: string,
    private broadcast: (runId: string, event: RunEvent) => void,
  ) {
    this.state = newRun(crypto.randomUUID(), command, model);
  }

  get id() {
    return this.state.id;
  }

  private emit(event: RunEvent) {
    this.state = applyEvent(this.state, event);
    this.broadcast(this.state.id, event);
  }

  private nextIndex(): number {
    return this.state.messages[1]?.parts.length ?? 0;
  }

  snapshot(snapshot: SnapshotInfo) {
    this.emit({ type: 'snapshot', snapshot });
  }

  stepStart() {
    this.emit({ type: 'step-start' });
  }

  startReasoning(): number {
    const index = this.nextIndex();
    this.emit({ type: 'reasoning-start', index });
    return index;
  }

  startText(): number {
    const index = this.nextIndex();
    this.emit({ type: 'text-start', index });
    return index;
  }

  delta(index: number, delta: string) {
    if (delta) this.emit({ type: 'delta', index, delta });
  }

  endPart(index: number) {
    this.emit({ type: 'part-end', index });
  }

  toolInputStart(toolCallId: string, toolName: string, title: string) {
    this.emit({ type: 'tool-input-start', toolCallId, toolName, title });
  }

  toolInputDelta(toolCallId: string, rawInput: string) {
    let input: unknown;
    try {
      input = JSON.parse(rawInput);
    } catch {
      // partial JSON; keep the last good parse
    }
    this.emit({ type: 'tool-input-delta', toolCallId, rawInput, input });
  }

  toolInputAvailable(toolCallId: string, input: unknown) {
    this.emit({ type: 'tool-input-available', toolCallId, input });
  }

  toolOutput(toolCallId: string, output: string) {
    this.emit({ type: 'tool-output', toolCallId, output });
  }

  toolError(toolCallId: string, errorText: string) {
    this.emit({ type: 'tool-error', toolCallId, errorText });
  }

  usage(usage: RunUsage) {
    this.emit({ type: 'usage', usage });
  }

  /** Pauses until the user answers in the popup. Resolves false on timeout or stop. */
  requestApproval(toolCallId: string, reason: string, signal: AbortSignal, timeoutMs = 120_000): Promise<boolean> {
    const approvalId = crypto.randomUUID();
    this.emit({ type: 'tool-approval-request', toolCallId, approvalId, reason });
    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean) => {
        if (!this.approvals.has(approvalId)) return;
        this.approvals.delete(approvalId);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.emit({ type: 'tool-approval-response', toolCallId, approved });
        resolve(approved);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal.addEventListener('abort', onAbort);
      this.approvals.set(approvalId, finish);
    });
  }

  answerApproval(approvalId: string, approved: boolean) {
    this.approvals.get(approvalId)?.(approved);
  }

  /** Marks tool calls that never got a result (e.g. after a stop or error). */
  failDanglingTools(errorText: string) {
    for (const part of this.state.messages[1]?.parts ?? []) {
      if (
        part.type === 'dynamic-tool' &&
        (part.state === 'input-streaming' || part.state === 'input-available' || part.state === 'approval-responded')
      ) {
        this.toolError(part.toolCallId, errorText);
      }
    }
  }

  end(status: RunStatus, extra: { summary?: string; error?: string } = {}) {
    this.emit({ type: 'run-end', status, ...extra });
  }

  get finished() {
    return this.state.status !== 'running';
  }
}
