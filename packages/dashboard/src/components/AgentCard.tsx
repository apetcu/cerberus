import type { AgentSummary } from '@cerberus/protocol';
import { since, threadTime } from '../lib/format';
import { HeartbeatDot } from './HeartbeatDot';
import { StatusPill } from './StatusPill';

export function AgentCard({ agent, onOpen }: { agent: AgentSummary; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="rounded-lg border border-line bg-surface p-4 text-left transition
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
