/**
 * ExecAgentController tests via FakeExecDriver (bash-scripted JSONL emitter).
 *
 * Exercises the one-shot-per-submit lifecycle: idle → busy on spawn,
 * message collection, automatic return to idle, exec-mode unsupported ops.
 */

import { describe, it, expect } from "vitest";
import { createServiceBus } from "../src/core/bus.js";
import { logger } from "../src/core/logger.js";
import { DriverRegistry } from "../src/drivers/registry.js";
import { AgentManager } from "../src/agents/manager.js";
import { registerBuiltinRuntimes } from "../src/agents/runtime.js";
import { ExecAgentController, ExecModeUnsupported } from "../src/agents/exec-controller.js";
import { FakeExecDriver } from "./fixtures/fake-exec-driver.js";

function setup() {
  const bus = createServiceBus();
  const drivers = new DriverRegistry();
  drivers.register(new FakeExecDriver());
  const manager = new AgentManager({ bus, logger, drivers });
  registerBuiltinRuntimes(manager);
  // Register exec runtime manually (as the plugin would)
  manager.registerRuntime("exec", async (opts) => {
    return new ExecAgentController({
      id: opts.id,
      driver: opts.driver,
      profile: opts.profile,
      cwd: opts.cwd,
      env: opts.env,
      bus: opts.bus,
      logger: opts.logger,
    });
  });
  return { bus, drivers, manager };
}

describe("ExecAgentController (FakeExecDriver)", () => {
  it("starts idle (no persistent child)", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fake-exec", { id: "idle-start" });
    expect(agent.mode).toBe("exec");
    expect(agent.state.status).toBe("idle");
    await agent.kill();
  });

  it("submit spawns a child, collects message, returns to idle", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fake-exec", { id: "submit-basic" });

    const result = await agent.submit("hello world", { timeoutMs: 5000 });
    expect(result.accepted).toBe(true);
    expect(result.message).toBeDefined();
    expect(result.message?.text).toContain("hello world");
    expect(agent.state.status).toBe("idle");
    await agent.kill();
  });

  it("transcript accumulates across multiple submits", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fake-exec", { id: "multi-submit" });

    await agent.submit("one", { timeoutMs: 5000 });
    await agent.submit("two", { timeoutMs: 5000 });
    await agent.submit("three", { timeoutMs: 5000 });

    expect(agent.transcript).toHaveLength(3);
    expect(agent.transcript[0].text).toContain("one");
    expect(agent.transcript[2].text).toContain("three");
    await agent.kill();
  });

  it("concurrent submit while busy rejects unless interruptIfBusy", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fake-exec", { id: "concurrent" });

    // Fire-and-forget first submit so we stay busy
    const first = agent.submit("slow", { timeoutMs: 5000 });
    // Immediately try a second — should throw
    await expect(agent.submit("second", { timeoutMs: 5000 })).rejects.toThrow(/already processing/);
    await first;
    await agent.kill();
  });

  it("approve/reject/rawWrite throw ExecModeUnsupported", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fake-exec", { id: "unsupported" });

    await expect(agent.approve()).rejects.toThrow(ExecModeUnsupported);
    await expect(agent.reject()).rejects.toThrow(ExecModeUnsupported);
    expect(() => agent.rawWrite("x")).toThrow(ExecModeUnsupported);
    await agent.kill();
  });

  it("kill marks exited and resolves exitPromise", async () => {
    const { manager } = setup();
    const agent = await manager.spawn("fake-exec", { id: "kill-test" });
    expect(agent.exited).toBe(false);
    await agent.kill();
    expect(agent.exited).toBe(true);
    await expect(agent.exitPromise).resolves.toBe(0);
  });
});
