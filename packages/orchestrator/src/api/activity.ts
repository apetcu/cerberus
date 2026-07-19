import { ulid } from 'ulid';
import type { ActivityEvent } from '@cerberus/protocol';
import type { EventBus } from './events.js';

const DEFAULT_CAPACITY = 500;

type Listener = (event: ActivityEvent) => void;

/**
 * A bounded, in-memory feed of lifecycle events. Deliberately not persisted: this answers
 * "what just happened", and a restart clearing it is acceptable. Forensics across restarts
 * would need Postgres, which the design explicitly leaves out of scope.
 */
export class ActivityLog {
  private readonly buffer: ActivityEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private unsubscribe: (() => void) | null;

  constructor(events: EventBus, private readonly capacity = DEFAULT_CAPACITY) {
    this.unsubscribe = events.onEvent((event) => {
      const entry: ActivityEvent = {
        id: ulid(), kind: event.kind, threadKey: event.threadKey, at: event.at,
      };
      this.buffer.push(entry);
      if (this.buffer.length > this.capacity) this.buffer.shift();
      for (const listener of this.listeners) {
        try {
          listener(entry);
        } catch {
          // Contained: publishing runs on the lifecycle hot path.
        }
      }
    });
  }

  /** Newest first, so the UI renders without re-sorting. */
  recent(limit = this.capacity): ActivityEvent[] {
    // Guard zero explicitly: slice(-0) is slice(0) and would return the whole buffer.
    if (limit <= 0) return [];
    return this.buffer.slice(-limit).reverse();
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}
