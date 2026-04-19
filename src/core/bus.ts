/**
 * ServiceBus — the in-process coordination layer.
 *
 * - Event pub/sub: `emit`, `on`, `once`, `off`. `on` and `once` return an
 *   `Unsubscribe` handle so callers (plugins especially) can track and clean
 *   up their subscriptions without manual bookkeeping.
 * - Key/value state: `get`, `set`, `delete`, `getByPrefix`. State is
 *   last-write-wins, flat namespace. Callers own key prefixes by convention
 *   (see plan §3.1 for the bus-key conventions).
 * - Wait primitive: `waitFor` resolves when an event fires that satisfies
 *   the predicate, or rejects on timeout. Reduces ReAct-loop boilerplate.
 *
 * Intentionally dead-simple. No serialization, no schema. Plugins coordinate
 * through keys they own; this module stays ignorant of what it carries.
 */

export type Unsubscribe = () => void;

export type BusListener<T = unknown> = (data?: T) => void;

export interface ServiceBus {
  /** Emit an event. Synchronous — all listeners run before `emit` returns. */
  emit(event: string, data?: unknown): void;

  /** Subscribe to an event. Returns an unsubscribe handle. */
  on<T = unknown>(event: string, cb: BusListener<T>): Unsubscribe;

  /** One-shot subscription. Auto-unsubscribes after the first emit. */
  once<T = unknown>(event: string, cb: BusListener<T>): Unsubscribe;

  /** Imperative unsubscribe. Prefer the handle returned by `on`/`once`. */
  off(event: string, cb: BusListener): void;

  /** Read a single key. */
  get<T = unknown>(key: string): T | undefined;

  /** Write a key. No event fires — callers should emit explicitly if needed. */
  set(key: string, value: unknown): void;

  /** Remove a key entirely. Distinct from `set(k, undefined)`. */
  delete(key: string): boolean;

  /** Snapshot of all keys starting with `prefix`. Returned Map is a copy. */
  getByPrefix(prefix: string): Map<string, unknown>;

  /**
   * Resolve when `event` fires with data satisfying `predicate` (default: any).
   * Rejects if `timeoutMs` elapses first. Default timeout: 30s.
   */
  waitFor<T = unknown>(
    event: string,
    predicate?: (data: unknown) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export function createServiceBus(): ServiceBus {
  const listeners = new Map<string, Set<BusListener>>();
  const state = new Map<string, unknown>();

  return {
    emit(event, data) {
      const set = listeners.get(event);
      if (!set || set.size === 0) return;
      // Copy to a list so listeners that unsubscribe themselves mid-fire
      // don't mutate the set we're iterating.
      for (const cb of [...set]) {
        try {
          cb(data);
        } catch {
          // Bus listeners must not be able to crash the bus. Callers that
          // want fatal errors should log in their own handler.
        }
      }
    },

    on<T = unknown>(event: string, cb: BusListener<T>): Unsubscribe {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb as BusListener);
      return () => {
        set!.delete(cb as BusListener);
        if (set!.size === 0) listeners.delete(event);
      };
    },

    once<T = unknown>(event: string, cb: BusListener<T>): Unsubscribe {
      const wrapper: BusListener = (data) => {
        unsub();
        cb(data as T);
      };
      const unsub = this.on(event, wrapper);
      return unsub;
    },

    off(event, cb) {
      const set = listeners.get(event);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) listeners.delete(event);
    },

    get<T = unknown>(key: string): T | undefined {
      return state.get(key) as T | undefined;
    },

    set(key, value) {
      state.set(key, value);
    },

    delete(key) {
      return state.delete(key);
    },

    getByPrefix(prefix) {
      const out = new Map<string, unknown>();
      for (const [k, v] of state) {
        if (k.startsWith(prefix)) out.set(k, v);
      }
      return out;
    },

    waitFor<T = unknown>(
      event: string,
      predicate?: (data: unknown) => boolean,
      timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    ): Promise<T> {
      return new Promise((resolve, reject) => {
        const unsub = this.on(event, (data) => {
          if (predicate && !predicate(data)) return;
          clearTimeout(timer);
          unsub();
          resolve(data as T);
        });
        const timer = setTimeout(() => {
          unsub();
          reject(new Error(`waitFor("${event}") timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
    },
  };
}
