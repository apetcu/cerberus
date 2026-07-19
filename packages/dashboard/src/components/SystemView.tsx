import { useEffect, useState, type ReactNode } from 'react';
import type { SystemInfo } from '@cerberus/protocol';
import { api } from '../lib/api';
import { since } from '../lib/format';

const HEALTH = { ok: 'text-ok', error: 'text-bad' } as const;

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-2.5">
      <dt className="w-44 shrink-0 text-xs text-dim">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-sm text-ink">{value}</dd>
      {hint && <dd className="shrink-0 text-xs text-dim">{hint}</dd>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <h3 className="border-b border-line px-4 py-2 text-sm font-medium">{title}</h3>
      <dl className="divide-y divide-line">{children}</dl>
    </section>
  );
}

export function SystemView() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setInfo(await api.getSystem());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  async function toggleDrain() {
    if (!info) return;
    setBusy(true);
    try {
      await api.setDrain(!info.drain.enabled);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not change drain state');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!info) return <p className="text-sm text-dim">Loading system info…</p>;

  return (
    <div className="space-y-4">
      {info.drain.enabled && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn">
          Draining since {new Date(info.drain.since ?? '').toLocaleTimeString()}. Existing agents keep
          running; new threads are not spawned until you resume.
        </div>
      )}

      <Card title="Runtime">
        <Row label="Container runtime" value={info.runtime} />
        <Row label="Agent image" value={info.agentImage} />
        <Row label="Orchestrator" value={info.versions.orchestrator} hint={`node ${info.versions.node}`} />
      </Card>

      <Card title="Slack">
        <Row
          label="Connection"
          value={info.slack.connected ? 'connected' : 'not connected'}
          hint={info.slack.lastEventAt ? `last event ${since(info.slack.lastEventAt)} ago` : 'no events yet'}
        />
        <Row label="Bot" value={info.slack.botName ?? 'unknown'} hint={info.slack.botUserId ?? ''} />
        <Row label="Workspace" value={info.slack.teamName ?? 'unknown'} />
      </Card>

      <Card title="Dependencies">
        {(['redis', 'postgres', 'runtime'] as const).map((dep) => (
          <div key={dep} className="flex items-baseline gap-4 px-4 py-2.5">
            <dt className="w-44 shrink-0 text-xs capitalize text-dim">{dep}</dt>
            <dd className={`flex-1 font-mono text-sm ${HEALTH[info.dependencies[dep]]}`}>
              {info.dependencies[dep]}
            </dd>
          </div>
        ))}
      </Card>

      <Card title="Configuration">
        <Row label="Idle timeout" value={`${Math.round(info.config.idleTimeoutMs / 60000)} min`} />
        <Row label="Reaper interval" value={`${Math.round(info.config.reaperIntervalMs / 1000)}s`} />
        <Row label="Max concurrent agents" value={String(info.config.maxConcurrentAgents)} />
        <Row
          label="Per-agent limits"
          value={`${info.config.agentCpu} cpu · ${info.config.agentMemoryMb} MB · ${info.config.agentPidsLimit} pids`}
        />
        <Row label="Workspaces root" value={info.config.workspacesRoot} />
        <Row label="Log level" value={info.config.logLevel} />
        <Row
          label="Console auth"
          value={info.config.dashboardTokenSet ? 'token required' : 'open'}
          hint={info.config.dashboardTokenSet ? '' : 'set DASHBOARD_TOKEN before exposing'}
        />
      </Card>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void toggleDrain()}
          disabled={busy}
          className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${
            info.drain.enabled ? 'bg-accent text-bg' : 'border border-line-strong text-muted hover:text-ink'
          }`}
        >
          {info.drain.enabled ? 'Resume spawning' : 'Drain the fleet'}
        </button>
        <span className="text-xs text-dim">
          Draining pauses new agent spawns without stopping running ones. Queued threads are picked up
          automatically when you resume.
        </span>
      </div>
    </div>
  );
}
