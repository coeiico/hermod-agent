// Carries out one typed command in the browser. The caller builds the
// snapshot (so it can show it) and passes it in with the command and the
// earlier turns of the thread.
import type { RunContext } from '@/ai/runtime/context';
import { defineAgent, type ConfigOverrides } from '@/ai/runtime/definition';
import type { Model } from '@/ai/runtime/model';
import { streamRun } from '@/ai/runtime/runner';
import { BROWSER_TOOLS } from '@/ai/tools/catalog';
import configYaml from './config.yaml?raw';
import { DELEGATION_TOOLS } from './delegation';
import instructions from './instructions.md?raw';
import system from './system.md?raw';
import task from './task.md?raw';

// The delegation tools come after the browser tools, so the cached prefix only grows at its end.
export const browserCommandAgent = defineAgent({ configYaml, system, instructions, task, tools: [...BROWSER_TOOLS, ...DELEGATION_TOOLS] });

/** How many earlier turns the model sees; older ones stay visible in the UI only. */
export const MAX_EARLIER_TURNS = 10;
// Long tool results (page text, history searches) are trimmed so a thread's
// history stays small next to the snapshot.
const MAX_RESULT_CHARS = 1_500;
const MAX_ANSWER_CHARS = 2_000;

/** One earlier command in the thread, as the model is told about it. */
export interface EarlierTurn {
  command: string;
  /** Carried on the command before it, which was stopped, interrupted or failed. */
  resumed?: boolean;
  startedAt: number;
  status: 'done' | 'error' | 'stopped' | 'interrupted';
  actions: {
    tool: string;
    input: unknown;
    outcome: 'ok' | 'error' | 'declined' | 'not run';
    /** The tool's result or error text. */
    result?: string;
  }[];
  /** What the user sent while the command ran, oldest first. */
  steering?: string[];
  answer?: string;
  error?: string;
}

export interface BrowserCommandInput {
  /** The snapshot text from buildSnapshot(). */
  snapshot: string;
  command: string;
  /** Carry on the thread's last command (the same text) instead of starting it fresh. */
  resumed: boolean;
  /** Earlier turns of the thread, oldest first. */
  earlierTurns: readonly EarlierTurn[];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

/** The command as the model reads it; instructions.md says what "Resume:" means. */
function commandLine(command: string, resumed: boolean | undefined): string {
  return resumed ? `Resume: ${command.trim()}` : command.trim();
}

function time(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The thread's earlier turns as the text task.md shows under <earlier_in_thread>. */
export function formatEarlierTurns(turns: readonly EarlierTurn[]): string {
  if (!turns.length) return 'None. This is the first command in this thread.';
  const shown = turns.slice(-MAX_EARLIER_TURNS);
  const skipped = turns.length - shown.length;
  const blocks = shown.map((turn, i) => {
    const lines = [`<turn number="${skipped + i + 1}" time="${time(turn.startedAt)}">`, `<command>${commandLine(turn.command, turn.resumed)}</command>`];
    for (const message of turn.steering ?? []) lines.push(`<steering>${message}</steering>`);
    if (turn.actions.length) {
      lines.push('<actions>');
      for (const action of turn.actions) {
        const result = action.result ? `: ${clip(action.result.replace(/\s+\n/g, '\n'), MAX_RESULT_CHARS)}` : '';
        lines.push(`- ${action.tool} ${JSON.stringify(action.input ?? {})} → ${action.outcome}${result}`);
      }
      lines.push('</actions>');
    }
    if (turn.answer) lines.push(`<answer>${clip(turn.answer, MAX_ANSWER_CHARS)}</answer>`);
    if (turn.status !== 'done') lines.push(`<ended>${turn.status}${turn.error ? `: ${turn.error}` : ''}</ended>`);
    lines.push('</turn>');
    return lines.join('\n');
  });
  if (skipped) blocks.unshift(`(${skipped} earlier command${skipped === 1 ? '' : 's'} not shown)`);
  return blocks.join('\n\n');
}

export function streamBrowserCommand(
  ctx: RunContext,
  input: BrowserCommandInput,
  options: { model: Model; overrides?: ConfigOverrides },
) {
  return streamRun(browserCommandAgent, ctx, {
    model: options.model,
    overrides: options.overrides,
    variables: {
      thread_history: formatEarlierTurns(input.earlierTurns),
      snapshot: input.snapshot,
      command: commandLine(input.command, input.resumed),
    },
  });
}
