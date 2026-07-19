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
      <AppShell title="Agent" subtitle={selected} view={view} onNavigate={navigate}>
        <AgentDetail threadKey={selected} onBack={() => setSelected(null)} />
      </AppShell>
    );
  }

  if (view === 'activity') {
    return (
      <AppShell title="Activity" subtitle="Newest first, last 500 events" view={view} onNavigate={navigate}>
        <ActivityView events={events} onOpen={openThread} />
      </AppShell>
    );
  }

  if (view === 'system') {
    return (
      <AppShell title="System" subtitle="Resolved configuration and health" view={view} onNavigate={navigate}>
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
