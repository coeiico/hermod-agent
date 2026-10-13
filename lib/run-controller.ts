// Worker-side owner of the current run. It turns the agent runtime's events
// into RunUpdates, folds each into the state (same reducer as the popup) and
// broadcasts it to any connected popup.
import { costOf } from '@/ai/models';
import { addUsage, ZERO_USAGE, type RunEvent, type Usage } from '@/ai/runtime/events';
import type { Snapshot } from '@/ai/tools/snapshot';
import { toolTitle } from '@/ai/tools/catalog';
import { applyUpdate, newRun, type RunState, type RunStatus, type RunUpdate } from './run';

export class RunController {
  state: RunState;
  private approvals = new Map<string, (approved: boolean) => void>();
  // API content-block index -> UI part index, for the response being streamed.
  private blockParts = new Map<number, number>();
  private usage: Usage = ZERO_USAGE;
  private rounds = 0;

  constructor(
    command: string,
    model: string,
    resumed: boolean,
    private broadcast: (runId: string, update: RunUpdate) => void,
  ) {
    this.state = newRun(crypto.randomUUID(), command, model, resumed);
  }

  private emit(update: RunUpdate) {
    this.state = applyUpdate(this.state, update);
    this.broadcast(this.state.id, update);
  }

  private nextIndex(): number {
    return this.state.messages[1]?.parts.length ?? 0;
  }

  snapshot(snapshot: Snapshot) {
    this.emit({ type: 'snapshot', snapshot });
  }

  /** Applies one event from the agent runtime. */
  handle(event: RunEvent) {
    switch (event.type) {
      case 'turn-started':
        this.blockParts.clear();
        this.emit({ type: 'step-start' });
        break;
      case 'reasoning-started': {
        const index = this.nextIndex();
        this.blockParts.set(event.block, index);
        this.emit({ type: 'reasoning-start', index });
        break;
      }
      case 'text-started': {
        const index = this.nextIndex();
        this.blockParts.set(event.block, index);
        this.emit({ type: 'text-start', index });
        break;
      }
      case 'delta': {
        const index = this.blockParts.get(event.block);
        if (index !== undefined && event.text) this.emit({ type: 'delta', index, delta: event.text });
        break;
      }
      case 'block-finished': {
        const index = this.blockParts.get(event.block);
        if (index !== undefined) this.emit({ type: 'part-end', index });
        break;
      }
      case 'tool-input-started':
        this.emit({ type: 'tool-input-start', toolCallId: event.callId, toolName: event.name, title: toolTitle(event.name) });
        break;
      case 'tool-input-delta': {
        let input: unknown;
        try {
          input = JSON.parse(event.json);
        } catch {
          // partial JSON; the reducer keeps the last good parse
        }
        this.emit({ type: 'tool-input-delta', toolCallId: event.callId, rawInput: event.json, input });
        break;
      }
      case 'response-discarded':
        this.blockParts.clear();
        this.failDanglingTools(event.reason);
        break;
      case 'response-completed':
        this.usage = addUsage(this.usage, event.usage);
        this.rounds++;
        this.emit({
          type: 'usage',
          usage: {
            rounds: this.rounds,
            inputTokens: this.usage.inputTokens,
            outputTokens: this.usage.outputTokens,
            reasoningTokens: this.usage.thinkingTokens,
            cacheReadTokens: this.usage.cacheReadTokens,
            cacheWriteTokens: this.usage.cacheWrite5mTokens + this.usage.cacheWrite1hTokens,
            contextTokens: event.usage.inputTokens + event.usage.cacheReadTokens + event.usage.cacheWrite5mTokens + event.usage.cacheWrite1hTokens,
            costUSD: costOf(this.usage, event.model),
          },
        });
        break;
      case 'tool-call-started':
        this.emit({ type: 'tool-input-available', toolCallId: event.callId, input: event.input });
        break;
      case 'tool-call-finished': {
        const { result } = event;
        // A declined call already shows as denied from the approval answer.
        if (result.status === 'ok') this.emit({ type: 'tool-output', toolCallId: event.callId, output: result.output });
        else if (result.status === 'error') this.emit({ type: 'tool-error', toolCallId: event.callId, errorText: result.message });
        break;
      }
      case 'run-finished':
        this.end('done', { summary: event.result.text || 'Done.' });
        break;
    }
  }

  /** Shows the question in the popup and waits for the answer, or false when `signal` aborts. */
  requestApproval(toolCallId: string, question: string, signal: AbortSignal): Promise<boolean> {
    const approvalId = crypto.randomUUID();
    this.emit({ type: 'tool-approval-request', toolCallId, approvalId, reason: question });
    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean) => {
        if (!this.approvals.delete(approvalId)) return;
        signal.removeEventListener('abort', onAbort);
        this.emit({ type: 'tool-approval-response', toolCallId, approved });
        resolve(approved);
      };
      const onAbort = () => finish(false);
      this.approvals.set(approvalId, finish);
      if (signal.aborted) finish(false);
      else signal.addEventListener('abort', onAbort);
    });
  }

  answerApproval(approvalId: string, approved: boolean) {
    this.approvals.get(approvalId)?.(approved);
  }

  /**
   * Marks tool calls that never got a result (after a stop or error), saying
   * whether each one had started: a started browser call cannot be cancelled,
   * so it may have taken effect.
   */
  failDanglingTools(reason: string) {
    for (const part of this.state.messages[1]?.parts ?? []) {
      if (part.type !== 'dynamic-tool') continue;
      if (part.state === 'input-streaming') {
        this.emit({ type: 'tool-error', toolCallId: part.toolCallId, errorText: `Not run: ${reason}.` });
      } else if (part.state === 'input-available' || part.state === 'approval-responded') {
        this.emit({ type: 'tool-error', toolCallId: part.toolCallId, errorText: `Interrupted: ${reason}. It may already have taken effect.` });
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
