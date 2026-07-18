import type { V1Pod } from '@kubernetes/client-node';
import {
  agentName, ROLE_LABEL, THREAD_LABEL,
  type AgentHandle, type AgentRuntime, type AgentSpec,
} from './agent-runtime.js';

export interface PodApi {
  createNamespacedPod(p: { namespace: string; body: V1Pod }): Promise<V1Pod>;
  deleteNamespacedPod(p: { name: string; namespace: string; gracePeriodSeconds?: number }): Promise<unknown>;
  listNamespacedPod(p: { namespace: string; labelSelector?: string }): Promise<{ items: V1Pod[] }>;
}

export interface K8sRuntimeConfig {
  namespace: string;
  workspacePvc: string;
}

export function buildPodManifest(spec: AgentSpec, cfg: K8sRuntimeConfig): V1Pod {
  return {
    metadata: {
      name: agentName(spec.threadKey),
      labels: { [THREAD_LABEL]: spec.threadKey, [ROLE_LABEL]: 'agent' },
    },
    spec: {
      restartPolicy: 'Never',
      // Per-pod PID limits are a kubelet flag (podPidsLimit), not settable via the Pod API.
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
      containers: [
        {
          name: 'agent',
          image: spec.image,
          ...(spec.command ? { command: spec.command } : {}),
          env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
          resources: {
            limits: {
              cpu: String(spec.limits.cpu),
              memory: `${Math.round(spec.limits.memoryBytes / (1024 * 1024))}Mi`,
            },
          },
          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          volumeMounts: [
            { name: 'workspaces', mountPath: '/workspace', subPath: spec.threadKey },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        { name: 'workspaces', persistentVolumeClaim: { claimName: cfg.workspacePvc } },
        { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
      ],
    },
  };
}

function toHandle(pod: V1Pod): AgentHandle {
  return {
    id: pod.metadata?.uid ?? pod.metadata?.name ?? '',
    name: pod.metadata?.name ?? '',
    threadKey: pod.metadata?.labels?.[THREAD_LABEL] ?? '',
    running: pod.status?.phase === 'Running' || pod.status?.phase === 'Pending',
  };
}

export class K8sRuntime implements AgentRuntime {
  constructor(private readonly api: PodApi, private readonly cfg: K8sRuntimeConfig) {}

  async spawn(spec: AgentSpec): Promise<AgentHandle> {
    try {
      const pod = await this.api.createNamespacedPod({
        namespace: this.cfg.namespace,
        body: buildPodManifest(spec, this.cfg),
      });
      return { ...toHandle(pod), running: true };
    } catch (err) {
      if ((err as { code?: number }).code !== 409) throw err;
      const existing = await this.inspect(agentName(spec.threadKey));
      if (existing?.running) return existing;
      // Dead pod with the same name: replace it.
      try {
        await this.api.deleteNamespacedPod({
          name: agentName(spec.threadKey), namespace: this.cfg.namespace, gracePeriodSeconds: 0,
        });
      } catch (delErr) {
        if ((delErr as { code?: number }).code !== 404) throw delErr;
      }
      const pod = await this.api.createNamespacedPod({
        namespace: this.cfg.namespace,
        body: buildPodManifest(spec, this.cfg),
      });
      return { ...toHandle(pod), running: true };
    }
  }

  async stop(handle: AgentHandle, graceful: boolean): Promise<void> {
    await this.api.deleteNamespacedPod({
      name: handle.name,
      namespace: this.cfg.namespace,
      gracePeriodSeconds: graceful ? 30 : 0,
    });
  }

  async list(): Promise<AgentHandle[]> {
    const { items } = await this.api.listNamespacedPod({
      namespace: this.cfg.namespace,
      labelSelector: `${ROLE_LABEL}=agent`,
    });
    return items.map(toHandle);
  }

  async inspect(name: string): Promise<AgentHandle | null> {
    const pod = (await this.list()).find((h) => h.name === name);
    return pod ?? null;
  }
}
