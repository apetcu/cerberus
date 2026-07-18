import { execSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Docker from 'dockerode';
import { Redis } from 'ioredis';
import pg from 'pg';
import pino from 'pino';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentName } from '../src/runtime/agent-runtime.js';
import { DockerRuntime } from '../src/runtime/docker-runtime.js';
import { ThreadSupervisor } from '../src/lifecycle/supervisor.js';
import { OutboxConsumer, type SlackPoster } from '../src/mailbox/outbox-consumer.js';
import { MailboxProducer, RedisDedupStore, RedisDeliveryGuard, type StreamsClient } from '../src/mailbox/redis-stores.js';
import { migrate, MIGRATIONS_DIR } from '../src/registry/migrate.js';
import { PostgresThreadRegistry } from '../src/registry/postgres-thread-registry.js';
import { EventRouter } from '../src/slack/router.js';

const log = pino({ level: 'silent' });
const KEY = 'T1-C1-1712345678.000100';

// Honor DOCKER_HOST (Colima/rootless/remote); otherwise pin the standard socket —
// dockerode's own default can resolve to a different daemon than the docker CLI
// when multiple engines are installed (e.g. Docker Desktop alongside OrbStack).
const docker = process.env.DOCKER_HOST
  ? new Docker()
  : new Docker({ socketPath: '/var/run/docker.sock' });

let redisC: StartedTestContainer;
let pgC: StartedPostgreSqlContainer;
let redis: Redis;
let pool: pg.Pool;
let ws: string;
let router: EventRouter;
let outbox: OutboxConsumer;
let runtime: DockerRuntime;
const posted: { threadKey: string; text: string }[] = [];
const ac = new AbortController();

beforeAll(async () => {
  try {
    execSync('docker image inspect cerberus-agent:dev', { stdio: 'ignore' });
  } catch {
    throw new Error('cerberus-agent:dev missing — run `pnpm build:agent-image` first');
  }
  redisC = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  pgC = await new PostgreSqlContainer('postgres:16-alpine').start();
  redis = new Redis(redisC.getMappedPort(6379), redisC.getHost());
  pool = new pg.Pool({ connectionString: pgC.getConnectionUri() });
  await migrate(pool, MIGRATIONS_DIR);
  ws = await mkdtemp(join(tmpdir(), 'cerberus-e2e-'));

  const sc = redis as unknown as StreamsClient;
  const registry = new PostgresThreadRegistry(pool);
  runtime = new DockerRuntime(docker);
  const supervisor = new ThreadSupervisor({ registry, runtime, log }, {
    runtime: 'docker', agentImage: 'cerberus-agent:dev',
    agentRedisUrl: `redis://host.docker.internal:${redisC.getMappedPort(6379)}`,
    logLevel: 'info', workspacesRoot: ws, workspacesHostRoot: ws,
    maxConcurrentAgents: 5,
    limits: { cpu: 0.5, memoryBytes: 256 * 1024 * 1024, pids: 128 },
  });
  const poster: SlackPoster = { postToThread: async (threadKey, text) => { posted.push({ threadKey, text }); } };
  router = new EventRouter({
    dedup: new RedisDedupStore(sc), producer: new MailboxProducer(sc), supervisor, poster, log,
  });
  outbox = new OutboxConsumer(sc, poster, new RedisDeliveryGuard(sc), log);
  void outbox.run(ac.signal);
});

afterAll(async () => {
  ac.abort();
  const h = await runtime?.inspect(agentName(KEY));
  if (h) await runtime.stop(h, false);
  redis?.disconnect();
  await pool?.end();
  await redisC?.stop();
  await pgC?.stop();
  if (ws) await rm(ws, { recursive: true, force: true });
});

async function waitForReply(containing: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (posted.some((p) => p.text.includes(containing))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no reply containing "${containing}"; got: ${JSON.stringify(posted)}`);
}

const msg = (ts: string, text: string) => ({
  teamId: 'T1', channelId: 'C1', threadTs: '1712345678.000100', ts, text,
  userId: 'U1', userDisplay: 'adrian',
});

describe('cerberus end-to-end', () => {
  it('mention → spawn → echo reply through outbox', async () => {
    expect(await router.handle(msg('1712345678.000200', 'hello cerberus'))).toBe('accepted');
    await waitForReply('hello cerberus');
    expect(posted.some((p) => p.text.includes('#1'))).toBe(true);
  });

  it('kill container → reply → recreated with workspace continuity', async () => {
    const h = await runtime.inspect(agentName(KEY));
    expect(h?.running).toBe(true);
    await runtime.stop(h!, false); // simulate crash
    expect(await router.handle(msg('1712345678.000300', 'are you back'))).toBe('accepted');
    await waitForReply('are you back');
    expect(posted.some((p) => p.text.includes('#2'))).toBe(true); // history survived
    const conversation = JSON.parse(await readFile(join(ws, KEY, 'conversation.json'), 'utf8'));
    expect(conversation.filter((e: { role: string }) => e.role === 'user')).toHaveLength(2);
  });

  it('duplicate delivery is dropped', async () => {
    const before = posted.length;
    expect(await router.handle(msg('1712345678.000300', 'are you back'))).toBe('duplicate');
    await new Promise((r) => setTimeout(r, 2000));
    expect(posted.length).toBe(before);
  });
});
