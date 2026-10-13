// What the runner needs from a model provider, and nothing it does not.
// Messages use the Anthropic shape: it is the only provider, and translating
// to a neutral shape would buy nothing but code.
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from './definition';
import type { ModelEvent, Usage } from './events';
import type { Tool } from './tools';

export interface ModelRequest {
  /** The agent's config with this run's overrides applied. */
  config: AgentConfig;
  /** Cached prefix blocks, in order: system.md, then instructions.md. */
  system: readonly string[];
  /** The run so far: the task, then each response followed by its tool results. */
  messages: readonly Anthropic.MessageParam[];
  tools: readonly Tool[];
  /** `none` forbids tool calls, to force an answer from what the run already has. */
  toolChoice?: 'none';
  signal: AbortSignal;
}

export interface ModelResponse {
  type: 'response';
  message: Anthropic.Message;
  usage: Usage;
}

export interface Model {
  /**
   * The model's next response: events as it forms, then the ModelResponse
   * itself, last. Throws when the provider does not complete the response.
   */
  respond(request: ModelRequest): AsyncIterable<ModelEvent | ModelResponse>;
}
