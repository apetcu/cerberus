export interface ThreadKeyParts {
  teamId: string;
  channelId: string;
  threadTs: string;
}

/** `<teamId>-<channelId>-<threadTs>`. Components must be non-empty and contain no '-'. */
export function buildThreadKey(p: ThreadKeyParts): string {
  for (const [name, value] of Object.entries(p)) {
    if (!value || value.includes('-')) throw new Error(`invalid threadKey component ${name}: "${value}"`);
  }
  return `${p.teamId}-${p.channelId}-${p.threadTs}`;
}

export function parseThreadKey(key: string): ThreadKeyParts {
  const parts = key.split('-');
  if (parts.length !== 3 || parts.some((s) => s.length === 0)) {
    throw new Error(`invalid threadKey: "${key}"`);
  }
  const [teamId, channelId, threadTs] = parts as [string, string, string];
  return { teamId, channelId, threadTs };
}

export const OUTBOX_STREAM = 'outbox';
/**
 * The consumer group every agent reads its mailbox through. Shared here because the
 * orchestrator's MailboxBacklog inspects this group's state to decide whether a thread
 * holds unprocessed work; the two sides must never drift apart on the name.
 */
export const MAILBOX_GROUP = 'agent';
export const mailboxKey = (threadKey: string): string => `mailbox:${threadKey}`;
export const dedupKey = (id: string): string => `dedup:slack:${id}`;
export const deliveryGuardKey = (outboundId: string): string => `delivered:${outboundId}`;
export const heartbeatKey = (threadKey: string): string => `heartbeat:${threadKey}`;
