# Activity and System Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two console destinations from `docs/superpowers/specs/2026-07-19-console-activity-system-design.md`: a live fleet-wide Activity feed, and a read-only System view with a fleet drain switch.

**Architecture:** An `ActivityLog` subscribes to the existing in-process `EventBus` and keeps the last 500 events in a ring buffer, served over a new `activity` WebSocket channel (snapshot on subscribe, deltas after) and `GET /api/activity`. A `DrainState` flag is consulted by `ThreadSupervisor` and toggled through `POST /api/system/drain`. `GET /api/system` reports resolved config, Slack connection state, and dependency health, with no secrets.

**Tech Stack:** TypeScript ESM, zod, `ws`, React 19 + Tailwind v4, vitest.

## Global Constraints

- All wire types live once in `packages/protocol/src/dashboard.ts` and are imported by both orchestrator and dashboard. No shape is redefined.
- **No secret may appear in `SystemInfo`.** Slack tokens, `REDIS_URL`, `AGENT_REDIS_URL`, `DATABASE_URL`, and `DASHBOARD_TOKEN` are excluded; the dashboard token is reported only as the boolean `dashboardTokenSet`. A test asserts the serialised payload contains none of those values.
- Activity buffer capacity is 500, newest first. The client trims to the same cap.
- WS channel names are exactly `overview`, `activity`, `thread:<threadKey>`, `logs:<threadKey>`.
- `EnsureOutcome` becomes `'already-running' | 'spawned' | 'deferred' | 'failed' | 'drained'`.
- Draining never stops running agents and never drops messages: the mailbox write already happens before `ensureRunning`.
- Timestamps on the wire are ISO-8601 strings. Dark theme tokens only, no ad-hoc hex in components.
- Strict ESM `.js` import extensions. `pnpm -r typecheck` and `pnpm test` green before every commit. Conventional commits.

## File map

```
packages/protocol/src/dashboard.ts                     # + ActivityEvent, SystemInfo, activity message
packages/orchestrator/src/api/activity.ts              # new: ActivityLog
packages/orchestrator/src/lifecycle/drain.ts           # new: DrainState
packages/orchestrator/src/lifecycle/supervisor.ts      # + drain check, 'drained'
packages/orchestrator/src/slack/gateway.ts             # + getStatus()
packages/orchestrator/src/mailbox/outbox-consumer.ts   # + reply_posted
packages/orchestrator/src/api/events.ts                # + reply_posted kind
packages/orchestrator/src/api/hub.ts                   # + activity channel
packages/orchestrator/src/api/routes.ts                # + /api/activity, /api/system, /api/system/drain
packages/orchestrator/src/slack/router.ts              # drained message
packages/orchestrator/src/app.ts                       # wiring
packages/dashboard/src/components/{ActivityView,SystemView,AppShell}.tsx
packages/dashboard/src/App.tsx                         # view router
packages/dashboard/src/lib/api.ts                      # + getSystem, setDrain
```

---

### Task 1: Protocol types, ActivityLog, DrainState

**Files:**
- Modify: `packages/protocol/src/dashboard.ts`, `packages/orchestrator/src/api/events.ts`
- Create: `packages/orchestrator/src/api/activity.ts`, `packages/orchestrator/src/lifecycle/drain.ts`
- Test: `packages/orchestrator/test/activity.test.ts`, `packages/orchestrator/test/drain.test.ts`

**Interfaces:**
- Consumes: `EventBus` and `CerberusEvent` from `../api/events.js`.
- Produces: `ActivityEvent`, `SystemInfo` types and the `activity` server message (protocol); `ActivityLog` and `DrainState` classes. Tasks 2 to 4 consume all of these.

- [ ] **Step 1: Add the `reply_posted` event kind**

In `packages/orchestrator/src/api/events.ts`, change the `kind` union to:
```typescript
  kind: 'agent_spawned' | 'agent_stopped' | 'agent_failed' | 'message_routed' | 'reply_posted';
```

- [ ] **Step 2: Add protocol types**

Append to `packages/protocol/src/dashboard.ts`:
```typescript
export const ACTIVITY_CHANNEL = 'activity';

export type ActivityKind =
  | 'agent_spawned' | 'agent_stopped' | 'agent_failed' | 'message_routed' | 'reply_posted';

export interface ActivityEvent {
  /** ULID, stable key for the UI. */
  id: string;
  kind: ActivityKind;
  threadKey: string;
  /** ISO-8601 */
  at: string;
}

export interface SystemInfo {
  runtime: 'docker' | 'k8s';
  agentImage: string;
  versions: { orchestrator: string; node: string };
  config: {
    idleTimeoutMs: number;
    reaperIntervalMs: number;
    maxConcurrentAgents: number;
    agentCpu: number;
    agentMemoryMb: number;
    agentPidsLimit: number;
    workspacesRoot: string;
    logLevel: string;
    dashboardEnabled: boolean;
    /** Never the token itself. */
    dashboardTokenSet: boolean;
  };
  slack: {
    connected: boolean;
    botUserId: string | null;
    botName: string | null;
    teamName: string | null;
    lastEventAt: string | null;
  };
  dependencies: { redis: 'ok' | 'error'; postgres: 'ok' | 'error'; runtime: 'ok' | 'error' };
  drain: { enabled: boolean; since: string | null };
}
```
and add this member to the `serverMessageSchema` discriminated union, after the `log_end` member:
```typescript
  z.object({
    type: z.literal('activity'),
    events: z.array(z.object({
      id: z.string(), kind: z.string(), threadKey: z.string(), at: z.string(),
    })),
  }),
```

- [ ] **Step 3: Write the failing tests**

`packages/orchestrator/test/activity.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest';
import { EventBus, type CerberusEvent } from '../src/api/events.js';
import { ActivityLog } from '../src/api/activity.js';

const evt = (threadKey: string, kind: CerberusEvent['kind'] = 'agent_spawned'): CerberusEvent => ({
  kind, threadKey, at: new Date().toISOString(),
});

describe('ActivityLog', () => {
  it('records published events newest first', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    bus.publish(evt('k1'));
    bus.publish(evt('k2'));
    expect(log.recent().map((e) => e.threadKey)).toEqual(['k2', 'k1']);
  });

  it('stamps each event with a unique id', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    bus.publish(evt('k1'));
    bus.publish(evt('k1'));
    const [a, b] = log.recent();
    expect(a!.id).not.toBe(b!.id);
  });

  it('drops the oldest entries beyond capacity', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus, 3);
    for (const k of ['a', 'b', 'c', 'd']) bus.publish(evt(k));
    expect(log.recent().map((e) => e.threadKey)).toEqual(['d', 'c', 'b']);
  });

  it('honours the limit argument', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    for (const k of ['a', 'b', 'c']) bus.publish(evt(k));
    expect(log.recent(2).map((e) => e.threadKey)).toEqual(['c', 'b']);
  });

  it('notifies listeners of each new event and stops after unsubscribe', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    const seen = vi.fn();
    const off = log.onEvent(seen);
    bus.publish(evt('k1'));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0]).toMatchObject({ threadKey: 'k1', kind: 'agent_spawned' });
    off();
    bus.publish(evt('k2'));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('stop() detaches from the bus', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    log.stop();
    bus.publish(evt('k1'));
    expect(log.recent()).toEqual([]);
  });
});
```

`packages/orchestrator/test/drain.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { DrainState } from '../src/lifecycle/drain.js';

describe('DrainState', () => {
  it('starts disabled with no timestamp', () => {
    const drain = new DrainState();
    expect(drain.enabled).toBe(false);
    expect(drain.since).toBeNull();
  });

  it('records when draining began and clears it on resume', () => {
    const drain = new DrainState();
    drain.set(true);
    expect(drain.enabled).toBe(true);
    expect(typeof drain.since).toBe('string');
    drain.set(false);
    expect(drain.enabled).toBe(false);
    expect(drain.since).toBeNull();
  });

  it('keeps the original timestamp when enabled twice', () => {
    const drain = new DrainState();
    drain.set(true);
    const first = drain.since;
    drain.set(true);
    expect(drain.since).toBe(first);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run packages/orchestrator/test/activity.test.ts packages/orchestrator/test/drain.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 5: Implement**

`packages/orchestrator/src/api/activity.ts`:
```typescript
import { ulid } from 'ulid';
import type { ActivityEvent } from '@cerberus/protocol';
import type { EventBus } from './events.js';

const DEFAULT_CAPACITY = 500;

type Listener = (event: ActivityEvent) => void;

/**
 * A bounded, in-memory feed of lifecycle events. Deliberately not persisted: this answers
 * "what just happened", and a restart clearing it is acceptable. Forensics across restarts
 * would need Postgres, which the design explicitly leaves out of scope.
 */
export class ActivityLog {
  private readonly buffer: ActivityEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private unsubscribe: (() => void) | null;

  constructor(events: EventBus, private readonly capacity = DEFAULT_CAPACITY) {
    this.unsubscribe = events.onEvent((event) => {
      const entry: ActivityEvent = {
        id: ulid(), kind: event.kind, threadKey: event.threadKey, at: event.at,
      };
      this.buffer.push(entry);
      if (this.buffer.length > this.capacity) this.buffer.shift();
      for (const listener of this.listeners) {
        try {
          listener(entry);
        } catch {
          // Contained: publishing runs on the lifecycle hot path.
        }
      }
    });
  }

  /** Newest first, so the UI renders without re-sorting. */
  recent(limit = this.capacity): ActivityEvent[] {
    return this.buffer.slice(-limit).reverse();
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}
```

`packages/orchestrator/src/lifecycle/drain.ts`:
```typescript
/**
 * Fleet-wide pause on spawning, for deploys. Process-local and in-memory, matching the
 * single-replica orchestrator. Draining never stops running agents and never drops
 * messages: the mailbox write happens before ensureRunning, so anything arriving while
 * drained is processed once draining ends.
 */
export class DrainState {
  private draining = false;
  private startedAt: string | null = null;

  get enabled(): boolean {
    return this.draining;
  }

  get since(): string | null {
    return this.startedAt;
  }

  set(enabled: boolean): void {
    if (enabled === this.draining) return; // keep the original timestamp
    this.draining = enabled;
    this.startedAt = enabled ? new Date().toISOString() : null;
  }
}
```

- [ ] **Step 6: Run tests and commit**

Run: `pnpm vitest run packages/orchestrator/test/activity.test.ts packages/orchestrator/test/drain.test.ts && pnpm typecheck && pnpm test`
Expected: 9 new tests pass, full suite green.

```bash
git add -A && git commit -m "feat(orchestrator): activity ring buffer and drain state"
```

---

### Task 2: Drain enforcement, event coverage, Slack status

**Files:**
- Modify: `packages/orchestrator/src/lifecycle/supervisor.ts`, `packages/orchestrator/src/slack/router.ts`, `packages/orchestrator/src/mailbox/outbox-consumer.ts`, `packages/orchestrator/src/slack/gateway.ts`
- Test: `packages/orchestrator/test/supervisor.test.ts` (add cases), `packages/orchestrator/test/outbox-consumer.test.ts` (add case)

**Interfaces:**
- Consumes: `DrainState` (Task 1), `EventBus`.
- Produces: `EnsureOutcome` gains `'drained'`; `SlackGateway.getStatus(): SlackStatus` where
```typescript
export interface SlackStatus {
  connected: boolean;
  botUserId: string | null;
  botName: string | null;
  teamName: string | null;
  lastEventAt: string | null;
}
```
Task 3 consumes both.

- [ ] **Step 1: Supervisor honours drain**

In `packages/orchestrator/src/lifecycle/supervisor.ts`:

Change the outcome type (line 24) to:
```typescript
export type EnsureOutcome = 'already-running' | 'spawned' | 'deferred' | 'failed' | 'drained';
```
Add `import type { DrainState } from './drain.js';` and add to `SupervisorDeps`:
```typescript
  drain?: DrainState;
```
In `ensureLocked`, immediately **before** the `countByStatus('running')` concurrency check, insert:
```typescript
    if (this.deps.drain?.enabled) {
      // Deploys pause spawning fleet-wide. The message is already in the mailbox, so it is
      // processed once draining ends rather than lost.
      return { record, outcome: 'drained' };
    }
```

- [ ] **Step 2: Router explains draining distinctly**

In `packages/orchestrator/src/slack/router.ts`, in the outcome handling, add a branch before the `deferred` one:
```typescript
    if (outcome === 'drained') {
      await poster.postToThread(threadKey, ':construction: Cerberus is being updated. Your message is queued and will be answered shortly.');
    } else if (outcome === 'failed') {
```
so the chain reads `drained`, then `failed`, then `deferred`. Keep the existing `failed` and `deferred` bodies unchanged.

- [ ] **Step 3: Outbox publishes reply_posted**

In `packages/orchestrator/src/mailbox/outbox-consumer.ts`, add `import type { EventBus } from '../api/events.js';`, extend the constructor with a fifth optional parameter `private readonly events?: EventBus`, and immediately after the `await this.poster.postToThread(decoded.threadKey, decoded.text);` line add:
```typescript
        this.events?.publish({
          kind: 'reply_posted', threadKey: decoded.threadKey, at: new Date().toISOString(),
        });
```

- [ ] **Step 4: Gateway reports connection state**

In `packages/orchestrator/src/slack/gateway.ts`, add the exported interface above the class:
```typescript
export interface SlackStatus {
  connected: boolean;
  botUserId: string | null;
  botName: string | null;
  teamName: string | null;
  lastEventAt: string | null;
}
```
Add a private field to `SlackGateway`:
```typescript
  private status: SlackStatus = {
    connected: false, botUserId: null, botName: null, teamName: null, lastEventAt: null,
  };
```
At the top of `dispatch`, before the routerRef check, add:
```typescript
    this.status.lastEventAt = new Date().toISOString();
```
Replace `start()` with:
```typescript
  async start(): Promise<void> {
    await this.app.start();
    this.status.connected = true;
    try {
      const auth = await this.app.client.auth.test();
      this.status.botUserId = (auth.user_id as string | undefined) ?? null;
      this.status.botName = (auth.user as string | undefined) ?? null;
      this.status.teamName = (auth.team as string | undefined) ?? null;
    } catch (err) {
      // Identity is a nicety; a failure here must not stop the orchestrator booting.
      this.log.warn({ err }, 'could not resolve slack identity');
    }
  }

  getStatus(): SlackStatus {
    return { ...this.status };
  }
```
and in `stop()`, add `this.status.connected = false;` before `await this.app.stop();`.

- [ ] **Step 5: Add the tests**

Append to the supervisor describe block in `packages/orchestrator/test/supervisor.test.ts` (add `import { DrainState } from '../src/lifecycle/drain.js';`). The existing file builds a supervisor through a local helper; extend that helper to accept and pass through an optional `drain`, then add:
```typescript
  it('returns drained and never spawns while draining', async () => {
    const drain = new DrainState();
    drain.set(true);
    const { runtime, supervisor } = make({}, drain);
    const res = await supervisor.ensureRunning(params);
    expect(res.outcome).toBe('drained');
    expect(runtime.spawned).toHaveLength(0);
  });

  it('spawns again once draining ends', async () => {
    const drain = new DrainState();
    drain.set(true);
    const { runtime, supervisor } = make({}, drain);
    await supervisor.ensureRunning(params);
    drain.set(false);
    const res = await supervisor.ensureRunning(params);
    expect(res.outcome).toBe('spawned');
    expect(runtime.spawned).toHaveLength(1);
  });
```
If the helper's signature differs, adapt the call shape but keep the assertions identical.

Append to `packages/orchestrator/test/outbox-consumer.test.ts`, inside the `handleEntry` describe, with `import { EventBus } from '../src/api/events.js';` added:
```typescript
  it('publishes reply_posted after a successful post', async () => {
    const { redis, poster, guard } = fakes(true);
    const events = new EventBus();
    const seen: string[] = [];
    events.onEvent((e) => seen.push(e.kind));
    const c = new OutboxConsumer(redis, poster, guard, log, events);
    await c.handleEntry('5-0', encodePayload(out('a')));
    expect(seen).toEqual(['reply_posted']);
  });

  it('does not publish reply_posted when the post fails', async () => {
    const { redis, guard } = fakes(true);
    const poster: SlackPoster = { postToThread: async () => { throw new Error('slack down'); } };
    const events = new EventBus();
    const seen: string[] = [];
    events.onEvent((e) => seen.push(e.kind));
    const c = new OutboxConsumer(redis, poster, guard, log, events);
    await c.handleEntry('5-0', encodePayload(out('a')));
    expect(seen).toEqual([]);
  });
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm test`
Expected: full suite green including the 4 new cases.

```bash
git add -A && git commit -m "feat(orchestrator): drain-aware supervisor, reply_posted events, slack status"
```

---

### Task 3: API surface and hub channel

**Files:**
- Modify: `packages/orchestrator/src/api/hub.ts`, `packages/orchestrator/src/api/routes.ts`, `packages/orchestrator/src/app.ts`
- Test: `packages/orchestrator/test/hub.test.ts` (add cases), `packages/orchestrator/test/routes.test.ts` (add cases)

**Interfaces:**
- Consumes: `ActivityLog`, `DrainState` (Task 1); `SlackStatus` (Task 2); `SystemInfo`, `ActivityEvent`, `ACTIVITY_CHANNEL` (Task 1 protocol).
- Produces: `GET /api/activity?limit=N` returning `{ events: ActivityEvent[] }`; `GET /api/system` returning `SystemInfo`; `POST /api/system/drain` accepting `{ enabled: boolean }` and returning `{ enabled, since }`; the `activity` WS channel. Task 4 consumes all of these.

- [ ] **Step 1: Hub serves the activity channel**

In `packages/orchestrator/src/api/hub.ts`:
- Add `activity: ActivityLog;` to `HubDeps`, importing `ActivityLog` from `./activity.js` and `ACTIVITY_CHANNEL` from `@cerberus/protocol`.
- Add a field `private unsubscribeActivity: (() => void) | null = null;`
- Extract the fan-out into a private method so the constructor and `start()` share it:
```typescript
  private subscribeActivity(): () => void {
    return this.deps.activity.onEvent((event) => {
      for (const client of this.clients) {
        if (client.channels.has(ACTIVITY_CHANNEL)) {
          this.send(client, { type: 'activity', events: [event] });
        }
      }
    });
  }
```
- In the constructor, after the events subscription, add `this.unsubscribeActivity = this.subscribeActivity();`
- In `start()`, next to the events re-subscribe, add `this.unsubscribeActivity ??= this.subscribeActivity();`
- In `stop()`, next to the events unsubscribe, add `this.unsubscribeActivity?.(); this.unsubscribeActivity = null;`
- In `sendSnapshot`, add a branch before the `thread:` branch:
```typescript
      if (channel === ACTIVITY_CHANNEL) {
        this.send(client, { type: 'snapshot', channel, data: { events: this.deps.activity.recent() } });
        return;
      }
```

- [ ] **Step 2: Routes**

In `packages/orchestrator/src/api/routes.ts`, extend `ApiDeps` with:
```typescript
  activity: ActivityLog;
  drain: DrainState;
  system: () => Promise<SystemInfo>;
  events?: EventBus;
```
(import `ActivityLog` from `./activity.js`, `DrainState` from `../lifecycle/drain.js`, `EventBus` from `./events.js`, `SystemInfo` as a type from `@cerberus/protocol`, and `z` from `zod` if not already imported).

Add these branches immediately after the existing `parts[1] === 'overview'` branch:
```typescript
      if (parts[1] === 'activity' && method === 'GET') {
        const rawLimit = Number(url.searchParams.get('limit') ?? '200');
        const limit = Number.isFinite(rawLimit)
          ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500)
          : 200;
        json(res, 200, { events: deps.activity.recent(limit) });
        return true;
      }

      if (parts[1] === 'system' && parts.length === 2 && method === 'GET') {
        json(res, 200, await deps.system());
        return true;
      }

      if (parts[1] === 'system' && parts[2] === 'drain' && method === 'POST') {
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err instanceof PayloadTooLargeError) { json(res, 413, { error: 'body too large' }); return true; }
          json(res, 400, { error: 'invalid json' });
          return true;
        }
        const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
        if (!parsed.success) { json(res, 400, { error: 'expected { enabled: boolean }' }); return true; }
        deps.drain.set(parsed.data.enabled);
        deps.log.info({ enabled: parsed.data.enabled }, 'drain state changed');
        json(res, 200, { enabled: deps.drain.enabled, since: deps.drain.since });
        return true;
      }
```

Also publish events for console-driven lifecycle actions. In the `sub === 'stop'` branch, after `await deps.registry.setStatus(...)`, add:
```typescript
          deps.events?.publish({ kind: 'agent_stopped', threadKey: key, at: new Date().toISOString() });
```
and in the `sub === 'restart'` branch, after the `ensureRunning` call, add:
```typescript
          if (result.outcome === 'spawned') {
            deps.events?.publish({ kind: 'agent_spawned', threadKey: key, at: new Date().toISOString() });
          }
```

- [ ] **Step 3: Wire it in app.ts**

In `packages/orchestrator/src/app.ts`:
- Import `ActivityLog` from `./api/activity.js`, `DrainState` from `./lifecycle/drain.js`, and `type SystemInfo` from `@cerberus/protocol`.
- After `const events = new EventBus();` add:
```typescript
  const activity = new ActivityLog(events);
  const drain = new DrainState();
```
- Pass `drain` into the `ThreadSupervisor` deps object (alongside `registry, runtime, log, events`).
- Pass `events` as the fifth argument to `new OutboxConsumer(redisBlocking, gateway, new RedisDeliveryGuard(redis), log, events)`.
- Pass `activity` into the `DashboardHub` deps.
- Add a `buildSystemInfo` function above the returned object:
```typescript
  const buildSystemInfo = async (): Promise<SystemInfo> => {
    const check = async (fn: () => Promise<unknown>): Promise<'ok' | 'error'> => {
      try { await fn(); return 'ok'; } catch { return 'error'; }
    };
    const [redisOk, postgresOk, runtimeOk] = await Promise.all([
      check(() => redisRaw.ping()),
      check(() => pool.query('SELECT 1')),
      check(() => runtime.list()),
    ]);
    return {
      runtime: cfg.RUNTIME,
      agentImage: cfg.AGENT_IMAGE,
      versions: { orchestrator: process.env.npm_package_version ?? '0.1.0', node: process.version },
      config: {
        idleTimeoutMs: cfg.IDLE_TIMEOUT_MS,
        reaperIntervalMs: cfg.REAPER_INTERVAL_MS,
        maxConcurrentAgents: cfg.MAX_CONCURRENT_AGENTS,
        agentCpu: cfg.AGENT_CPU,
        agentMemoryMb: cfg.AGENT_MEMORY_MB,
        agentPidsLimit: cfg.AGENT_PIDS_LIMIT,
        workspacesRoot: cfg.WORKSPACES_ROOT,
        logLevel: cfg.LOG_LEVEL,
        dashboardEnabled: cfg.DASHBOARD_ENABLED,
        // Boolean only: the token itself must never cross the wire.
        dashboardTokenSet: cfg.DASHBOARD_TOKEN.length > 0,
      },
      slack: gateway.getStatus(),
      dependencies: { redis: redisOk, postgres: postgresOk, runtime: runtimeOk },
      drain: { enabled: drain.enabled, since: drain.since },
    };
  };
```
- Pass `activity`, `drain`, `system: buildSystemInfo`, and `events` into `createApiHandler`.
- In `shutdown()`, add `activity.stop();` next to `hub.stop();`.

- [ ] **Step 4: Add the tests**

Append to `packages/orchestrator/test/hub.test.ts` inside the `DashboardHub` describe. Add `ACTIVITY_CHANNEL` to the protocol import and `ActivityLog` from `../src/api/activity.js`; `makeHub` must construct an `ActivityLog` over the same bus and pass it in as `activity`, and must return it alongside `hub` and `events`:
```typescript
  it('sends an activity snapshot on subscribe and a delta per event', async () => {
    const { hub, events } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    events.publish({ kind: 'agent_spawned', threadKey: KEY, at: 'now' });
    socket.subscribe(ACTIVITY_CHANNEL);
    await flush();
    const snap = socket.ofType('snapshot').find((m) => m.channel === ACTIVITY_CHANNEL) as
      { data: { events: unknown[] } } | undefined;
    expect(snap?.data.events).toHaveLength(1);

    events.publish({ kind: 'reply_posted', threadKey: KEY, at: 'now' });
    await flush();
    const deltas = socket.ofType('activity') as unknown as Array<{ events: Array<{ kind: string }> }>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.events[0]!.kind).toBe('reply_posted');
  });

  it('does not push activity to clients that did not subscribe', async () => {
    const { hub, events } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(OVERVIEW_CHANNEL);
    await flush();
    events.publish({ kind: 'agent_spawned', threadKey: KEY, at: 'now' });
    await flush();
    expect(socket.ofType('activity')).toHaveLength(0);
  });
```

Append to `packages/orchestrator/test/routes.test.ts` inside `describe('api routes', ...)`. Extend `makeDeps` to include, with `import { DrainState } from '../src/lifecycle/drain.js';` added:
```typescript
    activity: { recent: vi.fn((limit?: number) =>
      [{ id: '1', kind: 'agent_spawned', threadKey: KEY, at: 'now' }].slice(0, limit ?? 500)) } as never,
    drain: new DrainState(),
    system: vi.fn(async () => ({
      runtime: 'docker', agentImage: 'cerberus-agent:dev',
      versions: { orchestrator: '0.1.0', node: 'v22.0.0' },
      config: {
        idleTimeoutMs: 1800000, reaperIntervalMs: 60000, maxConcurrentAgents: 50,
        agentCpu: 0.5, agentMemoryMb: 512, agentPidsLimit: 256,
        workspacesRoot: '/workspaces', logLevel: 'info',
        dashboardEnabled: true, dashboardTokenSet: true,
      },
      slack: { connected: true, botUserId: 'U1', botName: 'bot', teamName: 'T', lastEventAt: 'now' },
      dependencies: { redis: 'ok', postgres: 'ok', runtime: 'ok' },
      drain: { enabled: false, since: null },
    })) as never,
```
then add the cases:
```typescript
  it('GET /api/activity returns events and clamps the limit', async () => {
    const deps = makeDeps();
    await serve(deps);
    const res = await fetch(`${base}/api/activity?limit=9999`);
    expect(res.status).toBe(200);
    expect((await res.json() as { events: unknown[] }).events).toHaveLength(1);
    expect(deps.activity.recent).toHaveBeenCalledWith(500);
  });

  it('GET /api/system returns the payload and leaks no secrets', async () => {
    await serve(makeDeps({ token: 'super-secret-token' }));
    const res = await fetch(`${base}/api/system`, { headers: { authorization: 'Bearer super-secret-token' } });
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    for (const secret of ['super-secret-token', 'xoxb-', 'xapp-', 'postgres://', 'redis://']) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain('"dashboardTokenSet":true');
  });

  it('POST /api/system/drain toggles and validates', async () => {
    const deps = makeDeps();
    await serve(deps);
    const on = await fetch(`${base}/api/system/drain`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect(deps.drain.enabled).toBe(true);

    const bad = await fetch(`${base}/api/system/drain`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(bad.status).toBe(400);
  });
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm test`
Expected: full suite green.

```bash
git add -A && git commit -m "feat(orchestrator): activity channel, system info, and drain endpoints"
```

---

### Task 4: Console navigation, Activity view, System view

**Files:**
- Create: `packages/dashboard/src/components/ActivityView.tsx`, `packages/dashboard/src/components/SystemView.tsx`
- Modify: `packages/dashboard/src/components/AppShell.tsx`, `packages/dashboard/src/App.tsx`, `packages/dashboard/src/lib/api.ts`, `packages/dashboard/src/lib/ws.ts`

**Interfaces:**
- Consumes: `ACTIVITY_CHANNEL`, `ActivityEvent`, `SystemInfo`, `OverviewSnapshot` from `@cerberus/protocol`; `useChannel` from `../lib/ws.js`; `api` from `../lib/api.js`.
- Produces: `useActivityChannel(active)` hook; `ActivityView`, `SystemView` components; `AppShell` gains `view`/`onNavigate`/`counts` props and exports `ConsoleView`.

- [ ] **Step 1: Activity hook**

Add to `packages/dashboard/src/lib/ws.ts` (import `ACTIVITY_CHANNEL` and `type ActivityEvent` from `@cerberus/protocol`):
```typescript
/** Snapshot on subscribe, then one delta per event, newest first, capped like the server. */
export function useActivityChannel(active: boolean): ActivityEvent[] {
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    if (!active) return;
    setEvents([]);
    return manager.subscribe(ACTIVITY_CHANNEL, (message) => {
      if (message.type === 'snapshot' && message.channel === ACTIVITY_CHANNEL) {
        setEvents((message.data as { events?: ActivityEvent[] }).events ?? []);
      } else if (message.type === 'activity') {
        setEvents((prev) => [...(message.events as ActivityEvent[]), ...prev].slice(0, 500));
      }
    });
  }, [active]);

  return events;
}
```

- [ ] **Step 2: API client additions**

Add to the `api` object in `packages/dashboard/src/lib/api.ts` (import `type SystemInfo` from `@cerberus/protocol`):
```typescript
  getSystem: () => request<SystemInfo>('/api/system'),
  setDrain: (enabled: boolean) =>
    request<{ enabled: boolean; since: string | null }>('/api/system/drain', {
      method: 'POST', body: JSON.stringify({ enabled }),
    }),
```

- [ ] **Step 3: Activity view**

`packages/dashboard/src/components/ActivityView.tsx`:
```tsx
import type { ActivityEvent } from '@cerberus/protocol';
import { since, shortKey } from '../lib/format';

const KIND: Record<string, { label: string; className: string }> = {
  agent_spawned:  { label: 'spawned',  className: 'text-ok border-ok/30 bg-ok/10' },
  agent_stopped:  { label: 'stopped',  className: 'text-muted border-line-strong bg-idle/10' },
  agent_failed:   { label: 'failed',   className: 'text-bad border-bad/30 bg-bad/10' },
  message_routed: { label: 'message',  className: 'text-accent border-accent/30 bg-accent/10' },
  reply_posted:   { label: 'reply',    className: 'text-warn border-warn/30 bg-warn/10' },
};

export function ActivityView({ events, onOpen }: {
  events: ActivityEvent[];
  onOpen: (threadKey: string) => void;
}) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface/50 px-6 py-16 text-center">
        <div className="text-sm text-muted">Nothing has happened yet</div>
        <div className="mt-1 text-xs text-dim">
          Spawns, replies, and reaps across the whole fleet appear here as they happen.
        </div>
      </div>
    );
  }

  return (
    <ol className="overflow-hidden rounded-lg border border-line bg-surface">
      {events.map((event) => {
        const kind = KIND[event.kind] ?? { label: event.kind, className: 'text-muted border-line-strong' };
        return (
          <li key={event.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
            <span className={`w-20 shrink-0 rounded-full border px-2 py-0.5 text-center text-[11px] ${kind.className}`}>
              {kind.label}
            </span>
            <button
              onClick={() => onOpen(event.threadKey)}
              className="min-w-0 flex-1 truncate text-left font-mono text-xs text-ink hover:text-accent"
            >
              {shortKey(event.threadKey)}
            </button>
            <span className="shrink-0 text-xs text-dim">{since(event.at)} ago</span>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 4: System view**

`packages/dashboard/src/components/SystemView.tsx`:
```tsx
import { useEffect, useState, type ReactNode } from 'react';
import type { SystemInfo } from '@cerberus/protocol';
import { api } from '../lib/api';
import { since } from '../lib/format';

const HEALTH = { ok: 'text-ok', error: 'text-bad' } as const;

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-2.5">
      <dt className="w-44 shrink-0 text-xs text-dim">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-sm text-ink">{value}</dd>
      {hint && <dd className="shrink-0 text-xs text-dim">{hint}</dd>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <h3 className="border-b border-line px-4 py-2 text-sm font-medium">{title}</h3>
      <dl className="divide-y divide-line">{children}</dl>
    </section>
  );
}

export function SystemView() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setInfo(await api.getSystem());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  async function toggleDrain() {
    if (!info) return;
    setBusy(true);
    try {
      await api.setDrain(!info.drain.enabled);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!info) return <p className="text-sm text-dim">Loading system info…</p>;

  return (
    <div className="space-y-4">
      {info.drain.enabled && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn">
          Draining since {new Date(info.drain.since ?? '').toLocaleTimeString()}. Existing agents keep
          running; new threads are queued rather than spawned.
        </div>
      )}

      <Card title="Runtime">
        <Row label="Container runtime" value={info.runtime} />
        <Row label="Agent image" value={info.agentImage} />
        <Row label="Orchestrator" value={info.versions.orchestrator} hint={`node ${info.versions.node}`} />
      </Card>

      <Card title="Slack">
        <Row
          label="Connection"
          value={info.slack.connected ? 'connected' : 'not connected'}
          hint={info.slack.lastEventAt ? `last event ${since(info.slack.lastEventAt)} ago` : 'no events yet'}
        />
        <Row label="Bot" value={info.slack.botName ?? 'unknown'} hint={info.slack.botUserId ?? ''} />
        <Row label="Workspace" value={info.slack.teamName ?? 'unknown'} />
      </Card>

      <Card title="Dependencies">
        {(['redis', 'postgres', 'runtime'] as const).map((dep) => (
          <div key={dep} className="flex items-baseline gap-4 px-4 py-2.5">
            <dt className="w-44 shrink-0 text-xs capitalize text-dim">{dep}</dt>
            <dd className={`flex-1 font-mono text-sm ${HEALTH[info.dependencies[dep]]}`}>
              {info.dependencies[dep]}
            </dd>
          </div>
        ))}
      </Card>

      <Card title="Configuration">
        <Row label="Idle timeout" value={`${Math.round(info.config.idleTimeoutMs / 60000)} min`} />
        <Row label="Reaper interval" value={`${Math.round(info.config.reaperIntervalMs / 1000)}s`} />
        <Row label="Max concurrent agents" value={String(info.config.maxConcurrentAgents)} />
        <Row
          label="Per-agent limits"
          value={`${info.config.agentCpu} cpu · ${info.config.agentMemoryMb} MB · ${info.config.agentPidsLimit} pids`}
        />
        <Row label="Workspaces root" value={info.config.workspacesRoot} />
        <Row label="Log level" value={info.config.logLevel} />
        <Row
          label="Console auth"
          value={info.config.dashboardTokenSet ? 'token required' : 'open'}
          hint={info.config.dashboardTokenSet ? '' : 'set DASHBOARD_TOKEN before exposing'}
        />
      </Card>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void toggleDrain()}
          disabled={busy}
          className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${
            info.drain.enabled ? 'bg-accent text-bg' : 'border border-line-strong text-muted hover:text-ink'
          }`}
        >
          {info.drain.enabled ? 'Resume spawning' : 'Drain the fleet'}
        </button>
        <span className="text-xs text-dim">
          Draining pauses new agent spawns without stopping running ones. Messages queue and are
          answered once you resume.
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Real navigation**

In `packages/dashboard/src/components/AppShell.tsx`, export the view type and extend the props:
```tsx
export type ConsoleView = 'agents' | 'activity' | 'system';

export function AppShell({ title, subtitle, actions, view, onNavigate, counts, children }: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  view: ConsoleView;
  onNavigate: (view: ConsoleView) => void;
  counts?: Partial<Record<ConsoleView, number>>;
  children: ReactNode;
}) {
```
and replace the existing `Fleet` label and `<nav>` block with:
```tsx
        <div className="mt-8 label">Fleet</div>
        <nav className="mt-2 space-y-1 text-sm">
          {(['agents', 'activity', 'system'] as const).map((item) => (
            <button
              key={item}
              onClick={() => onNavigate(item)}
              aria-current={view === item ? 'page' : undefined}
              className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 capitalize transition ${
                view === item ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink'
              }`}
            >
              <span>{item}</span>
              {counts?.[item] !== undefined && (
                <span className="rounded-full bg-line px-1.5 text-[11px] tabular-nums text-muted">
                  {counts[item]}
                </span>
              )}
            </button>
          ))}
        </nav>
```

- [ ] **Step 6: View router**

Replace `packages/dashboard/src/App.tsx` with:
```tsx
import { useState } from 'react';
import { OVERVIEW_CHANNEL, type OverviewSnapshot } from '@cerberus/protocol';
import { ActivityView } from './components/ActivityView';
import { AgentDetail } from './components/AgentDetail';
import { AgentGrid } from './components/AgentGrid';
import { AppShell, type ConsoleView } from './components/AppShell';
import { OverviewBar } from './components/OverviewBar';
import { SystemView } from './components/SystemView';
import { useActivityChannel, useChannel } from './lib/ws';

export default function App() {
  const [view, setView] = useState<ConsoleView>('agents');
  const [selected, setSelected] = useState<string | null>(null);

  // The overview stays subscribed only while the agent list is showing; the detail view has
  // its own channel and does not need the whole fleet.
  const { data } = useChannel<OverviewSnapshot>(
    view === 'agents' && !selected ? OVERVIEW_CHANNEL : null,
  );
  const events = useActivityChannel(view === 'activity');

  const counts = { agents: data?.counts.running, activity: events.length || undefined };

  function navigate(next: ConsoleView) {
    setSelected(null);
    setView(next);
  }

  function openThread(threadKey: string) {
    setView('agents');
    setSelected(threadKey);
  }

  if (selected) {
    return (
      <AppShell title="Agent" subtitle={selected} view={view} onNavigate={navigate} counts={counts}>
        <AgentDetail threadKey={selected} onBack={() => setSelected(null)} />
      </AppShell>
    );
  }

  if (view === 'activity') {
    return (
      <AppShell title="Activity" subtitle="Newest first, last 500 events" view={view} onNavigate={navigate} counts={counts}>
        <ActivityView events={events} onOpen={openThread} />
      </AppShell>
    );
  }

  if (view === 'system') {
    return (
      <AppShell title="System" subtitle="Resolved configuration and health" view={view} onNavigate={navigate} counts={counts}>
        <SystemView />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Agents"
      subtitle={data ? `${data.runtime} runtime${data.runtimeHealthy ? '' : ' (unreachable)'}` : 'connecting…'}
      view={view}
      onNavigate={navigate}
      counts={counts}
    >
      {!data ? (
        <div className="text-sm text-dim">Loading fleet…</div>
      ) : (
        <div className="space-y-5">
          {!data.runtimeHealthy && (
            <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn">
              Container runtime unreachable. Showing registry state only.
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

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm test && pnpm build:dashboard`
Expected: all green, dist produced.

```bash
git add -A && git commit -m "feat(dashboard): activity feed, system view, and real navigation"
```

---

## Plan self-review notes

- **Spec coverage:** ring buffer and capacity (Task 1); event coverage gaps for console actions and replies (Tasks 2 and 3); activity channel with snapshot plus deltas (Task 3); `GET /api/activity` with clamping (Task 3); `SystemInfo` including the no-secrets assertion (Tasks 1 and 3); Slack status (Task 2); drain state, enforcement, endpoint, and distinct Slack copy (Tasks 1 to 3); sidebar with counts and view router (Task 4). Failure scenarios are covered by the dependency `check()` helper, the empty-state renders, and the `auth.test` catch.
- **Deliberate deviation:** the spec says `recent()` returns newest first; the implementation slices then reverses so `limit` takes the newest N rather than the oldest N. The test pins that reading.
- **`process.env.npm_package_version`** is undefined when running under `tsx` directly rather than through a pnpm script, hence the `'0.1.0'` fallback. Cosmetic only.
