import { describe, it, expect } from "vitest";
import { createServiceBus } from "../src/core/bus.js";
import { logger } from "../src/core/logger.js";
import { DriverRegistry } from "../src/drivers/registry.js";
import { AgentManager } from "../src/agents/manager.js";
import { registerBuiltinRuntimes } from "../src/agents/runtime.js";
import { FakeDriver } from "./fixtures/fake-driver.js";

function setup() {
  const bus = createServiceBus();
  const drivers = new DriverRegistry();
  drivers.register(new FakeDriver());
  const manager = new AgentManager({ bus, logger, drivers });
  registerBuiltinRuntimes(manager);
  return { bus, drivers, manager };
}

describe("AgentManager + PtyAgentController (FakeDriver)", () => {
  it("spawns an agent and reports info", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fake", { id: "test-1" });
    expect(agent.id).toBe("test-1");
    expect(agent.driverId).toBe("fake");
    expect(agent.mode).toBe("pty");
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0].id).toBe("test-1");
    await agent.kill();
  });

  it("resolves alias on spawn", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fk", { id: "test-2" });
    expect(agent.driverId).toBe("fake");
    await agent.kill();
  });

  it("submit returns accepted+message when fake echoes a MSG line", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fake", { id: "submit-test" });
    // Wait for READY
    await new Promise((r) => setTimeout(r, 200));
    const result = await agent.submit("hello", { timeoutMs: 3000 });
    expect(result.accepted).toBe(true);
    expect(result.message).toBeDefined();
    expect(result.message?.text).toContain("hello");
    await agent.kill();
  });

  it("submit with expectMessage:false returns immediately", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fake", { id: "fire-forget" });
    await new Promise((r) => setTimeout(r, 200));
    const start = Date.now();
    const result = await agent.submit("anything", { expectMessage: false });
    const elapsed = Date.now() - start;
    expect(result.accepted).toBe(true);
    expect(result.message).toBeUndefined();
    expect(elapsed).toBeLessThan(500);
    await agent.kill();
  });

  it("emits state events on the bus", async () => {
    const { manager, bus } = setup();
    const states: string[] = [];
    bus.on("agent.bus-test.state", (s) => {
      const status = (s as { status: string }).status;
      if (status && !states.includes(status)) states.push(status);
    });
    const agent = await manager.spawn("fake", { id: "bus-test" });
    await new Promise((r) => setTimeout(r, 200));
    await agent.submit("trigger busy", { timeoutMs: 3000 });
    await agent.kill();
    // Should see at least idle (and probably busy)
    expect(states.includes("idle") || states.includes("busy")).toBe(true);
  });

  it("kill resolves exitPromise", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fake", { id: "kill-test" });
    await new Promise((r) => setTimeout(r, 100));
    await agent.kill();
    const code = await agent.exitPromise;
    expect(typeof code).toBe("number");
    expect(agent.exited).toBe(true);
  });

  it("throws when spawning unknown driver", async () => {
    const { manager } = setup();
    await expect(manager.spawn("nope")).rejects.toThrow(/Unknown driver/);
  });

  it("throws when no runtime is registered for the chosen mode", async () => {
    const bus = createServiceBus();
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const manager = new AgentManager({ bus, logger, drivers });
    // Don't register pty runtime — should fail
    await expect(manager.spawn("fake")).rejects.toThrow(/No runtime available/);
  });

  it("throws on duplicate id", async () => {
    const { manager } = setup();
    const a = await manager.spawn("fake", { id: "dup" });
    await expect(manager.spawn("fake", { id: "dup" })).rejects.toThrow(/already in use/);
    await a.kill();
  });

  it("registerRuntime/unregisterRuntime works", () => {
    const { manager } = setup();
    expect(manager.registeredModes()).toContain("pty");
    expect(manager.unregisterRuntime("pty")).toBe(true);
    expect(manager.registeredModes()).not.toContain("pty");
  });

  it("rejects double-registration of same mode", () => {
    const { manager } = setup();
    const noop = async () => ({} as never);
    expect(() => manager.registerRuntime("pty", noop)).toThrow(/already registered/);
  });
});
