// Every agent directory must load, follow the prompt structure, and render.
import { describe, expect, it } from 'vitest';
import { AgentConfigSchema, parseConfig } from '../runtime/definition';
import { renderTemplate } from '../runtime/prompts';
import { BROWSER_TOOLS } from '../tools/catalog';
import { browserCommandAgent, formatEarlierTurns, MAX_EARLIER_TURNS, type EarlierTurn } from './interactive/browser_command/agent';

const raw = (pattern: Record<string, unknown>) => pattern as Record<string, string>;
const configs = raw(import.meta.glob('./**/config.yaml', { query: '?raw', import: 'default', eager: true }));
const systems = raw(import.meta.glob('./**/system.md', { query: '?raw', import: 'default', eager: true }));
const instructions = raw(import.meta.glob('./**/instructions.md', { query: '?raw', import: 'default', eager: true }));
const tasks = raw(import.meta.glob('./**/task.md', { query: '?raw', import: 'default', eager: true }));
const dirs = Object.keys(configs).map((path) => path.replace(/\/config\.yaml$/, ''));

function headings(markdown: string): string[] {
  return markdown.split('\n').filter((line) => /^# /.test(line)).map((line) => line.trim());
}

describe.each(dirs)('%s', (dir) => {
  it('has a valid config.yaml', () => {
    expect(() => parseConfig(configs[`${dir}/config.yaml`]!)).not.toThrow();
  });

  it('has the required prompt files and headings', () => {
    expect(headings(systems[`${dir}/system.md`] ?? '')).toContain('# Behavior');
    expect(headings(instructions[`${dir}/instructions.md`] ?? '')).toEqual(expect.arrayContaining(['# Role', '# Objective']));
    expect(headings(tasks[`${dir}/task.md`] ?? '')).toContain('# Task');
  });
});

describe('_template/config.yaml', () => {
  it('documents every config option', () => {
    const template = configs['./_template/config.yaml']!;
    for (const key of Object.keys(AgentConfigSchema.shape)) {
      expect(template, `option "${key}" is missing from _template/config.yaml`).toMatch(new RegExp(`^${key}:`, 'm'));
    }
  });
});

describe('browser_command', () => {
  it('renders its task with the thread, snapshot and command', () => {
    const rendered = renderTemplate(
      browserCommandAgent.task,
      { thread_history: formatEarlierTurns([]), snapshot: 'W1 focused', command: 'close it' },
      'task.md',
    );
    expect(rendered).toContain('<earlier_in_thread>\nNone. This is the first command in this thread.\n</earlier_in_thread>');
    expect(rendered).toContain('<browser_snapshot>\nW1 focused\n</browser_snapshot>');
    expect(rendered).toContain('<command>\nclose it\n</command>');
  });

  it('formats earlier turns, keeping only the most recent ones and trimming long results', () => {
    const turn = (n: number): EarlierTurn => ({
      command: `command ${n}`,
      startedAt: Date.UTC(2026, 9, 13, 9, n),
      status: n === 12 ? 'stopped' : 'done',
      actions: [{ tool: 'get_page_text', input: { tabId: n }, outcome: 'ok', result: 'x'.repeat(5_000) }],
      answer: `answer ${n}`,
    });
    const text = formatEarlierTurns(Array.from({ length: 12 }, (_, i) => turn(i + 1)));
    expect(text).toMatch(/^\(2 earlier commands not shown\)/);
    expect(text.match(/<turn /g)).toHaveLength(MAX_EARLIER_TURNS);
    expect(text).not.toContain('<command>command 2</command>');
    expect(text).toContain('<turn number="3"');
    expect(text).toContain('- get_page_text {"tabId":12} → ok: ');
    expect(text).toContain('(3500 more characters)');
    expect(text).toContain('<answer>answer 12</answer>\n<ended>stopped</ended>');
  });

  it('uses the full browser tool catalog with unique names', () => {
    expect(browserCommandAgent.tools).toBe(BROWSER_TOOLS);
    expect(new Set(BROWSER_TOOLS.map((t) => t.name)).size).toBe(BROWSER_TOOLS.length);
  });

  it('asks before every destructive tool', () => {
    for (const tool of BROWSER_TOOLS.filter((t) => t.effect === 'destructive')) expect(tool.confirm, tool.name).toBeTypeOf('function');
  });
});
