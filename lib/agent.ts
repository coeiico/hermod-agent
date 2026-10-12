// The tool-use loop for one command. Runs in the background worker. History
// lives only inside this function: every command starts from a fresh snapshot
// and the messages array is dropped when it returns.
import Anthropic from '@anthropic-ai/sdk';
import { getModel, type CacheTtl, type Effort } from './models';
import { EMPTY_USAGE, type RunUsage } from './run';
import type { RunController } from './run-controller';
import { buildSnapshot } from './snapshot';
import { SYSTEM_PROMPT } from './system-prompt';
import { API_TOOLS, TOOLS_BY_NAME } from './tools';

const MAX_ROUNDS = 10;
// Room for adaptive thinking plus tool calls. A low cap risks truncating a
// tool call mid-input, which then can't be run.
const MAX_TOKENS = 8000;
// With eager input streaming, the SDK can fail to parse a malformed tool
// input; that round is re-sent at most this many times.
const MAX_BAD_JSON_RETRIES = 2;

export interface AgentOptions {
  apiKey: string;
  command: string;
  model: string;
  effort: Effort;
  cacheTtl: CacheTtl;
  ctrl: RunController;
  signal: AbortSignal;
}

class StopRun extends Error {}

function addUsage(total: RunUsage, usage: Anthropic.Usage, modelId: string): RunUsage {
  const price = getModel(modelId).price;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? cacheWrite - write1h;
  const cost =
    (input * price.input +
      output * price.output +
      cacheRead * price.cacheRead +
      write5m * price.cacheWrite5m +
      write1h * price.cacheWrite1h) /
    1_000_000;
  return {
    rounds: total.rounds + 1,
    inputTokens: total.inputTokens + input,
    outputTokens: total.outputTokens + output,
    reasoningTokens: total.reasoningTokens + (usage.output_tokens_details?.thinking_tokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + cacheRead,
    cacheWriteTokens: total.cacheWriteTokens + cacheWrite,
    contextTokens: input + cacheRead + cacheWrite,
    costUSD: total.costUSD + cost,
  };
}

function friendlyApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was rejected (401). Check it under Settings → Manage keys.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use that model (403).';
  if (err instanceof Anthropic.NotFoundError) return 'Model not found (404). Pick another model in Settings.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the API (429). Wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request (400): ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return `The API had a server error (${err.status}). Try again.`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach api.anthropic.com. Check your connection.';
  if (err instanceof Anthropic.APIError) return `API error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export function createClient(apiKey: string): Anthropic {
  // dangerouslyAllowBrowser sends the anthropic-dangerous-direct-browser-access
  // header, which the API requires for calls from a browser context.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

/**
 * Streams one round, mirroring blocks into the UI as they arrive, and returns
 * the final message.
 */
async function streamRound(
  client: Anthropic,
  params: Anthropic.MessageStreamParams,
  ctrl: RunController,
  signal: AbortSignal,
): Promise<Anthropic.Message> {
  const stream = client.messages.stream(params, { signal });
  // API content-block index -> UI part index (reasoning/text) or tool call ID.
  const parts = new Map<number, number>();
  const tools = new Map<number, { id: string; raw: string }>();

  for await (const event of stream) {
    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'thinking') parts.set(event.index, ctrl.startReasoning());
        else if (block.type === 'text') parts.set(event.index, ctrl.startText());
        else if (block.type === 'tool_use') {
          tools.set(event.index, { id: block.id, raw: '' });
          ctrl.toolInputStart(block.id, block.name, TOOLS_BY_NAME.get(block.name)?.title ?? block.name);
        }
        break;
      }
      case 'content_block_delta': {
        const d = event.delta;
        const part = parts.get(event.index);
        if (d.type === 'thinking_delta' && part !== undefined) ctrl.delta(part, d.thinking);
        else if (d.type === 'text_delta' && part !== undefined) ctrl.delta(part, d.text);
        else if (d.type === 'input_json_delta') {
          const tool = tools.get(event.index);
          if (tool) {
            tool.raw += d.partial_json;
            ctrl.toolInputDelta(tool.id, tool.raw);
          }
        }
        break;
      }
      case 'content_block_stop': {
        const part = parts.get(event.index);
        if (part !== undefined) ctrl.endPart(part);
        break;
      }
    }
  }
  return stream.finalMessage();
}

export async function runAgent(opts: AgentOptions): Promise<void> {
  const { ctrl, signal } = opts;
  const client = createClient(opts.apiKey);

  const snapshot = await buildSnapshot();
  ctrl.snapshot(snapshot);

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `<browser_snapshot>\n${snapshot.text}\n</browser_snapshot>\n\n<command>\n${opts.command}\n</command>`,
    },
  ];

  const baseParams = {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    // Cache prefix order is tools -> system -> messages. The breakpoint on the
    // system block caches tools + system together; neither ever changes.
    tools: API_TOOLS,
    system: [
      {
        type: 'text' as const,
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' as const, ...(opts.cacheTtl === '1h' ? { ttl: '1h' as const } : {}) },
      },
    ],
    // Automatic caching of the growing tail, so rounds 2+ of one command
    // re-read the snapshot from cache. Stays at the default 5m TTL, which is
    // allowed after a 1h system breakpoint (longer TTLs must come first).
    cache_control: { type: 'ephemeral' as const },
    thinking: { type: 'adaptive' as const, display: 'summarized' as const },
    output_config: { effort: opts.effort },
  };

  let usage = EMPTY_USAGE;
  const toolLog: string[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (signal.aborted) throw new StopRun();
    ctrl.stepStart();

    let message: Anthropic.Message | undefined;
    for (let attempt = 0; !message; attempt++) {
      try {
        message = await streamRound(client, { ...baseParams, messages }, ctrl, signal);
      } catch (err) {
        if (signal.aborted) throw new StopRun();
        if (err instanceof Anthropic.APIError || attempt >= MAX_BAD_JSON_RETRIES) {
          throw new Error(friendlyApiError(err));
        }
        // Not an API error: the SDK couldn't parse a streamed tool input.
        // That block never completed, so there's no tool_use_id to answer;
        // re-send the same round.
        console.warn('[hermod] unparseable tool input, retrying round', err);
        ctrl.failDanglingTools('Malformed tool input from the model; retrying.');
      }
    }

    usage = addUsage(usage, message.usage, opts.model);
    ctrl.usage(usage);
    console.info(
      `[hermod] round ${round} ${opts.model}: input ${message.usage.input_tokens}, cache read ${message.usage.cache_read_input_tokens ?? 0}, cache write ${message.usage.cache_creation_input_tokens ?? 0}, output ${message.usage.output_tokens}, stop ${message.stop_reason}`,
    );

    if (message.stop_reason === 'refusal') {
      ctrl.failDanglingTools('Not run: Claude declined the request.');
      ctrl.end('error', { error: 'Claude declined this request.' });
      return;
    }

    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    if (message.stop_reason === 'max_tokens') {
      // A tool input cut off at max_tokens can still look valid; never run it.
      ctrl.failDanglingTools('Not run: the response hit the output limit.');
      ctrl.end('error', { error: 'The response hit the output token limit before finishing. Try a simpler command or lower effort.' });
      return;
    }

    if (message.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const summary = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      ctrl.end('done', { summary: summary || 'Done.' });
      return;
    }

    // Append the assistant turn unchanged (thinking blocks included): the
    // history must stay append-only within the loop.
    messages.push({ role: 'assistant', content: message.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      results.push(await runTool(use, ctrl, signal, toolLog));
    }
    // All results go back in one user message.
    messages.push({ role: 'user', content: results });
  }

  ctrl.end('done', {
    summary: `Stopped after ${MAX_ROUNDS} rounds.${toolLog.length ? ` Done so far: ${toolLog.join(' ')}` : ' Nothing was changed.'}`,
  });
}

async function runTool(
  use: Anthropic.ToolUseBlock,
  ctrl: RunController,
  signal: AbortSignal,
  toolLog: string[],
): Promise<Anthropic.ToolResultBlockParam> {
  const error = (text: string): Anthropic.ToolResultBlockParam => {
    ctrl.toolError(use.id, text);
    return { type: 'tool_result', tool_use_id: use.id, content: text, is_error: true };
  };

  if (signal.aborted) return error('Stopped by the user before this ran.');

  const tool = TOOLS_BY_NAME.get(use.name);
  if (!tool) return error(`Unknown tool "${use.name}".`);

  // Eager input streaming skips server-side validation, so validate here.
  const parsed = tool.schema.safeParse(use.input);
  if (!parsed.success) {
    return error(`INVALID_INPUT: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}. Input received: ${JSON.stringify(use.input)}`);
  }
  ctrl.toolInputAvailable(use.id, parsed.data);

  try {
    const question = tool.confirm ? await tool.confirm(parsed.data) : null;
    if (question) {
      const approved = await ctrl.requestApproval(use.id, question, signal);
      if (!approved) {
        const text = signal.aborted
          ? 'Stopped by the user. Nothing was changed.'
          : 'The user declined this action. Nothing was changed. Do not retry it.';
        return { type: 'tool_result', tool_use_id: use.id, content: text };
      }
    }
    const output = await tool.run(parsed.data, { signal });
    ctrl.toolOutput(use.id, output);
    toolLog.push(output.split('\n')[0]!);
    return { type: 'tool_result', tool_use_id: use.id, content: output };
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
}

export { StopRun };
