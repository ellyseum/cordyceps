/**
 * cordy client — thin JSON-RPC over WebSocket client.
 *
 * Used by every `cordy` subcommand to talk to the daemon. Supports:
 *   - Discovery via ~/.cordyceps/instances/{pid}.json
 *   - Notification subscriptions (for live streaming subcommands)
 *   - Ephemeral mode: spawn a transient daemon, run, tear down
 */

import WebSocket from "ws";
import { findLatestInstance, type InstanceRecord } from "../daemon/instances.js";

export class RpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcClient {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  subscribe(events: string[]): Promise<void>;
  unsubscribe(events: string[]): Promise<void>;
  on(method: string, cb: (params: unknown) => void): () => void;
  close(): void;
  readonly url: string;
}

export interface ConnectOpts {
  url?: string;
  token?: string;
  /** If true, connect to an ephemeral daemon (caller must spawn it) */
  ephemeral?: boolean;
}

/** Connect to the latest-running daemon (or the one specified). */
export async function connect(opts: ConnectOpts = {}): Promise<RpcClient> {
  let url = opts.url;
  let token = opts.token;

  if (!url || !token) {
    const inst = findLatestInstance();
    if (!inst) {
      throw new Error(
        "No running cordyceps daemon found. Start one with `cordy daemon start`, " +
        "or run with `cordy --ephemeral <command>` for a transient daemon.",
      );
    }
    url = inst.url;
    token = inst.token;
  }

  return await openClient(url, token);
}

export async function openClient(url: string, token: string): Promise<RpcClient> {
  const wsUrl = `${url}?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      ws.removeAllListeners();
      reject(new Error(`Failed to connect to ${url}: ${err.message}`));
    };
    const onClose = (code: number) => {
      ws.removeAllListeners();
      reject(new Error(`Connection rejected (close ${code}). Bad token?`));
    };
    ws.once("open", () => {
      ws.removeListener("error", onError);
      ws.removeListener("close", onClose);
      resolve();
    });
    ws.once("error", onError);
    ws.once("close", onClose);
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  const handlers = new Map<string, Set<(params: unknown) => void>>();

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        id?: number;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
        method?: string;
        params?: unknown;
      };

      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
        } else {
          p.resolve(msg.result);
        }
        return;
      }

      if (msg.method) {
        const set = handlers.get(msg.method);
        if (set) for (const cb of [...set]) cb(msg.params);
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    // Reject all pending calls
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection closed"));
    }
    pending.clear();
  });

  const call = <T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  };

  const client: RpcClient = {
    url,
    call,
    async subscribe(events: string[]): Promise<void> {
      await call("notifications.subscribe", { events });
    },
    async unsubscribe(events: string[]): Promise<void> {
      await call("notifications.unsubscribe", { events });
    },
    on(method: string, cb: (params: unknown) => void): () => void {
      let set = handlers.get(method);
      if (!set) { set = new Set(); handlers.set(method, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };

  return client;
}
