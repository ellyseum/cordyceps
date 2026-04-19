import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServiceBus } from "../../src/core/bus.js";
import { logger } from "../../src/core/logger.js";
import { DriverRegistry } from "../../src/drivers/registry.js";
import { AgentManager } from "../../src/agents/manager.js";
import { registerBuiltinRuntimes } from "../../src/agents/runtime.js";
import { RpcDispatcher } from "../../src/transport/rpc.js";
import { loadPlugin, destroyPlugin } from "../../src/plugins/loader.js";
import auditPlugin from "../../src/plugins/builtin/audit/index.js";
import { FakeDriver } from "../fixtures/fake-driver.js";

let tmpDir: string;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "cordy-audit-test-"));
  const bus = createServiceBus();
  const drivers = new DriverRegistry();
  drivers.register(new FakeDriver());
  const manager = new AgentManager({ bus, logger, drivers });
  registerBuiltinRuntimes(manager);
  const rpc = new RpcDispatcher({ logger });
  return { bus, drivers, manager, rpc };
}

describe("audit plugin", () => {
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("loads with custom dir from settings", async () => {
    const { bus, drivers, manager, rpc } = setup();
    const loaded = await loadPlugin(auditPlugin, {
      bus, agents: manager, drivers, rpc, logger,
      cwd: process.cwd(),
      pluginConfigs: { audit: { enabled: true, settings: { auditDir: tmpDir } } },
    });
    expect(loaded.registeredMethods).toContain("audit.tail");
    expect(existsSync(tmpDir)).toBe(true);
    await destroyPlugin(loaded, { rpc, logger });
  });

  it("writes JSONL on agent.created and agent.message", async () => {
    const { bus, drivers, manager, rpc } = setup();
    const loaded = await loadPlugin(auditPlugin, {
      bus, agents: manager, drivers, rpc, logger,
      cwd: process.cwd(),
      pluginConfigs: { audit: { enabled: true, settings: { auditDir: tmpDir } } },
    });

    const agent = await manager.spawn("fake", { id: "audit-test" });
    await new Promise((r) => setTimeout(r, 200));
    await agent.submit("hello", { timeoutMs: 3000 });
    await agent.kill();
    await new Promise((r) => setTimeout(r, 100));

    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    const content = readFileSync(join(tmpDir, files[0]), "utf-8");
    expect(content).toContain("agent.created");
    expect(content).toContain("agent.message");

    await destroyPlugin(loaded, { rpc, logger });
  });

  it("audit.tail returns recent entries", async () => {
    const { bus, drivers, manager, rpc } = setup();
    const loaded = await loadPlugin(auditPlugin, {
      bus, agents: manager, drivers, rpc, logger,
      cwd: process.cwd(),
      pluginConfigs: { audit: { enabled: true, settings: { auditDir: tmpDir } } },
    });

    const agent = await manager.spawn("fake", { id: "tail-test" });
    await new Promise((r) => setTimeout(r, 100));
    await agent.kill();
    await new Promise((r) => setTimeout(r, 100));

    const handler = rpc["methods"].get("audit.tail")!;
    const entries = await handler({ limit: 10 }, { clientId: "test", session: { isSubscribed: () => true } as any });
    expect(Array.isArray(entries)).toBe(true);
    expect((entries as Array<{ kind: string }>).length).toBeGreaterThan(0);

    await destroyPlugin(loaded, { rpc, logger });
  });

  it("--no-audit skips init (no JSONL written)", async () => {
    const { bus, drivers, manager, rpc } = setup();
    const loaded = await loadPlugin(auditPlugin, {
      bus, agents: manager, drivers, rpc, logger,
      cwd: process.cwd(),
      pluginConfigs: { audit: { enabled: true, settings: { auditDir: tmpDir } } },
      flagOverrides: { audit: { "--no-audit": true } },
    });
    const agent = await manager.spawn("fake", { id: "no-audit" });
    await new Promise((r) => setTimeout(r, 100));
    await agent.kill();
    await new Promise((r) => setTimeout(r, 100));
    // Audit dir was created by mkdtempSync in setup() but no JSONL should be written
    const jsonl = readdirSync(tmpDir).filter((f) => f.endsWith(".jsonl"));
    expect(jsonl).toHaveLength(0);
    await destroyPlugin(loaded, { rpc, logger });
  });

  it("plugin disabled in config skips entirely", async () => {
    const { bus, drivers, manager, rpc } = setup();
    const loaded = await loadPlugin(auditPlugin, {
      bus, agents: manager, drivers, rpc, logger,
      cwd: process.cwd(),
      pluginConfigs: { audit: { enabled: false } },
    });
    expect(loaded.registeredMethods).toHaveLength(0);
    await destroyPlugin(loaded, { rpc, logger });
  });

  it("destroyPlugin unregisters methods + unsubscribes", async () => {
    const { bus, drivers, manager, rpc } = setup();
    const loaded = await loadPlugin(auditPlugin, {
      bus, agents: manager, drivers, rpc, logger,
      cwd: process.cwd(),
      pluginConfigs: { audit: { enabled: true, settings: { auditDir: tmpDir } } },
    });
    expect(rpc.listMethods()).toContain("audit.tail");
    await destroyPlugin(loaded, { rpc, logger });
    expect(rpc.listMethods()).not.toContain("audit.tail");
  });
});
