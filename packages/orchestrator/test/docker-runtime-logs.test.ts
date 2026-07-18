import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DockerRuntime } from '../src/runtime/docker-runtime.js';
import type { AgentHandle } from '../src/runtime/agent-runtime.js';

const handle: AgentHandle = { id: 'c1', name: 'cerberus-agent-x', threadKey: 'T1-C1-1.2', running: true };

function fakeDocker(logs: () => Promise<unknown>) {
  return { getContainer: vi.fn(() => ({ logs })) } as never;
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of it) out.push(line);
  return out;
}

describe('DockerRuntime.logs abort handling', () => {
  it('yields nothing and never calls the daemon when the signal is already aborted', async () => {
    const logs = vi.fn(async () => Readable.from([]));
    const ac = new AbortController();
    ac.abort();
    const lines = await collect(new DockerRuntime(fakeDocker(logs)).logs(
      handle, { tail: 10, follow: true, signal: ac.signal },
    ));
    expect(lines).toEqual([]);
    expect(logs).not.toHaveBeenCalled();
  });

  it('destroys the acquired stream when the signal aborts while the logs call is in flight', async () => {
    const stream = Readable.from([]);
    const destroy = vi.fn();
    (stream as unknown as { destroy: unknown }).destroy = destroy;
    const ac = new AbortController();
    // Abort lands while the logs promise is still pending, before `stream` is assigned.
    const logs = vi.fn(async () => { ac.abort(); return stream; });
    const lines = await collect(new DockerRuntime(fakeDocker(logs)).logs(
      handle, { tail: 10, follow: true, signal: ac.signal },
    ));
    expect(lines).toEqual([]);
    expect(destroy).toHaveBeenCalled();
  });

  it('decodes framed output on the non-follow Buffer path', async () => {
    const payload = Buffer.from('hello\nworld\n', 'utf8');
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(payload.length, 4);
    const logs = vi.fn(async () => Buffer.concat([header, payload]));
    const lines = await collect(new DockerRuntime(fakeDocker(logs)).logs(
      handle, { tail: 10, follow: false },
    ));
    expect(lines).toEqual(['hello', 'world']);
  });
});
