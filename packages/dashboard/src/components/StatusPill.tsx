import type { ThreadStatusName } from '@cerberus/protocol';

const STYLES: Record<ThreadStatusName, string> = {
  running: 'bg-ok/10 text-ok border-ok/30',
  provisioning: 'bg-warn/10 text-warn border-warn/30',
  stopping: 'bg-busy/10 text-busy border-busy/30',
  stopped: 'bg-idle/10 text-muted border-line-strong',
  failed: 'bg-bad/10 text-bad border-bad/30',
};

export function StatusPill({ status }: { status: ThreadStatusName }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${STYLES[status]}`}>
      {status}
    </span>
  );
}
