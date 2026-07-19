# Console Activity and System Views: Design

**Date:** 2026-07-19
**Status:** Approved
**Builds on:** `docs/superpowers/specs/2026-07-19-cerberus-console-design.md`

## Summary

The console can answer "how is this one agent doing" but not "what just happened across the fleet" or "how is this deployed right now". Two new sidebar destinations close those gaps, and the one-item nav becomes a real three-item nav.

Decisions made during brainstorming:

| Decision | Choice | Alternatives considered |
|---|---|---|
| Activity retention | In-memory ring buffer, 500 events | Persist to Postgres (adds migration, write per event, pruning policy); buffer plus async persist |
| System view scope | Read-only, plus a fleet drain switch | Purely read-only; also a Slack reconnect button |
| Drain outcome | New `EnsureOutcome` value `drained` | Reuse `deferred` (wrong user-facing message) |
| Activity transport | Snapshot on subscribe, deltas after | Full snapshot on every event (resends 500 rows per tick) |

Events are diagnostic, not durable. A restart clearing the feed is acceptable for "what just happened"; forensics across restarts would need Postgres, which is deliberately out of scope.

## Activity

### Server

`packages/orchestrator/src/api/activity.ts`:

```typescript
export interface ActivityEvent {
  id: string;          // ULID, stable key for the UI
  kind: CerberusEvent['kind'];
  threadKey: string;
  at: string;          // ISO-8601
}

export class ActivityLog {
  constructor(events: EventBus, capacity?: number);   // default 500
  recent(limit?: number): ActivityEvent[];            // newest first
  onEvent(fn: (event: ActivityEvent) => void): () => void;
  stop(): void;                                        // unsubscribes from the bus
}
```

`ActivityLog` subscribes to the `EventBus` at construction, stamps each event with a ULID, and pushes it into a bounded array. When the buffer is full the oldest entry is dropped. `recent()` returns newest first so the UI renders without re-sorting.

### Event coverage

The bus already publishes `agent_spawned`, `agent_failed` (supervisor), `agent_stopped` (reaper), and `message_routed` (router). Two gaps are closed:

- The console's own `POST /stop` and `POST /restart` publish nothing today, so a console-driven action never appears in the feed. They now publish `agent_stopped` and `agent_spawned`.
- `reply_posted` is added and published by `OutboxConsumer` after a successful Slack post.

With those, the feed tells the whole round trip: `message_routed → agent_spawned → reply_posted → agent_stopped`.

### Transport

A new WS channel `activity`:

| Direction | Message | When |
|---|---|---|
| server → client | `{ type: 'snapshot', channel: 'activity', data: { events } }` | On subscribe |
| server → client | `{ type: 'activity', events: [event] }` | On each new event |

Deltas rather than repeated snapshots: the buffer holds 500 rows and the reconcile tick fires every 2 seconds, so resending it wholesale would waste bandwidth for no benefit. The client appends deltas and trims to the same 500 cap.

`GET /api/activity?limit=N` returns the same shape for non-WS callers. `limit` is clamped to 1..500.

## System

### Payload

`GET /api/system`:

```typescript
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
    dashboardTokenSet: boolean;   // never the token itself
  };
  slack: {
    connected: boolean;
    botUserId: string | null;
    botName: string | null;
    teamName: string | null;
    lastEventAt: string | null;
  };
  dependencies: {
    redis: 'ok' | 'error';
    postgres: 'ok' | 'error';
    runtime: 'ok' | 'error';
  };
  drain: { enabled: boolean; since: string | null };
}
```

**No secret may appear in this payload.** Slack tokens, `REDIS_URL`, `AGENT_REDIS_URL`, `DATABASE_URL`, and `DASHBOARD_TOKEN` are excluded; the dashboard token is reported only as the boolean `dashboardTokenSet`. A test asserts the serialised payload contains none of those values, so a future field addition cannot regress it silently.

### Slack connection state

`SlackGateway` gains a `getStatus(): SlackStatus` method. At `start()` it calls `auth.test` once and caches `botUserId`, `botName`, and `teamName`; `connected` reflects whether `start()` completed without throwing. `dispatch()` stamps `lastEventAt` on every inbound event, which is the signal that actually matters when debugging "the bot is silent": a connected socket with a stale `lastEventAt` means events are not subscribed, which is exactly the failure mode that cost real time during setup.

### Drain

`packages/orchestrator/src/lifecycle/drain.ts`:

```typescript
export class DrainState {
  get enabled(): boolean;
  get since(): string | null;
  set(enabled: boolean): void;
}
```

In-memory and process-local, matching the single-replica orchestrator. `ThreadSupervisor.ensureRunning` consults it before the concurrency check and returns the new outcome `drained` without spawning. `POST /api/system/drain` with `{ "enabled": boolean }` toggles it.

`EnsureOutcome` gains `'drained'` alongside `already-running | spawned | deferred | failed`. `EventRouter` posts a distinct Slack message for it, because "we are deploying, back shortly" and "all slots are busy" are different facts and the existing deferred copy would be misleading.

Draining does not stop running agents and does not drop messages: the mailbox write happens before `ensureRunning`, so anything that arrives while drained is processed once draining ends.

## Sidebar and routing

`AppShell` takes `view` and `onNavigate` props and renders three items: Agents, Activity, System. Agents and Activity carry live count badges (running agents; buffered events). `App.tsx` becomes a small view router over `'agents' | 'activity' | 'system'` plus the currently selected thread; the existing agent overview and detail views are unchanged.

## Files

```
packages/protocol/src/dashboard.ts                 # + ActivityEvent, SystemInfo, activity message
packages/orchestrator/src/api/activity.ts          # new: ActivityLog
packages/orchestrator/src/lifecycle/drain.ts       # new: DrainState
packages/orchestrator/src/api/hub.ts               # + activity channel
packages/orchestrator/src/api/routes.ts            # + /api/activity, /api/system, /api/system/drain
packages/orchestrator/src/slack/gateway.ts         # + getStatus()
packages/orchestrator/src/lifecycle/supervisor.ts  # + drain check, 'drained' outcome
packages/orchestrator/src/mailbox/outbox-consumer.ts # + reply_posted event
packages/orchestrator/src/app.ts                   # wiring
packages/dashboard/src/components/ActivityView.tsx # new
packages/dashboard/src/components/SystemView.tsx   # new
packages/dashboard/src/components/AppShell.tsx     # real nav
packages/dashboard/src/App.tsx                     # view router
```

## Failure scenarios

| Failure | Behavior |
|---|---|
| Event burst larger than the buffer | Oldest entries drop; the feed stays bounded and current |
| A client subscribes to `activity` with no events yet | Empty snapshot, then deltas as they arrive |
| `auth.test` fails at startup | `connected: false` with null identity; the orchestrator still starts, and the System view shows the failure rather than hiding it |
| Dependency check throws while building `SystemInfo` | That dependency reports `error`; the rest of the payload still renders |
| Drain enabled with threads mid-flight | Running agents finish; new spawns return `drained` and their messages wait in mailboxes |

## Testing

- **Unit:** ring buffer capacity and newest-first ordering; unsubscribe stops delivery; hub sends an activity snapshot on subscribe and a delta per event; `/api/system` shape plus an assertion that no secret value appears in the payload; `/api/system/drain` toggles state; supervisor returns `drained` and never calls `runtime.spawn` while draining; `limit` clamping on `/api/activity`.
- **Browser:** drive the live console: navigate all three views, watch an event appear in Activity as an agent is restarted, confirm System reports the real bot identity and dependency health, toggle drain and confirm a restart returns `drained`.

## Scope cuts

- No persistence of events, so no history across restarts.
- No filtering or search in the Activity view; it is a chronological feed capped at 500.
- Drain is process-local, not coordinated across replicas (the orchestrator is single-replica by design today).
- No Slack reconnect action; restarting the container remains the remedy.
