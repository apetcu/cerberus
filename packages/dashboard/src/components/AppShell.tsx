import type { ReactNode } from 'react';
import { ConnectionBadge } from './ConnectionBadge';

export type ConsoleView = 'agents' | 'activity' | 'system';

export function AppShell({ title, subtitle, actions, view, onNavigate, counts, children }: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  view: ConsoleView;
  onNavigate: (view: ConsoleView) => void;
  counts?: Partial<Record<ConsoleView, number>>;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface/60 px-4 py-5 lg:flex">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="" width={28} height={28} className="size-7" />
          <span className="font-semibold tracking-tight">Cerberus</span>
        </div>
        <div className="mt-8 label">Fleet</div>
        <nav className="mt-2 space-y-1 text-sm">
          {(['agents', 'activity', 'system'] as const).map((item) => (
            <button
              key={item}
              onClick={() => onNavigate(item)}
              aria-current={view === item ? 'page' : undefined}
              className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 capitalize transition ${
                view === item ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink'
              }`}
            >
              <span>{item}</span>
              {counts?.[item] !== undefined && (
                <span className="rounded-full bg-line px-1.5 text-[11px] tabular-nums text-muted">
                  {counts[item]}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-1 text-xs text-dim">
          <a className="block hover:text-muted" href="/metrics">Metrics</a>
          <a className="block hover:text-muted" href="/readyz">Readiness</a>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="truncate text-xs text-dim">{subtitle}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {actions}
            <ConnectionBadge />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </main>
    </div>
  );
}
