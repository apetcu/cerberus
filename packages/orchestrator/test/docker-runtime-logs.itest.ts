import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentName, type AgentSpec } from '../src/runtime/agent-runtime.js';
import { DockerRuntime } from '../src/runtime/docker-runtime.js';

const KEY = 'T8-C8-8.8';
let ws: string;
const docker = process.env.DOCKER_HOST
  ? new Docker()
  : new Docker({ socketPath: '/var/run/docker.sock' });
const runtime = new DockerRuntime(docker);

const spec = (): AgentSpec => ({
  threadKey: KEY,
  image: 'alpine:3.20',
  workspaceHostPath: ws,
  env: { THREAD_KEY: KEY },
  limits: { cpu: 0.25, memoryBytes: 64 * 1024 * 1024, pids: 64 },
  command: ['sh', '-c', 'echo line-one; echo line-two; sleep 60'],
});

async function cleanup(): Promise<void> {
  const h = await runtime.inspect(agentName(KEY));
  if (h) await runtime.stop(h, false);
}

beforeAll(async () => {
  execSync('docker pull alpine:3.20', { stdio: 'ignore' });
  ws = await mkdtemp(join(tmpdir(), 'cerberus-logs-'));
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('DockerRuntime.logs', () => {
  it('returns the container tail as clean lines', async () => {
    const handle = await runtime.spawn(spec());
    await new Promise((r) => setTimeout(r, 1500)); // let the echoes land

    const lines: string[] = [];
    for await (const line of runtime.logs(handle, { tail: 100, follow: false })) {
      lines.push(line);
    }
    expect(lines).toContain('line-one');
    expect(lines).toContain('line-two');
    // Docker stream framing must be stripped, not passed through as control bytes.
    expect(lines.every((l) => !/[\x00-\x08]/.test(l))).toBe(true);
  });

  it('stops a following stream when the signal aborts', async () => {
    const handle = (await runtime.inspect(agentName(KEY)))!;
    const ac = new AbortController();
    const collected: string[] = [];
    const done = (async () => {
      for await (const line of runtime.logs(handle, { tail: 10, follow: true, signal: ac.signal })) {
        collected.push(line);
      }
    })();
    setTimeout(() => ac.abort(), 1000);
    await done; // resolves rather than hanging once aborted
    expect(collected.length).toBeGreaterThan(0);
  });
});
