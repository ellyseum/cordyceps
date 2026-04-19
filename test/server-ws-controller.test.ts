/**
 * ServerWsAgentController tests via an in-process WebSocket fake server.
 * Exercises connect/submit/message/disconnect/kill lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { createServiceBus } from "../src/core/bus.js";
import { logger } from "../src/core/logger.js";
import { DriverRegistry } from "../src/drivers/registry.js";
import { AgentManager } from "../src/agents/manager.js";
import { registerBuiltinRuntimes } from "../src/agents/runtime.js";
import { ServerWsAgentController } from "../src/agents/server-ws-controller.js";
import { FakeServerWsDriver } from "./fixtures/fake-server-ws-driver.js";

interface Harness {
  server: WebSocketServer;
  wsUrl: string;
  /** Connections the test server has accepted */
  connections: WebSocket[];
}

function startFakeServer(): Promise<Harness> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const connections: WebSocket[] = [];
    server.on("connection", (ws) => {
      connections.push(ws);
      ws.on("message", (raw) => {
        const text = raw.toString();
        try {
          const req = JSON.parse(text) as { type: string; text?: string };
          if (req.type === "submit") {
            ws.send(JSON.stringify({ type: "started" }));
            setTimeout(() => ws.send(JSON.stringify({ type: "message", text: `echo: ${req.text}` })), 20);
            setTimeout(() => ws.send(JSON.stringify({ type: "done" })), 40);
          }
          // interrupt/approve/reject/quit ignored by fake server
        } catch { /* ignore */ }
      });
    });
    server.once("listening", () => {
      const addr = server.address() as AddressInfo;
      const wsUrl = `ws://127.0.0.1:${addr.port}/`;
      resolve({ server, wsUrl, connections });
    });
  });
}

function setup(harness: Harness) {
  const bus = createServiceBus();
  const drivers = new DriverRegistry();
  drivers.register(new FakeServerWsDriver());
  const manager = new AgentManager({ bus, logger, drivers });
  registerBuiltinRuntimes(manager);
  manager.registerRuntime("server-ws", async (opts) => {
    const c = new ServerWsAgentController({
      id: opts.id,
      driver: opts.driver,
      profile: { ...opts.profile, wsUrl: harness.wsUrl },
      cwd: opts.cwd,
      env: opts.env,
      bus: opts.bus,
      logger: opts.logger,
    });
    await c.start();
    return c;
  });
  return { bus, drivers, manager };
}

describe("ServerWsAgentController (FakeServerWsDriver)", () => {
  let harness: Harness;

  beforeEach(async () => { harness = await startFakeServer(); });
  afterEach(async () => {
    harness.server.close();
    for (const ws of harness.connections) try { ws.close(); } catch { /* ignore */ }
  });

  it("connects and transitions starting → idle", async () => {
    const { manager } = setup(harness);
    const agent = await manager.spawn("fake-ws", { id: "connect-test" });
    expect(agent.mode).toBe("server-ws");
    // Give the open event time to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(agent.state.status).toBe("idle");
    await agent.kill();
  });

  it("submit round-trips a message via WS", async () => {
    const { manager } = setup(harness);
    const agent = await manager.spawn("fake-ws", { id: "submit-test" });
    await new Promise((r) => setTimeout(r, 50));
    const result = await agent.submit("ping", { timeoutMs: 3000 });
    expect(result.accepted).toBe(true);
    expect(result.message?.text).toContain("ping");
    await agent.kill();
  });

  it("transcript accumulates across submits", async () => {
    const { manager } = setup(harness);
    const agent = await manager.spawn("fake-ws", { id: "transcript-test" });
    await new Promise((r) => setTimeout(r, 50));
    await agent.submit("one", { timeoutMs: 3000 });
    await agent.submit("two", { timeoutMs: 3000 });
    expect(agent.transcript).toHaveLength(2);
    await agent.kill();
  });

  it("kill closes the WS and marks exited", async () => {
    const { manager } = setup(harness);
    const agent = await manager.spawn("fake-ws", { id: "kill-test" });
    await new Promise((r) => setTimeout(r, 50));
    expect(agent.exited).toBe(false);
    await agent.kill();
    expect(agent.exited).toBe(true);
    await expect(agent.exitPromise).resolves.toBeTypeOf("number");
  });

  it("server-side close triggers exit event", async () => {
    const { manager } = setup(harness);
    const agent = await manager.spawn("fake-ws", { id: "server-close" });
    await new Promise((r) => setTimeout(r, 50));
    expect(agent.exited).toBe(false);
    // Close from the server side
    for (const ws of harness.connections) ws.close();
    // Wait for exit event
    await agent.exitPromise;
    expect(agent.exited).toBe(true);
  });
});
