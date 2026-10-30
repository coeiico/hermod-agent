// Guesses the user's next command after one finishes, for the prompt's hint:
// the popup shows it greyed out and Tab fills it in. The worker runs it in the
// background after each finished command; it has no tools.
import { formatEarlierTurns, type EarlierTurn } from '@/ai/agents/interactive/browser_command/agent';
import type { RunContext } from '@/ai/runtime/context';
import { defineAgent } from '@/ai/runtime/definition';
import type { Model } from '@/ai/runtime/model';
import { streamRun } from '@/ai/runtime/runner';
import configYaml from './config.yaml?raw';
import instructions from './instructions.md?raw';
import system from './system.md?raw';
import task from './task.md?raw';

export const nextCommandAgent = defineAgent({ configYaml, system, instructions, task });

// Longer than this is an explanation, not a command.
const MAX_COMMAND_CHARS = 120;

export interface NextCommandInput {
  /** The snapshot text from buildSnapshot(), taken after the last command. */
  snapshot: string;
  /** The thread's finished commands, oldest first. */
  earlierTurns: readonly EarlierTurn[];
}

export function streamNextCommand(ctx: RunContext, input: NextCommandInput, options: { model: Model }) {
  return streamRun(nextCommandAgent, ctx, {
    model: options.model,
    variables: { thread_history: formatEarlierTurns(input.earlierTurns), snapshot: input.snapshot },
  });
}

/** The command in the model's reply, or undefined for `NONE` or anything that isn't one short line. */
export function parseNextCommand(reply: string): string | undefined {
  const line = reply.trim().split('\n')[0]?.trim().replace(/^["'`“]+|["'`”]+$/g, '').trim() ?? '';
  if (!line || /^none\.?$/i.test(line) || line.length > MAX_COMMAND_CHARS) return undefined;
  return line;
}
