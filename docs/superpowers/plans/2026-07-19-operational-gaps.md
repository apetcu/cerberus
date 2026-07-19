# Operational Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect agents that crash or wedge, revive threads holding unread mail, and bound workspace disk, so the orchestrator survives unattended operation.

**Architecture:** Three stateless classes, each exposing one `async tick()`-shaped method and owning no timer, wired to intervals in `app.ts` exactly as `IdleReaper` already is. Detection (liveness) is separated from revival (sweeper) so that the decision to spawn lives in exactly one place.

**Tech Stack:** TypeScript ESM (`.js` import extensions, `noUncheckedIndexedAccess`), vitest, ioredis, dockerode, Postgres via `pg`, React 19 for the console.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-operational-gaps-design.md`. Its values are binding.
- **No em-dashes** in any code comment, log line, user-facing copy, or documentation. Use commas, colons, or separate sentences.
- Every loop is disabled by setting its interval to `0`. Tests rely on this.
- No secret may reach `SystemInfo`. The guard test in `packages/orchestrator/test/system-info.test.ts` runs the real builder against sentinel secrets; keep it passing.
- Follow the existing `IdleReaper` shape: the class owns no timer, `app.ts` schedules it.
- Registry API is `setStatus(threadKey, status, ids?)` and `listByStatus(status)`. There is no `markStopped`.
- Existing suites must stay green: 152 unit, 23 integration.
- Commit after every task and push. The user asked for frequent commits explicitly.

---

### Task 1: Config, protocol types, and events

**Files:**
- Modify: `packages/orchestrator/src/config.ts` (five new vars)
- Modify: `packages/protocol/src/dashboard.ts` (`SystemInfo.workspaces`, new config fields, activity kinds)
- Modify: `packages/orchestrator/src/api/events.ts` (`CerberusEvent` gains two kinds)
- Test: `packages/orchestrator/test/config.test.ts`

**Interfaces produced:**
```typescript
// config.ts, following the existing numeric-env pattern
LIVENESS_INTERVAL_MS: number;      // default 15000
HEARTBEAT_GRACE_MS: number;        // default 60000
SWEEP_INTERVAL_MS: number;         // default 20000
WORKSPACE_GC_INTERVAL_MS: number;  // default 300000
WORKSPACES_MAX_MB: number;         // default 10240

// events.ts
type CerberusEventKind = ... | 'agent_died' | 'workspace_evicted';
// agent_died carries: { cause: DeathCause }
// workspace_evicted carries: { bytes: number }

// dashboard.ts
export interface WorkspaceUsage {
  totalBytes: number; capBytes: number; count: number; oldestTouchedAt: string | null;
}
// SystemInfo gains: workspaces: WorkspaceUsage
// SystemInfo.config gains the five numbers above
```

- [ ] **Step 1:** Add the five config vars with defaults, following the exact parsing pattern already used for `REAPER_INTERVAL_MS`.
- [ ] **Step 2:** Extend `CerberusEvent` with `agent_died` and `workspace_evicted`. The `ActivityEvent` mapping in `packages/orchestrator/src/api/activity.ts` copies `kind` through, so confirm the new kinds flow to the feed without further change.
- [ ] **Step 3:** Add `WorkspaceUsage` and extend `SystemInfo` in the protocol package. Update the zod schema alongside the type.
- [ ] **Step 4:** Update `packages/orchestrator/src/api/system-info.ts` to include the new config numbers and a `workspaces` value. Take workspace usage from an injected `() => Promise<WorkspaceUsage>` dep so Task 4 can supply the real implementation without touching this file again.
- [ ] **Step 5:** Run `pnpm test` (152 expected, plus your new config assertions) and `pnpm typecheck`. The system-info secret guard must still pass.
- [ ] **Step 6:** Commit `feat(protocol): config, events, and system fields for the operational loops`, then push.

---

### Task 2: LivenessMonitor

**Files:**
- Create: `packages/orchestrator/src/lifecycle/liveness.ts`
- Test: `packages/orchestrator/test/liveness.test.ts`

**Interfaces consumed:** `ThreadRegistry.listByStatus('running')`, `ThreadRegistry.setStatus`, `AgentRuntime.inspect`, `AgentRuntime.stop`, `EventBus.publish`, config from Task 1.

**Interfaces produced:**
```typescript
export type DeathCause = 'container_gone' | 'container_exited' | 'heartbeat_stale';

export interface LivenessDeps {
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  redis: { exists(key: string): Promise<number> };
  log: Logger;
  events?: EventBus;
  metrics?: Metrics;
  now?: () => Date;
}

export class LivenessMonitor {
  constructor(deps: LivenessDeps, heartbeatGraceMs: number);
  tick(): Promise<number>;
}
```

**Behavior:** for each row from `listByStatus('running')`:
1. If the row started less than `heartbeatGraceMs` ago, skip it. A booting container has not written its first heartbeat and is not wedged.
2. `runtime.inspect(handle)`: `null` gives cause `container_gone`; `running: false` gives `container_exited`.
3. Otherwise check `redis.exists(heartbeatKey(threadKey))`. Zero gives cause `heartbeat_stale`, and in this case only, call `runtime.stop(handle)` first so the wedged container does not linger. Tolerate a stop failure and continue.
4. On any cause: `setStatus(threadKey, 'stopped', { containerId: null, containerName: null })` then publish `agent_died` with the cause.

A throw from `inspect` for one row must not abort the tick or mark that row stopped: log it and move to the next row. A transport error is not evidence the agent is dead.

- [ ] **Step 1:** Write `packages/orchestrator/test/liveness.test.ts` covering: gone container marked stopped with `container_gone`; exited container gives `container_exited`; missing heartbeat stops the container then marks it, with cause `heartbeat_stale`; a row inside the grace window is untouched; a healthy row with a fresh heartbeat is untouched; an `inspect` that throws leaves that row's status alone but still processes the next row.
- [ ] **Step 2:** Run the test, confirm it fails for the right reason.
- [ ] **Step 3:** Implement `liveness.ts`.
- [ ] **Step 4:** Run `pnpm test` green and `pnpm typecheck` clean.
- [ ] **Step 5:** Commit `feat(orchestrator): detect crashed and wedged agents`, then push.

---

### Task 3: MailboxSweeper, drain resume, and honest copy

**Files:**
- Create: `packages/orchestrator/src/lifecycle/sweeper.ts`
- Modify: `packages/orchestrator/src/lifecycle/drain.ts` (resume callback)
- Modify: `packages/orchestrator/src/slack/router.ts` (restore the drain message)
- Modify: `packages/dashboard/src/components/SystemView.tsx` (restore the drain copy)
- Modify: `docs/superpowers/specs/2026-07-19-console-activity-system-design.md` (restore the resume claim)
- Test: `packages/orchestrator/test/sweeper.test.ts`, `packages/orchestrator/test/drain.test.ts`

**Interfaces produced:**
```typescript
export interface SweeperDeps {
  registry: ThreadRegistry;
  mailbox: { xlen(key: string): Promise<number> };
  supervisor: Pick<ThreadSupervisor, 'ensureRunning'>;
  drain: DrainState;
  log: Logger;
  events?: EventBus;
}

export class MailboxSweeper {
  constructor(deps: SweeperDeps);
  sweep(): Promise<number>;
}

// drain.ts
export class DrainState {
  set(enabled: boolean): void;
  onResume(fn: () => void): () => void;   // fires when set(false) actually changes state
}
```

**Behavior:** return `0` immediately if `drain.enabled`. Otherwise gather `listByStatus('stopped')` and `listByStatus('failed')`, and for each row with `xlen(mailboxKey(threadKey)) > 0`, call `supervisor.ensureRunning({ threadKey, teamId, channelId, threadTs })` from the row's own fields. Count only outcomes of `spawned`. A throw on one thread is logged and does not abort the sweep.

`DrainState.set(false)` fires `onResume` listeners only on a real transition, matching the existing early-return that preserves `since`.

**Copy restoration.** These three strings were softened when resume did not sweep. Now it does, so they go back to promising it. Exact new text:
- `router.ts`: `':construction: Cerberus is being updated and is not starting new agents. Your message is queued and will be answered as soon as it resumes.'`
- `SystemView.tsx` helper line: `Draining pauses new agent spawns without stopping running ones. Queued threads are picked up automatically when you resume.`
- The console spec's resume sentence: replace the "does not itself sweep queued threads" note with a statement that resuming sweeps every thread holding mail, naming `MailboxSweeper`.

- [ ] **Step 1:** Write `sweeper.test.ts`: revives a stopped thread with pending mail; ignores a stopped thread with an empty mailbox; ignores a running thread; returns 0 and calls nothing while draining; one thread throwing does not stop the others; counts only `spawned`.
- [ ] **Step 2:** Extend `drain.test.ts`: `onResume` fires on a true transition, does not fire when already disabled, and the unsubscribe stops delivery.
- [ ] **Step 3:** Run both, confirm they fail correctly.
- [ ] **Step 4:** Implement `sweeper.ts` and the `onResume` hook.
- [ ] **Step 5:** Apply the three copy restorations verbatim as given above.
- [ ] **Step 6:** `pnpm test` green, `pnpm typecheck` clean, `pnpm build:dashboard` succeeds.
- [ ] **Step 7:** Commit `feat(orchestrator): revive threads holding unread mail`, then push.

---

### Task 4: WorkspaceGC

**Files:**
- Create: `packages/orchestrator/src/lifecycle/workspace-gc.ts`
- Test: `packages/orchestrator/test/workspace-gc.test.ts`

**Interfaces produced:**
```typescript
export interface WorkspaceGCDeps {
  root: string;
  registry: ThreadRegistry;
  log: Logger;
  events?: EventBus;
  fs?: WorkspaceFs;   // injected for tests; defaults to node:fs/promises
}

export class WorkspaceGC {
  constructor(deps: WorkspaceGCDeps, maxMb: number);
  usage(): Promise<WorkspaceUsage>;
  collect(): Promise<number>;
}
```

**Behavior:** `usage()` lists directories under `root`, sizes each recursively, and reports the total, the cap in bytes, the count, and the oldest last-touched time as ISO-8601. Last-touched is the `conversation.json` mtime, falling back to the directory mtime when that file is absent.

`collect()` returns `0` when `maxMb` is `0` or the total is under the cap. Otherwise it builds the protected set from `listByStatus('running')` mapped to directory names, sorts the unprotected directories by last-touched ascending, and deletes until the running total is under the cap. Each deletion publishes `workspace_evicted` with `{ threadKey, bytes }`. A directory that vanishes mid-run counts zero bytes and is not an error. If the cap still cannot be met after exhausting unprotected candidates, log a warning naming the shortfall in bytes and return what was reclaimed. Never delete a protected directory.

Directory name to thread key: workspaces are named by thread key (see `WORKSPACES_ROOT` layout, for example `T1-C1-1.2`). Map by exact name.

- [ ] **Step 1:** Write `workspace-gc.test.ts` against an injected in-memory `WorkspaceFs`: under cap deletes nothing; over cap evicts oldest first and stops as soon as it is under; a running thread's workspace is never deleted even when it is oldest; when only protected directories remain it warns and returns partial bytes; `maxMb: 0` disables; `usage()` reports total, count, and oldest correctly.
- [ ] **Step 2:** Run, confirm failing.
- [ ] **Step 3:** Implement `workspace-gc.ts`.
- [ ] **Step 4:** `pnpm test` green, `pnpm typecheck` clean.
- [ ] **Step 5:** Commit `feat(orchestrator): bound workspace disk with LRU eviction`, then push.

---

### Task 5: Wiring and console surfacing

**Files:**
- Modify: `packages/orchestrator/src/app.ts` (construct all three, schedule intervals, wire resume, supply the usage dep)
- Modify: `packages/dashboard/src/components/SystemView.tsx` (workspace usage bar)
- Modify: `packages/dashboard/src/components/ActivityView.tsx` (render the two new kinds)
- Modify: `README.md` (known-gaps paragraph and the config table)
- Test: `packages/orchestrator/test/system-info.test.ts`

**Behavior:** construct `LivenessMonitor`, `MailboxSweeper`, and `WorkspaceGC` in `app.ts` beside the existing reaper. Schedule each with its own interval, skipping any whose interval is `0`. Every scheduled callback catches and logs, so one failing tick never becomes an unhandled rejection. Clear all timers in the shutdown path where the reaper's timer is already cleared. Wire `drain.onResume(() => void sweeper.sweep())`. Pass `() => gc.usage()` as the workspace dep added to `system-info.ts` in Task 1.

The liveness interval and the sweep interval are independent timers, not a chain. Do not try to run them in lockstep.

Console: SystemView gets a usage bar showing used against cap with a human-readable byte label and the workspace count. ActivityView needs labels and colors for `agent_died` (use the existing failure color) and `workspace_evicted` (use a neutral or warning color), matching how existing kinds are styled. README: update the known-gaps paragraph that currently says a dead container keeps a `running` row and that deferred spawns are not retried, since both are now false, and add the five new variables to the configuration table.

- [ ] **Step 1:** Wire everything in `app.ts`.
- [ ] **Step 2:** Extend `system-info.test.ts` to assert the workspace block appears and that the secret guard still passes with the new fields.
- [ ] **Step 3:** Add the console rendering for both new event kinds and the usage bar.
- [ ] **Step 4:** Update the README known-gaps paragraph and config table. No em-dashes.
- [ ] **Step 5:** `pnpm test`, `pnpm test:integration`, `pnpm typecheck`, `pnpm build:dashboard`, all green.
- [ ] **Step 6:** Commit `feat: wire the operational loops and surface them in the console`, then push.
