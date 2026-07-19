import { useConnectionStatus } from '../lib/ws';

const COPY = {
  open: { text: 'live', className: 'text-ok' },
  connecting: { text: 'connecting', className: 'text-muted' },
  reconnecting: { text: 'reconnecting', className: 'text-warn' },
} as const;

export function ConnectionBadge() {
  const status = useConnectionStatus();
  const { text, className } = COPY[status];
  return (
    <span className={`flex items-center gap-2 text-xs ${className}`}>
      <span className={`size-1.5 rounded-full bg-current ${status === 'open' ? 'pulse' : ''}`} />
      {text}
    </span>
  );
}
