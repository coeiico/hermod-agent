import { describe, expect, it } from 'vitest';
import { CommandQueue } from './command-queue';

describe('CommandQueue', () => {
  it('starts the oldest head of each idle thread, up to the free slots', () => {
    const queue = new CommandQueue();
    const a1 = queue.add('a', 'first in a');
    queue.add('a', 'second in a');
    const b1 = queue.add('b', 'first in b');
    queue.add('c', 'first in c');

    const started = queue.takeStartable((t) => t === 'c', 5);
    expect(started.map((s) => s.command.id)).toEqual([a1.id, b1.id]);
    expect(queue.list('a').map((c) => c.text)).toEqual(['second in a']);
    expect(queue.list('c')).toHaveLength(1);
    expect(queue.takeStartable(() => false, 1).map((s) => s.command.text)).toEqual(['second in a']);
  });

  it('puts a late steer first, and holds paused commands until unpaused', () => {
    const queue = new CommandQueue();
    queue.add('a', 'next');
    queue.add('a', 'late steer', { front: true });
    queue.pauseAll();
    expect(queue.takeStartable(() => false, 3)).toEqual([]);

    const [head] = queue.list('a');
    queue.unpause('a', head!.id);
    expect(queue.takeStartable(() => false, 3).map((s) => s.command.text)).toEqual(['late steer']);
  });

  it('removes one command and survives a round trip through JSON', () => {
    const queue = new CommandQueue();
    const one = queue.add('a', 'one');
    queue.add('a', 'two');
    expect(queue.remove('a', one.id)?.text).toBe('one');
    expect(queue.remove('a', 'missing')).toBeUndefined();
    const restored = new CommandQueue(JSON.parse(JSON.stringify(queue.toJSON())));
    expect(restored.list('a').map((c) => c.text)).toEqual(['two']);
  });
});
