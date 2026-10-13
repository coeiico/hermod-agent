// Tools an agent can call, and how one call is run: input validation, the
// confirmation step, a timeout, and errors turned into results the model can
// recover from.
import { z } from 'zod';
import { throwIfStopped, type ApprovalMode, type RunContext } from './context';
import type { ToolResult } from './events';

/** What a tool does to the browser. `read` changes nothing; `destructive` loses something the user had open. */
export type ToolEffect = 'read' | 'write' | 'destructive';

export interface ToolRunContext {
  signal: AbortSignal;
}

interface ToolBase<S extends z.ZodType> {
  name: string;
  /** Short label for the UI. */
  title: string;
  description: string;
  /** Validates the model's input. Streamed tool input is not validated by the API, so this always runs. */
  input: S;
  /** Overrides the run's tool timeout, for a tool that is slow by nature. */
  timeoutMs?: number;
  run: (input: z.infer<S>, ctx: ToolRunContext) => Promise<string>;
}

/** A question to put to the user before running, or null to run straight away. */
type Confirm<S extends z.ZodType> = (input: z.infer<S>) => Promise<string | null> | string | null;

// A destructive tool must say how it asks for confirmation; it may still skip
// asking for small changes (closing one tab) by returning null. A write tool
// may ask too, for the calls that warrant it (starting a download).
// `alwaysAsk` keeps its question even in `never` mode, for the calls no mode
// should make unseen: ones that can't be undone, or that a page could have asked for.
export type Tool<S extends z.ZodType = z.ZodType> = ToolBase<S> &
  (
    | { effect: 'read'; confirm?: undefined; alwaysAsk?: undefined }
    | { effect: 'write'; confirm?: Confirm<S>; alwaysAsk?: boolean }
    | { effect: 'destructive'; confirm: Confirm<S>; alwaysAsk?: boolean }
  );

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool {
  return tool as unknown as Tool;
}

export interface ToolCall {
  callId: string;
  name: string;
  input: unknown;
}

function error(errorType: string, message: string): ToolResult {
  return { status: 'error', errorType, message };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The question to ask before this call under the run's approval mode, or null to run without asking. */
async function approvalQuestion(tool: Tool, input: unknown, mode: ApprovalMode): Promise<string | null> {
  if (tool.effect === 'read' || (mode === 'never' && !tool.alwaysAsk)) return null;
  const question = tool.confirm ? await tool.confirm(input) : null;
  if (question || mode !== 'ask') return question;
  return `${tool.title}?`;
}

class ToolTimeout extends Error {
  override name = 'ToolTimeout';
}

/**
 * Settles with `work`, or rejects when it runs past `ms` or `signal` aborts.
 * The run moves on at once when stopped; the browser call itself may still
 * finish (browser APIs cannot be cancelled).
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeout(`${label} did not finish within ${Math.round(ms / 1000)} seconds.`)), ms);
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Runs one call. Never throws for a tool failure; throws only when the run itself has stopped. */
export async function executeToolCall(
  tools: ReadonlyMap<string, Tool>,
  call: ToolCall,
  ctx: RunContext,
): Promise<ToolResult> {
  const tool = tools.get(call.name);
  if (!tool) return error('unknown_tool', `Tool "${call.name}" is not available.`);

  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return error('invalid_input', `${issues}. Input received: ${JSON.stringify(call.input)}`);
  }
  const input = parsed.data;

  let question: string | null;
  try {
    question = await approvalQuestion(tool, input, ctx.approval);
  } catch (err) {
    return error('confirmation_failed', describe(err));
  }
  if (question) {
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.limits.confirmTimeoutMs)]);
    const approved = await ctx.confirm({ callId: call.callId, toolName: tool.name, question, signal });
    throwIfStopped(ctx);
    if (!approved) {
      const output = signal.aborted
        ? 'The user did not answer the confirmation in time. Nothing was changed.'
        : 'The user declined this action. Nothing was changed. Do not retry it.';
      return { status: 'declined', output };
    }
  }

  try {
    const output = await withTimeout(
      tool.run(input, { signal: ctx.signal }),
      tool.timeoutMs ?? ctx.limits.toolTimeoutMs,
      `Tool "${tool.name}"`,
      ctx.signal,
    );
    return { status: 'ok', output };
  } catch (err) {
    throwIfStopped(ctx);
    return error(err instanceof ToolTimeout ? 'timeout' : 'failed', describe(err));
  }
}
