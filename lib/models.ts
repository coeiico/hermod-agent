export type Effort = 'low' | 'medium' | 'high';
export type CacheTtl = '5m' | '1h';

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  /** USD per million tokens. */
  price: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
  };
}

// Prices are Anthropic first-party API rates. Haiku 5.5 bills a higher rate
// card above 100K prompt tokens; a browser snapshot never gets near that, so
// only the standard card is listed.
export const MODELS: ModelInfo[] = [
  {
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    description: 'Fast and cheap. Handles clear commands.',
    contextWindow: 1_000_000,
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    description: 'Smarter, a little slower. For fuzzy or multi-step requests.',
    contextWindow: 1_000_000,
    price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  },
];

export const DEFAULT_MODEL = 'claude-haiku-5-5';

export function getModel(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!;
}

export const EFFORT_OPTIONS: { value: Effort; label: string; description: string }[] = [
  { value: 'low', label: 'Low', description: 'Fastest. Thinks only when it has to.' },
  { value: 'medium', label: 'Medium', description: 'Thinks a little more before acting.' },
  { value: 'high', label: 'High', description: 'Most careful, slowest.' },
];
