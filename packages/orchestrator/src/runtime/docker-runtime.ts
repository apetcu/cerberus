import { Readable } from 'node:stream';
import type Docker from 'dockerode';
import {
  agentName, ROLE_LABEL, THREAD_LABEL,
  type AgentHandle, type AgentRuntime, type AgentSpec, type LogOptions,
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

  async *logs(handle: AgentHandle, opts: LogOptions): AsyncIterable<string> {
    const container = this.docker.getContainer(handle.id);
    // dockerode's `logs` overloads key off a *literal* `follow` type: `follow: false` resolves
    // a buffered Promise<Buffer>, `follow: true` a Promise<ReadableStream>. Branching on the
    // literal (rather than passing `opts.follow` through) is what makes each overload apply.
    const raw = opts.follow
      ? await container.logs({ follow: true, stdout: true, stderr: true, tail: opts.tail })
      : await container.logs({ follow: false, stdout: true, stderr: true, tail: opts.tail });
    const stream: NodeJS.ReadableStream = Buffer.isBuffer(raw) ? Readable.from([raw]) : raw;

    let aborted = false;
    const abort = () => {
      aborted = true;
      (stream as unknown as { destroy?: () => void }).destroy?.();
    };
    opts.signal?.addEventListener('abort', abort, { once: true });

    let buffer = '';
    try {
      for await (const chunk of stream) {
        buffer += stripDockerFraming(chunk as Buffer);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) yield line;
      }
      if (buffer.length > 0) yield buffer;
    } catch (err) {
      // Destroying the stream mid-read to honor an abort surfaces as a stream error
      // (e.g. "Premature close"); that's the intended shutdown, not a failure.
      if (!aborted) throw err;
    } finally {
      opts.signal?.removeEventListener('abort', abort);
      abort();
    }
  }
}

/**
 * Docker multiplexes non-TTY container output into 8-byte framed chunks:
 * [stream_type, 0, 0, 0, len_be32] followed by len payload bytes. Strip the headers
 * so consumers see plain text rather than control bytes.
 */
function stripDockerFraming(chunk: Buffer): string {
  let out = '';
  let offset = 0;
  while (offset < chunk.length) {
    const isFrameHeader =
      chunk.length - offset >= 8 && chunk[offset]! <= 2 &&
      chunk[offset + 1] === 0 && chunk[offset + 2] === 0 && chunk[offset + 3] === 0;
    if (!isFrameHeader) {
      out += chunk.subarray(offset).toString('utf8');
      break;
    }
    const size = chunk.readUInt32BE(offset + 4);
    out += chunk.subarray(offset + 8, offset + 8 + size).toString('utf8');
    offset += 8 + size;
  }
  return out;
}
