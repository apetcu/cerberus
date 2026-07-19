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
