import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRunContext, RunCancelled, type ApprovalMode, type Limits } from './context';
import { defineAgent } from './definition';
import { ZERO_USAGE, type ModelEvent, type RunEvent } from './events';
import type { Model, ModelRequest, ModelResponse } from './model';
import { AgentRefused, OutputLimitReached, streamRun } from './runner';
import { defineTool } from './tools';

// ------------------------------------------------------------ fakes

type Block = Anthropic.ContentBlock;

function message(content: Block[], stop: Anthropic.StopReason): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Message;
}

const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as Block;

/** Answers each request with the next scripted message and records what it was sent. */
class ScriptedModel implements Model {
  requests: ModelRequest[] = [];
  constructor(private script: ((req: ModelRequest) => Anthropic.Message)[]) {}

  async *respond(request: ModelRequest): AsyncGenerator<ModelEvent | ModelResponse> {
    this.requests.push({ ...request, messages: structuredClone([...request.messages]) });
    const next = this.script.shift();
    if (!next) throw new Error('script ran out');
    const msg = next(request);
    yield { type: 'text-started', block: 0 };
    yield { type: 'response', message: msg, usage: { ...ZERO_USAGE, inputTokens: 10, outputTokens: 5 } };
  }
}

const moveRun = vi.fn(async ({ ids }: { ids: number[] }) => `moved ${ids.join(',')}`);
const deleteRun = vi.fn(async () => 'deleted');

const move = defineTool({
  name: 'move',
  title: 'Move',
  effect: 'write',
  description: 'Move things.',
  input: z.object({ ids: z.array(z.number()) }),
  run: moveRun,
});

const remove = defineTool({
  name: 'remove',
  title: 'Remove',
  effect: 'destructive',
  description: 'Remove things.',
  input: z.object({ id: z.number() }),
  confirm: ({ id }) => `Remove ${id}?`,
  run: deleteRun,
});

const slow = defineTool({
  name: 'slow',
  title: 'Slow',
  effect: 'read',
  description: 'Never finishes.',
  input: z.object({}),
  timeoutMs: 20,
  run: () => new Promise<string>(() => {}),
});

const agent = defineAgent({
  configYaml: 'id: test_agent.v1\nmodel: claude-test\neffort: low\nmax_tokens: 1000',
  system: '# Behavior\n\nBe helpful.',
  instructions: '# Role\n\nTester.\n\n# Objective\n\nTest.',
  task: '# Task\n\n{{ command }}',
  tools: [move, remove, slow],
});

function context(
  options: { approval?: ApprovalMode; confirm?: (q: string) => boolean; limits?: Partial<Limits>; cancel?: AbortController } = {},
) {
  const cancel = options.cancel ?? new AbortController();
  return createRunContext({
    cancel: cancel.signal,
    approval: options.approval ?? 'auto',
    confirm: async (req) => options.confirm?.(req.question) ?? false,
    limits: options.limits,
  });
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

// ------------------------------------------------------------ tests

describe('streamRun', () => {
  it('renders the prompts, runs tool calls, and returns all results in one user message', async () => {
    const model = new ScriptedModel([
      () => message([toolUse('t1', 'move', { ids: [1, 2] }), toolUse('t2', 'move', { ids: 'nope' })], 'tool_use'),
      () => message([text('Moved them.')], 'end_turn'),
    ]);
    const events = await collect(streamRun(agent, context(), { model, variables: { command: 'move 1 and 2' } }));

    const first = model.requests[0]!;
    expect(first.system).toEqual(['# Behavior\n\nBe helpful.', '# Role\n\nTester.\n\n# Objective\n\nTest.']);
    expect(first.messages).toEqual([{ role: 'user', content: '# Task\n\nmove 1 and 2' }]);
    expect(first.config.effort).toBe('low');

    const second = model.requests[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]!.role).toBe('assistant');
    const results = second.messages[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['t1', 't2']);
    expect(results[0]).toMatchObject({ content: 'moved 1,2' });
    expect(results[1]).toMatchObject({ is_error: true });
    expect(String(results[1]!.content)).toMatch(/^invalid_input:/);

    const finished = events.at(-1);
    expect(finished).toMatchObject({ type: 'run-finished', result: { text: 'Moved them.', turns: 2, forcedAnswer: false } });
    expect(finished?.type === 'run-finished' && finished.result.usage.inputTokens).toBe(20);
  });

  it('applies overrides over the config', async () => {
    const model = new ScriptedModel([() => message([text('ok')], 'end_turn')]);
    await collect(streamRun(agent, context(), { model, variables: { command: 'x' }, overrides: { model: 'other', effort: undefined } }));
    expect(model.requests[0]!.config).toMatchObject({ model: 'other', effort: 'low' });
  });

  it('asks before a destructive tool and reports a decline without running it', async () => {
    deleteRun.mockClear();
    const questions: string[] = [];
    const model = new ScriptedModel([
      () => message([toolUse('t1', 'remove', { id: 7 })], 'tool_use'),
      () => message([text('Left it.')], 'end_turn'),
    ]);
    const events = await collect(
      streamRun(agent, context({ confirm: (q) => (questions.push(q), false) }), { model, variables: { command: 'x' } }),
    );
    expect(questions).toEqual(['Remove 7?']);
    expect(deleteRun).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'tool-call-finished')).toMatchObject({ result: { status: 'declined' } });
  });

  it('runs a destructive tool once the user approves', async () => {
    deleteRun.mockClear();
    const model = new ScriptedModel([
      () => message([toolUse('t1', 'remove', { id: 7 })], 'tool_use'),
      () => message([text('Removed.')], 'end_turn'),
    ]);
    await collect(streamRun(agent, context({ confirm: () => true }), { model, variables: { command: 'x' } }));
    expect(deleteRun).toHaveBeenCalledOnce();
  });

  it('asks before every change in ask mode, and never in never mode', async () => {
    const script = () =>
      new ScriptedModel([
        () => message([toolUse('t1', 'move', { ids: [1] }), toolUse('t2', 'remove', { id: 7 })], 'tool_use'),
        () => message([text('Done.')], 'end_turn'),
      ]);

    const asked: string[] = [];
    await collect(streamRun(agent, context({ approval: 'ask', confirm: (q) => (asked.push(q), true) }), { model: script(), variables: { command: 'x' } }));
    expect(asked).toEqual(['Move?', 'Remove 7?']);

    deleteRun.mockClear();
    const neverAsked: string[] = [];
    await collect(streamRun(agent, context({ approval: 'never', confirm: (q) => (neverAsked.push(q), false) }), { model: script(), variables: { command: 'x' } }));
    expect(neverAsked).toEqual([]);
    expect(deleteRun).toHaveBeenCalledOnce();
  });

  it('turns a tool timeout into an error result', async () => {
    const model = new ScriptedModel([
      () => message([toolUse('t1', 'slow', {})], 'tool_use'),
      () => message([text('It timed out.')], 'end_turn'),
    ]);
    const events = await collect(streamRun(agent, context(), { model, variables: { command: 'x' } }));
    expect(events.find((e) => e.type === 'tool-call-finished')).toMatchObject({ result: { status: 'error', errorType: 'timeout' } });
  });

  it('forces a final answer without tools once turns run out', async () => {
    const model = new ScriptedModel([
      () => message([toolUse('t1', 'move', { ids: [1] })], 'tool_use'),
      () => message([toolUse('t2', 'move', { ids: [2] })], 'tool_use'),
      () => message([text('Did two moves.')], 'end_turn'),
    ]);
    const events = await collect(streamRun(agent, context({ limits: { maxTurns: 2 } }), { model, variables: { command: 'x' } }));
    expect(model.requests.map((r) => r.toolChoice)).toEqual([undefined, undefined, 'none']);
    expect(events.at(-1)).toMatchObject({ type: 'run-finished', result: { forcedAnswer: true, turns: 3 } });
  });

  it('throws on a refusal and on a truncated response, running no tools', async () => {
    moveRun.mockClear();
    const refused = new ScriptedModel([() => message([], 'refusal')]);
    await expect(collect(streamRun(agent, context(), { model: refused, variables: { command: 'x' } }))).rejects.toBeInstanceOf(AgentRefused);

    const truncated = new ScriptedModel([() => message([toolUse('t1', 'move', { ids: [1] })], 'max_tokens')]);
    await expect(collect(streamRun(agent, context(), { model: truncated, variables: { command: 'x' } }))).rejects.toBeInstanceOf(OutputLimitReached);
    expect(moveRun).not.toHaveBeenCalled();
  });

  it('stops with RunCancelled when cancelled', async () => {
    const cancel = new AbortController();
    const model = new ScriptedModel([
      () => {
        cancel.abort();
        return message([toolUse('t1', 'move', { ids: [1] })], 'tool_use');
      },
    ]);
    await expect(collect(streamRun(agent, context({ cancel }), { model, variables: { command: 'x' } }))).rejects.toBeInstanceOf(RunCancelled);
  });

  it('fails the render when task.md names a variable that was not given', async () => {
    const model = new ScriptedModel([]);
    await expect(collect(streamRun(agent, context(), { model, variables: {} }))).rejects.toThrow('{{ command }}');
  });
});

describe('defineAgent', () => {
  const base = { configYaml: 'id: a.v1\nmodel: m', system: '# Behavior', instructions: '# Role', task: '# Task' };

  it('rejects an unknown config key', () => {
    expect(() => defineAgent({ ...base, configYaml: 'id: a.v1\nmodel: m\ntemperature: 1' })).toThrow(/temperature/);
  });

  it('rejects template variables in the cached prompts', () => {
    expect(() => defineAgent({ ...base, system: '# Behavior\n{{ now }}' })).toThrow(/system\.md/);
  });

  it('rejects duplicate tool names', () => {
    expect(() => defineAgent({ ...base, tools: [move, move] })).toThrow(/twice/);
  });
});
