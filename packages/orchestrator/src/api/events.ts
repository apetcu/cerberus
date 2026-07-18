export interface CerberusEvent {
  kind: 'agent_spawned' | 'agent_stopped' | 'agent_failed' | 'message_routed';
  threadKey: string;
  /** ISO-8601 */
  at: string;
}

type Listener = (event: CerberusEvent) => void;

/**
 * In-process fan-out of lifecycle events to dashboard subscribers.
 * Listener failures are contained: one bad subscriber never blocks the others
 * or breaks the lifecycle path that published the event.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  publish(event: CerberusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Deliberately swallowed: publishing happens on the hot path of spawn/reap/route.
      }
    }
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
