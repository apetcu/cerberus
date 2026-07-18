import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS_DIR } from '../src/registry/migrate.js';
import { PostgresThreadRegistry } from '../src/registry/postgres-thread-registry.js';
import type { UpsertParams } from '../src/registry/thread-registry.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let reg: PostgresThreadRegistry;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool, MIGRATIONS_DIR);
  reg = new PostgresThreadRegistry(pool);
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const params: UpsertParams = {
  threadKey: 'T1-C1-1.2', teamId: 'T1', channelId: 'C1', threadTs: '1.2',
  runtime: 'docker', workspacePath: '/workspaces/T1-C1-1.2',
};

describe('PostgresThreadRegistry', () => {
  it('migrate is idempotent', async () => {
    expect(await migrate(pool, MIGRATIONS_DIR)).toEqual([]);
  });

  it('upsert inserts then bumps activity', async () => {
    const first = await reg.upsertActivity(params);
    expect(first.status).toBe('provisioning');
    const second = await reg.upsertActivity(params);
    expect(second.lastActivityAt.getTime()).toBeGreaterThanOrEqual(first.lastActivityAt.getTime());
  });

  it('status transitions and container ids', async () => {
    await reg.setStatus(params.threadKey, 'running', { containerId: 'c1', containerName: 'n1' });
    expect(await reg.get(params.threadKey)).toMatchObject({ status: 'running', containerId: 'c1' });
    await reg.setStatus(params.threadKey, 'stopped', {});
    expect(await reg.get(params.threadKey)).toMatchObject({ status: 'stopped', containerId: null });
  });

  it('failure count, counts and idle listing', async () => {
    expect(await reg.recordFailure(params.threadKey)).toBe(1);
    await reg.setStatus(params.threadKey, 'running');
    expect(await reg.countByStatus('running')).toBe(1);
    expect(await reg.listRunningIdleSince(new Date(Date.now() + 3_600_000))).toHaveLength(1);
    expect(await reg.listRunningIdleSince(new Date(0))).toHaveLength(0);
    expect(await reg.get('missing')).toBeNull();
  });
});
