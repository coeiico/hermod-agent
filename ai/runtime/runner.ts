// The loop that runs an agent: model turns, the tool calls between them, and
// their limits. History lives only inside one run; every run starts fresh.
import type Anthropic from '@anthropic-ai/sdk';
import { throwIfStopped, type RunContext, type SteeringMessage } from './context';
import type { AgentDefinition, ConfigOverrides } from './definition';
import { addUsage, ZERO_USAGE, type RunEvent, type ToolResult } from './events';
import type { Model, ModelResponse } from './model';
import { renderTemplate } from './prompts';
import { executeToolCall } from './tools';

/** Claude declined the request (stop_reason "refusal"). */
export class AgentRefused extends Error {
  override name = 'AgentRefused';
}

/** A response hit max_tokens. Any tool call in it may be cut off, so none are run. */
export class OutputLimitReached extends Error {
  override name = 'OutputLimitReached';
}

export interface RunOptions {
  model: Model;
  /** Values for task.md's placeholders. */
  variables: Readonly<Record<string, string>>;
  overrides?: ConfigOverrides;
}

// Page views (outlines, screenshots) are large and go stale as soon as the
// page changes. Once TRIM_AT of them have built up, all but the newest
// KEEP_PAGE_VIEWS are replaced. Changing an earlier message invalidates the
// prompt cache from there on, so trimming happens in batches, not every turn.
const TRIM_AT = 5;
const KEEP_PAGE_VIEWS = 2;
const TRIMMED_PAGE_VIEW = '[Older page view removed; call read_page or screenshot for the current page.]';

function toToolResultBlock(callId: string, result: ToolResult): Anthropic.ToolResultBlockParam {
  if (result.status === 'error') {
    return { type: 'tool_result', tool_use_id: callId, is_error: true, content: `${result.errorType}: ${result.message}` };
  }
  if (result.status === 'ok' && result.image) {
    return {
      type: 'tool_result',
      tool_use_id: callId,
      content: [
        { type: 'text', text: result.output },
        { type: 'image', source: { type: 'base64', media_type: result.image.mediaType, data: result.image.data } },
      ],
    };
  }
  return { type: 'tool_result', tool_use_id: callId, content: result.output };
}

function steeringBlock(message: SteeringMessage): Anthropic.TextBlockParam {
  return { type: 'text', text: `<steering>\n${message.text}\n</steering>` };
}

/** Adds blocks to the end of the last message, which is the user's. */
function appendToLastUserMessage(messages: Anthropic.MessageParam[], blocks: Anthropic.ContentBlockParam[]): void {
  const last = messages.at(-1)!;
  const content = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content;
  messages[messages.length - 1] = { ...last, content: [...content, ...blocks] };
}

/** Where a page-view tool result sits: its user message and its block within it. */
interface PageViewAt {
  message: number;
  block: number;
}

/** Replaces the older page views with a note once enough have built up; returns those still whole. */
function trimPageViews(messages: Anthropic.MessageParam[], pageViews: PageViewAt[]): PageViewAt[] {
  if (pageViews.length < TRIM_AT) return pageViews;
  const old = pageViews.slice(0, pageViews.length - KEEP_PAGE_VIEWS);
  for (const { message, block } of old) {
    const msg = messages[message]!;
    const content = (msg.content as Anthropic.ContentBlockParam[]).slice();
    const result = content[block] as Anthropic.ToolResultBlockParam;
    content[block] = { type: 'tool_result', tool_use_id: result.tool_use_id, content: TRIMMED_PAGE_VIEW };
    messages[message] = { ...msg, content };
  }
  return pageViews.slice(-KEEP_PAGE_VIEWS);
}

function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Runs the agent to its final answer, reporting each step. Ends with
 * `run-finished`; a failure throws (RunCancelled, RunDeadlineExceeded,
 * AgentRefused, OutputLimitReached, ModelError).
 */
export async function* streamRun(definition: AgentDefinition, ctx: RunContext, options: RunOptions): AsyncGenerator<RunEvent> {
  const config = { ...definition.config, ...definedOnly(options.overrides) };
  const started = Date.now();
  const tools = new Map(definition.tools.map((t) => [t.name, t]));
  const system = [definition.system, definition.instructions].filter(Boolean);
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: renderTemplate(definition.task, options.variables, `${config.id} task.md`) },
  ];
  let usage = ZERO_USAGE;
  let pageViews: PageViewAt[] = [];

  // The turn after the last is the forced answer: no tools, from what the run has.
  for (let turn = 1; turn <= ctx.limits.maxTurns + 1; turn++) {
    throwIfStopped(ctx);
    const forced = turn > ctx.limits.maxTurns;
    if (forced) console.warn(`[hermod] ${config.id} out of turns, forcing a final answer`);
    // Steers go after the tool results, so history stays append-only.
    const steers = ctx.steering?.take() ?? [];
    if (steers.length) {
      appendToLastUserMessage(messages, steers.map(steeringBlock));
      yield { type: 'steering-read', ids: steers.map((m) => m.id) };
    }
    pageViews = trimPageViews(messages, pageViews);
    yield { type: 'turn-started', turn };

    const callStarted = Date.now();
    let response: ModelResponse | undefined;
    try {
      for await (const item of options.model.respond({
        config,
        system,
        // A snapshot: the run's own list keeps growing after the request is sent.
        messages: [...messages],
        tools: definition.tools,
        toolChoice: forced ? 'none' : undefined,
        signal: ctx.signal,
      })) {
        if (item.type === 'response') response = item;
        else yield item;
      }
    } catch (err) {
      throwIfStopped(ctx);
      throw err;
    }
    if (!response) throw new Error(`${config.id}: the model produced no response.`);

    const { message } = response;
    usage = addUsage(usage, response.usage);
    const durationMs = Date.now() - callStarted;
    console.info(
      `[hermod] ${config.id} turn ${turn} ${config.model}: input ${response.usage.inputTokens}, cache read ${response.usage.cacheReadTokens}, cache write ${response.usage.cacheWrite5mTokens + response.usage.cacheWrite1hTokens}, output ${response.usage.outputTokens}, stop ${message.stop_reason}, ${durationMs}ms`,
    );
    yield { type: 'response-completed', turn, model: config.model, usage: response.usage, stopReason: message.stop_reason, durationMs };

    if (message.stop_reason === 'refusal') throw new AgentRefused('Claude declined this request.');
    if (message.stop_reason === 'max_tokens') {
      throw new OutputLimitReached('The response hit the output token limit before finishing. Try a simpler command or lower effort.');
    }

    const calls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const answered = message.stop_reason !== 'tool_use' || calls.length === 0;
    // A steer that came in while the model wrote its answer is still read:
    // the run carries on with it instead of ending.
    if (answered && !forced && ctx.steering?.size) {
      messages.push({ role: 'assistant', content: message.content });
      const late = ctx.steering.take();
      messages.push({ role: 'user', content: late.map(steeringBlock) });
      yield { type: 'steering-read', ids: late.map((m) => m.id) };
      continue;
    }
    if (answered) {
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      yield { type: 'run-finished', result: { text, turns: turn, usage, durationMs: Date.now() - started, forcedAnswer: forced } };
      return;
    }
    if (forced) throw new Error(`${config.id}: the forced final answer still asked for tools.`);

    // The assistant turn goes back unchanged, thinking blocks included: history
    // stays append-only within a run.
    messages.push({ role: 'assistant', content: message.content });

    // Calls run one at a time, in the order the model wrote them: browser
    // actions often depend on the one before (move, then focus).
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      throwIfStopped(ctx);
      yield { type: 'tool-call-started', callId: call.id, name: call.name, input: call.input };
      const result = await executeToolCall(tools, { callId: call.id, name: call.name, input: call.input }, ctx);
      yield { type: 'tool-call-finished', callId: call.id, name: call.name, result };
      if (result.status === 'ok' && result.pageView) pageViews.push({ message: messages.length, block: results.length });
      results.push(toToolResultBlock(call.id, result));
    }
    // All results go back in one user message.
    messages.push({ role: 'user', content: results });
  }
}
