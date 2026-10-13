// What a run reports as it goes. `streamRun` yields these; the background
// worker turns them into UI state.

export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Counted within outputTokens, not on top of them. */
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
  };
}

/** One tool call's outcome, as the model will read it. */
export type ToolResult =
  | { status: 'ok'; output: string }
  | { status: 'declined'; output: string }
  | { status: 'error'; errorType: string; message: string };

export interface RunResult {
  /** The final answer's text. */
  text: string;
  turns: number;
  /** Summed over every model call of the run. */
  usage: Usage;
  durationMs: number;
  /** True when the run used up its turns and the answer was forced without tools. */
  forcedAnswer: boolean;
}

/**
 * What a provider reports while one response forms. `block` is the content
 * block's index within that response.
 */
export type ModelEvent =
  | { type: 'reasoning-started'; block: number }
  | { type: 'text-started'; block: number }
  | { type: 'delta'; block: number; text: string }
  | { type: 'block-finished'; block: number }
  | { type: 'tool-input-started'; block: number; callId: string; name: string }
  /** `json` is the tool input received so far, not just the new fragment. */
  | { type: 'tool-input-delta'; callId: string; json: string }
  /** The response so far was thrown away (malformed tool input) and the turn is being re-sent. */
  | { type: 'response-discarded'; reason: string };

export type RunEvent =
  | { type: 'turn-started'; turn: number }
  | ModelEvent
  | { type: 'response-completed'; turn: number; model: string; usage: Usage; stopReason: string | null; durationMs: number }
  | { type: 'tool-call-started'; callId: string; name: string; input: unknown }
  | { type: 'tool-call-finished'; callId: string; name: string; result: ToolResult }
  | { type: 'run-finished'; result: RunResult };
