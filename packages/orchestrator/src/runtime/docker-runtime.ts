import type Docker from 'dockerode';
import {
  agentName, ROLE_LABEL, THREAD_LABEL,
  type AgentHandle, type AgentRuntime, type AgentSpec,
} from './agent-runtime.js';

export class DockerRuntime implements AgentRuntime {
  constructor(
    private readonly docker: Docker,
    private readonly opts: { network?: string } = {},
  ) {}

  async spawn(spec: AgentSpec): Promise<AgentHandle> {
    const name = agentName(spec.threadKey);
    const existing = await this.inspect(name);
    if (existing?.running) return existing;
    if (existing) await this.docker.getContainer(existing.id).remove({ force: true });

    const container = await this.docker.createContainer({
      name,
      Image: spec.image,
      Cmd: spec.command,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: { [THREAD_LABEL]: spec.threadKey, [ROLE_LABEL]: 'agent' },
      HostConfig: {
        Binds: [`${spec.workspaceHostPath}:/workspace:rw`],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=67108864' },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NanoCpus: Math.round(spec.limits.cpu * 1e9),
        Memory: spec.limits.memoryBytes,
        PidsLimit: spec.limits.pids,
        ...(this.opts.network ? { NetworkMode: this.opts.network } : {}),
      },
    });
    await container.start();
    return { id: container.id, name, threadKey: spec.threadKey, running: true };
  }

  async stop(handle: AgentHandle, graceful: boolean): Promise<void> {
    const container = this.docker.getContainer(handle.id);
    if (graceful) {
      try {
        await container.stop({ t: 30 });
      } catch (err) {
        // 304 = already stopped
        if ((err as { statusCode?: number }).statusCode !== 304) throw err;
      }
    }
    await container.remove({ force: true });
  }

  async list(): Promise<AgentHandle[]> {
    const rows = await this.docker.listContainers({
      all: true,
      filters: { label: [`${ROLE_LABEL}=agent`] },
    });
    return rows.map((r) => ({
      id: r.Id,
      name: (r.Names[0] ?? '').replace(/^\//, ''),
      threadKey: r.Labels[THREAD_LABEL] ?? '',
      running: r.State === 'running',
    }));
  }

  async inspect(name: string): Promise<AgentHandle | null> {
    const rows = await this.docker.listContainers({ all: true, filters: { name: [name] } });
    const row = rows.find((r) => r.Names.includes(`/${name}`));
    if (!row) return null;
    return {
      id: row.Id,
      name,
      threadKey: row.Labels[THREAD_LABEL] ?? '',
      running: row.State === 'running',
    };
  }
}
