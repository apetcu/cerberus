import { describe, expect, it, vi } from 'vitest';
import type { V1Pod } from '@kubernetes/client-node';
import { agentName, ROLE_LABEL, THREAD_LABEL, type AgentSpec } from '../src/runtime/agent-runtime.js';
import { buildPodManifest, K8sRuntime, type PodApi } from '../src/runtime/k8s-runtime.js';

const KEY = 'T1-C1-1.2';
const cfg = { namespace: 'cerberus', workspacePvc: 'cerberus-workspaces' };
const spec: AgentSpec = {
  threadKey: KEY, image: 'cerberus-agent:dev', workspaceHostPath: KEY,
  env: { THREAD_KEY: KEY, REDIS_URL: 'redis://r' },
  limits: { cpu: 0.5, memoryBytes: 512 * 1024 * 1024, pids: 256 },
};

describe('buildPodManifest', () => {
  const pod = buildPodManifest(spec, cfg);
  const c = pod.spec!.containers[0]!;

  it('names and labels the pod for reconciliation', () => {
    expect(pod.metadata!.name).toBe(agentName(KEY));
    expect(pod.metadata!.labels).toMatchObject({ [THREAD_LABEL]: KEY, [ROLE_LABEL]: 'agent' });
  });

  it('applies the security profile', () => {
    expect(pod.spec!.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000 });
    expect(c.securityContext).toMatchObject({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(c.resources!.limits).toEqual({ cpu: '0.5', memory: '512Mi' });
  });

  it('mounts the shared PVC via subPath and a tmp emptyDir', () => {
    expect(c.volumeMounts).toContainEqual({ name: 'workspaces', mountPath: '/workspace', subPath: KEY });
    expect(c.volumeMounts).toContainEqual({ name: 'tmp', mountPath: '/tmp' });
    expect(pod.spec!.volumes).toContainEqual({
      name: 'workspaces', persistentVolumeClaim: { claimName: cfg.workspacePvc },
    });
  });
});

describe('K8sRuntime', () => {
  const runningPod = (key: string): V1Pod => ({
    metadata: { name: agentName(key), labels: { [THREAD_LABEL]: key, [ROLE_LABEL]: 'agent' }, uid: 'u1' },
    status: { phase: 'Running' },
  });

  it('spawn creates a pod and reports running', async () => {
    const api: PodApi = {
      createNamespacedPod: vi.fn(async ({ body }) => body),
      deleteNamespacedPod: vi.fn(async () => ({})),
      listNamespacedPod: vi.fn(async () => ({ items: [] })),
      readNamespacedPodLog: vi.fn(async () => ''),
    };
    const handle = await new K8sRuntime(api, cfg).spawn(spec);
    expect(api.createNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'cerberus' }),
    );
    expect(handle).toMatchObject({ name: agentName(KEY), threadKey: KEY, running: true });
  });

  it('spawn returns the existing running pod (idempotent)', async () => {
    const api: PodApi = {
      createNamespacedPod: vi.fn(async () => { throw Object.assign(new Error('conflict'), { code: 409 }); }),
      deleteNamespacedPod: vi.fn(async () => ({})),
      listNamespacedPod: vi.fn(async () => ({ items: [runningPod(KEY)] })),
      readNamespacedPodLog: vi.fn(async () => ''),
    };
    const handle = await new K8sRuntime(api, cfg).spawn(spec);
    expect(handle.running).toBe(true);
  });

  it('recreates when 409 but the pod vanished (delete 404 tolerated)', async () => {
    let first = true;
    const api: PodApi = {
      createNamespacedPod: vi.fn(async ({ body }) => {
        if (first) { first = false; throw Object.assign(new Error('conflict'), { code: 409 }); }
        return body;
      }),
      deleteNamespacedPod: vi.fn(async () => { throw Object.assign(new Error('gone'), { code: 404 }); }),
      listNamespacedPod: vi.fn(async () => ({ items: [] })),
      readNamespacedPodLog: vi.fn(async () => ''),
    };
    const handle = await new K8sRuntime(api, cfg).spawn(spec);
    expect(handle.running).toBe(true);
  });

  it('list maps pods to handles; stop deletes with grace', async () => {
    const api: PodApi = {
      createNamespacedPod: vi.fn(async ({ body }) => body),
      deleteNamespacedPod: vi.fn(async () => ({})),
      listNamespacedPod: vi.fn(async () => ({ items: [runningPod(KEY)] })),
      readNamespacedPodLog: vi.fn(async () => ''),
    };
    const rt = new K8sRuntime(api, cfg);
    const handles = await rt.list();
    expect(handles[0]).toMatchObject({ threadKey: KEY, running: true });
    await rt.stop(handles[0]!, true);
    expect(api.deleteNamespacedPod).toHaveBeenCalledWith({
      name: agentName(KEY), namespace: 'cerberus', gracePeriodSeconds: 30,
    });
  });

  it('keeps emitting new lines after the tail window saturates', async () => {
    const windows = [
      'a\nb\nc',      // tail=3 window, full
      'b\nc\nd',      // rolled: only "d" is new
      'c\nd\ne',      // rolled: only "e" is new
    ];
    let call = 0;
    const api: PodApi = {
      createNamespacedPod: vi.fn(async ({ body }) => body),
      deleteNamespacedPod: vi.fn(async () => ({})),
      listNamespacedPod: vi.fn(async () => ({ items: [] })),
      readNamespacedPodLog: vi.fn(async () => windows[Math.min(call++, windows.length - 1)]!),
    };
    const runtime = new K8sRuntime(api, cfg);
    const handle = { id: 'u1', name: agentName(KEY), threadKey: KEY, running: true };

    const ac = new AbortController();
    const seen: string[] = [];
    const done = (async () => {
      for await (const line of runtime.logs(handle, { tail: 3, follow: true, signal: ac.signal })) {
        seen.push(line);
        if (seen.length >= 5) ac.abort();
      }
    })();
    await Promise.race([done, new Promise((r) => setTimeout(r, 9000))]);
    ac.abort();

    expect(seen.slice(0, 3)).toEqual(['a', 'b', 'c']);
    expect(seen).toContain('d');
    expect(seen).toContain('e');
  }, 15000);

  it('yields nothing when the signal is already aborted', async () => {
    const api: PodApi = {
      createNamespacedPod: vi.fn(async ({ body }) => body),
      deleteNamespacedPod: vi.fn(async () => ({})),
      listNamespacedPod: vi.fn(async () => ({ items: [] })),
      readNamespacedPodLog: vi.fn(async () => 'x'),
    };
    const ac = new AbortController();
    ac.abort();
    const seen: string[] = [];
    for await (const line of new K8sRuntime(api, cfg).logs(
      { id: 'u1', name: agentName(KEY), threadKey: KEY, running: true },
      { tail: 10, follow: true, signal: ac.signal },
    )) seen.push(line);
    expect(seen).toEqual([]);
    expect(api.readNamespacedPodLog).not.toHaveBeenCalled();
  });
});
