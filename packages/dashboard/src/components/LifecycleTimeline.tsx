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
