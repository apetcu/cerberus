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
