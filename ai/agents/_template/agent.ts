// A starting point for a new agent: copy this directory to
// ai/agents/<role>/<name>/ and fill in the prompts and config.
import type { RunContext } from '@/ai/runtime/context';
import { defineAgent } from '@/ai/runtime/definition';
import type { Model } from '@/ai/runtime/model';
import { streamRun } from '@/ai/runtime/runner';
import configYaml from './config.yaml?raw';
import instructions from './instructions.md?raw';
import system from './system.md?raw';
import task from './task.md?raw';

export const templateAgent = defineAgent({
  configYaml,
  system,
  instructions,
  task,
  // The tools the model may call, imported from ai/tools, e.g.
  // `tools: [searchHistory]`. Leave it out for an agent that calls none.
  tools: [],
});

/** Shapes the agent's inputs into task.md's variables. Every variable task.md names must be passed. */
export function streamTemplate(ctx: RunContext, input: { someInput: string }, options: { model: Model }) {
  return streamRun(templateAgent, ctx, { model: options.model, variables: { some_input: input.someInput } });
}
