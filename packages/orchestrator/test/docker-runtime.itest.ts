import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentName, THREAD_LABEL, type AgentSpec } from '../src/runtime/agent-runtime.js';
import { DockerRuntime } from '../src/runtime/docker-runtime.js';

const KEY = 'T9-C9-9.9';
let ws: string;
// Honor DOCKER_HOST (Colima/rootless/remote); otherwise pin the standard socket —
// dockerode's own default can resolve to a different daemon than the docker CLI
// when multiple engines are installed (e.g. Docker Desktop alongside OrbStack).
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
  command: ['sleep', '300'],
});

async function cleanup(): Promise<void> {
  const h = await runtime.inspect(agentName(KEY));
  if (h) await runtime.stop(h, false);
}

beforeAll(async () => {
  execSync('docker pull alpine:3.20', { stdio: 'inherit' });
  ws = await mkdtemp(join(tmpdir(), 'cerberus-rt-'));
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await rm(ws, { recursive: true, force: true });
});

describe('DockerRuntime', () => {
  it('spawns with labels, security hardening, and limits', async () => {
    const handle = await runtime.spawn(spec());
    expect(handle.running).toBe(true);
    expect(handle.name).toBe(agentName(KEY));

    const info = await docker.getContainer(handle.id).inspect();
    expect(info.Config.Labels[THREAD_LABEL]).toBe(KEY);
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.CapDrop).toContain('ALL');
    expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(info.HostConfig.PidsLimit).toBe(64);
    expect(info.HostConfig.Memory).toBe(64 * 1024 * 1024);
    expect(info.HostConfig.Binds?.[0]).toBe(`${ws}:/workspace:rw`);
  });

  it('spawn is idempotent while running', async () => {
    const again = await runtime.spawn(spec());
    expect(again.name).toBe(agentName(KEY));
    expect((await runtime.list()).filter((h) => h.threadKey === KEY)).toHaveLength(1);
  });

  it('list and inspect report the container', async () => {
    const found = await runtime.inspect(agentName(KEY));
    expect(found?.running).toBe(true);
    expect((await runtime.list()).some((h) => h.threadKey === KEY)).toBe(true);
  });

  it('stop removes the container', async () => {
    const h = await runtime.inspect(agentName(KEY));
    await runtime.stop(h!, false);
    expect(await runtime.inspect(agentName(KEY))).toBeNull();
  });
});
