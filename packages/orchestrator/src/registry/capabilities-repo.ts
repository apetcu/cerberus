import type { Pool } from 'pg';
import { capabilitiesSchema, type Capabilities } from '@cerberus/protocol';

export interface CapabilitiesRepo {
  get(threadKey: string): Promise<Capabilities | null>;
  upsert(threadKey: string, caps: Capabilities): Promise<Capabilities>;
  getMany(threadKeys: string[]): Promise<Map<string, Capabilities>>;
}

interface Row {
  thread_key: string;
  tools: unknown;
  model: string;
  cpu: string;        // pg returns NUMERIC as string
  memory_mb: number;
  pids_limit: number;
  updated_at: Date;
}

function toCapabilities(row: Row): Capabilities {
  return capabilitiesSchema.parse({
    tools: row.tools,
    model: row.model,
    cpu: Number(row.cpu),
    memoryMb: row.memory_mb,
    pidsLimit: row.pids_limit,
    updatedAt: row.updated_at.toISOString(),
  });
}

export class PostgresCapabilitiesRepo implements CapabilitiesRepo {
  constructor(private readonly pool: Pool) {}

  async get(threadKey: string): Promise<Capabilities | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM thread_capabilities WHERE thread_key = $1', [threadKey],
    );
    return rows[0] ? toCapabilities(rows[0]) : null;
  }

  async upsert(threadKey: string, caps: Capabilities): Promise<Capabilities> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO thread_capabilities (thread_key, tools, model, cpu, memory_mb, pids_limit, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (thread_key) DO UPDATE SET
         tools = EXCLUDED.tools, model = EXCLUDED.model, cpu = EXCLUDED.cpu,
         memory_mb = EXCLUDED.memory_mb, pids_limit = EXCLUDED.pids_limit, updated_at = now()
       RETURNING *`,
      [threadKey, JSON.stringify(caps.tools), caps.model, caps.cpu, caps.memoryMb, caps.pidsLimit],
    );
    return toCapabilities(rows[0]!);
  }

  async getMany(threadKeys: string[]): Promise<Map<string, Capabilities>> {
    if (threadKeys.length === 0) return new Map();
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM thread_capabilities WHERE thread_key = ANY($1)', [threadKeys],
    );
    return new Map(rows.map((r) => [r.thread_key, toCapabilities(r)]));
  }
}
