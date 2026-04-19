/**
 * ServerHttpAgentController tests via an in-process HTTP server that
 * streams NDJSON responses. Exercises submit lifecycle, transcript
 * accumulation, error handling, and kill semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createServiceBus } from "../src/core/bus.js";
import { logger } from "../src/core/logger.js";
import { DriverRegistry } from "../src/drivers/registry.js";
import { AgentManager } from "../src/agents/manager.js";
import { registerBuiltinRuntimes } from "../src/agents/runtime.js";
import { ServerHttpAgentController, ServerHttpModeError } from "../src/agents/server-http-controller.js";
import { FakeServerHttpDriver } from "./fixtures/fake-server-http-driver.js";

interface Harness {
  server: Server;
  baseUrl: string;
}

function startFakeHttp(): Promise<Harness> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== "/generate" || req.method !== "POST") {
        res.statusCode = 404;
        res.end();
        return;
      }

      let body = "";
      req.setEncoding("utf-8");
      req.on("data", (c: string) => { body += c; });
      req.on("end", () => {
        let prompt = "";
        try {
          const parsed = JSON.parse(body) as { prompt?: string };
          prompt = parsed.prompt ?? "";
        } catch { /* ignore */ }

        res.setHeader("content-type", "application/x-ndjson");
        res.statusCode = 200;
        res.write(JSON.stringify({ type: "started" }) + "\n");
        setTimeout(() => res.write(JSON.stringify({ type: "message", text: `echo: ${prompt}` }) + "\n"), 20);
        setTimeout(() => {
          res.write(JSON.stringify({ type: "done" }) + "\n");
          res.end();
        }, 40);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function setup(harness: Harness) {
  const bus = createServiceBus();
  const drivers = new DriverRegistry();
  drivers.register(new FakeServerHttpDriver());
  const manager = new AgentManager({ bus, logger, drivers });
  registerBuiltinRuntimes(manager);
  manager.registerRuntime("server-http", async (opts) => {
    return new ServerHttpAgentController({
      id: opts.id,
      driver: opts.driver,
      profile: { ...opts.profile, baseUrl: harness.baseUrl },
      cwd: opts.cwd,
      env: opts.env,
      bus: opts.bus,
      logger: opts.logger,
    });
  });
  return { bus, drivers, manager };
}

describe("ServerHttpAgentController (FakeServerHttpDriver)", () => {
  let harness: Harness;

  beforeEach(async () => { harness = await startFakeHttp(); });
  afterEach(async () => { harness.server.close(); });

  it("starts idle (stateless endpoint)", async () => {
    const { manager } = setup(harness);
    const agent = await manager.spawn("fake-http", { id: "http-idle" });
    expect(agent.mode).toBe("server-http");
    expect(agent.state.status).toBe("idle");
    await agent.kill();
  });

  it("submit POSTs and streams the NDJSON response into a message", async () => {
    const { manager } = setup(harness);
    const agent = await manager.spawn("fake-http", { id: "http-submit" });
    const result = await agent.submit("ping", { timeoutMs: 5000 });
    expect(result.accepted).toBe(true);
    expect(result.message?.text).toContain("ping");
    expect(agent.state.status).toBe("idle");
    await agent.kill();
  });

  it("transcript accumulates across requests", async () => {
    const { manager } = setup(harness);
    const agent = await manager.spawn("fake-http", { id: "http-multi" });
    await agent.submit("one", { timeoutMs: 5000 });
    await agent.submit("two", { timeoutMs: 5000 });
    expect(agent.transcript).toHaveLength(2);
    await agent.kill();
  });

  it("approve/reject throw ServerHttpModeError", async () => {
    const { manager } = setup(harness);
    const agent = await manager.spawn("fake-http", { id: "http-nosupport" });
    await expect(agent.approve()).rejects.toThrow(ServerHttpModeError);
    await expect(agent.reject()).rejects.toThrow(ServerHttpModeError);
    await agent.kill();
  });

  it("kill aborts any in-flight request and resolves exitPromise", async () => {
    const { manager } = setup(harness);
    const agent = await manager.spawn("fake-http", { id: "http-kill" });
    expect(agent.exited).toBe(false);
    await agent.kill();
    expect(agent.exited).toBe(true);
    await expect(agent.exitPromise).resolves.toBe(0);
  });
});
