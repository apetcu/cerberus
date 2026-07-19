import type { ActivityEvent } from '@cerberus/protocol';
import { since, shortKey, humanBytes } from '../lib/format';

const KIND: Record<string, { label: string; className: string }> = {
  agent_spawned:    { label: 'spawned',   className: 'text-ok border-ok/30 bg-ok/10' },
  agent_stopped:    { label: 'stopped',   className: 'text-muted border-line-strong bg-idle/10' },
  agent_failed:     { label: 'failed',    className: 'text-bad border-bad/30 bg-bad/10' },
  message_routed:   { label: 'message',   className: 'text-accent border-accent/30 bg-accent/10' },
  reply_posted:     { label: 'reply',     className: 'text-warn border-warn/30 bg-warn/10' },
  // Same failure color as agent_failed: a died agent is a failure the operator must notice.
  agent_died:       { label: 'died',      className: 'text-bad border-bad/30 bg-bad/10' },
  // Neutral: routine housekeeping, not a failure.
  workspace_evicted: { label: 'evicted',  className: 'text-muted border-line-strong bg-idle/10' },
};

const CAUSE_LABEL: Record<string, string> = {
  container_gone: 'container gone',
  container_exited: 'container exited',
  heartbeat_stale: 'heartbeat stale',
};

/** Extra context shown after the thread key: the cause for a death, the size for an eviction. */
function detail(event: ActivityEvent): string | null {
  if (event.kind === 'agent_died' && event.cause) return CAUSE_LABEL[event.cause] ?? event.cause;
  if (event.kind === 'workspace_evicted' && event.bytes !== undefined) return humanBytes(event.bytes);
  return null;
}

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
        const extra = detail(event);
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
            {extra && <span className="shrink-0 text-xs text-dim">{extra}</span>}
            <span className="shrink-0 text-xs text-dim">{since(event.at)} ago</span>
          </li>
        );
      })}
    </ol>
  );
}
