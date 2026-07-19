import type { OverviewSnapshot } from '@cerberus/protocol';
import { StatTile } from './StatTile';

export function OverviewBar({ snapshot }: { snapshot: OverviewSnapshot }) {
  const { counts } = snapshot;
  // `total` counts the most recent MAX_AGENTS threads the snapshot carries, not the whole fleet.
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatTile label="Running" value={counts.running} tone="ok" />
      <StatTile label="Provisioning" value={counts.provisioning} tone="warn" />
      <StatTile label="Stopped" value={counts.stopped} />
      <StatTile label="Failed" value={counts.failed} tone={counts.failed > 0 ? 'bad' : 'ink'} />
      <StatTile label="Recent" value={counts.total} />
    </div>
  );
}
