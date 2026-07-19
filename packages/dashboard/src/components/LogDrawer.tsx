import { useEffect, useMemo, useRef, useState } from 'react';
import { logsChannel } from '@cerberus/protocol';
import { useLogChannel } from '../lib/ws';

export function LogDrawer({ threadKey, onClose }: { threadKey: string; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const { lines, ended, clear } = useLogChannel(logsChannel(threadKey), paused);
  const bottom = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => (filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines),
    [lines, filter],
  );

  useEffect(() => {
    if (!paused) bottom.current?.scrollIntoView({ block: 'end' });
  }, [visible.length, paused]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/50" onClick={onClose}>
      <section
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-3xl flex-col border-l border-line bg-bg shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">Container logs</h2>
            <p className="truncate font-mono text-xs text-dim">{threadKey}</p>
          </div>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className="w-40 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs text-ink placeholder:text-dim"
          />
          <button onClick={() => setPaused((p) => !p)}
            className="rounded-md border border-line-strong px-2 py-1 text-xs text-muted hover:text-ink">
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={() => void navigator.clipboard.writeText(lines.join('\n'))}
            className="rounded-md border border-line-strong px-2 py-1 text-xs text-muted hover:text-ink">
            Copy
          </button>
          <button onClick={clear}
            className="rounded-md border border-line-strong px-2 py-1 text-xs text-muted hover:text-ink">
            Clear
          </button>
          <button onClick={onClose} className="px-1 text-lg leading-none text-muted hover:text-ink">×</button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-black/40 px-4 py-3">
          {visible.length === 0 && !ended && <p className="text-xs text-dim">Waiting for output…</p>}
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-ink">
            {visible.join('\n')}
          </pre>
          {ended && <p className="mt-3 text-xs text-warn">Stream ended: {ended}</p>}
          <div ref={bottom} />
        </div>

        <footer className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-dim">
          <span>{visible.length} lines{filter && ` (filtered from ${lines.length})`}</span>
          {paused && <span className="text-warn">paused — buffering</span>}
        </footer>
      </section>
    </div>
  );
}
