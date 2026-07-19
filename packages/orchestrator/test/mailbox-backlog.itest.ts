import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MAILBOX_GROUP, mailboxKey } from '@cerberus/protocol';
import { MailboxBacklog, MailboxProducer, type StreamsClient } from '../src/mailbox/redis-stores.js';
import { MailboxSweeper } from '../src/lifecycle/sweeper.js';
import { DrainState } from '../src/lifecycle/drain.js';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import type { EnsureOutcome } from '../src/lifecycle/supervisor.js';

let container: StartedTestContainer;
let redis: Redis;
let producer: MailboxProducer;
let backlog: MailboxBacklog;

const log = pino({ level: 'silent' });
const CONSUMER = 'main'; // same consumer name the agent uses

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new Redis(container.getMappedPort(6379), container.getHost());
  producer = new MailboxProducer(redis as unknown as StreamsClient);
  backlog = new MailboxBacklog(redis as unknown as StreamsClient);
});
afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

let seq = 0;
const nextThread = () => `T1-C1-${(seq += 1)}.0`;

async function publishUser(threadKey: string, text: string): Promise<void> {
  await producer.publish({
    id: `m${(seq += 1)}`, threadKey, kind: 'user_message', text,
    user: { id: 'U1', display: 'adrian' }, ts: `${Date.now()}`,
  });
}

/** Mirrors MailboxConsumer.ensureGroup: the group the real agent reads through. */
async function createGroup(threadKey: string): Promise<void> {
  await redis.xgroup('CREATE', mailboxKey(threadKey), MAILBOX_GROUP, '0', 'MKSTREAM')
    .catch((err) => { if (!String(err).includes('BUSYGROUP')) throw err; });
}

/** Delivers up to `count` new entries to the agent group, exactly as the agent does. */
async function deliver(threadKey: string, count: number): Promise<string[]> {
  const res = await redis.xreadgroup(
    'GROUP', MAILBOX_GROUP, CONSUMER, 'COUNT', count, 'STREAMS', mailboxKey(threadKey), '>',
  ) as [string, [string, string[]][]][] | null;
  return (res?.[0]?.[1] ?? []).map(([id]) => id);
}

async function ack(threadKey: string, ids: string[]): Promise<void> {
  for (const id of ids) await redis.xack(mailboxKey(threadKey), MAILBOX_GROUP, id);
}

function makeSweeper(registry: MemoryThreadRegistry) {
  const ensureRunning = vi.fn(async ({ threadKey }: { threadKey: string }) => ({
    record: (await registry.get(threadKey))!, outcome: 'spawned' as EnsureOutcome,
  }));
  const sweeper = new MailboxSweeper({
    registry, mailbox: backlog, supervisor: { ensureRunning }, drain: new DrainState(), log,
  });
  return { sweeper, ensureRunning };
}

async function seedStopped(registry: MemoryThreadRegistry, threadKey: string): Promise<void> {
  await registry.upsertActivity({
    threadKey, teamId: 'T1', channelId: 'C1', threadTs: threadKey.split('-')[2]!,
    runtime: 'docker', workspacePath: `/w/${threadKey}`,
  });
  await registry.setStatus(threadKey, 'stopped');
}

describe('MailboxBacklog.hasUserWork', () => {
  it('is false for a thread whose messages were all consumed and acked, even after a reap parked a shutdown control', async () => {
    const threadKey = nextThread();
    await createGroup(threadKey);
    await publishUser(threadKey, 'hello');
    await publishUser(threadKey, 'are you there?');
    const ids = await deliver(threadKey, 10);
    expect(ids).toHaveLength(2);
    await ack(threadKey, ids);

    // The idle reaper publishes shutdown into the same stream on every reap. The
    // container is already gone, so nothing ever consumes it.
    await producer.publishControl(threadKey, 'shutdown');

    // The stream retains all three entries: XLEN is why the old rule made zombies.
    expect(await redis.xlen(mailboxKey(threadKey))).toBe(3);
    expect(await backlog.hasUserWork(threadKey)).toBe(false);
  });

  it('is true for a thread with a genuinely unread user message', async () => {
    const threadKey = nextThread();
    await createGroup(threadKey);
    await publishUser(threadKey, 'first');
    const ids = await deliver(threadKey, 10);
    await ack(threadKey, ids);
    await publishUser(threadKey, 'second, never delivered');

    expect(await backlog.hasUserWork(threadKey)).toBe(true);
  });

  it('is true when no group exists yet but a user message waits (spawn failed before the agent booted)', async () => {
    const threadKey = nextThread();
    await publishUser(threadKey, 'hello?');

    expect(await backlog.hasUserWork(threadKey)).toBe(true);
  });

  it('is true for a delivered-but-unacked user message (agent crashed mid-turn)', async () => {
    const threadKey = nextThread();
    await createGroup(threadKey);
    await publishUser(threadKey, 'crash on this');
    const ids = await deliver(threadKey, 10);
    expect(ids).toHaveLength(1);
    // No ack: the entry sits in the pending entries list and must be retried.

    expect(await backlog.hasUserWork(threadKey)).toBe(true);
  });

  it('is false when the only delivered-but-unacked entry is a control', async () => {
    const threadKey = nextThread();
    await createGroup(threadKey);
    await publishUser(threadKey, 'hi');
    await ack(threadKey, await deliver(threadKey, 10));
    // Agent read the reaper's shutdown but died before acking it: still not user work.
    await producer.publishControl(threadKey, 'shutdown');
    const ids = await deliver(threadKey, 10);
    expect(ids).toHaveLength(1);

    expect(await backlog.hasUserWork(threadKey)).toBe(false);
  });

  it('is false for a thread with no mailbox stream at all', async () => {
    expect(await backlog.hasUserWork(nextThread())).toBe(false);
  });
});

describe('MailboxSweeper against real Redis', () => {
  it('does not revive a cleanly reaped thread whose stream holds only acked history and a shutdown control', async () => {
    const threadKey = nextThread();
    await createGroup(threadKey);
    await publishUser(threadKey, 'chat');
    await ack(threadKey, await deliver(threadKey, 10));
    await producer.publishControl(threadKey, 'shutdown'); // the reap

    const registry = new MemoryThreadRegistry();
    await seedStopped(registry, threadKey);
    const { sweeper, ensureRunning } = makeSweeper(registry);

    expect(await sweeper.sweep()).toBe(0);
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('revives a stopped thread with an undelivered user message', async () => {
    const threadKey = nextThread();
    await createGroup(threadKey);
    await publishUser(threadKey, 'anyone home?');

    const registry = new MemoryThreadRegistry();
    await seedStopped(registry, threadKey);
    const { sweeper, ensureRunning } = makeSweeper(registry);

    expect(await sweeper.sweep()).toBe(1);
    expect(ensureRunning).toHaveBeenCalledTimes(1);
  });

  it('revives a stopped thread with a delivered-but-unacked user message', async () => {
    const threadKey = nextThread();
    await createGroup(threadKey);
    await publishUser(threadKey, 'mid-turn crash');
    expect(await deliver(threadKey, 10)).toHaveLength(1); // delivered, never acked

    const registry = new MemoryThreadRegistry();
    await seedStopped(registry, threadKey);
    const { sweeper, ensureRunning } = makeSweeper(registry);

    expect(await sweeper.sweep()).toBe(1);
    expect(ensureRunning).toHaveBeenCalledTimes(1);
  });
});
