/**
 * Transport server — HTTP /health + WS /rpc.
 *
 * Loopback-only (`127.0.0.1`). Auto-probes ports 3200-3299 unless an explicit
 * port is given. Bearer token auth on WS upgrade — failure is WS close 1008.
 *
 * Wires the AgentManager bus events → JSON-RPC notifications via the dispatcher
 * so subscribed clients see real-time agent activity.
 */

import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "../core/logger.js";
import type { ServiceBus, Unsubscribe } from "../core/bus.js";
import { ClientSession } from "./client-session.js";
import { RpcDispatcher } from "./rpc.js";
import { verifyUpgradeToken, isLoopbackUpgrade } from "./auth.js";

export interface TransportServerOpts {
  bus: ServiceBus;
  dispatcher: RpcDispatcher;
  logger: Logger;
  token: string;
  /** Specific port (otherwise probe 3200-3299) */
  port?: number;
  version: string;
  startedAt: number;
}

export interface TransportServer {
  url: string;
  port: number;
  /** Stop the server gracefully */
  stop(): Promise<void>;
}

const PORT_PROBE_RANGE = { start: 3200, end: 3299 };

export async function startTransport(opts: TransportServerOpts): Promise<TransportServer> {
  const { bus, dispatcher, logger, token } = opts;

  const server = createHttpServer((req, res) => handleHttp(req, res, opts));

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/rpc") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!isLoopbackUpgrade(req)) {
      // Defense in depth alongside the loopback bind. Any non-loopback Host
      // or Origin gets rejected before we even look at the token.
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      logger.warn(
        "transport",
        `WS upgrade rejected: non-loopback Host/Origin (host=${req.headers.host ?? "?"} origin=${req.headers.origin ?? "?"})`,
      );
      return;
    }
    if (!verifyUpgradeToken(req, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      logger.warn("transport", `WS upgrade rejected from ${req.socket.remoteAddress}: bad/missing token`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, dispatcher, logger));
  });

  const port = await bindLoopback(server, opts.port);
  const url = `ws://127.0.0.1:${port}/rpc`;

  // Wire bus → JSON-RPC notifications
  const cleanups: Unsubscribe[] = [];
  cleanups.push(forwardBusEvent(bus, dispatcher, "agent.created"));
  cleanups.push(forwardBusEvent(bus, dispatcher, "plugin.ready"));
  cleanups.push(forwardBusEvent(bus, dispatcher, "daemon.stopping"));

  // Per-agent events use dynamic event names — we forward by agent ID.
  // Subscribe to the static names by listening to `agent.created` and wiring up.
  cleanups.push(bus.on("agent.created", (info) => {
    const agentId = (info as { id: string }).id;
    if (!agentId) return;
    cleanups.push(bus.on(`agent.${agentId}.state`, (s) => dispatcher.broadcast("agent.state", { agentId, state: s })));
    cleanups.push(bus.on(`agent.${agentId}.message`, (m) => dispatcher.broadcast("agent.message", { agentId, message: m })));
    cleanups.push(bus.on(`agent.${agentId}.blocked`, (b) => dispatcher.broadcast("agent.blocked", { agentId, blocking: b })));
    cleanups.push(bus.on(`agent.${agentId}.idle`, (s) => dispatcher.broadcast("agent.idle", { agentId, state: s })));
    cleanups.push(bus.on(`agent.${agentId}.exited`, (e) => dispatcher.broadcast("agent.exited", { agentId, ...e as object })));
    cleanups.push(bus.on(`agent.${agentId}.output`, (d) => dispatcher.broadcast("agent.output", { agentId, data: d })));
  }));

  // Expose URL + port on the bus for plugins that want to log them. The
  // bearer token deliberately stays out of the bus — anything in-process can
  // read it, and the instance file (mode 0600) is the canonical discovery
  // surface for clients that need it.
  bus.set("transport.url", url);
  bus.set("transport.port", port);

  logger.info("transport", `listening on ${url}`);

  return {
    url,
    port,
    async stop() {
      for (const unsub of cleanups) unsub();
      // Close all WS clients first
      for (const c of dispatcher.listClients()) {
        try { c.ws.close(1001, "Server shutting down"); } catch { /* ignore */ }
      }
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info("transport", "stopped");
    },
  };
}

// ── HTTP /health ──────────────────────────────────────────────────────────

function handleHttp(req: IncomingMessage, res: ServerResponse, opts: TransportServerOpts): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health" && req.method === "GET") {
    const body = JSON.stringify({
      ok: true,
      version: opts.version,
      pid: process.pid,
      uptime: Math.round((Date.now() - opts.startedAt) / 1000),
      methods: opts.dispatcher.listMethods().length,
    });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

// ── WS client handling ───────────────────────────────────────────────────

function handleClient(ws: WebSocket, dispatcher: RpcDispatcher, logger: Logger): void {
  const session = new ClientSession(ws);
  dispatcher.addClient(session);
  logger.debug("transport", `client connected: ${session.id}`);

  ws.on("message", async (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      session.send({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
      return;
    }
    const response = await dispatcher.dispatch(session, parsed);
    if (response) session.send(response);
  });

  ws.on("close", () => {
    dispatcher.removeClient(session);
    logger.debug("transport", `client disconnected: ${session.id}`);
  });

  ws.on("error", (err) => {
    logger.warn("transport", `WS error on ${session.id}: ${err.message}`);
  });
}

// ── Port binding ─────────────────────────────────────────────────────────

async function bindLoopback(server: HttpServer, explicitPort?: number): Promise<number> {
  if (explicitPort) {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(explicitPort, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    return explicitPort;
  }

  for (let port = PORT_PROBE_RANGE.start; port <= PORT_PROBE_RANGE.end; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("error", onError);
          reject(err);
        };
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
      return port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`No free port in ${PORT_PROBE_RANGE.start}-${PORT_PROBE_RANGE.end}`);
}

// ── Bus → notification helpers ───────────────────────────────────────────

function forwardBusEvent(
  bus: ServiceBus,
  dispatcher: RpcDispatcher,
  eventName: string,
): Unsubscribe {
  return bus.on(eventName, (data) => dispatcher.broadcast(eventName, data));
}
