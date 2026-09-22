import type { EventChannel, WorldEvents } from '@worldview/ipc-contract';

type Listener = (payload: unknown, clientId?: string) => void;

/**
 * Runtime event bus. Listeners registered by `WorldRuntime.on` receive every event;
 * `clientId` targets a single client (used by per-subscription `world.changed` deltas)
 * and is undefined for broadcasts. A throwing listener never stops the fan-out.
 */
export class RuntimeEmitter {
  private readonly listeners = new Map<EventChannel, Set<Listener>>();

  on<E extends EventChannel>(event: E, listener: (payload: WorldEvents[E], clientId?: string) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener);
    return () => {
      set.delete(listener as Listener);
    };
  }

  emit<E extends EventChannel>(event: E, payload: WorldEvents[E], clientId?: string): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const l of [...set]) {
      try {
        l(payload, clientId);
      } catch {
        /* one listener must never break the others */
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
