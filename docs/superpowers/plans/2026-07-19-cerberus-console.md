# Cerberus Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the monitoring console from `docs/superpowers/specs/2026-07-19-cerberus-console-design.md` — a dark ops dashboard served by the orchestrator that shows every live agent, drills into one, streams its raw container logs, and edits mocked per-agent capabilities.

**Architecture:** The orchestrator's existing HTTP server gains `/api/*` REST routes, a `/api/stream` WebSocket, and static serving of a React/Vite bundle. Live updates come from an in-process `EventBus` (lifecycle components publish; the hub re-snapshots on a 100ms debounce) plus a 2s reconcile tick for state the orchestrator can't observe by event. Log streaming goes through a new `AgentRuntime.logs()` method so Docker and Kubernetes stay interchangeable.

**Tech Stack:** TypeScript ESM, `ws` (WebSocket server), React 19 + Vite 6 + Tailwind CSS 4, zod, vitest, existing pg/ioredis/dockerode/@kubernetes/client-node.

## Global Constraints

- Node >= 22, pnpm 9, `"type": "module"`, `tsx` runtime, `pnpm -r typecheck` green before every commit. New package name: `@cerberus/dashboard`.
- All wire types (REST bodies and WS envelopes) are defined once in `packages/protocol/src/dashboard.ts` with zod schemas and imported by both orchestrator and dashboard. No duplicated shape definitions.
- Snapshot payloads must never contain Slack tokens, Redis URLs, or any credential. Timestamps in payloads are ISO-8601 strings (`Date.toISOString()`), never `Date` objects.
- WS channel names are exactly: `overview`, `thread:<threadKey>`, `logs:<threadKey>`.
- Reads must not mutate: no route outside `PUT /api/threads/:key/capabilities`, `POST /api/threads/:key/stop`, `POST /api/threads/:key/restart` may change state.
- `DASHBOARD_TOKEN` (default `''`): when non-empty, REST requires `Authorization: Bearer <token>` and WS requires `?token=<token>`; when empty, no auth. `DASHBOARD_ENABLED` (default `true`).
- Existing lifecycle classes accept the `EventBus` as an **optional** dependency — every existing test constructs them without it and must keep passing unchanged.
- Dark theme only. Tailwind tokens defined once in `packages/dashboard/src/styles.css`; no ad-hoc hex values in components.
- Unit tests `packages/*/test/**/*.test.ts`; integration `*.itest.ts`. Conventional commits, one per task minimum.

## File Map

```
packages/protocol/src/dashboard.ts                        # all wire types + zod schemas
packages/orchestrator/src/api/{events,snapshots,routes,hub,static,server}.ts
packages/orchestrator/src/registry/capabilities-repo.ts
packages/orchestrator/migrations/0002_capabilities.sql
packages/orchestrator/src/runtime/agent-runtime.ts        # + logs() on the interface
packages/orchestrator/src/runtime/{docker,k8s}-runtime.ts # + logs() impls
packages/dashboard/{index.html,vite.config.ts,package.json,tsconfig.json}
packages/dashboard/src/{main.tsx,App.tsx,styles.css}
packages/dashboard/src/lib/{ws.ts,api.ts,format.ts}
packages/dashboard/src/components/*.tsx
```

---

### Task 1: Protocol — dashboard wire types

**Files:**
- Create: `packages/protocol/src/dashboard.ts`
- Modify: `packages/protocol/src/index.ts` (add `export * from './dashboard.js';`)
- Test: `packages/protocol/test/dashboard.test.ts`

**Interfaces:**
- Produces (every later task imports these from `@cerberus/protocol`): `ThreadStatusName`, `AgentSummary`, `AgentDetail`, `OverviewSnapshot`, `Capabilities`, `ConversationEntry`, `clientMessageSchema`/`ClientMessage`, `serverMessageSchema`/`ServerMessage`, `capabilitiesSchema`, `DEFAULT_TOOLS`, channel helpers `threadChannel(key)`, `logsChannel(key)`, `OVERVIEW_CHANNEL`.

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/dashboard.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import {
  capabilitiesSchema, clientMessageSchema, DEFAULT_TOOLS, logsChannel,
  OVERVIEW_CHANNEL, serverMessageSchema, threadChannel,
} from '../src/dashboard.js';

describe('channels', () => {
  it('builds channel names', () => {
    expect(OVERVIEW_CHANNEL).toBe('overview');
    expect(threadChannel('T1-C1-1.2')).toBe('thread:T1-C1-1.2');
    expect(logsChannel('T1-C1-1.2')).toBe('logs:T1-C1-1.2');
  });
});

describe('capabilitiesSchema', () => {
  it('applies defaults for a bare object', () => {
    const caps = capabilitiesSchema.parse({});
    expect(caps.tools).toEqual(DEFAULT_TOOLS);
    expect(caps.model).toBe('stub');
    expect(caps.cpu).toBeGreaterThan(0);
  });

  it('rejects unknown tools and out-of-range limits', () => {
    expect(() => capabilitiesSchema.parse({ tools: { nope: true } })).toThrow();
    expect(() => capabilitiesSchema.parse({ cpu: 0 })).toThrow();
    expect(() => capabilitiesSchema.parse({ memoryMb: 10 })).toThrow();
  });
});

describe('ws envelopes', () => {
  it('parses subscribe/unsubscribe from clients', () => {
    expect(clientMessageSchema.parse({ type: 'subscribe', channel: 'overview' }).channel).toBe('overview');
    expect(clientMessageSchema.parse({ type: 'unsubscribe', channel: 'logs:k' }).type).toBe('unsubscribe');
    expect(() => clientMessageSchema.parse({ type: 'evil', channel: 'x' })).toThrow();
  });

  it('parses server messages', () => {
    const log = serverMessageSchema.parse({ type: 'log', channel: 'logs:k', line: 'hello' });
    expect(log.type).toBe('log');
    const err = serverMessageSchema.parse({ type: 'error', message: 'nope' });
    expect(err.type).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/protocol/test/dashboard.test.ts`
Expected: FAIL — cannot find module `../src/dashboard.js`.

- [ ] **Step 3: Write the implementation**

`packages/protocol/src/dashboard.ts`:
```typescript
import { z } from 'zod';

export const OVERVIEW_CHANNEL = 'overview';
export const threadChannel = (threadKey: string): string => `thread:${threadKey}`;
export const logsChannel = (threadKey: string): string => `logs:${threadKey}`;

export type ThreadStatusName = 'provisioning' | 'running' | 'stopping' | 'stopped' | 'failed';

export const DEFAULT_TOOLS = {
  web_search: false,
  code_execution: false,
  file_access: true,
  mcp_connectors: false,
} as const;

export const toolsSchema = z.object({
  web_search: z.boolean().default(DEFAULT_TOOLS.web_search),
  code_execution: z.boolean().default(DEFAULT_TOOLS.code_execution),
  file_access: z.boolean().default(DEFAULT_TOOLS.file_access),
  mcp_connectors: z.boolean().default(DEFAULT_TOOLS.mcp_connectors),
}).strict();

/** Mocked per-agent configuration: stored and displayed, not yet enforced by the runtime. */
export const capabilitiesSchema = z.object({
  tools: toolsSchema.default(DEFAULT_TOOLS),
  model: z.string().min(1).default('stub'),
  cpu: z.number().positive().max(8).default(0.5),
  memoryMb: z.number().int().min(64).max(16384).default(512),
  pidsLimit: z.number().int().min(16).max(4096).default(256),
  updatedAt: z.string().nullable().default(null),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export interface ConversationEntry {
  id: string;
  role: 'user' | 'agent';
  text: string;
  ts: string;
}

export interface AgentSummary {
  threadKey: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  status: ThreadStatusName;
  containerName: string | null;
  containerRunning: boolean;
  /** heartbeat:<threadKey> present in Redis (agent alive within its 30s TTL). */
  heartbeatFresh: boolean;
  mailboxDepth: number;
  failureCount: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface AgentDetail extends AgentSummary {
  containerId: string | null;
  runtime: 'docker' | 'k8s';
  workspacePath: string;
  conversation: ConversationEntry[];
  capabilities: Capabilities;
}

export interface OverviewSnapshot {
  generatedAt: string;
  runtime: 'docker' | 'k8s';
  runtimeHealthy: boolean;
  counts: {
    total: number;
    running: number;
    provisioning: number;
    stopping: number;
    stopped: number;
    failed: number;
  };
  agents: AgentSummary[];
}

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), channel: z.string().min(1) }),
  z.object({ type: z.literal('unsubscribe'), channel: z.string().min(1) }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), channel: z.string(), data: z.unknown() }),
  z.object({ type: z.literal('log'), channel: z.string(), line: z.string() }),
  z.object({ type: z.literal('log_end'), channel: z.string(), reason: z.string() }),
  z.object({ type: z.literal('error'), channel: z.string().optional(), message: z.string() }),
  z.object({ type: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
```

Append to `packages/protocol/src/index.ts`:
```typescript
export * from './dashboard.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/protocol/test/dashboard.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck && git add -A && git commit -m "feat(protocol): dashboard wire types and ws envelopes"
```

---

### Task 2: Orchestrator — EventBus

**Files:**
- Create: `packages/orchestrator/src/api/events.ts`
- Modify: `packages/orchestrator/src/lifecycle/supervisor.ts`, `packages/orchestrator/src/lifecycle/reaper.ts`, `packages/orchestrator/src/slack/router.ts`
- Test: `packages/orchestrator/test/events.test.ts`

**Interfaces:**
- Produces: `CerberusEvent = { kind: 'agent_spawned'|'agent_stopped'|'agent_failed'|'message_routed'; threadKey: string; at: string }`, `class EventBus { publish(e): void; onEvent(fn: (e: CerberusEvent) => void): () => void }` (returns an unsubscribe function). Task 6's hub consumes it.
- Consumed by: `ThreadSupervisor`, `IdleReaper`, `EventRouter` — each takes `events?: EventBus` in its deps object and publishes when present. Existing constructions without it keep working.

- [ ] **Step 1: Write the failing test**

`packages/orchestrator/test/events.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest';
import { EventBus, type CerberusEvent } from '../src/api/events.js';

const evt = (threadKey: string): CerberusEvent => ({
  kind: 'agent_spawned', threadKey, at: new Date().toISOString(),
});

describe('EventBus', () => {
  it('delivers published events to every listener', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.onEvent(a);
    bus.onEvent(b);
    bus.publish(evt('k1'));
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ threadKey: 'k1' }));
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.onEvent(fn);
    off();
    bus.publish(evt('k1'));
    expect(fn).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener from the others', () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.onEvent(() => { throw new Error('bad listener'); });
    bus.onEvent(good);
    expect(() => bus.publish(evt('k1'))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/orchestrator/test/events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/orchestrator/src/api/events.ts`:
```typescript
export interface CerberusEvent {
  kind: 'agent_spawned' | 'agent_stopped' | 'agent_failed' | 'message_routed';
  threadKey: string;
  /** ISO-8601 */
  at: string;
}

type Listener = (event: CerberusEvent) => void;

/**
 * In-process fan-out of lifecycle events to dashboard subscribers.
 * Listener failures are contained: one bad subscriber never blocks the others
 * or breaks the lifecycle path that published the event.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  publish(event: CerberusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Deliberately swallowed: publishing happens on the hot path of spawn/reap/route.
      }
    }
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
```

- [ ] **Step 4: Wire publishers into the lifecycle components**

In `packages/orchestrator/src/lifecycle/supervisor.ts` — add to the `SupervisorDeps` interface:
```typescript
  events?: EventBus;
```
with `import type { EventBus } from '../api/events.js';` at the top. Then in `ensureLocked`, immediately after the successful `log.info({ threadKey: p.threadKey, container: handle.name }, 'agent spawned');` line, add:
```typescript
      this.deps.events?.publish({ kind: 'agent_spawned', threadKey: p.threadKey, at: new Date().toISOString() });
```
and in the `catch` block, immediately after `log.error({ err, threadKey: p.threadKey }, 'agent spawn failed');`, add:
```typescript
      this.deps.events?.publish({ kind: 'agent_failed', threadKey: p.threadKey, at: new Date().toISOString() });
```

In `packages/orchestrator/src/lifecycle/reaper.ts` — add `events?: EventBus;` to `ReaperDeps` (same import path `../api/events.js`), and inside `tick()`'s per-row `try` immediately after `log.info({ threadKey: rec.threadKey }, 'idle agent reaped');` add:
```typescript
        this.deps.events?.publish({ kind: 'agent_stopped', threadKey: rec.threadKey, at: new Date().toISOString() });
```

In `packages/orchestrator/src/slack/router.ts` — add `events?: EventBus;` to `RouterDeps` (import from `../api/events.js`), destructure `events` alongside the other deps in `handle`, and immediately after `log.info({ threadKey, outcome }, 'inbound message routed');` add:
```typescript
    events?.publish({ kind: 'message_routed', threadKey, at: new Date().toISOString() });
```

- [ ] **Step 5: Run the full unit suite**

Run: `pnpm vitest run`
Expected: PASS — the 3 new EventBus tests plus every existing test (existing constructions omit `events`, so the optional chaining is a no-op).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && git add -A && git commit -m "feat(orchestrator): event bus published by supervisor, reaper, and router"
```

---

### Task 3: Runtime — log streaming

**Files:**
- Modify: `packages/orchestrator/src/runtime/agent-runtime.ts` (add `logs` to the interface), `packages/orchestrator/src/runtime/docker-runtime.ts`, `packages/orchestrator/src/runtime/k8s-runtime.ts`
- Test: `packages/orchestrator/test/docker-runtime-logs.itest.ts`

**Interfaces:**
- Consumes: `AgentHandle` (existing).
- Produces on `AgentRuntime`:
```typescript
  logs(handle: AgentHandle, opts: LogOptions): AsyncIterable<string>;
```
with `export interface LogOptions { tail: number; follow: boolean; signal?: AbortSignal }`. Yields whole lines without trailing newlines. Task 6's hub consumes it.
- Note: `PodApi` in `k8s-runtime.ts` gains `readNamespacedPodLog(p: { name: string; namespace: string; tailLines?: number }): Promise<string>` — existing k8s unit tests construct `PodApi` object literals and must be updated to include a `readNamespacedPodLog: vi.fn(async () => '')` member.

- [ ] **Step 1: Write the failing integration test**

`packages/orchestrator/test/docker-runtime-logs.itest.ts`:
```typescript
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
    expect(lines.every((l) => !l.includes(''))).toBe(true);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config vitest.integration.config.ts packages/orchestrator/test/docker-runtime-logs.itest.ts`
Expected: FAIL — `runtime.logs is not a function`.

- [ ] **Step 3: Add `logs` to the interface**

In `packages/orchestrator/src/runtime/agent-runtime.ts`, add above the `AgentRuntime` interface:
```typescript
export interface LogOptions {
  tail: number;
  follow: boolean;
  signal?: AbortSignal;
}
```
and inside the `AgentRuntime` interface, after `inspect`:
```typescript
  /** Yields whole log lines (no trailing newline). Ends when the stream closes or the signal aborts. */
  logs(handle: AgentHandle, opts: LogOptions): AsyncIterable<string>;
```

- [ ] **Step 4: Implement in DockerRuntime**

Add to `packages/orchestrator/src/runtime/docker-runtime.ts` (import `LogOptions` alongside the existing type imports):
```typescript
  async *logs(handle: AgentHandle, opts: LogOptions): AsyncIterable<string> {
    const container = this.docker.getContainer(handle.id);
    const stream = (await container.logs({
      follow: opts.follow,
      stdout: true,
      stderr: true,
      tail: opts.tail,
    })) as unknown as NodeJS.ReadableStream;

    const abort = () => {
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
    } finally {
      opts.signal?.removeEventListener('abort', abort);
      abort();
    }
  }
```
and at the bottom of the same file:
```typescript
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
```

- [ ] **Step 5: Implement in K8sRuntime**

In `packages/orchestrator/src/runtime/k8s-runtime.ts`, add to the `PodApi` interface:
```typescript
  readNamespacedPodLog(p: { name: string; namespace: string; tailLines?: number }): Promise<string>;
```
and add to the `K8sRuntime` class:
```typescript
  async *logs(handle: AgentHandle, opts: LogOptions): AsyncIterable<string> {
    // Kubernetes returns the tail as one body; following is polled rather than streamed
    // so the same interface works without a second (SPDY) client.
    let seen = 0;
    do {
      if (opts.signal?.aborted) return;
      const body = await this.api.readNamespacedPodLog({
        name: handle.name, namespace: this.cfg.namespace, tailLines: opts.tail,
      });
      const lines = body.split('\n').filter((l) => l.length > 0);
      for (const line of lines.slice(seen)) yield line;
      seen = lines.length;
      if (opts.follow) await new Promise((r) => setTimeout(r, 2000));
    } while (opts.follow && !opts.signal?.aborted);
  }
```
(import `LogOptions` with the other runtime types).

Update the three `PodApi` object literals in `packages/orchestrator/test/k8s-runtime.test.ts` to include:
```typescript
      readNamespacedPodLog: vi.fn(async () => ''),
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run && pnpm vitest run --config vitest.integration.config.ts packages/orchestrator/test/docker-runtime-logs.itest.ts`
Expected: unit suite green (k8s tests updated), integration 2/2 PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck && git add -A && git commit -m "feat(orchestrator): runtime log streaming for docker and kubernetes"
```

---

### Task 4: Capabilities — migration and repository

**Files:**
- Create: `packages/orchestrator/migrations/0002_capabilities.sql`, `packages/orchestrator/src/registry/capabilities-repo.ts`
- Test: `packages/orchestrator/test/capabilities-repo.itest.ts`

**Interfaces:**
- Consumes: `Capabilities`, `capabilitiesSchema` (Task 1); existing `pg.Pool`, `migrate`, `MIGRATIONS_DIR`.
- Produces:
```typescript
export interface CapabilitiesRepo {
  get(threadKey: string): Promise<Capabilities | null>;   // null when no row
  upsert(threadKey: string, caps: Capabilities): Promise<Capabilities>;
  getMany(threadKeys: string[]): Promise<Map<string, Capabilities>>;
}
export class PostgresCapabilitiesRepo implements CapabilitiesRepo { constructor(pool: Pool) }
```
Tasks 5 and 6 consume it.

- [ ] **Step 1: Write the migration**

`packages/orchestrator/migrations/0002_capabilities.sql`:
```sql
CREATE TABLE thread_capabilities (
  thread_key   TEXT PRIMARY KEY REFERENCES threads(thread_key) ON DELETE CASCADE,
  tools        JSONB NOT NULL DEFAULT '{}'::jsonb,
  model        TEXT NOT NULL DEFAULT 'stub',
  cpu          NUMERIC(4,2) NOT NULL DEFAULT 0.5,
  memory_mb    INT NOT NULL DEFAULT 512,
  pids_limit   INT NOT NULL DEFAULT 256,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Write the failing integration test**

`packages/orchestrator/test/capabilities-repo.itest.ts`:
```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run --config vitest.integration.config.ts packages/orchestrator/test/capabilities-repo.itest.ts`
Expected: FAIL — cannot find `capabilities-repo.js`.

- [ ] **Step 4: Write the implementation**

`packages/orchestrator/src/registry/capabilities-repo.ts`:
```typescript
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run --config vitest.integration.config.ts packages/orchestrator/test/capabilities-repo.itest.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && git add -A && git commit -m "feat(orchestrator): thread capabilities table and repository"
```

---

### Task 5: Snapshot builders

**Files:**
- Create: `packages/orchestrator/src/api/snapshots.ts`
- Modify: `packages/orchestrator/src/registry/thread-registry.ts`, `memory-thread-registry.ts`, `postgres-thread-registry.ts` (add `listRecent`), `packages/orchestrator/src/mailbox/redis-stores.ts` (add `xlen`/`exists` to `StreamsClient`)
- Test: `packages/orchestrator/test/snapshots.test.ts`

**Interfaces:**
- Consumes: `ThreadRegistry`, `AgentRuntime`, `CapabilitiesRepo` (Task 4), `StreamsClient`, protocol types (Task 1).
- Produces:
```typescript
export interface SnapshotDeps {
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  capabilities: CapabilitiesRepo;
  redis: StreamsClient;
  runtimeName: 'docker' | 'k8s';
  workspacesRoot: string;
  log: Logger;
}
export class SnapshotBuilder {
  constructor(deps: SnapshotDeps);
  overview(): Promise<OverviewSnapshot>;
  detail(threadKey: string): Promise<AgentDetail | null>;   // null when no registry row
}
```
- Also produces on `ThreadRegistry`: `listRecent(limit: number): Promise<ThreadRecord[]>` — ordered by `last_activity_at DESC`.
- Also produces on `StreamsClient`: `xlen(key: string): Promise<number>` and `exists(key: string): Promise<number>`.

- [ ] **Step 1: Extend the registry and redis interfaces**

In `packages/orchestrator/src/registry/thread-registry.ts`, add to the `ThreadRegistry` interface:
```typescript
  /** Most recently active threads first. */
  listRecent(limit: number): Promise<ThreadRecord[]>;
```

In `packages/orchestrator/src/registry/memory-thread-registry.ts`, add:
```typescript
  async listRecent(limit: number): Promise<ThreadRecord[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
```

In `packages/orchestrator/src/registry/postgres-thread-registry.ts`, add:
```typescript
  async listRecent(limit: number): Promise<ThreadRecord[]> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM threads ORDER BY last_activity_at DESC LIMIT $1', [limit],
    );
    return rows.map(toRecord);
  }
```

In `packages/orchestrator/src/mailbox/redis-stores.ts`, add to the `StreamsClient` interface:
```typescript
  xlen(key: string): Promise<number>;
  exists(key: string): Promise<number>;
```

- [ ] **Step 2: Write the failing test**

`packages/orchestrator/test/snapshots.test.ts`:
```typescript
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesSchema } from '@cerberus/protocol';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import { agentName, type AgentHandle, type AgentRuntime } from '../src/runtime/agent-runtime.js';
import { SnapshotBuilder } from '../src/api/snapshots.js';
import type { CapabilitiesRepo } from '../src/registry/capabilities-repo.js';
import type { StreamsClient } from '../src/mailbox/redis-stores.js';

const log = pino({ level: 'silent' });
const KEY = 'T1-C1-1.2';

function fakeRuntime(live: AgentHandle[], throws = false): AgentRuntime {
  return {
    spawn: vi.fn(), stop: vi.fn(), logs: vi.fn(),
    list: vi.fn(async () => { if (throws) throw new Error('docker down'); return live; }),
    inspect: vi.fn(async (name: string) => live.find((h) => h.name === name) ?? null),
  } as unknown as AgentRuntime;
}

const fakeRedis = (depth: number, heartbeat: number): StreamsClient => ({
  xlen: vi.fn(async () => depth),
  exists: vi.fn(async () => heartbeat),
} as unknown as StreamsClient);

const fakeCaps = (stored: boolean): CapabilitiesRepo => ({
  get: vi.fn(async () => (stored ? capabilitiesSchema.parse({ model: 'stored-model' }) : null)),
  upsert: vi.fn(),
  getMany: vi.fn(async () => new Map()),
});

describe('SnapshotBuilder', () => {
  let ws: string;
  let registry: MemoryThreadRegistry;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'cerberus-snap-'));
    registry = new MemoryThreadRegistry();
    await registry.upsertActivity({
      threadKey: KEY, teamId: 'T1', channelId: 'C1', threadTs: '1.2',
      runtime: 'docker', workspacePath: join(ws, KEY),
    });
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  const build = (runtime: AgentRuntime, redis: StreamsClient, caps = fakeCaps(false)) =>
    new SnapshotBuilder({
      registry, runtime, capabilities: caps, redis,
      runtimeName: 'docker', workspacesRoot: ws, log,
    });

  it('overview reports counts, container liveness, heartbeat and mailbox depth', async () => {
    await registry.setStatus(KEY, 'running', { containerId: 'c1', containerName: agentName(KEY) });
    const handle = { id: 'c1', name: agentName(KEY), threadKey: KEY, running: true };
    const snap = await build(fakeRuntime([handle]), fakeRedis(3, 1)).overview();

    expect(snap.counts).toMatchObject({ total: 1, running: 1 });
    expect(snap.runtimeHealthy).toBe(true);
    expect(snap.agents[0]).toMatchObject({
      threadKey: KEY, status: 'running', containerRunning: true, heartbeatFresh: true, mailboxDepth: 3,
    });
    expect(typeof snap.agents[0]!.createdAt).toBe('string');
  });

  it('marks containerRunning false when the registry row has no live container', async () => {
    await registry.setStatus(KEY, 'running', { containerId: 'gone', containerName: 'gone' });
    const snap = await build(fakeRuntime([]), fakeRedis(0, 0)).overview();
    expect(snap.agents[0]).toMatchObject({ containerRunning: false, heartbeatFresh: false });
  });

  it('degrades gracefully when the runtime is unreachable', async () => {
    const snap = await build(fakeRuntime([], true), fakeRedis(0, 0)).overview();
    expect(snap.runtimeHealthy).toBe(false);
    expect(snap.agents).toHaveLength(1); // registry data still renders
  });

  it('detail includes conversation from the workspace and stored capabilities', async () => {
    await mkdir(join(ws, KEY), { recursive: true });
    await writeFile(join(ws, KEY, 'conversation.json'), JSON.stringify([
      { id: 'a', role: 'user', text: 'hi', ts: '2026-07-19T00:00:00.000Z' },
    ]));
    const detail = await build(fakeRuntime([]), fakeRedis(0, 0), fakeCaps(true)).detail(KEY);
    expect(detail!.conversation).toHaveLength(1);
    expect(detail!.capabilities.model).toBe('stored-model');
    expect(detail!.workspacePath).toContain(KEY);
  });

  it('detail falls back to default capabilities and empty conversation', async () => {
    const detail = await build(fakeRuntime([]), fakeRedis(0, 0)).detail(KEY);
    expect(detail!.conversation).toEqual([]);
    expect(detail!.capabilities.model).toBe('stub');
  });

  it('detail returns null for an unknown thread', async () => {
    expect(await build(fakeRuntime([]), fakeRedis(0, 0)).detail('nope')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/orchestrator/test/snapshots.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

`packages/orchestrator/src/api/snapshots.ts`:
```typescript
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  capabilitiesSchema, heartbeatKey, mailboxKey,
  type AgentDetail, type AgentSummary, type ConversationEntry, type OverviewSnapshot,
} from '@cerberus/protocol';
import type { ThreadRecord } from '../domain/thread.js';
import type { StreamsClient } from '../mailbox/redis-stores.js';
import type { Logger } from '../observability/logger.js';
import type { CapabilitiesRepo } from '../registry/capabilities-repo.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentHandle, AgentRuntime } from '../runtime/agent-runtime.js';

export interface SnapshotDeps {
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  capabilities: CapabilitiesRepo;
  redis: StreamsClient;
  runtimeName: 'docker' | 'k8s';
  workspacesRoot: string;
  log: Logger;
}

const MAX_AGENTS = 200;

export class SnapshotBuilder {
  constructor(private readonly deps: SnapshotDeps) {}

  async overview(): Promise<OverviewSnapshot> {
    const records = await this.deps.registry.listRecent(MAX_AGENTS);
    const { live, healthy } = await this.liveHandles();
    const agents = await Promise.all(records.map((r) => this.summarize(r, live)));

    const counts = {
      total: agents.length,
      running: agents.filter((a) => a.status === 'running').length,
      provisioning: agents.filter((a) => a.status === 'provisioning').length,
      stopping: agents.filter((a) => a.status === 'stopping').length,
      stopped: agents.filter((a) => a.status === 'stopped').length,
      failed: agents.filter((a) => a.status === 'failed').length,
    };

    return {
      generatedAt: new Date().toISOString(),
      runtime: this.deps.runtimeName,
      runtimeHealthy: healthy,
      counts,
      agents,
    };
  }

  async detail(threadKey: string): Promise<AgentDetail | null> {
    const record = await this.deps.registry.get(threadKey);
    if (!record) return null;
    const { live } = await this.liveHandles();
    const summary = await this.summarize(record, live);
    const [conversation, stored] = await Promise.all([
      this.readConversation(record.workspacePath),
      this.deps.capabilities.get(threadKey),
    ]);
    return {
      ...summary,
      containerId: record.containerId,
      runtime: record.runtime,
      workspacePath: record.workspacePath,
      conversation,
      capabilities: stored ?? capabilitiesSchema.parse({}),
    };
  }

  /** Live containers keyed by threadKey; `healthy` is false when the runtime is unreachable. */
  private async liveHandles(): Promise<{ live: Map<string, AgentHandle>; healthy: boolean }> {
    try {
      const handles = await this.deps.runtime.list();
      return {
        live: new Map(handles.filter((h) => h.running).map((h) => [h.threadKey, h])),
        healthy: true,
      };
    } catch (err) {
      this.deps.log.warn({ err }, 'runtime unreachable while building snapshot');
      return { live: new Map(), healthy: false };
    }
  }

  private async summarize(record: ThreadRecord, live: Map<string, AgentHandle>): Promise<AgentSummary> {
    const [mailboxDepth, heartbeat] = await Promise.all([
      this.deps.redis.xlen(mailboxKey(record.threadKey)).catch(() => 0),
      this.deps.redis.exists(heartbeatKey(record.threadKey)).catch(() => 0),
    ]);
    return {
      threadKey: record.threadKey,
      teamId: record.teamId,
      channelId: record.channelId,
      threadTs: record.threadTs,
      status: record.status,
      containerName: record.containerName,
      containerRunning: live.has(record.threadKey),
      heartbeatFresh: heartbeat > 0,
      mailboxDepth,
      failureCount: record.failureCount,
      createdAt: record.createdAt.toISOString(),
      lastActivityAt: record.lastActivityAt.toISOString(),
    };
  }

  private async readConversation(workspacePath: string): Promise<ConversationEntry[]> {
    try {
      const raw = await readFile(join(workspacePath, 'conversation.json'), 'utf8');
      return JSON.parse(raw) as ConversationEntry[];
    } catch {
      // No conversation yet, or the workspace is not mounted here — an empty history is correct.
      return [];
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/orchestrator/test/snapshots.test.ts && pnpm vitest run`
Expected: 6 new tests PASS; full unit suite still green.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && git add -A && git commit -m "feat(orchestrator): overview and detail snapshot builders"
```

---

### Task 6: REST routes, static serving, auth

**Files:**
- Create: `packages/orchestrator/src/api/routes.ts`, `packages/orchestrator/src/api/static.ts`
- Test: `packages/orchestrator/test/routes.test.ts`

**Interfaces:**
- Consumes: `SnapshotBuilder` (Task 5), `CapabilitiesRepo` (Task 4), `ThreadSupervisor`, `AgentRuntime`, `ThreadRegistry`.
- Produces:
```typescript
export interface ApiDeps {
  snapshots: SnapshotBuilder;
  capabilities: CapabilitiesRepo;
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  supervisor: Pick<ThreadSupervisor, 'ensureRunning'>;
  token: string;               // '' disables auth
  log: Logger;
}
export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
```
The handler returns `true` when it handled the request, `false` when the path is not an `/api/*` route (so the caller falls through to static/health).
```typescript
export function createStaticHandler(distDir: string): (req, res) => Promise<boolean>;
export function isAuthorized(req: IncomingMessage, token: string): boolean;
```

- [ ] **Step 1: Write the failing test**

`packages/orchestrator/test/routes.test.ts`:
```typescript
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesSchema, type AgentDetail, type OverviewSnapshot } from '@cerberus/protocol';
import { createApiHandler, type ApiDeps } from '../src/api/routes.js';

const log = pino({ level: 'silent' });
const KEY = 'T1-C1-1.2';

const overview = { generatedAt: 'now', runtime: 'docker', runtimeHealthy: true,
  counts: { total: 0, running: 0, provisioning: 0, stopping: 0, stopped: 0, failed: 0 },
  agents: [] } as unknown as OverviewSnapshot;

function makeDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    snapshots: {
      overview: vi.fn(async () => overview),
      detail: vi.fn(async (k: string) => (k === KEY ? ({ threadKey: k } as unknown as AgentDetail) : null)),
    } as never,
    capabilities: {
      get: vi.fn(async () => null),
      upsert: vi.fn(async (_k: string, c) => c),
      getMany: vi.fn(async () => new Map()),
    },
    registry: { get: vi.fn(async (k: string) => (k === KEY ? ({ threadKey: k } as never) : null)) } as never,
    runtime: { inspect: vi.fn(async () => null), stop: vi.fn() } as never,
    supervisor: { ensureRunning: vi.fn(async () => ({ record: {} as never, outcome: 'spawned' as const })) },
    token: '',
    log,
    ...overrides,
  };
}

let server: Server;
let base: string;

function serve(deps: ApiDeps) {
  const handler = createApiHandler(deps);
  server = createServer((req, res) => {
    void handler(req, res).then((handled) => { if (!handled) res.writeHead(404).end('nope'); });
  });
  return new Promise<void>((resolve) => {
    server.listen(0, () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); });
  });
}

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('api routes', () => {
  it('GET /api/overview returns the snapshot', async () => {
    await serve(makeDeps());
    const res = await fetch(`${base}/api/overview`);
    expect(res.status).toBe(200);
    expect((await res.json() as OverviewSnapshot).runtime).toBe('docker');
  });

  it('GET /api/threads/:key returns detail, 404 for unknown', async () => {
    await serve(makeDeps());
    expect((await fetch(`${base}/api/threads/${KEY}`)).status).toBe(200);
    expect((await fetch(`${base}/api/threads/missing`)).status).toBe(404);
  });

  it('PUT capabilities validates the body and upserts', async () => {
    const deps = makeDeps();
    await serve(deps);
    const ok = await fetch(`${base}/api/threads/${KEY}/capabilities`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', cpu: 1 }),
    });
    expect(ok.status).toBe(200);
    expect(deps.capabilities.upsert).toHaveBeenCalled();

    const bad = await fetch(`${base}/api/threads/${KEY}/capabilities`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cpu: -1 }),
    });
    expect(bad.status).toBe(400);
  });

  it('PUT capabilities 404s for an unknown thread', async () => {
    await serve(makeDeps());
    const res = await fetch(`${base}/api/threads/missing/capabilities`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(capabilitiesSchema.parse({})),
    });
    expect(res.status).toBe(404);
  });

  it('POST restart calls ensureRunning', async () => {
    const deps = makeDeps();
    await serve(deps);
    const res = await fetch(`${base}/api/threads/${KEY}/restart`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(deps.supervisor.ensureRunning).toHaveBeenCalled();
  });

  it('requires a bearer token when one is configured', async () => {
    await serve(makeDeps({ token: 'sekret' }));
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    const ok = await fetch(`${base}/api/overview`, { headers: { authorization: 'Bearer sekret' } });
    expect(ok.status).toBe(200);
  });

  it('returns false (unhandled) for non-api paths', async () => {
    await serve(makeDeps());
    expect((await fetch(`${base}/healthz`)).status).toBe(404); // our test server's fallthrough
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/orchestrator/test/routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the API handler**

`packages/orchestrator/src/api/routes.ts`:
```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import { capabilitiesSchema } from '@cerberus/protocol';
import type { ThreadSupervisor } from '../lifecycle/supervisor.js';
import type { Logger } from '../observability/logger.js';
import type { CapabilitiesRepo } from '../registry/capabilities-repo.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { SnapshotBuilder } from './snapshots.js';

export interface ApiDeps {
  snapshots: SnapshotBuilder;
  capabilities: CapabilitiesRepo;
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  supervisor: Pick<ThreadSupervisor, 'ensureRunning'>;
  /** Empty string disables auth. */
  token: string;
  log: Logger;
}

export function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${token}`) return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') === token;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApiHandler(deps: ApiDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;

    if (!isAuthorized(req, deps.token)) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }

    try {
      const parts = url.pathname.split('/').filter(Boolean); // ['api', 'threads', key, sub?]
      const method = req.method ?? 'GET';

      if (parts[1] === 'overview' && method === 'GET') {
        json(res, 200, await deps.snapshots.overview());
        return true;
      }

      if (parts[1] === 'threads' && parts.length === 2 && method === 'GET') {
        json(res, 200, (await deps.snapshots.overview()).agents);
        return true;
      }

      const key = parts[2] ? decodeURIComponent(parts[2]) : '';
      const sub = parts[3];

      if (parts[1] === 'threads' && key) {
        if (!sub && method === 'GET') {
          const detail = await deps.snapshots.detail(key);
          if (!detail) { json(res, 404, { error: 'unknown thread' }); return true; }
          json(res, 200, detail);
          return true;
        }

        if (sub === 'capabilities' && method === 'GET') {
          const stored = await deps.capabilities.get(key);
          json(res, 200, stored ?? capabilitiesSchema.parse({}));
          return true;
        }

        if (sub === 'capabilities' && method === 'PUT') {
          if (!(await deps.registry.get(key))) { json(res, 404, { error: 'unknown thread' }); return true; }
          const parsed = capabilitiesSchema.safeParse(await readBody(req));
          if (!parsed.success) { json(res, 400, { error: 'invalid capabilities', issues: parsed.error.issues }); return true; }
          json(res, 200, await deps.capabilities.upsert(key, parsed.data));
          return true;
        }

        if (sub === 'logs' && method === 'GET') {
          const record = await deps.registry.get(key);
          const handle = record?.containerName ? await deps.runtime.inspect(record.containerName) : null;
          if (!handle) { json(res, 404, { error: 'no container for thread' }); return true; }
          const tail = Number(url.searchParams.get('tail') ?? '200');
          const lines: string[] = [];
          for await (const line of deps.runtime.logs(handle, { tail, follow: false })) lines.push(line);
          json(res, 200, { lines });
          return true;
        }

        if (sub === 'stop' && method === 'POST') {
          const record = await deps.registry.get(key);
          const handle = record?.containerName ? await deps.runtime.inspect(record.containerName) : null;
          if (!handle) { json(res, 404, { error: 'no container for thread' }); return true; }
          await deps.runtime.stop(handle, true);
          await deps.registry.setStatus(key, 'stopped', { containerId: null, containerName: null });
          json(res, 200, { stopped: true });
          return true;
        }

        if (sub === 'restart' && method === 'POST') {
          const record = await deps.registry.get(key);
          if (!record) { json(res, 404, { error: 'unknown thread' }); return true; }
          const result = await deps.supervisor.ensureRunning({
            threadKey: key, teamId: record.teamId, channelId: record.channelId, threadTs: record.threadTs,
          });
          json(res, 200, { outcome: result.outcome });
          return true;
        }
      }

      json(res, 404, { error: 'not found' });
      return true;
    } catch (err) {
      deps.log.error({ err, path: url.pathname }, 'api request failed');
      json(res, 500, { error: 'internal error' });
      return true;
    }
  };
}
```

- [ ] **Step 4: Write the static handler**

`packages/orchestrator/src/api/static.ts`:
```typescript
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

/**
 * Serves the built dashboard. Unknown paths fall back to index.html (SPA routing);
 * traversal attempts resolve outside distDir and are rejected before any read.
 */
export function createStaticHandler(distDir: string) {
  const root = resolve(distDir);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if ((req.method ?? 'GET') !== 'GET') return false;
    const url = new URL(req.url ?? '/', 'http://localhost');

    const requested = resolve(join(root, normalize(url.pathname)));
    const inRoot = requested === root || requested.startsWith(root + sep);
    const target = inRoot && (await isFile(requested)) ? requested : join(root, 'index.html');

    try {
      const body = await readFile(target);
      const type = MIME[extname(target)] ?? 'application/octet-stream';
      const cache = target.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable'   // vite emits content-hashed asset names
        : 'no-cache';
      res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': cache });
      res.end(body);
      return true;
    } catch {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Dashboard assets not built. Run: pnpm build:dashboard');
      return true;
    }
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/orchestrator/test/routes.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && git add -A && git commit -m "feat(orchestrator): dashboard rest api and static asset serving"
```

---

### Task 7: WebSocket hub

**Files:**
- Create: `packages/orchestrator/src/api/hub.ts`
- Modify: `packages/orchestrator/package.json` (add `"ws": "^8.18.0"` to dependencies, `"@types/ws": "^8.5.13"` to devDependencies)
- Test: `packages/orchestrator/test/hub.test.ts`

**Interfaces:**
- Consumes: `EventBus` (Task 2), `SnapshotBuilder` (Task 5), `AgentRuntime.logs` (Task 3), protocol channel helpers and envelopes (Task 1).
- Produces:
```typescript
export interface HubDeps {
  snapshots: SnapshotBuilder;
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  events: EventBus;
  log: Logger;
  tickMs?: number;      // default 2000
  debounceMs?: number;  // default 100
}
export class DashboardHub {
  constructor(deps: HubDeps);
  /** Registers a connected socket. Returns a disposer that cleans up all its channels. */
  addClient(socket: HubSocket): () => void;
  start(): void;
  stop(): void;
}
export interface HubSocket {
  send(data: string): void;
  on(event: 'message' | 'close', fn: (payload?: unknown) => void): void;
}
```
The socket is abstracted as `HubSocket` so tests drive it without opening a real WebSocket; `ws`'s `WebSocket` satisfies it structurally.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @cerberus/orchestrator add ws && pnpm --filter @cerberus/orchestrator add -D @types/ws
```

- [ ] **Step 2: Write the failing test**

`packages/orchestrator/test/hub.test.ts`:
```typescript
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { logsChannel, OVERVIEW_CHANNEL, threadChannel, type ServerMessage } from '@cerberus/protocol';
import { EventBus } from '../src/api/events.js';
import { DashboardHub, type HubSocket } from '../src/api/hub.js';

const log = pino({ level: 'silent' });
const KEY = 'T1-C1-1.2';

class FakeSocket implements HubSocket {
  sent: ServerMessage[] = [];
  private handlers: Record<string, (payload?: unknown) => void> = {};
  send(data: string): void { this.sent.push(JSON.parse(data) as ServerMessage); }
  on(event: 'message' | 'close', fn: (payload?: unknown) => void): void { this.handlers[event] = fn; }
  emit(event: 'message' | 'close', payload?: unknown): void { this.handlers[event]?.(payload); }
  subscribe(channel: string): void { this.emit('message', JSON.stringify({ type: 'subscribe', channel })); }
  unsubscribe(channel: string): void { this.emit('message', JSON.stringify({ type: 'unsubscribe', channel })); }
  ofType(type: ServerMessage['type']): ServerMessage[] { return this.sent.filter((m) => m.type === type); }
}

function makeHub(logLines: string[] = [], opts: { detail?: unknown } = {}) {
  const events = new EventBus();
  const aborted: AbortSignal[] = [];
  const runtime = {
    inspect: vi.fn(async () => ({ id: 'c1', name: 'cerberus-agent-x', threadKey: KEY, running: true })),
    logs: vi.fn(async function* (_h: unknown, o: { signal?: AbortSignal }) {
      if (o.signal) aborted.push(o.signal);
      for (const line of logLines) yield line;
      await new Promise(() => {}); // stay open like a follow stream
    }),
  } as never;
  const hub = new DashboardHub({
    snapshots: {
      overview: vi.fn(async () => ({ generatedAt: 'now', agents: [] })),
      detail: vi.fn(async () => opts.detail ?? { threadKey: KEY }),
    } as never,
    registry: { get: vi.fn(async () => ({ threadKey: KEY, containerName: 'cerberus-agent-x' })) } as never,
    runtime, events, log, tickMs: 10_000, debounceMs: 5,
  });
  return { hub, events, aborted };
}

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('DashboardHub', () => {
  it('sends a snapshot immediately on subscribe', async () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(OVERVIEW_CHANNEL);
    await flush();
    expect(socket.ofType('snapshot')).toHaveLength(1);
    expect(socket.ofType('snapshot')[0]!.channel).toBe(OVERVIEW_CHANNEL);
  });

  it('pushes a fresh snapshot when a lifecycle event fires', async () => {
    const { hub, events } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(OVERVIEW_CHANNEL);
    await flush();
    events.publish({ kind: 'agent_spawned', threadKey: KEY, at: 'now' });
    await flush();
    expect(socket.ofType('snapshot').length).toBeGreaterThanOrEqual(2);
  });

  it('debounces an event burst into a single extra snapshot', async () => {
    const { hub, events } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(OVERVIEW_CHANNEL);
    await flush();
    const before = socket.ofType('snapshot').length;
    for (let i = 0; i < 5; i++) events.publish({ kind: 'message_routed', threadKey: KEY, at: 'now' });
    await flush();
    expect(socket.ofType('snapshot').length).toBe(before + 1);
  });

  it('stops sending after unsubscribe', async () => {
    const { hub, events } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(threadChannel(KEY));
    await flush();
    socket.unsubscribe(threadChannel(KEY));
    const before = socket.sent.length;
    events.publish({ kind: 'agent_spawned', threadKey: KEY, at: 'now' });
    await flush();
    expect(socket.sent.length).toBe(before);
  });

  it('streams log lines and aborts the stream on unsubscribe', async () => {
    const { hub, aborted } = makeHub(['line-one', 'line-two']);
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(logsChannel(KEY));
    await flush();
    expect(socket.ofType('log').map((m) => (m as { line: string }).line)).toEqual(['line-one', 'line-two']);
    socket.unsubscribe(logsChannel(KEY));
    await flush();
    expect(aborted[0]!.aborted).toBe(true);
  });

  it('aborts log streams when the socket closes', async () => {
    const { hub, aborted } = makeHub(['x']);
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(logsChannel(KEY));
    await flush();
    socket.emit('close');
    await flush();
    expect(aborted[0]!.aborted).toBe(true);
  });

  it('answers ping with pong and rejects malformed messages', async () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.emit('message', JSON.stringify({ type: 'ping' }));
    socket.emit('message', 'not json');
    await flush();
    expect(socket.ofType('pong')).toHaveLength(1);
    expect(socket.ofType('error')).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/orchestrator/test/hub.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

`packages/orchestrator/src/api/hub.ts`:
```typescript
import {
  clientMessageSchema, logsChannel, OVERVIEW_CHANNEL, threadChannel,
  type ServerMessage,
} from '@cerberus/protocol';
import type { Logger } from '../observability/logger.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { EventBus } from './events.js';
import type { SnapshotBuilder } from './snapshots.js';

export interface HubSocket {
  send(data: string): void;
  on(event: 'message' | 'close', fn: (payload?: unknown) => void): void;
}

export interface HubDeps {
  snapshots: SnapshotBuilder;
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  events: EventBus;
  log: Logger;
  tickMs?: number;
  debounceMs?: number;
}

interface Client {
  socket: HubSocket;
  channels: Set<string>;
  logStreams: Map<string, AbortController>;
}

const LOG_TAIL = 200;

export class DashboardHub {
  private readonly clients = new Set<Client>();
  private readonly tickMs: number;
  private readonly debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(private readonly deps: HubDeps) {
    this.tickMs = deps.tickMs ?? 2000;
    this.debounceMs = deps.debounceMs ?? 100;
  }

  start(): void {
    this.unsubscribeEvents = this.deps.events.onEvent(() => this.scheduleFlush());
    // Reconcile tick: catches state the orchestrator never emits an event for
    // (a container dying on its own, mailbox depth, heartbeat expiry).
    this.timer = setInterval(() => void this.flush(), this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.unsubscribeEvents?.();
    for (const client of this.clients) this.disposeClient(client);
    this.clients.clear();
  }

  addClient(socket: HubSocket): () => void {
    const client: Client = { socket, channels: new Set(), logStreams: new Map() };
    this.clients.add(client);

    socket.on('message', (raw) => {
      void this.onMessage(client, raw);
    });
    socket.on('close', () => {
      this.disposeClient(client);
      this.clients.delete(client);
    });

    return () => {
      this.disposeClient(client);
      this.clients.delete(client);
    };
  }

  private async onMessage(client: Client, raw: unknown): Promise<void> {
    let parsed;
    try {
      parsed = clientMessageSchema.parse(JSON.parse(String(raw)));
    } catch {
      this.send(client, { type: 'error', message: 'malformed message' });
      return;
    }

    if (parsed.type === 'ping') {
      this.send(client, { type: 'pong' });
      return;
    }

    if (parsed.type === 'subscribe') {
      client.channels.add(parsed.channel);
      if (parsed.channel.startsWith('logs:')) {
        await this.startLogStream(client, parsed.channel);
      } else {
        await this.sendSnapshot(client, parsed.channel);
      }
      return;
    }

    client.channels.delete(parsed.channel);
    this.stopLogStream(client, parsed.channel);
  }

  private scheduleFlush(): void {
    if (this.debounce) return; // a flush is already pending; the burst collapses into it
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Re-send snapshots for every subscribed non-log channel. */
  private async flush(): Promise<void> {
    for (const client of this.clients) {
      for (const channel of client.channels) {
        if (channel.startsWith('logs:')) continue;
        await this.sendSnapshot(client, channel);
      }
    }
  }

  private async sendSnapshot(client: Client, channel: string): Promise<void> {
    try {
      if (channel === OVERVIEW_CHANNEL) {
        this.send(client, { type: 'snapshot', channel, data: await this.deps.snapshots.overview() });
        return;
      }
      if (channel.startsWith('thread:')) {
        const threadKey = channel.slice('thread:'.length);
        const detail = await this.deps.snapshots.detail(threadKey);
        if (!detail) {
          this.send(client, { type: 'error', channel, message: 'unknown thread' });
          return;
        }
        this.send(client, { type: 'snapshot', channel, data: detail });
        return;
      }
      this.send(client, { type: 'error', channel, message: 'unknown channel' });
    } catch (err) {
      this.deps.log.error({ err, channel }, 'snapshot failed');
      this.send(client, { type: 'error', channel, message: 'snapshot failed' });
    }
  }

  private async startLogStream(client: Client, channel: string): Promise<void> {
    const threadKey = channel.slice('logs:'.length);
    this.stopLogStream(client, channel);

    const record = await this.deps.registry.get(threadKey);
    const handle = record?.containerName ? await this.deps.runtime.inspect(record.containerName) : null;
    if (!handle) {
      this.send(client, { type: 'log_end', channel, reason: 'no container for this thread' });
      return;
    }

    const controller = new AbortController();
    client.logStreams.set(channel, controller);

    void (async () => {
      try {
        for await (const line of this.deps.runtime.logs(handle, {
          tail: LOG_TAIL, follow: true, signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          this.send(client, { type: 'log', channel, line });
        }
        if (!controller.signal.aborted) {
          this.send(client, { type: 'log_end', channel, reason: 'stream closed' });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          this.deps.log.warn({ err, threadKey }, 'log stream failed');
          this.send(client, { type: 'log_end', channel, reason: 'stream error' });
        }
      } finally {
        client.logStreams.delete(channel);
      }
    })();
  }

  private stopLogStream(client: Client, channel: string): void {
    const controller = client.logStreams.get(channel);
    if (!controller) return;
    controller.abort();
    client.logStreams.delete(channel);
  }

  private disposeClient(client: Client): void {
    for (const controller of client.logStreams.values()) controller.abort();
    client.logStreams.clear();
    client.channels.clear();
  }

  private send(client: Client, message: ServerMessage): void {
    try {
      client.socket.send(JSON.stringify(message));
    } catch (err) {
      this.deps.log.warn({ err }, 'failed to send to dashboard client');
    }
  }
}

export { OVERVIEW_CHANNEL, logsChannel, threadChannel };
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/orchestrator/test/hub.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && git add -A && git commit -m "feat(orchestrator): websocket hub with snapshots, debounce, and log streams"
```

---

### Task 8: Wire the console into the orchestrator

**Files:**
- Modify: `packages/orchestrator/src/observability/health.ts` (accept optional extra handlers + WS upgrade), `packages/orchestrator/src/app.ts`, `packages/orchestrator/src/config.ts`, `packages/orchestrator/Dockerfile`, `deploy/docker-compose.yml`, `README.md`, root `package.json`
- Test: none new (covered by Tasks 5–7 plus the manual browser check in Task 10)

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces: a running console at `http://localhost:8080/` when `DASHBOARD_ENABLED=true`.

- [ ] **Step 1: Extend the health server to host the console**

In `packages/orchestrator/src/observability/health.ts`, extend `HealthServerOptions`:
```typescript
export interface HealthServerOptions {
  port: number;
  metrics: Metrics;
  checks: Record<string, () => Promise<void>>;
  log: Logger;
  /** Tried in order before the built-in routes; the first to return true owns the request. */
  handlers?: Array<(req: IncomingMessage, res: ServerResponse) => Promise<boolean>>;
  /** Called on HTTP upgrade so the hub can accept WebSocket connections. */
  onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}
```
(add `import type { IncomingMessage, ServerResponse } from 'node:http';` and `import type { Duplex } from 'node:stream';`)

Inside the request handler, before the `/healthz` branch:
```typescript
      for (const handler of opts.handlers ?? []) {
        if (await handler(req, res)) return;
      }
```
and after `server.listen(...)`:
```typescript
  if (opts.onUpgrade) {
    server.on('upgrade', (req, socket, head) => opts.onUpgrade!(req, socket as Duplex, head));
  }
```

- [ ] **Step 2: Add config**

In `packages/orchestrator/src/config.ts`, add to the schema:
```typescript
  DASHBOARD_ENABLED: z.coerce.boolean().default(true),
  DASHBOARD_TOKEN: z.string().default(''),
  DASHBOARD_DIST: z.string().default(''),   // '' resolves to packages/dashboard/dist
```

- [ ] **Step 3: Wire it in the composition root**

In `packages/orchestrator/src/app.ts`, add imports:
```typescript
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { EventBus } from './api/events.js';
import { DashboardHub, type HubSocket } from './api/hub.js';
import { createApiHandler } from './api/routes.js';
import { SnapshotBuilder } from './api/snapshots.js';
import { createStaticHandler } from './api/static.js';
import { PostgresCapabilitiesRepo } from './registry/capabilities-repo.js';
```

Create the bus before the supervisor and pass it into supervisor, reaper, and router deps (`events`), then after the outbox/reaper/reconciler are constructed:
```typescript
  const capabilities = new PostgresCapabilitiesRepo(pool);
  const snapshots = new SnapshotBuilder({
    registry, runtime, capabilities, redis,
    runtimeName: cfg.RUNTIME, workspacesRoot: cfg.WORKSPACES_ROOT, log,
  });
  const hub = new DashboardHub({ snapshots, registry, runtime, events, log });
  const wss = new WebSocketServer({ noServer: true });
  const distDir = cfg.DASHBOARD_DIST ||
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'dist');
```

In `start()`, replace the `startHealthServer` call with:
```typescript
      const dashboardHandlers = cfg.DASHBOARD_ENABLED
        ? [
            createApiHandler({
              snapshots, capabilities, registry, runtime, supervisor,
              token: cfg.DASHBOARD_TOKEN, log,
            }),
            createStaticHandler(distDir),
          ]
        : [];

      health = await startHealthServer({
        port: cfg.HEALTH_PORT, metrics, log,
        checks: {
          redis: async () => { await redisRaw.ping(); },
          postgres: async () => { await pool.query('SELECT 1'); },
        },
        handlers: dashboardHandlers,
        onUpgrade: cfg.DASHBOARD_ENABLED
          ? (req, socket, head) => {
              const url = new URL(req.url ?? '/', 'http://localhost');
              if (url.pathname !== '/api/stream' || !isAuthorized(req, cfg.DASHBOARD_TOKEN)) {
                socket.destroy();
                return;
              }
              wss.handleUpgrade(req, socket, head, (ws) => hub.addClient(ws as unknown as HubSocket));
            }
          : undefined,
      });
      if (cfg.DASHBOARD_ENABLED) hub.start();
```
(import `isAuthorized` from `./api/routes.js`.)

In `shutdown()`, before closing the health server:
```typescript
      hub.stop();
      wss.close();
```

- [ ] **Step 4: Build the dashboard into the image**

Root `package.json` scripts — add:
```json
    "build:dashboard": "pnpm --filter @cerberus/dashboard build",
```

`packages/orchestrator/Dockerfile` — replace the copy/install block so the dashboard is built into the image:
```dockerfile
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/orchestrator packages/orchestrator
COPY packages/dashboard packages/dashboard
RUN pnpm install --frozen-lockfile --filter @cerberus/orchestrator... --filter @cerberus/dashboard... \
 && pnpm --filter @cerberus/dashboard build \
 && pnpm --filter @cerberus/dashboard exec rm -rf node_modules
WORKDIR /app/packages/orchestrator
ENV NODE_ENV=production
# Runs as root: needs /var/run/docker.sock. The orchestrator is the privileged component by design.
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
```

- [ ] **Step 5: Document it**

In `deploy/docker-compose.yml`, change the orchestrator ports entry to bind loopback explicitly and comment why:
```yaml
    # Console + health + metrics. Loopback-only: the console has the orchestrator's
    # privileges. Set DASHBOARD_TOKEN before exposing this beyond localhost.
    ports: ["127.0.0.1:8080:8080"]
```

In `README.md`, add a "Console" section after the quickstart: open `http://localhost:8080`, what the three screens show, the `DASHBOARD_TOKEN` / `DASHBOARD_ENABLED` env vars, and one line stating that log access equals conversation access.

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, full unit suite green.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(orchestrator): serve the console from the health server"
```

---

### Task 9: Dashboard — scaffold, design system, shell, overview

**Design references** (from Mobbin, dark infrastructure consoles):
- [Modal](https://mobbin.com/screens/c45ca886-b69b-4675-8ef3-abeb91ff887e) — card grid where each card's legend shows **exact current values** inline ("Live: 1 container", "Reserved: 0.11 cores"). Our agent cards copy this: stats read as `mailbox 0 · uptime 4m`.
- [Sentry](https://mobbin.com/screens/ac81ee7f-550f-4395-aafe-13da3dc10e05) — oversized single-number stat tiles above the detail content; muted label, huge value.
- [Neon](https://mobbin.com/screens/cf45e7bf-4a0e-40cc-9db5-a29845b58d4e) — left rail grouped by section, tiny uppercase legend labels, top-right control pills.
- [LangSmith](https://mobbin.com/screens/b7b317f3-20b0-4cf6-86af-c10ae16d0681) — every card has a title plus a one-line muted description; nav items carry count badges.

**Files:**
- Create: `packages/dashboard/{package.json,tsconfig.json,vite.config.ts,index.html}`
- Create: `packages/dashboard/src/{main.tsx,App.tsx,styles.css}`
- Create: `packages/dashboard/src/lib/{ws.ts,api.ts,format.ts}`
- Create: `packages/dashboard/src/components/{AppShell,OverviewBar,StatTile,AgentGrid,AgentCard,StatusPill,HeartbeatDot,ConnectionBadge}.tsx`

**Interfaces:**
- Consumes: `OverviewSnapshot`, `AgentSummary`, `ServerMessage`, `ClientMessage`, channel helpers from `@cerberus/protocol`.
- Produces: `useChannel<T>(channel: string | null): { data: T | null; status: ConnectionStatus }` and `useLogChannel(threadKey)` (Task 10) from `lib/ws.ts`; `api.getCapabilities/putCapabilities/stopAgent/restartAgent` from `lib/api.ts`.

- [ ] **Step 1: Scaffold the package**

`packages/dashboard/package.json`:
```json
{
  "name": "@cerberus/dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@cerberus/protocol": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.2",
    "vite": "^6.0.7"
  }
}
```

`packages/dashboard/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
}
```

`packages/dashboard/vite.config.ts`:
```typescript
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // `pnpm --filter @cerberus/dashboard dev` talks to a locally running orchestrator.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
```

`packages/dashboard/index.html`:
```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cerberus Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Install: `pnpm install`

- [ ] **Step 2: Design tokens**

`packages/dashboard/src/styles.css`:
```css
@import "tailwindcss";

@theme {
  --color-bg: #0b0c0e;
  --color-surface: #131519;
  --color-raised: #1a1d23;
  --color-line: #23262d;
  --color-line-strong: #2e323a;
  --color-ink: #e6e8eb;
  --color-muted: #9ba1aa;
  --color-dim: #6b717b;
  --color-accent: #38bdf8;
  --color-ok: #34d399;
  --color-warn: #fbbf24;
  --color-busy: #fb923c;
  --color-idle: #6b717b;
  --color-bad: #f87171;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}

html, body, #root { height: 100%; }
body {
  background: var(--color-bg);
  color: var(--color-ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Tiny uppercase legend labels, per the Neon reference. */
.label {
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-dim);
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.85); }
}
.pulse { animation: pulse-dot 1.6s ease-in-out infinite; }
```

- [ ] **Step 3: WebSocket client**

`packages/dashboard/src/lib/ws.ts`:
```typescript
import { useEffect, useRef, useState } from 'react';
import { serverMessageSchema, type ServerMessage } from '@cerberus/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

type Handler = (message: ServerMessage) => void;

/**
 * One shared socket for the whole app. Channels are reference-counted, so opening
 * a detail view and its log drawer reuses the same connection, and a reconnect
 * re-subscribes everything that is still mounted.
 */
class ConnectionManager {
  private socket: WebSocket | null = null;
  private backoffMs = 1000;
  private readonly channels = new Map<string, number>();
  private readonly handlers = new Set<Handler>();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private status: ConnectionStatus = 'connecting';

  private ensureSocket(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = new URLSearchParams(location.search).get('token');
    const url = `${proto}://${location.host}/api/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.backoffMs = 1000;
      this.setStatus('open');
      for (const channel of this.channels.keys()) this.send({ type: 'subscribe', channel });
    });
    socket.addEventListener('message', (event) => {
      const parsed = serverMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) return;
      for (const handler of this.handlers) handler(parsed.data);
    });
    socket.addEventListener('close', () => {
      this.setStatus('reconnecting');
      setTimeout(() => this.ensureSocket(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    });
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private send(message: { type: 'subscribe' | 'unsubscribe'; channel: string }): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  onStatus(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  subscribe(channel: string, handler: Handler): () => void {
    this.ensureSocket();
    this.handlers.add(handler);
    const count = this.channels.get(channel) ?? 0;
    this.channels.set(channel, count + 1);
    if (count === 0) this.send({ type: 'subscribe', channel });

    return () => {
      this.handlers.delete(handler);
      const remaining = (this.channels.get(channel) ?? 1) - 1;
      if (remaining <= 0) {
        this.channels.delete(channel);
        this.send({ type: 'unsubscribe', channel });
      } else {
        this.channels.set(channel, remaining);
      }
    };
  }
}

const manager = new ConnectionManager();

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  useEffect(() => manager.onStatus(setStatus), []);
  return status;
}

/** Subscribes to a snapshot channel; `null` unsubscribes. */
export function useChannel<T>(channel: string | null): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!channel) {
      setData(null);
      return;
    }
    setError(null);
    return manager.subscribe(channel, (message) => {
      if (message.type === 'snapshot' && message.channel === channel) {
        setData(message.data as T);
      } else if (message.type === 'error' && message.channel === channel) {
        setError(message.message);
      }
    });
  }, [channel]);

  return { data, error };
}

export interface LogState {
  lines: string[];
  ended: string | null;
}

/** Subscribes to a log channel, buffering while paused so resuming loses nothing. */
export function useLogChannel(channel: string | null, paused: boolean): LogState & { clear: () => void } {
  const [lines, setLines] = useState<string[]>([]);
  const [ended, setEnded] = useState<string | null>(null);
  const buffer = useRef<string[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!channel) return;
    setLines([]);
    setEnded(null);
    buffer.current = [];
    return manager.subscribe(channel, (message) => {
      if (message.channel !== channel) return;
      if (message.type === 'log') {
        if (pausedRef.current) buffer.current.push(message.line);
        else setLines((prev) => [...prev, message.line].slice(-2000));
      } else if (message.type === 'log_end') {
        setEnded(message.reason);
      }
    });
  }, [channel]);

  useEffect(() => {
    if (paused || buffer.current.length === 0) return;
    const flushed = buffer.current;
    buffer.current = [];
    setLines((prev) => [...prev, ...flushed].slice(-2000));
  }, [paused]);

  return { lines, ended, clear: () => setLines([]) };
}
```

- [ ] **Step 4: REST client and formatters**

`packages/dashboard/src/lib/api.ts`:
```typescript
import { capabilitiesSchema, type Capabilities } from '@cerberus/protocol';

function authHeaders(): HeadersInit {
  const token = new URLSearchParams(location.search).get('token');
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const api = {
  getCapabilities: (threadKey: string) =>
    request<Capabilities>(`/api/threads/${encodeURIComponent(threadKey)}/capabilities`),
  putCapabilities: (threadKey: string, caps: Capabilities) =>
    request<Capabilities>(`/api/threads/${encodeURIComponent(threadKey)}/capabilities`, {
      method: 'PUT',
      body: JSON.stringify(capabilitiesSchema.parse(caps)),
    }),
  stopAgent: (threadKey: string) =>
    request<{ stopped: boolean }>(`/api/threads/${encodeURIComponent(threadKey)}/stop`, { method: 'POST' }),
  restartAgent: (threadKey: string) =>
    request<{ outcome: string }>(`/api/threads/${encodeURIComponent(threadKey)}/restart`, { method: 'POST' }),
};
```

`packages/dashboard/src/lib/format.ts`:
```typescript
/** "4m", "2h 5m", "3d" — compact enough for a card stat line. */
export function since(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** Slack thread ts → local clock time. */
export function threadTime(threadTs: string): string {
  const seconds = Number(threadTs.split('.')[0]);
  if (!Number.isFinite(seconds)) return threadTs;
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const shortKey = (threadKey: string): string => threadKey.split('-').slice(1).join('-');
```

- [ ] **Step 5: Status primitives**

`packages/dashboard/src/components/StatusPill.tsx`:
```tsx
import type { ThreadStatusName } from '@cerberus/protocol';

const STYLES: Record<ThreadStatusName, string> = {
  running: 'bg-ok/10 text-ok border-ok/30',
  provisioning: 'bg-warn/10 text-warn border-warn/30',
  stopping: 'bg-busy/10 text-busy border-busy/30',
  stopped: 'bg-idle/10 text-muted border-line-strong',
  failed: 'bg-bad/10 text-bad border-bad/30',
};

export function StatusPill({ status }: { status: ThreadStatusName }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${STYLES[status]}`}>
      {status}
    </span>
  );
}
```

`packages/dashboard/src/components/HeartbeatDot.tsx`:
```tsx
export function HeartbeatDot({ alive }: { alive: boolean }) {
  return (
    <span
      title={alive ? 'Heartbeat fresh (< 30s)' : 'No heartbeat'}
      className={`inline-block size-2 rounded-full ${alive ? 'bg-ok pulse' : 'border border-line-strong bg-transparent'}`}
    />
  );
}
```

`packages/dashboard/src/components/ConnectionBadge.tsx`:
```tsx
import { useConnectionStatus } from '../lib/ws';

const COPY = {
  open: { text: 'live', className: 'text-ok' },
  connecting: { text: 'connecting', className: 'text-muted' },
  reconnecting: { text: 'reconnecting', className: 'text-warn' },
} as const;

export function ConnectionBadge() {
  const status = useConnectionStatus();
  const { text, className } = COPY[status];
  return (
    <span className={`flex items-center gap-2 text-xs ${className}`}>
      <span className={`size-1.5 rounded-full bg-current ${status === 'open' ? 'pulse' : ''}`} />
      {text}
    </span>
  );
}
```

- [ ] **Step 6: Stat tiles and agent cards**

`packages/dashboard/src/components/StatTile.tsx`:
```tsx
export function StatTile({ label, value, tone = 'ink' }: {
  label: string;
  value: number | string;
  tone?: 'ink' | 'ok' | 'warn' | 'bad';
}) {
  const color = { ink: 'text-ink', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' }[tone];
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="label">{label}</div>
      <div className={`mt-1 text-3xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
```

`packages/dashboard/src/components/OverviewBar.tsx`:
```tsx
import type { OverviewSnapshot } from '@cerberus/protocol';
import { StatTile } from './StatTile';

export function OverviewBar({ snapshot }: { snapshot: OverviewSnapshot }) {
  const { counts } = snapshot;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatTile label="Running" value={counts.running} tone="ok" />
      <StatTile label="Provisioning" value={counts.provisioning} tone="warn" />
      <StatTile label="Stopped" value={counts.stopped} />
      <StatTile label="Failed" value={counts.failed} tone={counts.failed > 0 ? 'bad' : 'ink'} />
      <StatTile label="Threads" value={counts.total} />
    </div>
  );
}
```

`packages/dashboard/src/components/AgentCard.tsx`:
```tsx
import type { AgentSummary } from '@cerberus/protocol';
import { since, threadTime } from '../lib/format';
import { HeartbeatDot } from './HeartbeatDot';
import { StatusPill } from './StatusPill';

export function AgentCard({ agent, onOpen }: { agent: AgentSummary; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="group rounded-lg border border-line bg-surface p-4 text-left transition
                 hover:border-line-strong hover:bg-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm text-ink">{agent.channelId}</div>
          <div className="mt-0.5 text-xs text-dim">thread {threadTime(agent.threadTs)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <HeartbeatDot alive={agent.heartbeatFresh} />
          <StatusPill status={agent.status} />
        </div>
      </div>

      {/* Inline current-value legend, after the Modal reference. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted">
        <span>mailbox <span className="text-ink tabular-nums">{agent.mailboxDepth}</span></span>
        <span className="text-line-strong">·</span>
        <span>active <span className="text-ink tabular-nums">{since(agent.lastActivityAt)}</span> ago</span>
        <span className="text-line-strong">·</span>
        <span>
          container{' '}
          <span className={agent.containerRunning ? 'text-ok' : 'text-dim'}>
            {agent.containerRunning ? 'up' : 'down'}
          </span>
        </span>
        {agent.failureCount > 0 && (
          <>
            <span className="text-line-strong">·</span>
            <span className="text-bad">{agent.failureCount} failures</span>
          </>
        )}
      </div>
    </button>
  );
}
```

`packages/dashboard/src/components/AgentGrid.tsx`:
```tsx
import type { AgentSummary } from '@cerberus/protocol';
import { AgentCard } from './AgentCard';

export function AgentGrid({ agents, onOpen }: {
  agents: AgentSummary[];
  onOpen: (threadKey: string) => void;
}) {
  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface/50 px-6 py-16 text-center">
        <div className="text-sm text-muted">No threads yet</div>
        <div className="mt-1 text-xs text-dim">Mention the bot in Slack and its agent will appear here.</div>
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {agents.map((agent) => (
        <AgentCard key={agent.threadKey} agent={agent} onOpen={() => onOpen(agent.threadKey)} />
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Shell and app**

`packages/dashboard/src/components/AppShell.tsx`:
```tsx
import type { ReactNode } from 'react';
import { ConnectionBadge } from './ConnectionBadge';

export function AppShell({ title, subtitle, actions, children }: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface/60 px-4 py-5 lg:flex">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md bg-accent/15 text-sm">🐕</span>
          <span className="font-semibold tracking-tight">Cerberus</span>
        </div>
        <div className="mt-8 label">Fleet</div>
        <nav className="mt-2 space-y-1 text-sm">
          <span className="block rounded-md bg-raised px-2 py-1.5 text-ink">Agents</span>
        </nav>
        <div className="mt-auto space-y-1 text-xs text-dim">
          <a className="block hover:text-muted" href="/metrics">Metrics</a>
          <a className="block hover:text-muted" href="/readyz">Readiness</a>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="truncate text-xs text-dim">{subtitle}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {actions}
            <ConnectionBadge />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </main>
    </div>
  );
}
```

`packages/dashboard/src/App.tsx` (Task 10 replaces the detail placeholder):
```tsx
import { useState } from 'react';
import { OVERVIEW_CHANNEL, type OverviewSnapshot } from '@cerberus/protocol';
import { AgentGrid } from './components/AgentGrid';
import { AppShell } from './components/AppShell';
import { OverviewBar } from './components/OverviewBar';
import { useChannel } from './lib/ws';

export default function App() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data } = useChannel<OverviewSnapshot>(OVERVIEW_CHANNEL);

  const subtitle = data
    ? `${data.runtime} runtime${data.runtimeHealthy ? '' : ' — unreachable'}`
    : 'connecting…';

  return (
    <AppShell title="Agents" subtitle={subtitle}>
      {!data ? (
        <div className="text-sm text-dim">Loading fleet…</div>
      ) : (
        <div className="space-y-5">
          {!data.runtimeHealthy && (
            <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn">
              Container runtime unreachable — showing registry state only.
            </div>
          )}
          <OverviewBar snapshot={data} />
          <AgentGrid agents={data.agents} onOpen={setSelected} />
          {selected && <div className="text-xs text-dim">Selected {selected}</div>}
        </div>
      )}
    </AppShell>
  );
}
```

`packages/dashboard/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 8: Build and verify**

Run: `pnpm typecheck && pnpm build:dashboard`
Expected: typecheck clean; `packages/dashboard/dist/index.html` plus hashed assets exist.

Then with the stack running (`cd deploy && docker compose up --build -d`), open `http://localhost:8080` and confirm: the shell renders dark, the connection badge reads **live**, stat tiles show real counts, and any existing thread appears as a card.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(dashboard): console shell, live overview, and agent grid"
```

---

### Task 10: Dashboard — agent detail, capabilities, log drawer

**Files:**
- Create: `packages/dashboard/src/components/{AgentDetail,LifecycleTimeline,ConversationView,CapabilityPanel,LogDrawer,TabBar}.tsx`
- Modify: `packages/dashboard/src/App.tsx` (render detail for the selected agent)

**Interfaces:**
- Consumes: `useChannel<AgentDetail>(threadChannel(key))`, `useLogChannel(logsChannel(key), paused)`, `api.*` (Task 9), `AgentDetail`, `Capabilities`, `DEFAULT_TOOLS` from `@cerberus/protocol`.

- [ ] **Step 1: Tab bar**

`packages/dashboard/src/components/TabBar.tsx`:
```tsx
export function TabBar<T extends string>({ tabs, active, onChange }: {
  tabs: readonly T[];
  active: T;
  onChange: (tab: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onChange(tab)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize transition ${
            tab === active
              ? 'border-accent text-ink'
              : 'border-transparent text-muted hover:text-ink'
          }`}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Lifecycle timeline and conversation**

`packages/dashboard/src/components/LifecycleTimeline.tsx`:
```tsx
import type { AgentDetail } from '@cerberus/protocol';
import { since } from '../lib/format';

export function LifecycleTimeline({ agent }: { agent: AgentDetail }) {
  const rows = [
    { label: 'Created', value: new Date(agent.createdAt).toLocaleString(), hint: `${since(agent.createdAt)} ago` },
    { label: 'Last activity', value: new Date(agent.lastActivityAt).toLocaleString(), hint: `${since(agent.lastActivityAt)} ago` },
    { label: 'Container', value: agent.containerName ?? '—', hint: agent.containerRunning ? 'running' : 'not running' },
    { label: 'Container id', value: agent.containerId?.slice(0, 12) ?? '—', hint: agent.runtime },
    { label: 'Workspace', value: agent.workspacePath, hint: 'persists across restarts' },
    { label: 'Mailbox depth', value: String(agent.mailboxDepth), hint: 'unread messages' },
    { label: 'Failures', value: String(agent.failureCount), hint: agent.failureCount > 0 ? 'spawn errors' : 'none' },
  ];

  return (
    <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline gap-4 px-4 py-2.5">
          <dt className="w-32 shrink-0 text-xs text-dim">{row.label}</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-sm text-ink">{row.value}</dd>
          <dd className="shrink-0 text-xs text-dim">{row.hint}</dd>
        </div>
      ))}
    </dl>
  );
}
```

`packages/dashboard/src/components/ConversationView.tsx`:
```tsx
import type { ConversationEntry } from '@cerberus/protocol';

export function ConversationView({ entries }: { entries: ConversationEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-dim">No messages yet in this thread's workspace.</p>;
  }
  return (
    <ol className="space-y-2">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className={`rounded-lg border px-4 py-2.5 ${
            entry.role === 'user' ? 'border-line bg-surface' : 'border-accent/20 bg-accent/5'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="label">{entry.role}</span>
            <span className="text-xs text-dim">{new Date(entry.ts).toLocaleTimeString()}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{entry.text}</p>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 3: Capability panel**

`packages/dashboard/src/components/CapabilityPanel.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { capabilitiesSchema, DEFAULT_TOOLS, type Capabilities } from '@cerberus/protocol';
import { api } from '../lib/api';

const TOOL_COPY: Record<keyof typeof DEFAULT_TOOLS, { name: string; hint: string }> = {
  web_search: { name: 'Web search', hint: 'Look things up online' },
  code_execution: { name: 'Code execution', hint: 'Run code in the workspace' },
  file_access: { name: 'File access', hint: 'Read and write /workspace' },
  mcp_connectors: { name: 'MCP connectors', hint: 'External tool servers' },
};

const MODELS = ['stub', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];

export function CapabilityPanel({ threadKey, initial }: { threadKey: string; initial: Capabilities }) {
  const [draft, setDraft] = useState<Capabilities>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(initial.updatedAt);

  useEffect(() => { setDraft(initial); setSavedAt(initial.updatedAt); }, [threadKey]);

  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...initial, updatedAt: initial.updatedAt });

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.putCapabilities(threadKey, capabilitiesSchema.parse(draft));
      setDraft(saved);
      setSavedAt(saved.updatedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
        Configuration preview — stored for later, not yet enforced by the runtime.
      </div>

      <section className="rounded-lg border border-line bg-surface p-4">
        <h3 className="text-sm font-medium">Tools</h3>
        <p className="mt-0.5 text-xs text-dim">What this agent will be allowed to do.</p>
        <div className="mt-3 space-y-1">
          {(Object.keys(TOOL_COPY) as Array<keyof typeof DEFAULT_TOOLS>).map((tool) => (
            <label key={tool} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-raised">
              <input
                type="checkbox"
                checked={draft.tools[tool]}
                onChange={(e) => setDraft({ ...draft, tools: { ...draft.tools, [tool]: e.target.checked } })}
                className="size-4 accent-[var(--color-accent)]"
              />
              <span className="flex-1">
                <span className="block text-sm text-ink">{TOOL_COPY[tool].name}</span>
                <span className="block text-xs text-dim">{TOOL_COPY[tool].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-line bg-surface p-4">
        <h3 className="text-sm font-medium">Model</h3>
        <select
          value={draft.model}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          className="mt-2 w-full rounded-md border border-line-strong bg-bg px-3 py-2 font-mono text-sm text-ink"
        >
          {MODELS.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </section>

      <section className="rounded-lg border border-line bg-surface p-4">
        <h3 className="text-sm font-medium">Resource limits</h3>
        <div className="mt-3 space-y-4">
          <Slider label="CPU" unit="cores" min={0.25} max={4} step={0.25}
            value={draft.cpu} onChange={(cpu) => setDraft({ ...draft, cpu })} />
          <Slider label="Memory" unit="MB" min={128} max={4096} step={128}
            value={draft.memoryMb} onChange={(memoryMb) => setDraft({ ...draft, memoryMb })} />
          <Slider label="PIDs" unit="max" min={32} max={1024} step={32}
            value={draft.pidsLimit} onChange={(pidsLimit) => setDraft({ ...draft, pidsLimit })} />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {error && <span className="text-xs text-bad">{error}</span>}
        {!error && savedAt && (
          <span className="text-xs text-dim">Saved {new Date(savedAt).toLocaleTimeString()}</span>
        )}
      </div>
    </div>
  );
}

function Slider({ label, unit, min, max, step, value, onChange }: {
  label: string; unit: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-sm text-ink">{label}</span>
        <span className="font-mono text-sm text-muted tabular-nums">{value} {unit}</span>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-[var(--color-accent)]"
      />
    </label>
  );
}
```

- [ ] **Step 4: Log drawer**

`packages/dashboard/src/components/LogDrawer.tsx`:
```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { logsChannel } from '@cerberus/protocol';
import { useLogChannel } from '../lib/ws';

export function LogDrawer({ threadKey, onClose }: { threadKey: string; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const { lines, ended, clear } = useLogChannel(logsChannel(threadKey), paused);
  const bottom = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => (filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines),
    [lines, filter],
  );

  useEffect(() => {
    if (!paused) bottom.current?.scrollIntoView({ block: 'end' });
  }, [visible.length, paused]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/50" onClick={onClose}>
      <section
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-3xl flex-col border-l border-line bg-bg shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">Container logs</h2>
            <p className="truncate font-mono text-xs text-dim">{threadKey}</p>
          </div>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className="w-40 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs text-ink placeholder:text-dim"
          />
          <button onClick={() => setPaused((p) => !p)}
            className="rounded-md border border-line-strong px-2 py-1 text-xs text-muted hover:text-ink">
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={() => void navigator.clipboard.writeText(lines.join('\n'))}
            className="rounded-md border border-line-strong px-2 py-1 text-xs text-muted hover:text-ink">
            Copy
          </button>
          <button onClick={clear}
            className="rounded-md border border-line-strong px-2 py-1 text-xs text-muted hover:text-ink">
            Clear
          </button>
          <button onClick={onClose} className="px-1 text-lg leading-none text-muted hover:text-ink">×</button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-black/40 px-4 py-3">
          {visible.length === 0 && !ended && <p className="text-xs text-dim">Waiting for output…</p>}
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-ink">
            {visible.join('\n')}
          </pre>
          {ended && <p className="mt-3 text-xs text-warn">Stream ended: {ended}</p>}
          <div ref={bottom} />
        </div>

        <footer className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-dim">
          <span>{visible.length} lines{filter && ` (filtered from ${lines.length})`}</span>
          {paused && <span className="text-warn">paused — buffering</span>}
        </footer>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Agent detail**

`packages/dashboard/src/components/AgentDetail.tsx`:
```tsx
import { useState } from 'react';
import { threadChannel, type AgentDetail as Detail } from '@cerberus/protocol';
import { api } from '../lib/api';
import { useChannel } from '../lib/ws';
import { CapabilityPanel } from './CapabilityPanel';
import { ConversationView } from './ConversationView';
import { HeartbeatDot } from './HeartbeatDot';
import { LifecycleTimeline } from './LifecycleTimeline';
import { LogDrawer } from './LogDrawer';
import { StatusPill } from './StatusPill';
import { TabBar } from './TabBar';

const TABS = ['overview', 'conversation', 'capabilities'] as const;
type Tab = (typeof TABS)[number];

export function AgentDetail({ threadKey, onBack }: { threadKey: string; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { data, error } = useChannel<Detail>(threadChannel(threadKey));

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try { await fn(); } finally { setBusy(null); }
  }

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!data) return <p className="text-sm text-dim">Loading agent…</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="text-sm text-muted hover:text-ink">← Agents</button>
        <span className="font-mono text-sm text-ink">{data.channelId}</span>
        <StatusPill status={data.status} />
        <HeartbeatDot alive={data.heartbeatFresh} />
        <div className="ml-auto flex gap-2">
          <button onClick={() => setShowLogs(true)}
            className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-muted hover:text-ink">
            Logs
          </button>
          <button
            disabled={busy !== null || !data.containerRunning}
            onClick={() => void act('stop', () => api.stopAgent(threadKey))}
            className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-muted hover:text-ink disabled:opacity-40"
          >
            {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
          <button
            disabled={busy !== null}
            onClick={() => void act('restart', () => api.restartAgent(threadKey))}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-40"
          >
            {busy === 'restart' ? 'Starting…' : 'Restart'}
          </button>
        </div>
      </div>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'overview' && <LifecycleTimeline agent={data} />}
      {tab === 'conversation' && <ConversationView entries={data.conversation} />}
      {tab === 'capabilities' && <CapabilityPanel threadKey={threadKey} initial={data.capabilities} />}

      {showLogs && <LogDrawer threadKey={threadKey} onClose={() => setShowLogs(false)} />}
    </div>
  );
}
```

- [ ] **Step 6: Route it from App**

Replace the body of `packages/dashboard/src/App.tsx` with:
```tsx
import { useState } from 'react';
import { OVERVIEW_CHANNEL, type OverviewSnapshot } from '@cerberus/protocol';
import { AgentDetail } from './components/AgentDetail';
import { AgentGrid } from './components/AgentGrid';
import { AppShell } from './components/AppShell';
import { OverviewBar } from './components/OverviewBar';
import { useChannel } from './lib/ws';

export default function App() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data } = useChannel<OverviewSnapshot>(selected ? null : OVERVIEW_CHANNEL);

  if (selected) {
    return (
      <AppShell title="Agent" subtitle={selected}>
        <AgentDetail threadKey={selected} onBack={() => setSelected(null)} />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Agents"
      subtitle={data ? `${data.runtime} runtime${data.runtimeHealthy ? '' : ' — unreachable'}` : 'connecting…'}
    >
      {!data ? (
        <div className="text-sm text-dim">Loading fleet…</div>
      ) : (
        <div className="space-y-5">
          {!data.runtimeHealthy && (
            <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn">
              Container runtime unreachable — showing registry state only.
            </div>
          )}
          <OverviewBar snapshot={data} />
          <AgentGrid agents={data.agents} onOpen={setSelected} />
        </div>
      )}
    </AppShell>
  );
}
```

- [ ] **Step 7: Build and verify in a real browser**

Run: `pnpm typecheck && pnpm build:dashboard && cd deploy && docker compose up --build -d`

Then at `http://localhost:8080`, confirm each of these against a live thread (mention the bot in Slack to create one):
1. The new agent card appears within ~2s without a page reload.
2. Opening it shows the lifecycle table with the real container name and workspace path.
3. **Conversation** lists the messages exchanged in that Slack thread.
4. **Logs** streams the agent's output live (the `user message …` / `reply …` lines from the agent logging), and Pause holds the view while Resume flushes the buffered lines.
5. **Capabilities**: toggle a tool, move a slider, Save; reload the page and the values persist.
6. Stop the agent from the detail header — the card's container indicator flips to `down` and the status pill updates without a reload.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(dashboard): agent detail, capability panel, and live log drawer"
```

---

## Plan Self-Review Notes

- **Spec coverage:** architecture (Tasks 6–8), WS channels + event/tick push (2, 7), log streaming (3, 7, 10), three screens (9, 10), capabilities mock incl. the not-enforced banner (1, 4, 6, 10), API surface (6), config + token auth (6, 8), security/static traversal (6), failure scenarios — reconnect (9), runtime unreachable (5, 9), log end (7, 10), unknown-thread 404 (6), missing assets 503 (6) — testing (each task) and README/compose docs (8).
- **Deliberate deviation from the spec:** the spec sketched separate `server.ts`; the plan instead extends the existing health server via `handlers`/`onUpgrade`, which avoids a second HTTP listener on the same port. Same behavior, one less moving part.
- **K8s log following is polled** (2s) rather than streamed, to avoid pulling in a SPDY client; the Docker path — the one used today — is a true follow stream.
- **No frontend unit tests:** the console's logic worth testing (snapshot shaping, hub behavior, log teardown) lives server-side and is covered there; the UI is verified by driving it in a browser per Task 10 Step 7.


