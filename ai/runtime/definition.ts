// What an agent is, as opposed to how one run of it goes: its config, prompts
// and tools.
import { parse } from 'yaml';
import { z } from 'zod';
import type { Tool } from './tools';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const CACHE_TTLS = ['5m', '1h'] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

/**
 * An agent's `config.yaml`. A key it does not know is an error, not ignored.
 * `agents/_template/config.yaml` documents every option.
 */
export const AgentConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z_]*\.v\d+$/, 'id is the agent name with a version suffix, like browser_command.v1'),
  model: z.string().min(1),
  effort: z.enum(EFFORTS).default('medium'),
  thinking_display: z.enum(['summarized', 'omitted']).default('summarized'),
  max_tokens: z.number().int().positive().default(16_000),
  cache_ttl: z.enum(CACHE_TTLS).default('5m'),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** Run-time choices that replace config values for one run, such as the model the user picked. */
export type ConfigOverrides = Partial<Pick<AgentConfig, 'model' | 'effort' | 'cache_ttl'>>;

export interface AgentDefinition {
  config: AgentConfig;
  /** `system.md`: behaviour that holds whatever the task. */
  system: string;
  /** `instructions.md`: the role, objective and examples. */
  instructions: string;
  /** `task.md`: the template for the opening user message. */
  task: string;
  tools: readonly Tool[];
}

export interface AgentSource {
  configYaml: string;
  system: string;
  instructions: string;
  task: string;
  tools?: readonly Tool[];
}

export function parseConfig(configYaml: string): AgentConfig {
  const result = AgentConfigSchema.safeParse(parse(configYaml));
  if (!result.success) throw new Error(`Invalid agent config.yaml:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export function defineAgent(source: AgentSource): AgentDefinition {
  const config = parseConfig(source.configYaml);
  // system.md and instructions.md sit in the cached prompt prefix, so they are
  // never templated: anything that varies per request belongs in task.md.
  for (const [file, text] of [['system.md', source.system], ['instructions.md', source.instructions]] as const) {
    if (text.includes('{{')) throw new Error(`${config.id}: ${file} must not contain template variables; put them in task.md.`);
  }
  const tools = source.tools ?? [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`${config.id}: tool "${tool.name}" is listed twice.`);
    seen.add(tool.name);
  }
  return { config, system: source.system.trim(), instructions: source.instructions.trim(), task: source.task, tools };
}
