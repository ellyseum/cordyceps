/**
 * Daemon engine — wires bus + drivers + manager + dispatcher + transport.
 *
 * Called by `cli/shell.ts` (foreground) or via `cli/commands/daemon.ts`
 * (detached fork). Returns a handle to stop the daemon gracefully.
 */

import { createServiceBus, type ServiceBus } from "../core/bus.js";
import { initLogger, logger } from "../core/logger.js";
import { loadConfig } from "../core/config.js";
import { createBuiltinDriverRegistry } from "../drivers/index.js";
import { AgentManager } from "../agents/manager.js";
import { registerBuiltinRuntimes } from "../agents/runtime.js";
import { RpcDispatcher } from "../transport/rpc.js";
import { registerCoreMethods } from "../transport/methods.js";
import { startTransport, type TransportServer } from "../transport/server.js";
import { generateToken } from "../transport/auth.js";
import { writeInstance, removeInstance } from "../daemon/instances.js";
import { discoverBuiltins, loadAll, destroyPlugin, type LoadedPlugin } from "../plugins/loader.js";

const VERSION = "0.4.2";

export interface EngineOpts {
  port?: number;
  /** Optional path override for the global config */
  configPath?: string;
  /** Optional explicit token (otherwise auto-generated) */
  token?: string;
}

export interface RunningEngine {
  url: string;
  port: number;
  token: string;
  bus: ServiceBus;
  manager: AgentManager;
  transport: TransportServer;
  stop(): Promise<void>;
}

export async function startEngine(opts: EngineOpts = {}): Promise<RunningEngine> {
  initLogger();
  logger.info("engine", `cordyceps ${VERSION} starting (pid=${process.pid})`);

  const config = loadConfig(opts.configPath);
  const startedAt = Date.now();

  const bus = createServiceBus();
  const drivers = createBuiltinDriverRegistry();
  const manager = new AgentManager({ bus, logger, drivers });
  registerBuiltinRuntimes(manager);

  const dispatcher = new RpcDispatcher({ logger });
  registerCoreMethods(dispatcher, { manager, drivers, bus, logger, startedAt, version: VERSION });

  const port = opts.port ?? config.daemon?.port ?? undefined;
  const token = opts.token ?? generateToken();

  const transport = await startTransport({
    bus, dispatcher, logger, token, port, version: VERSION, startedAt,
  });

  // Load built-in plugins (audit, future user plugins)
  const builtinPlugins = await discoverBuiltins();
  const loadedPlugins: LoadedPlugin[] = await loadAll(builtinPlugins, {
    bus,
    agents: manager,
    drivers,
    rpc: dispatcher,
    logger,
    cwd: process.cwd(),
    pluginConfigs: config.plugins ?? {},
  });

  // Register our instance file so external clients can find us
  writeInstance({
    pid: process.pid,
    url: transport.url,
    token,
    port: transport.port,
    startedAt: new Date(startedAt).toISOString(),
    version: VERSION,
  });

  // Cleanup on signals
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("engine", `received ${signal}, shutting down`);
    bus.emit("daemon.stopping", { reason: signal });
    try {
      await manager.killAll();
    } catch (err) {
      logger.warn("engine", `killAll failed: ${(err as Error).message}`);
    }
    // Tear down plugins in reverse load order
    for (const lp of [...loadedPlugins].reverse()) {
      await destroyPlugin(lp, { rpc: dispatcher, logger });
    }
    await transport.stop();
    removeInstance();
    logger.info("engine", "shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  return {
    url: transport.url,
    port: transport.port,
    token,
    bus,
    manager,
    transport,
    async stop() {
      stopping = true;
      bus.emit("daemon.stopping", { reason: "stop" });
      await manager.killAll();
      for (const lp of [...loadedPlugins].reverse()) {
        await destroyPlugin(lp, { rpc: dispatcher, logger });
      }
      await transport.stop();
      removeInstance();
    },
  };
}
