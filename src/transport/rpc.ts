/**
 * JSON-RPC 2.0 dispatcher.
 *
 * - `register(method, handler)` — adds a method (core or plugin)
 * - `unregister(method)` — removes (plugin teardown)
 * - `dispatch(client, message)` — handles inbound JSON-RPC requests
 * - `broadcast(method, params)` — sends a notification to all subscribed clients
 * - `send(clientId, method, params)` — direct notification to one client
 */

import type { Logger } from "../core/logger.js";
import {
  isRequest,
  isNotification,
  JsonRpcError,
  JsonRpcMethodError,
  type JsonRpcResponse,
  type JsonRpcRequest,
} from "./types.js";
import type { ClientSession } from "./client-session.js";

export interface RpcHandlerContext {
  clientId: string;
  session: ClientSession;
}

export type JsonRpcHandler = (
  params: unknown,
  ctx: RpcHandlerContext,
) => Promise<unknown>;

export class RpcDispatcher {
  private methods = new Map<string, JsonRpcHandler>();
  private clients = new Set<ClientSession>();
  private readonly logger: Logger;

  constructor(opts: { logger: Logger }) {
    this.logger = opts.logger;
  }

  /** Register a JSON-RPC method handler. Throws on duplicate. */
  register(method: string, handler: JsonRpcHandler): void {
    if (this.methods.has(method)) {
      throw new Error(`Method already registered: ${method}`);
    }
    this.methods.set(method, handler);
  }

  /** Unregister a method (used by plugin teardown). */
  unregister(method: string): boolean {
    return this.methods.delete(method);
  }

  /** Add a client to the broadcast pool. */
  addClient(client: ClientSession): void {
    this.clients.add(client);
  }

  /** Remove a client from the broadcast pool. */
  removeClient(client: ClientSession): void {
    this.clients.delete(client);
  }

  /** All currently connected clients. */
  listClients(): ClientSession[] {
    return [...this.clients];
  }

  /** All registered method names. */
  listMethods(): string[] {
    return [...this.methods.keys()].sort();
  }

  /**
   * Process an inbound JSON-RPC message from a client.
   * Returns the response to send back (for requests). Notifications return null.
   */
  async dispatch(client: ClientSession, raw: unknown): Promise<JsonRpcResponse | null> {
    // Notification (no id) — no response
    if (isNotification(raw)) {
      // Silently allow — clients in v1 don't send notifications upstream
      return null;
    }

    if (!isRequest(raw)) {
      // Malformed
      return {
        jsonrpc: "2.0",
        error: {
          code: JsonRpcError.INVALID_REQUEST,
          message: "Invalid Request",
        },
        id: null,
      };
    }

    const req = raw as JsonRpcRequest;
    const handler = this.methods.get(req.method);

    if (!handler) {
      return {
        jsonrpc: "2.0",
        error: {
          code: JsonRpcError.METHOD_NOT_FOUND,
          message: `Method not found: ${req.method}`,
        },
        id: req.id,
      };
    }

    try {
      const result = await handler(req.params, {
        clientId: client.id,
        session: client,
      });
      return {
        jsonrpc: "2.0",
        result: result ?? null,
        id: req.id,
      };
    } catch (err) {
      if (err instanceof JsonRpcMethodError) {
        return {
          jsonrpc: "2.0",
          error: { code: err.code, message: err.message, data: err.data },
          id: req.id,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("rpc", `handler ${req.method} threw: ${msg}`);
      return {
        jsonrpc: "2.0",
        error: {
          code: JsonRpcError.INTERNAL_ERROR,
          message: "Internal error",
          data: msg,
        },
        id: req.id,
      };
    }
  }

  /** Broadcast a notification to all subscribed clients. */
  broadcast(method: string, params?: unknown): void {
    const payload = { jsonrpc: "2.0" as const, method, params };
    for (const client of this.clients) {
      if (client.isSubscribed(method)) {
        client.send(payload);
      }
    }
  }

  /** Send a notification to a specific client (regardless of subscription). */
  send(clientId: string, method: string, params?: unknown): boolean {
    for (const client of this.clients) {
      if (client.id === clientId) {
        client.send({ jsonrpc: "2.0", method, params });
        return true;
      }
    }
    return false;
  }
}
