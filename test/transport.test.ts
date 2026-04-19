import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createServiceBus } from "../src/core/bus.js";
import { logger } from "../src/core/logger.js";
import { DriverRegistry } from "../src/drivers/registry.js";
import { AgentManager } from "../src/agents/manager.js";
import { registerBuiltinRuntimes } from "../src/agents/runtime.js";
import { RpcDispatcher } from "../src/transport/rpc.js";
import { registerCoreMethods } from "../src/transport/methods.js";
import { startTransport, type TransportServer } from "../src/transport/server.js";
import { generateToken } from "../src/transport/auth.js";
import { FakeDriver } from "./fixtures/fake-driver.js";

interface Setup {
  server: TransportServer;
  url: string;
  token: string;
  bus: ReturnType<typeof createServiceBus>;
  manager: AgentManager;
}

async function setup(): Promise<Setup> {
  const bus = createServiceBus();
  const drivers = new DriverRegistry();
  drivers.register(new FakeDriver());
  const manager = new AgentManager({ bus, logger, drivers });
  registerBuiltinRuntimes(manager);
  const dispatcher = new RpcDispatcher({ logger });
  const startedAt = Date.now();
  const version = "0.1.0-test";
  registerCoreMethods(dispatcher, { manager, drivers, bus, logger, startedAt, version });
  const token = generateToken();
  const server = await startTransport({ bus, dispatcher, logger, token, version, startedAt });
  return { server, url: server.url, token, bus, manager };
}

interface ClientHandle {
  ws: WebSocket;
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notifications: Array<{ method: string; params: unknown }>;
  close(): void;
}

async function connect(url: string, token: string): Promise<ClientHandle> {
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  const notifications: Array<{ method: string; params: unknown }> = [];

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: unknown };
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
      } else if (msg.method) {
        notifications.push({ method: msg.method, params: msg.params });
      }
    } catch { /* ignore */ }
  });

  return {
    ws,
    notifications,
    call(method, params, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`call ${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
      }) as Promise<any>;
    },
    close() { ws.close(); },
  };
}

let s: Setup;

describe("Transport (JSON-RPC over WebSocket)", () => {
  beforeEach(async () => { s = await setup(); });
  afterEach(async () => {
    // Kill any agents the test created
    for (const a of s.manager.list()) {
      try { await s.manager.kill(a.id); } catch { /* ignore */ }
    }
    await s.server.stop();
  });

  describe("auth", () => {
    it("rejects WS upgrade with no token (401)", async () => {
      const ws = new WebSocket(`${s.url}`);
      const result = await new Promise<string>((resolve) => {
        ws.on("error", (err) => resolve("error: " + err.message));
        ws.on("close", (code) => resolve("close: " + code));
        ws.on("open", () => resolve("open"));
      });
      // Either close (server closed it) or error (handshake failed)
      expect(result).not.toBe("open");
    });

    it("rejects WS upgrade with wrong token", async () => {
      const ws = new WebSocket(`${s.url}?token=bogus`);
      const result = await new Promise<string>((resolve) => {
        ws.on("error", (err) => resolve("error: " + err.message));
        ws.on("close", (code) => resolve("close: " + code));
        ws.on("open", () => resolve("open"));
      });
      expect(result).not.toBe("open");
    });

    it("accepts WS upgrade with correct token", async () => {
      const c = await connect(s.url, s.token);
      expect(c.ws.readyState).toBe(WebSocket.OPEN);
      c.close();
    });
  });

  describe("/health (HTTP)", () => {
    it("returns 200 + JSON without auth", async () => {
      const port = s.server.port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; version: string };
      expect(body.ok).toBe(true);
      expect(body.version).toBe("0.1.0-test");
    });

    it("returns 404 for other paths", async () => {
      const port = s.server.port;
      const res = await fetch(`http://127.0.0.1:${port}/unknown`);
      expect(res.status).toBe(404);
    });
  });

  describe("JSON-RPC core methods", () => {
    it("daemon.health returns version + drivers", async () => {
      const c = await connect(s.url, s.token);
      const result = await c.call<{ ok: boolean; version: string; drivers: string[] }>("daemon.health");
      expect(result.ok).toBe(true);
      expect(result.drivers).toContain("fake");
      c.close();
    });

    it("agents.list starts empty", async () => {
      const c = await connect(s.url, s.token);
      const list = await c.call<unknown[]>("agents.list");
      expect(list).toEqual([]);
      c.close();
    });

    it("agents.spawn → list shows the agent", async () => {
      const c = await connect(s.url, s.token);
      const info = await c.call<{ id: string; driverId: string }>("agents.spawn", { driverId: "fake", id: "x" });
      expect(info.id).toBe("x");
      expect(info.driverId).toBe("fake");
      const list = await c.call<{ id: string }[]>("agents.list");
      expect(list).toHaveLength(1);
      c.close();
    });

    it("returns -32601 for unknown method", async () => {
      const c = await connect(s.url, s.token);
      await expect(c.call("nope.never")).rejects.toMatchObject({ code: -32601 });
      c.close();
    });

    it("returns -32602 for missing required params", async () => {
      const c = await connect(s.url, s.token);
      await expect(c.call("agents.spawn", {})).rejects.toMatchObject({ code: -32602 });
      c.close();
    });

    it("returns -32001 for unknown agent", async () => {
      const c = await connect(s.url, s.token);
      await expect(c.call("agents.state", { id: "nope" })).rejects.toMatchObject({ code: -32001 });
      c.close();
    });
  });

  describe("notifications", () => {
    it("agent.created notification fires on subscribed clients", async () => {
      const c = await connect(s.url, s.token);
      // Default subscriptions include agent.created
      await c.call("agents.spawn", { driverId: "fake", id: "notify-test" });
      // Give the notification a beat to arrive
      await new Promise((r) => setTimeout(r, 100));
      const created = c.notifications.find((n) => n.method === "agent.created");
      expect(created).toBeDefined();
      expect((created!.params as { id: string }).id).toBe("notify-test");
      c.close();
    });

    it("notifications.unsubscribe removes notification fanout", async () => {
      const c = await connect(s.url, s.token);
      await c.call("notifications.unsubscribe", { events: ["agent.created"] });
      await c.call("agents.spawn", { driverId: "fake", id: "no-notify" });
      await new Promise((r) => setTimeout(r, 100));
      expect(c.notifications.find((n) => n.method === "agent.created")).toBeUndefined();
      c.close();
    });

    it("agent.output is opt-in (NOT in default subscriptions)", async () => {
      const c = await connect(s.url, s.token);
      const agent = await c.call<{ id: string }>("agents.spawn", { driverId: "fake", id: "output-test" });
      await new Promise((r) => setTimeout(r, 200));
      // No subscribe to agent.output → none received
      expect(c.notifications.filter((n) => n.method === "agent.output")).toHaveLength(0);
      // Now subscribe
      await c.call("notifications.subscribe", { events: ["agent.output"] });
      await c.call("agents.submit", { id: agent.id, prompt: "hi", expectMessage: false });
      await new Promise((r) => setTimeout(r, 300));
      expect(c.notifications.filter((n) => n.method === "agent.output").length).toBeGreaterThan(0);
      c.close();
    });
  });

  describe("multi-client", () => {
    it("two clients both receive broadcasts", async () => {
      const a = await connect(s.url, s.token);
      const b = await connect(s.url, s.token);
      await a.call("agents.spawn", { driverId: "fake", id: "broadcast-test" });
      await new Promise((r) => setTimeout(r, 100));
      expect(a.notifications.find((n) => n.method === "agent.created")).toBeDefined();
      expect(b.notifications.find((n) => n.method === "agent.created")).toBeDefined();
      a.close(); b.close();
    });
  });
});
