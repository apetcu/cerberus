export function HeartbeatDot({ alive }: { alive: boolean }) {
  return (
    <span
      title={alive ? 'Heartbeat fresh (< 30s)' : 'No heartbeat'}
      className={`inline-block size-2 rounded-full ${alive ? 'bg-ok pulse' : 'border border-line-strong bg-transparent'}`}
    />
  );
}
