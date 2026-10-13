// The Claude Messages API as a Model.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ModelEvent, Usage } from '../events';
import type { Model, ModelRequest, ModelResponse } from '../model';
import type { Tool } from '../tools';

// With eager input streaming, the SDK can fail to parse a malformed tool
// input. That block never completed, so there is no tool_use_id to answer;
// the response is re-sent at most this many times.
const MAX_MALFORMED_INPUT_RETRIES = 2;

/** The API request failed; the message is written for the user. */
export class ModelError extends Error {
  override name = 'ModelError';
}

export function createAnthropicClient(apiKey: string): Anthropic {
  // dangerouslyAllowBrowser sends the anthropic-dangerous-direct-browser-access
  // header, which the API requires for calls from a browser context.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

function userMessage(err: unknown): string {
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

// Tool definitions are part of the cached prefix: build them once per tool
// list so the bytes are identical on every request.
const apiToolsCache = new WeakMap<readonly Tool[], Anthropic.Tool[]>();

function apiTools(tools: readonly Tool[]): Anthropic.Tool[] {
  let cached = apiToolsCache.get(tools);
  if (!cached) {
    cached = tools.map((tool) => {
      const schema = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
      delete schema.$schema;
      return {
        name: tool.name,
        description: tool.description,
        input_schema: schema as Anthropic.Tool.InputSchema,
        // Stream tool input as it is generated so the UI can show it live.
        // The API then skips validation; the runtime validates every input.
        eager_input_streaming: true,
      };
    });
    apiToolsCache.set(tools, cached);
  }
  return cached;
}

function toUsage(usage: Anthropic.Usage): Usage {
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const writeTotal = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    thinkingTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? writeTotal - write1h,
    cacheWrite1hTokens: write1h,
  };
}

function buildParams(request: ModelRequest): Anthropic.MessageStreamParams {
  const { config } = request;
  const last = request.system.length - 1;
  return {
    model: config.model,
    max_tokens: config.max_tokens,
    // Cache order is tools -> system -> messages. The breakpoint on the last
    // system block caches tools and system together; neither changes per request.
    tools: apiTools(request.tools),
    system: request.system.map((text, i) => ({
      type: 'text' as const,
      text,
      ...(i === last ? { cache_control: { type: 'ephemeral' as const, ...(config.cache_ttl === '1h' ? { ttl: '1h' as const } : {}) } } : {}),
    })),
    // Automatic caching of the growing tail, so later turns re-read the task
    // (the browser snapshot) from cache. It stays at the default 5m TTL, which
    // is allowed after a 1h system breakpoint (longer TTLs must come first).
    cache_control: { type: 'ephemeral' },
    thinking: { type: 'adaptive', display: config.thinking_display },
    output_config: { effort: config.effort },
    ...(request.toolChoice === 'none' ? { tool_choice: { type: 'none' as const } } : {}),
    messages: [...request.messages],
  };
}

export class AnthropicModel implements Model {
  constructor(private readonly client: Anthropic) {}

  async *respond(request: ModelRequest): AsyncGenerator<ModelEvent | ModelResponse> {
    const params = buildParams(request);
    for (let attempt = 0; ; attempt++) {
      try {
        const message = yield* this.streamOnce(params, request.signal);
        yield { type: 'response', message, usage: toUsage(message.usage) };
        return;
      } catch (err) {
        if (request.signal.aborted) throw err;
        if (err instanceof Anthropic.APIError) throw new ModelError(userMessage(err), { cause: err });
        // Not an API error: the SDK could not parse a streamed tool input.
        if (attempt >= MAX_MALFORMED_INPUT_RETRIES) throw new ModelError(`The model kept sending malformed tool input: ${userMessage(err)}`, { cause: err });
        console.warn('[hermod] malformed tool input, re-sending the response', err);
        yield { type: 'response-discarded', reason: 'Malformed tool input from the model; retrying.' };
      }
    }
  }

  private async *streamOnce(params: Anthropic.MessageStreamParams, signal: AbortSignal): AsyncGenerator<ModelEvent, Anthropic.Message> {
    const stream = this.client.messages.stream(params, { signal });
    const toolInputs = new Map<number, { callId: string; json: string }>();
    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block;
          if (block.type === 'thinking') yield { type: 'reasoning-started', block: event.index };
          else if (block.type === 'text') yield { type: 'text-started', block: event.index };
          else if (block.type === 'tool_use') {
            toolInputs.set(event.index, { callId: block.id, json: '' });
            yield { type: 'tool-input-started', block: event.index, callId: block.id, name: block.name };
          }
          break;
        }
        case 'content_block_delta': {
          const d = event.delta;
          if (d.type === 'thinking_delta') yield { type: 'delta', block: event.index, text: d.thinking };
          else if (d.type === 'text_delta') yield { type: 'delta', block: event.index, text: d.text };
          else if (d.type === 'input_json_delta') {
            const input = toolInputs.get(event.index);
            if (input) {
              input.json += d.partial_json;
              yield { type: 'tool-input-delta', callId: input.callId, json: input.json };
            }
          }
          break;
        }
        case 'content_block_stop':
          yield { type: 'block-finished', block: event.index };
          break;
      }
    }
    return stream.finalMessage();
  }
}
