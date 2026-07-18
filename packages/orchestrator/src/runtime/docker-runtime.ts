import { Readable } from 'node:stream';
import type Docker from 'dockerode';
import {
  agentName, ROLE_LABEL, THREAD_LABEL,
  type AgentHandle, type AgentRuntime, type AgentSpec, type LogOptions,
} from './agent-runtime.js';
import { createFrameDecoder } from './docker-log-frames.js';

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

  async *logs(handle: AgentHandle, opts: LogOptions): AsyncIterable<string> {
    if (opts.signal?.aborted) return;

    const container = this.docker.getContainer(handle.id);
    let stream: NodeJS.ReadableStream | null = null;
    let aborted = false;

    // Registered before any await: a signal that fires while the logs call is in flight
    // must still be observed, otherwise a follow stream never terminates.
    const abort = (): void => {
      aborted = true;
      (stream as unknown as { destroy?: () => void } | null)?.destroy?.();
    };
    opts.signal?.addEventListener('abort', abort, { once: true });

    const decoder = createFrameDecoder();
    let lineBuffer = '';

    try {
      // dockerode's `logs` overloads key off a *literal* `follow` type: `follow: false`
      // resolves a buffered Promise<Buffer>, `follow: true` a Promise<ReadableStream>.
      // Branching on the literal (rather than passing `opts.follow` through) is what
      // makes each overload apply.
      const raw = opts.follow
        ? await container.logs({ follow: true, stdout: true, stderr: true, tail: opts.tail })
        : await container.logs({ follow: false, stdout: true, stderr: true, tail: opts.tail });
      if (aborted || opts.signal?.aborted) return;

      // With follow:false dockerode resolves the whole body as a Buffer, not a stream.
      stream = Buffer.isBuffer(raw) ? Readable.from([raw]) : (raw as unknown as NodeJS.ReadableStream);

      for await (const chunk of stream) {
        if (aborted) break;
        lineBuffer += decoder.push(chunk as Buffer);
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) yield line;
      }

      if (!aborted) {
        lineBuffer += decoder.flush();
        if (lineBuffer.length > 0) yield lineBuffer;
      }
    } catch (err) {
      // Destroying the stream to honor an abort surfaces as a premature-close error; that is
      // the intended teardown, not a failure. Anything else is real.
      if (!aborted) throw err;
    } finally {
      opts.signal?.removeEventListener('abort', abort);
      if (!aborted) (stream as unknown as { destroy?: () => void } | null)?.destroy?.();
    }
  }
}
