import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import { agentName, type AgentHandle, type AgentRuntime } from '../src/runtime/agent-runtime.js';
import { Reconciler } from '../src/lifecycle/reconciler.js';

const log = pino({ level: 'silent' });
const cfg = { runtime: 'docker' as const, workspacesRoot: '/workspaces' };

function makeRuntime(handles: AgentHandle[]) {
  const stopped: string[] = [];
  const runtime = {
    spawn: vi.fn(),
    stop: vi.fn(async (h: AgentHandle) => { stopped.push(h.name); }),
    list: vi.fn(async () => handles),
    inspect: vi.fn(async () => null),
  } as unknown as AgentRuntime;
  return { runtime, stopped };
}

const liveHandle = (threadKey: string): AgentHandle => ({
  id: 'id1', name: agentName(threadKey), threadKey, running: true,
});

describe('Reconciler', () => {
  it('marks running rows without live containers as stopped', async () => {
    const registry = new MemoryThreadRegistry();
    await registry.upsertActivity({
      threadKey: 'T1-C1-1.2', teamId: 'T1', channelId: 'C1', threadTs: '1.2',
      runtime: 'docker', workspacePath: '/workspaces/T1-C1-1.2',
    });
    await registry.setStatus('T1-C1-1.2', 'running', { containerId: 'gone', containerName: 'gone' });
    const { runtime } = makeRuntime([]);

    const result = await new Reconciler({ registry, runtime, log }, cfg).reconcile();
    expect(result.orphanedRows).toBe(1);
    expect((await registry.get('T1-C1-1.2'))!.status).toBe('stopped');
  });

  it('adopts live containers with valid labels but no row', async () => {
    const registry = new MemoryThreadRegistry();
    const { runtime } = makeRuntime([liveHandle('T1-C1-5.5')]);

    const result = await new Reconciler({ registry, runtime, log }, cfg).reconcile();
    expect(result.adopted).toBe(1);
    expect(await registry.get('T1-C1-5.5')).toMatchObject({
      status: 'running', teamId: 'T1', channelId: 'C1', threadTs: '5.5',
      workspacePath: '/workspaces/T1-C1-5.5',
    });
  });

  it('re-links live containers to existing non-running rows', async () => {
    const registry = new MemoryThreadRegistry();
    await registry.upsertActivity({
      threadKey: 'T1-C1-5.5', teamId: 'T1', channelId: 'C1', threadTs: '5.5',
      runtime: 'docker', workspacePath: '/workspaces/T1-C1-5.5',
    });
    await registry.setStatus('T1-C1-5.5', 'stopped', {});
    const h = liveHandle('T1-C1-5.5');
    const { runtime } = makeRuntime([h]);

    const result = await new Reconciler({ registry, runtime, log }, cfg).reconcile();
    expect(result.adopted).toBe(1);
    expect(await registry.get('T1-C1-5.5')).toMatchObject({
      status: 'running', containerName: h.name,
    });
  });

  it('force-stops containers with unparseable labels', async () => {
    const registry = new MemoryThreadRegistry();
    const bad: AgentHandle = { id: 'x', name: 'cerberus-agent-bad', threadKey: 'garbage', running: true };
    const { runtime, stopped } = makeRuntime([bad]);

    const result = await new Reconciler({ registry, runtime, log }, cfg).reconcile();
    expect(result.stoppedUnknown).toBe(1);
    expect(stopped).toEqual(['cerberus-agent-bad']);
  });
});
