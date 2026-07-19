/** "4m", "2h 5m", "3d" — compact enough for a card stat line. */
export function since(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** Slack thread ts → local clock time. */
export function threadTime(threadTs: string): string {
  const seconds = Number(threadTs.split('.')[0]);
  if (!Number.isFinite(seconds)) return threadTs;
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const shortKey = (threadKey: string): string => threadKey.split('-').slice(1).join('-');
