import { useEffect, useRef, useState } from 'react';
import { ACTIVITY_CHANNEL, serverMessageSchema, type ActivityEvent, type ServerMessage } from '@cerberus/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

type Handler = (message: ServerMessage) => void;

/**
 * One shared socket for the whole app. Channels are reference-counted, so opening
 * a detail view and its log drawer reuses the same connection, and a reconnect
 * re-subscribes everything that is still mounted.
 */
class ConnectionManager {
  private socket: WebSocket | null = null;
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly channels = new Map<string, number>();
  private readonly handlers = new Set<Handler>();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private status: ConnectionStatus = 'connecting';

  private ensureSocket(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    // A reconnect is already scheduled: honor the backoff rather than opening a socket
    // immediately just because another component mounted mid-outage.
    if (this.reconnectTimer !== null) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = new URLSearchParams(location.search).get('token');
    const url = `${proto}://${location.host}/api/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.backoffMs = 1000;
      this.setStatus('open');
      for (const channel of this.channels.keys()) this.send({ type: 'subscribe', channel });
    });
    socket.addEventListener('message', (event) => {
      const parsed = serverMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) return;
      for (const handler of this.handlers) handler(parsed.data);
    });
    socket.addEventListener('close', () => {
      this.setStatus('reconnecting');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureSocket();
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    });
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private send(message: { type: 'subscribe' | 'unsubscribe'; channel: string }): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  onStatus(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  subscribe(channel: string, handler: Handler): () => void {
    this.ensureSocket();
    this.handlers.add(handler);
    const count = this.channels.get(channel) ?? 0;
    this.channels.set(channel, count + 1);
    if (count === 0) this.send({ type: 'subscribe', channel });

    return () => {
      this.handlers.delete(handler);
      const remaining = (this.channels.get(channel) ?? 1) - 1;
      if (remaining <= 0) {
        this.channels.delete(channel);
        this.send({ type: 'unsubscribe', channel });
      } else {
        this.channels.set(channel, remaining);
      }
    };
  }
}

const manager = new ConnectionManager();

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  useEffect(() => manager.onStatus(setStatus), []);
  return status;
}

/** Subscribes to a snapshot channel; `null` unsubscribes. */
export function useChannel<T>(channel: string | null): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!channel) {
      setData(null);
      return;
    }
    setError(null);
    return manager.subscribe(channel, (message) => {
      if (message.type === 'snapshot' && message.channel === channel) {
        setData(message.data as T);
      } else if (message.type === 'error' && message.channel === channel) {
        setError(message.message);
      }
    });
  }, [channel]);

  return { data, error };
}

export interface LogState {
  lines: string[];
  ended: string | null;
}

/** Subscribes to a log channel, buffering while paused so resuming loses nothing. */
export function useLogChannel(channel: string | null, paused: boolean): LogState & { clear: () => void } {
  const [lines, setLines] = useState<string[]>([]);
  const [ended, setEnded] = useState<string | null>(null);
  const buffer = useRef<string[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // On reconnect the hub replays a fresh tail from scratch, which would otherwise be appended
  // to the lines already on screen and duplicate up to LOG_TAIL lines. Clearing on the
  // reconnecting -> open transition drops the stale tail instead of doubling it up.
  const status = useConnectionStatus();
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current === 'reconnecting' && status === 'open') {
      buffer.current = [];
      setLines([]);
    }
    prevStatus.current = status;
  }, [status]);

  useEffect(() => {
    if (!channel) return;
    setLines([]);
    setEnded(null);
    buffer.current = [];
    return manager.subscribe(channel, (message) => {
      // Narrow to the two variants that carry a channel before comparing — 'pong' has none.
      if (message.type !== 'log' && message.type !== 'log_end') return;
      if (message.channel !== channel) return;
      if (message.type === 'log') {
        if (pausedRef.current) {
          buffer.current.push(...message.lines);
          // Bound the pause buffer: a long pause on a chatty agent must not grow without limit.
          if (buffer.current.length > 5000) {
            buffer.current.splice(0, buffer.current.length - 5000);
          }
        } else {
          // Drain the buffer in the same update: a message arriving between the un-pause
          // render and the flush effect must never jump ahead of older buffered lines.
          const pending = buffer.current;
          buffer.current = [];
          setLines((prev) => [...prev, ...pending, ...message.lines].slice(-2000));
        }
      } else if (message.type === 'log_end') {
        setEnded(message.reason);
      }
    });
  }, [channel]);

  useEffect(() => {
    if (paused || buffer.current.length === 0) return;
    const flushed = buffer.current;
    buffer.current = [];
    setLines((prev) => [...prev, ...flushed].slice(-2000));
  }, [paused]);

  return { lines, ended, clear: () => setLines([]) };
}

/** Snapshot on subscribe, then one delta per event, newest first, capped like the server. */
export function useActivityChannel(active: boolean): ActivityEvent[] {
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    if (!active) return;
    setEvents([]);
    return manager.subscribe(ACTIVITY_CHANNEL, (message) => {
      if (message.type === 'snapshot' && message.channel === ACTIVITY_CHANNEL) {
        setEvents((message.data as { events?: ActivityEvent[] }).events ?? []);
      } else if (message.type === 'activity') {
        setEvents((prev) => [...(message.events as ActivityEvent[]), ...prev].slice(0, 500));
      }
    });
  }, [active]);

  return events;
}
