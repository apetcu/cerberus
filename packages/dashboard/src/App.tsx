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
      subtitle={data ? `${data.runtime} runtime${data.runtimeHealthy ? '' : ' (unreachable)'}` : 'connecting…'}
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
