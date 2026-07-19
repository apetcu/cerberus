import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { mailboxKey } from '@cerberus/protocol';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import { DrainState } from '../src/lifecycle/drain.js';
import { MailboxSweeper } from '../src/lifecycle/sweeper.js';
import type { EnsureOutcome } from '../src/lifecycle/supervisor.js';

const log = pino({ level: 'silent' });

async function seed(
  registry: MemoryThreadRegistry,
  threadKey: string,
  status: 'running' | 'stopped' | 'failed',
) {
  await registry.upsertActivity({
    threadKey, teamId: threadKey.split('-')[0]!, channelId: threadKey.split('-')[1]!,
    threadTs: threadKey.split('-')[2]!, runtime: 'docker', workspacePath: `/w/${threadKey}`,
  });
  await registry.setStatus(threadKey, status);
}

function makeMailbox(depths: Record<string, number>) {
  return { xlen: vi.fn(async (key: string) => depths[key] ?? 0) };
}

describe('MailboxSweeper', () => {
  it('revives a stopped thread with pending mail', async () => {
    const registry = new MemoryThreadRegistry();
    const THREAD = 'T1-C1-1.2';
    await seed(registry, THREAD, 'stopped');
    const mailbox = makeMailbox({ [mailboxKey(THREAD)]: 3 });
    const ensureRunning = vi.fn(async () => ({
      record: (await registry.get(THREAD))!, outcome: 'spawned' as EnsureOutcome,
    }));
    const drain = new DrainState();
    const sweeper = new MailboxSweeper({ registry, mailbox, supervisor: { ensureRunning }, drain, log });

    expect(await sweeper.sweep()).toBe(1);
    expect(ensureRunning).toHaveBeenCalledWith({
      threadKey: THREAD, teamId: 'T1', channelId: 'C1', threadTs: '1.2',
    });
  });

  it('ignores a stopped thread with an empty mailbox', async () => {
    const registry = new MemoryThreadRegistry();
    const THREAD = 'T1-C1-1.2';
    await seed(registry, THREAD, 'stopped');
    const mailbox = makeMailbox({});
    const ensureRunning = vi.fn();
    const drain = new DrainState();
    const sweeper = new MailboxSweeper({ registry, mailbox, supervisor: { ensureRunning }, drain, log });

    expect(await sweeper.sweep()).toBe(0);
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('ignores a running thread even with pending mail', async () => {
    const registry = new MemoryThreadRegistry();
    const THREAD = 'T1-C1-1.2';
    await seed(registry, THREAD, 'running');
    const mailbox = makeMailbox({ [mailboxKey(THREAD)]: 5 });
    const ensureRunning = vi.fn();
    const drain = new DrainState();
    const sweeper = new MailboxSweeper({ registry, mailbox, supervisor: { ensureRunning }, drain, log });

    expect(await sweeper.sweep()).toBe(0);
    expect(mailbox.xlen).not.toHaveBeenCalled();
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('returns 0 and calls nothing while draining', async () => {
    const registry = new MemoryThreadRegistry();
    const THREAD = 'T1-C1-1.2';
    await seed(registry, THREAD, 'stopped');
    const mailbox = makeMailbox({ [mailboxKey(THREAD)]: 3 });
    const ensureRunning = vi.fn();
    const drain = new DrainState();
    drain.set(true);
    const sweeper = new MailboxSweeper({ registry, mailbox, supervisor: { ensureRunning }, drain, log });

    expect(await sweeper.sweep()).toBe(0);
    expect(mailbox.xlen).not.toHaveBeenCalled();
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('one thread throwing does not stop the others', async () => {
    const registry = new MemoryThreadRegistry();
    const BAD = 'T1-C1-1.1';
    const GOOD = 'T1-C2-2.2';
    await seed(registry, BAD, 'stopped');
    await seed(registry, GOOD, 'failed');
    const mailbox = makeMailbox({ [mailboxKey(BAD)]: 1, [mailboxKey(GOOD)]: 1 });
    const ensureRunning = vi.fn(async ({ threadKey }: { threadKey: string }) => {
      if (threadKey === BAD) throw new Error('boom');
      return { record: (await registry.get(GOOD))!, outcome: 'spawned' as EnsureOutcome };
    });
    const drain = new DrainState();
    const errorSpy = vi.spyOn(log, 'error');
    const sweeper = new MailboxSweeper({ registry, mailbox, supervisor: { ensureRunning }, drain, log });

    expect(await sweeper.sweep()).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('counts only outcomes of spawned', async () => {
    const registry = new MemoryThreadRegistry();
    const ALREADY = 'T1-C1-1.1';
    const DEFERRED = 'T1-C2-2.2';
    const SPAWNED = 'T1-C3-3.3';
    await seed(registry, ALREADY, 'stopped');
    await seed(registry, DEFERRED, 'stopped');
    await seed(registry, SPAWNED, 'failed');
    const mailbox = makeMailbox({
      [mailboxKey(ALREADY)]: 1, [mailboxKey(DEFERRED)]: 1, [mailboxKey(SPAWNED)]: 1,
    });
    const outcomes: Record<string, EnsureOutcome> = {
      [ALREADY]: 'already-running', [DEFERRED]: 'deferred', [SPAWNED]: 'spawned',
    };
    const ensureRunning = vi.fn(async ({ threadKey }: { threadKey: string }) => ({
      record: (await registry.get(threadKey))!, outcome: outcomes[threadKey]!,
    }));
    const drain = new DrainState();
    const sweeper = new MailboxSweeper({ registry, mailbox, supervisor: { ensureRunning }, drain, log });

    expect(await sweeper.sweep()).toBe(1);
    expect(ensureRunning).toHaveBeenCalledTimes(3);
  });
});
