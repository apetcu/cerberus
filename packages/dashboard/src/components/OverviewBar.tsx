import type { OverviewSnapshot } from '@cerberus/protocol';
import { StatTile } from './StatTile';

export function OverviewBar({ snapshot }: { snapshot: OverviewSnapshot }) {
  const { counts } = snapshot;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatTile label="Running" value={counts.running} tone="ok" />
      <StatTile label="Provisioning" value={counts.provisioning} tone="warn" />
      <StatTile label="Stopped" value={counts.stopped} />
      <StatTile label="Failed" value={counts.failed} tone={counts.failed > 0 ? 'bad' : 'ink'} />
      <StatTile label="Threads" value={counts.total} />
    </div>
  );
}
