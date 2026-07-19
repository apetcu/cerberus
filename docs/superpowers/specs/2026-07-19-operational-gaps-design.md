# Operational Gaps: Design

**Date:** 2026-07-19
**Status:** Approved
**Builds on:** the orchestrator design and the console Activity and System views

## Summary

Three gaps make Cerberus a demo rather than something you leave running unattended. All three are named in the README as known gaps and none were scheduled.

1. A container that dies on its own leaves its registry row reading `running` forever. The reconciler runs once at boot; the reaper only stops idle agents. Nothing notices a crash in between.
2. An agent that wedges is invisible. The container is up, so every existing check passes, while the thread never replies again.
3. A spawn that returns `deferred` (concurrency cap) or `drained` is never retried. Only a new inbound Slack message or a manual restart brings the thread back, so every deploy strands whatever arrived during it.

Three periodic loops close these, each with one job.

Decisions made during brainstorming:

| Decision | Choice | Alternatives considered |
|---|---|---|
| Workspace retention | Cap total disk, evict least recently touched | Report and manual delete only; auto-delete after N days idle |
| Dead agent handling | Mark stopped, respawn only if mail is waiting | Mark stopped only; always respawn with a crash-loop cap |
| Respawn ownership | One sweeper owns every respawn path | Each detector respawns its own case |
| Mailbox backpressure | Out of scope, already solved | Add a depth cap and shedding policy |

That last row is a correction. An earlier assessment claimed Redis streams grow unbounded per thread. They do not: `packages/orchestrator/src/mailbox/redis-stores.ts:24` already writes with `MAXLEN ~ 1000`. No work is needed and the claim is withdrawn.

## Liveness

`packages/orchestrator/src/lifecycle/liveness.ts`:

```typescript
export type DeathCause = 'container_gone' | 'container_exited' | 'heartbeat_stale';

export class LivenessMonitor {
  constructor(deps: LivenessDeps, heartbeatGraceMs: number);
  /** Correct every stale running row. Returns how many were found dead. */
  tick(): Promise<number>;
}
```

All three loops follow the existing `IdleReaper` shape: the class exposes one `async tick()` and owns no timer. `app.ts` drives every interval, matching how the reaper is already wired, which keeps the classes trivially testable and the scheduling in one place.

Each tick reads the registry rows whose status is `running` and checks each row two ways.

**Crashed.** `runtime.inspect()` returns null (the container was removed) or reports `running: false` (it exited). Cause is `container_gone` or `container_exited`.

**Wedged.** The container is running but the Redis key `heartbeat:<threadKey>` is absent. The agent writes that key with a 30 second TTL, so absence means the agent stopped heartbeating even though its container is alive. This is the case no existing check can see. The monitor stops the container so it does not linger holding resources, then treats it as dead. Cause is `heartbeat_stale`.

A grace period guards both startup and flapping, but it is measured in time spent unhealthy, not time since the row last changed. The monitor keeps its own `Map<threadKey, { since, cause }>` of threads currently observed unhealthy. A healthy row clears its entry. The first tick that observes a row unhealthy only records `{ since: now, cause }`, never acts. A later tick that still finds the row unhealthy acts once `now - since` exceeds `heartbeatGraceMs` (default 60000), using the newest cause observed while keeping the original `since`. This is deliberately not based on `ThreadRecord.updatedAt`, because `registry.upsertActivity` bumps `updatedAt` on every inbound Slack message; a grace window measured from `updatedAt` would let a user who keeps messaging a crashed or wedged thread keep it inside its grace window forever, so the monitor would never mark it dead on exactly the threads a person is actively trying to use. Measuring time spent unhealthy instead still tolerates the spawn race (a brand new container has not written its first heartbeat yet) and transient flapping, since a recovered agent resets its own clock, while a thread that stays broken keeps accumulating time toward the grace no matter how often it is messaged.

Once the grace has elapsed the monitor calls `registry.setStatus(threadKey, 'stopped', { containerId: null, containerName: null })` and publishes `agent_died` with the cause, then drops the entry. It never spawns. Respawn is the sweeper's job, so that the decision to bring an agent back lives in exactly one place.

`AgentDied` joins `CerberusEvent` and therefore the Activity feed.

## Sweeper

`packages/orchestrator/src/lifecycle/sweeper.ts`:

```typescript
export class MailboxSweeper {
  constructor(deps: SweeperDeps);
  /** Revive every thread holding mail with no agent. Returns how many were revived. */
  sweep(): Promise<number>;
}
```

Each tick it finds threads that have pending mail and no running agent, and calls `supervisor.ensureRunning` on each. Candidates come from `registry.listByStatus('stopped')` plus `listByStatus('failed')`.

"Pending mail" means genuine unprocessed user work, not stream length. `XLEN` must not be used: the stream retains every entry after the agent consumes and acks it (the only trim is `MAXLEN ~ 1000` on `XADD`), so `XLEN` counts history and is nonzero forever after a thread's first message. An `XLEN`-based sweeper revives every cleanly reaped thread within one tick, producing immortal zombies that saturate the concurrency cap. Instead, `MailboxBacklog.hasUserWork` inspects the agent consumer group's state: a thread has pending mail exactly when the stream holds a user message the group has never been delivered (entries after `last-delivered-id` from `XINFO GROUPS`) or one delivered but never acked (the pending entries list from `XPENDING`, meaning the agent crashed mid-turn and must retry it). Control envelopes (`shutdown`, `ping`) never count as pending mail: the reaper publishes its `shutdown` control into the same stream and the container is often gone before consuming it, so counting that leftover would revive the exact thread the reaper just stopped. A thread cleanly reaped with no outstanding work is never revived.

This one loop closes three separate paths back to life: the crashed agent the monitor just marked stopped, the spawn deferred at the concurrency cap, and the thread stranded by drain. Each previously waited on the user to speak again.

The sweeper returns early while `drain.enabled` is true, so it does not fight the drain switch. It runs immediately when drain is released: `DrainState.set(false)` fires a callback the app wires to `sweeper.sweep()`. That makes the resume promise honest, so the Slack and console copy softened earlier is restored to say queued threads are picked up on resume.

Ordering matters. The sweeper runs after the liveness monitor within a tick cycle, because the monitor is what marks a crashed row stopped and therefore what makes it eligible for sweeping. They are separate intervals, not a pipeline, so a slow tick simply delays revival to the next pass rather than losing it.

The concurrency cap still applies. A sweep that hits the cap leaves the remaining threads for the next pass, which is the correct behavior and needs no special handling.

## Workspace GC

`packages/orchestrator/src/lifecycle/workspace-gc.ts`:

```typescript
export interface WorkspaceUsage {
  totalBytes: number;
  capBytes: number;
  count: number;
  oldestTouchedAt: string | null;
}

export class WorkspaceGC {
  constructor(deps: WorkspaceGCDeps, maxMb: number);
  usage(): Promise<WorkspaceUsage>;
  /** Evict until under the cap. Returns bytes reclaimed. */
  collect(): Promise<number>;
}
```

Each tick sizes every directory under `WORKSPACES_ROOT` and sums them. Under the cap it does nothing. Over the cap it sorts by last-touched ascending and deletes until back under.

**Only a workspace whose thread status is `stopped` or `failed` may be evicted.** This is an allowlist, not a "skip running" denylist: `provisioning` is the supervisor mid-spawn, `stopping` is the reaper's graceful-stop window in which the agent is still flushing `conversation.json`, and any status added later is protected until someone decides otherwise. Deleting the directory out from under a live agent would corrupt the conversation it is mid-way through writing. The status snapshot taken while sorting candidates goes stale while deletes run, so each delete re-reads that one thread's status under the supervisor's per-thread `KeyedMutex` immediately before removing anything, and skips it if it is no longer evictable; holding the same mutex the supervisor spawns under means eviction and spawn can never interleave on one thread key. A directory with no registry row at all is orphan data (every spawn path creates the row before the directory, rows are never deleted, and the boot reconciler re-adopts live containers), so it is evicted to keep the cap enforceable, but the deletion is logged rather than published as `workspace_evicted`, because that event would surface the directory name as a pseudo-thread in the Activity feed. If honoring the protections means the cap still cannot be met, the GC logs a warning naming the shortfall and stops. It never deletes a protected workspace to satisfy a number.

Eviction publishes `workspace_evicted` with the thread key and bytes reclaimed, so deletions appear in the Activity feed rather than happening invisibly. Deletion is the directory, not the registry row: the thread survives and simply starts its next conversation without history.

Last-touched comes from the `conversation.json` mtime, which the agent rewrites on every turn, making it an accurate proxy for thread activity.

`maxMb` of 0 disables the GC entirely.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LIVENESS_INTERVAL_MS` | 15000 | Liveness tick. 0 disables. |
| `HEARTBEAT_GRACE_MS` | 60000 | How long after spawn before a missing heartbeat counts as wedged. |
| `SWEEP_INTERVAL_MS` | 20000 | Sweeper tick. 0 disables. |
| `WORKSPACE_GC_INTERVAL_MS` | 300000 | GC tick, five minutes. 0 disables. |
| `WORKSPACES_MAX_MB` | 10240 | Disk cap. 0 disables the GC. |

Every loop is disabled by setting its interval to 0, which keeps tests deterministic and lets an operator switch off any one of them without a rebuild.

## Surfacing

`SystemInfo` gains a `workspaces` block (`totalBytes`, `capBytes`, `count`, `oldestTouchedAt`) and the five new config values, so the System view can show disk pressure before it becomes an incident. The new intervals join the existing config block, which is safe: they are numbers, not secrets.

The System view renders workspace usage as a labelled bar against the cap. The Activity feed renders `agent_died` with its cause and `workspace_evicted` with the bytes reclaimed.

## Failure scenarios

| Failure | Behavior |
|---|---|
| Runtime unreachable during a liveness tick | The tick logs and returns; rows keep their current status rather than being marked stopped on a transport error |
| Registry unreachable during a sweep | The sweep logs and returns; the next tick retries |
| Container stopped between inspect and markStopped | `markStopped` is idempotent, so the redundant write is harmless |
| Sweeper and an inbound Slack message race on the same thread | The per-thread `KeyedMutex` serialises them and the second sees `already-running` |
| Workspace deleted by hand between sizing and eviction | Deletion tolerates a missing directory and counts zero bytes reclaimed |
| Sweeper revives a thread between the GC's status snapshot and its delete | Each delete re-reads that thread's status under the supervisor's per-thread `KeyedMutex` immediately before removing anything and skips it unless it is still `stopped` or `failed`; sharing the spawn mutex means eviction and spawn cannot interleave on the same thread key |
| Every oversized workspace belongs to a running agent | Nothing is deleted; a warning names the shortfall |
| Heartbeat key missing because Redis was briefly down | The agent rewrites it within its next turn; a false positive costs one respawn, and the mailbox guarantees no message is lost |

## Testing

- **Unit:** monitor marks a gone container stopped and publishes the cause; monitor skips a row inside the grace window; monitor stops a wedged container before marking it; sweeper revives a thread with pending mail and skips one without; sweeper is a no-op while draining and runs on resume; GC evicts oldest first until under cap; GC never evicts a workspace whose status is not evictable; GC does nothing under the cap; every loop is inert at interval 0.
- **Integration:** against real Redis with a real consumer group and real acknowledgement: a thread whose messages were all consumed and acked has no pending mail, including after a reap parked a shutdown control in its stream; a thread with an undelivered user message has pending mail; a thread with a delivered-but-unacked user message has pending mail; the sweeper revives exactly the latter two.
- **Browser:** the System view shows workspace usage, and an `agent_died` event appears in the Activity feed after a container is killed out from under the orchestrator.

## Scope cuts

- No crash-loop detection. An agent that dies repeatedly is respawned each time its mailbox is non-empty. A poison message could loop; the per-message watchdog that would catch it is separate work.
- No mailbox backpressure. Already handled by `MAXLEN ~ 1000`.
- No workspace export or manual delete endpoint. The cap bounds disk; per-thread deletion on request is separate work.
- Drain remains process-local. These loops are equally process-local and would need the same partitioning work to survive a second replica.
