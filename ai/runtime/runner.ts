// The loop that runs an agent: model turns, the tool calls between them, and
// their limits. History lives only inside one run; every run starts fresh.
import type Anthropic from '@anthropic-ai/sdk';
import { throwIfStopped, type RunContext } from './context';
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

function toToolResultBlock(callId: string, result: ToolResult): Anthropic.ToolResultBlockParam {
  if (result.status === 'error') {
    return { type: 'tool_result', tool_use_id: callId, is_error: true, content: `${result.errorType}: ${result.message}` };
  }
  return { type: 'tool_result', tool_use_id: callId, content: result.output };
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

  // The turn after the last is the forced answer: no tools, from what the run has.
  for (let turn = 1; turn <= ctx.limits.maxTurns + 1; turn++) {
    throwIfStopped(ctx);
    const forced = turn > ctx.limits.maxTurns;
    if (forced) console.warn(`[hermod] ${config.id} out of turns, forcing a final answer`);
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
    if (message.stop_reason !== 'tool_use' || calls.length === 0) {
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
      results.push(toToolResultBlock(call.id, result));
    }
    // All results go back in one user message.
    messages.push({ role: 'user', content: results });
  }
}
