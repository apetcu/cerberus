import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { encodePayload, OUTBOX_STREAM, type AgentOutbound } from '@cerberus/protocol';
import { OutboxConsumer, type SlackPoster } from '../src/mailbox/outbox-consumer.js';
import type { DeliveryGuard, StreamsClient } from '../src/mailbox/redis-stores.js';
import { EventBus } from '../src/api/events.js';

const log = pino({ level: 'silent' });

const out = (id: string): AgentOutbound => ({
  id, inReplyTo: 'in', threadKey: 'T1-C1-1.2', kind: 'message', text: `t-${id}`, final: true,
});

function fakes(claimResult = true) {
  const acked: string[] = [];
  const redis = {
    xgroup: vi.fn(async () => 'OK'),
    xreadgroup: vi.fn(async () => null),
    xadd: vi.fn(async () => '1-0'),
    xack: vi.fn(async (_k: string, _g: string, id: string) => { acked.push(id); return 1; }),
    xautoclaim: vi.fn(async () => ['0-0', [], []]),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    xlen: vi.fn(async () => 0),
    exists: vi.fn(async () => 0),
  } satisfies StreamsClient & Record<string, unknown>;
  const posted: string[] = [];
  const poster: SlackPoster = { postToThread: vi.fn(async (_k, text) => { posted.push(text); }) };
  const guard: DeliveryGuard = { claim: vi.fn(async () => claimResult), release: vi.fn(async () => {}) };
  return { redis, poster, guard, acked, posted };
}

describe('OutboxConsumer.handleEntry', () => {
  it('posts and acks a fresh outbound', async () => {
    const { redis, poster, guard, acked, posted } = fakes(true);
    const c = new OutboxConsumer(redis, poster, guard, log);
    await c.handleEntry('5-0', encodePayload(out('a')));
    expect(posted).toEqual(['t-a']);
    expect(acked).toEqual(['5-0']);
  });

  it('acks without posting when delivery already claimed', async () => {
    const { redis, poster, guard, acked, posted } = fakes(false);
    const c = new OutboxConsumer(redis, poster, guard, log);
    await c.handleEntry('5-0', encodePayload(out('a')));
    expect(posted).toEqual([]);
    expect(acked).toEqual(['5-0']);
  });

  it('leaves entry unacked when poster throws', async () => {
    const { redis, guard, acked } = fakes(true);
    const poster: SlackPoster = { postToThread: async () => { throw new Error('slack down'); } };
    const c = new OutboxConsumer(redis, poster, guard, log);
    await c.handleEntry('5-0', encodePayload(out('a')));
    expect(acked).toEqual([]);
  });

  it('releases the claim when poster throws', async () => {
    const { redis, guard, acked } = fakes(true);
    const poster: SlackPoster = { postToThread: async () => { throw new Error('slack down'); } };
    const c = new OutboxConsumer(redis, poster, guard, log);
    await c.handleEntry('5-0', encodePayload(out('a')));
    expect(guard.release).toHaveBeenCalledWith('a');
    expect(acked).toEqual([]);
  });

  it('acks and drops malformed payloads', async () => {
    const { redis, poster, guard, acked, posted } = fakes(true);
    const c = new OutboxConsumer(redis, poster, guard, log);
    await c.handleEntry('6-0', ['payload', '{bad']);
    expect(posted).toEqual([]);
    expect(acked).toEqual(['6-0']);
  });

  it('publishes reply_posted after a successful post', async () => {
    const { redis, poster, guard } = fakes(true);
    const events = new EventBus();
    const seen: string[] = [];
    events.onEvent((e) => seen.push(e.kind));
    const c = new OutboxConsumer(redis, poster, guard, log, events);
    await c.handleEntry('5-0', encodePayload(out('a')));
    expect(seen).toEqual(['reply_posted']);
  });

  it('does not publish reply_posted when the post fails', async () => {
    const { redis, guard } = fakes(true);
    const poster: SlackPoster = { postToThread: async () => { throw new Error('slack down'); } };
    const events = new EventBus();
    const seen: string[] = [];
    events.onEvent((e) => seen.push(e.kind));
    const c = new OutboxConsumer(redis, poster, guard, log, events);
    await c.handleEntry('5-0', encodePayload(out('a')));
    expect(seen).toEqual([]);
  });
});

describe('OutboxConsumer.runOnce', () => {
  it('processes a batch from the stream', async () => {
    const { redis, poster, guard, posted } = fakes(true);
    (redis.xreadgroup as any).mockResolvedValueOnce([[OUTBOX_STREAM, [
      ['1-0', encodePayload(out('a'))],
      ['2-0', encodePayload(out('b'))],
    ]]]);
    const c = new OutboxConsumer(redis, poster, guard, log);
    expect(await c.runOnce(1)).toBe(2);
    expect(posted).toEqual(['t-a', 't-b']);
  });
});
