import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeInbound, mailboxKey } from '@cerberus/protocol';
import {
  MailboxProducer, RedisDedupStore, RedisDeliveryGuard, type StreamsClient,
} from '../src/mailbox/redis-stores.js';

let container: StartedTestContainer;
let redis: Redis;

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new Redis(container.getMappedPort(6379), container.getHost());
});
afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

describe('MailboxProducer', () => {
  it('publishes payload to the thread mailbox', async () => {
    const producer = new MailboxProducer(redis as unknown as StreamsClient);
    await producer.publish({ id: 'i1', threadKey: 'T1-C1-1.2', kind: 'user_message', text: 'hi', ts: '1.3' });
    const entries = await redis.xrange(mailboxKey('T1-C1-1.2'), '-', '+');
    expect(entries).toHaveLength(1);
    expect(decodeInbound(entries[0]![1]).text).toBe('hi');
  });

  it('publishControl publishes a control envelope', async () => {
    const producer = new MailboxProducer(redis as unknown as StreamsClient);
    await producer.publishControl('T1-C1-9.9', 'shutdown');
    const entries = await redis.xrange(mailboxKey('T1-C1-9.9'), '-', '+');
    expect(decodeInbound(entries[0]![1])).toMatchObject({ kind: 'control', control: 'shutdown' });
  });
});

describe('dedup + delivery guard', () => {
  it('markSeen: first true, second false', async () => {
    const dedup = new RedisDedupStore(redis as unknown as StreamsClient);
    expect(await dedup.markSeen('EV1')).toBe(true);
    expect(await dedup.markSeen('EV1')).toBe(false);
  });

  it('claim: first true, second false', async () => {
    const guard = new RedisDeliveryGuard(redis as unknown as StreamsClient);
    expect(await guard.claim('OUT1')).toBe(true);
    expect(await guard.claim('OUT1')).toBe(false);
  });

  it('release makes an id claimable again', async () => {
    const guard = new RedisDeliveryGuard(redis as unknown as StreamsClient);
    expect(await guard.claim('OUT2')).toBe(true);
    await guard.release('OUT2');
    expect(await guard.claim('OUT2')).toBe(true);
  });
});
