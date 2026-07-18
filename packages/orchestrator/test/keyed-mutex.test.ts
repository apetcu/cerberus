import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../src/lifecycle/keyed-mutex.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializes work on the same key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      mutex.run('a', async () => { order.push('start1'); await sleep(20); order.push('end1'); }),
      mutex.run('a', async () => { order.push('start2'); order.push('end2'); }),
    ]);
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      mutex.run('a', async () => { order.push('a-start'); await sleep(30); order.push('a-end'); }),
      mutex.run('b', async () => { await sleep(5); order.push('b-done'); }),
    ]);
    expect(order).toEqual(['a-start', 'b-done', 'a-end']);
  });

  it('releases the lock after a rejection', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await mutex.run('a', async () => 42)).toBe(42);
  });
});
