/**
 * ClientSession — per-WS-connection state.
 *
 * Tracks subscription allowlist + identity. The dispatcher uses this to
 * filter which notifications get pushed to which clients.
 */

import type { WebSocket } from "ws";

/** Default events all clients are subscribed to on connect (per plan §7.5). */
export const DEFAULT_SUBSCRIPTIONS = new Set([
  "agent.created",
  "agent.state",
  "agent.message",
  "agent.blocked",
  "agent.idle",
  "agent.exited",
  "plugin.ready",
  "daemon.stopping",
]);

/** Opt-in only — these are noisy/high-volume and require explicit subscribe. */
export const HIGH_VOLUME_EVENTS = new Set([
  "agent.output",
  "bus.changed",
]);

let nextClientId = 1;

export class ClientSession {
  readonly id: string;
  readonly ws: WebSocket;
  readonly subscriptions: Set<string>;
  readonly connectedAt: string;

  constructor(ws: WebSocket) {
    this.id = `client-${nextClientId++}`;
    this.ws = ws;
    this.subscriptions = new Set(DEFAULT_SUBSCRIPTIONS);
    this.connectedAt = new Date().toISOString();
  }

  isSubscribed(event: string): boolean {
    return this.subscriptions.has(event);
  }

  subscribe(events: string[]): void {
    for (const e of events) this.subscriptions.add(e);
  }

  unsubscribe(events: string[]): void {
    for (const e of events) this.subscriptions.delete(e);
  }

  send(payload: unknown): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      // WS write failed — ignore; the close handler will clean up
    }
  }
}
