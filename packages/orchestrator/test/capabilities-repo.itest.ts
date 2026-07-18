import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesSchema } from '@cerberus/protocol';
import { migrate, MIGRATIONS_DIR } from '../src/registry/migrate.js';
import { PostgresThreadRegistry } from '../src/registry/postgres-thread-registry.js';
import { PostgresCapabilitiesRepo } from '../src/registry/capabilities-repo.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let repo: PostgresCapabilitiesRepo;

const KEY = 'T1-C1-1.2';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool, MIGRATIONS_DIR);
  repo = new PostgresCapabilitiesRepo(pool);
  await new PostgresThreadRegistry(pool).upsertActivity({
    threadKey: KEY, teamId: 'T1', channelId: 'C1', threadTs: '1.2',
    runtime: 'docker', workspacePath: `/workspaces/${KEY}`,
  });
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('PostgresCapabilitiesRepo', () => {
  it('returns null before anything is stored', async () => {
    expect(await repo.get(KEY)).toBeNull();
  });

  it('upserts and reads back, round-tripping every field', async () => {
    const caps = capabilitiesSchema.parse({
      tools: { web_search: true, code_execution: true, file_access: false, mcp_connectors: true },
      model: 'claude-fable-5', cpu: 1.5, memoryMb: 2048, pidsLimit: 512,
    });
    const saved = await repo.upsert(KEY, caps);
    expect(saved.updatedAt).not.toBeNull();

    const read = (await repo.get(KEY))!;
    expect(read.tools).toEqual(caps.tools);
    expect(read.model).toBe('claude-fable-5');
    expect(read.cpu).toBe(1.5);
    expect(read.memoryMb).toBe(2048);
    expect(read.pidsLimit).toBe(512);
  });

  it('upsert overwrites an existing row rather than erroring', async () => {
    const caps = capabilitiesSchema.parse({ model: 'second-write', cpu: 0.25 });
    await repo.upsert(KEY, caps);
    expect((await repo.get(KEY))!.model).toBe('second-write');
  });

  it('getMany returns only keys that have rows', async () => {
    const map = await repo.getMany([KEY, 'T9-C9-9.9']);
    expect(map.has(KEY)).toBe(true);
    expect(map.has('T9-C9-9.9')).toBe(false);
  });

  it('rejects capabilities for an unknown thread (foreign key)', async () => {
    await expect(repo.upsert('T0-C0-0.0', capabilitiesSchema.parse({}))).rejects.toThrow();
  });
});
