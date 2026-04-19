/**
 * runtime-server-ws plugin — registers the "server-ws" runtime factory.
 *
 * Activates drivers declaring mode: "server-ws" (e.g. Codex's `app-server`).
 * The controller optionally spawns the backing server via
 * ServerWsSpec.spawnServer, then opens a persistent WS connection and pipes
 * frames through the driver's parser.
 */

import { ServerWsAgentController } from "../../../agents/server-ws-controller.js";
import type { RuntimeFactory } from "../../../agents/manager.js";
import type { CordycepsPlugin, PluginContext } from "../../api.js";

const serverWsFactory: RuntimeFactory = async (opts) => {
  const controller = new ServerWsAgentController({
    id: opts.id,
    driver: opts.driver,
    profile: opts.profile,
    cwd: opts.cwd,
    env: opts.env,
    bus: opts.bus,
    logger: opts.logger,
  });
  await controller.start();
  return controller;
};

const plugin: CordycepsPlugin = {
  name: "runtime-server-ws",
  description: "Registers the 'server-ws' runtime — persistent WebSocket to a driver's server",
  version: "1.0.0",
  order: { priority: 5 },

  async init(ctx: PluginContext) {
    ctx.agents.registerRuntime("server-ws", serverWsFactory);
    ctx.onDestroy(() => { ctx.agents.unregisterRuntime("server-ws"); });
    ctx.logger.info("runtime-server-ws", "server-ws runtime registered");
  },
};

export default plugin;
