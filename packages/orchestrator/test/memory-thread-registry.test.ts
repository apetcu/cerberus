import { describe, expect, it } from 'vitest';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import type { UpsertParams } from '../src/registry/thread-registry.js';

const params: UpsertParams = {
  threadKey: 'T1-C1-1.2', teamId: 'T1', channelId: 'C1', threadTs: '1.2',
  runtime: 'docker', workspacePath: '/workspaces/T1-C1-1.2',
};

describe('MemoryThreadRegistry', () => {
  it('inserts as provisioning, bumps lastActivity on re-upsert', async () => {
    const reg = new MemoryThreadRegistry();
    const first = await reg.upsertActivity(params);
    expect(first.status).toBe('provisioning');
    expect(first.failureCount).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    const second = await reg.upsertActivity(params);
    expect(second.lastActivityAt.getTime()).toBeGreaterThan(first.lastActivityAt.getTime());
    expect(second.createdAt).toEqual(first.createdAt);
  });

  it('setStatus with and without container ids', async () => {
    const reg = new MemoryThreadRegistry();
    await reg.upsertActivity(params);
    await reg.setStatus(params.threadKey, 'running', { containerId: 'c1', containerName: 'n1' });
    expect(await reg.get(params.threadKey)).toMatchObject({ status: 'running', containerId: 'c1', containerName: 'n1' });
    await reg.setStatus(params.threadKey, 'stopping');
    expect(await reg.get(params.threadKey)).toMatchObject({ status: 'stopping', containerId: 'c1' });
    await reg.setStatus(params.threadKey, 'stopped', {});
    expect(await reg.get(params.threadKey)).toMatchObject({ containerId: null, containerName: null });
  });

  it('recordFailure increments and returns count', async () => {
    const reg = new MemoryThreadRegistry();
    await reg.upsertActivity(params);
    expect(await reg.recordFailure(params.threadKey)).toBe(1);
    expect(await reg.recordFailure(params.threadKey)).toBe(2);
  });

  it('countByStatus / listByStatus / listRunningIdleSince', async () => {
    const reg = new MemoryThreadRegistry();
    await reg.upsertActivity(params);
    await reg.setStatus(params.threadKey, 'running');
    const other = { ...params, threadKey: 'T1-C1-9.9', threadTs: '9.9' };
    await reg.upsertActivity(other);
    expect(await reg.countByStatus('running')).toBe(1);
    expect((await reg.listByStatus('provisioning')).map((r) => r.threadKey)).toEqual(['T1-C1-9.9']);
    const future = new Date(Date.now() + 60_000);
    expect((await reg.listRunningIdleSince(future)).map((r) => r.threadKey)).toEqual([params.threadKey]);
    expect(await reg.listRunningIdleSince(new Date(0))).toEqual([]);
  });

  it('get returns null for unknown key', async () => {
    expect(await new MemoryThreadRegistry().get('nope')).toBeNull();
  });
});
