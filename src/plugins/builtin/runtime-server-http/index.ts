/**
 * runtime-server-http plugin — registers the "server-http" runtime factory.
 *
 * Activates drivers declaring mode: "server-http" (e.g. Ollama).
 * Each submit triggers an HTTP request whose response is streamed through the
 * driver's parser (NDJSON-framed when the response content-type says so).
 */

import { ServerHttpAgentController } from "../../../agents/server-http-controller.js";
import type { RuntimeFactory } from "../../../agents/manager.js";
import type { CordycepsPlugin, PluginContext } from "../../api.js";

const serverHttpFactory: RuntimeFactory = async (opts) => {
  return new ServerHttpAgentController({
    id: opts.id,
    driver: opts.driver,
    profile: opts.profile,
    cwd: opts.cwd,
    env: opts.env,
    bus: opts.bus,
    logger: opts.logger,
  });
};

const plugin: CordycepsPlugin = {
  name: "runtime-server-http",
  description: "Registers the 'server-http' runtime — HTTP request/response (or NDJSON stream) per submit",
  version: "1.0.0",
  order: { priority: 5 },

  async init(ctx: PluginContext) {
    ctx.agents.registerRuntime("server-http", serverHttpFactory);
    ctx.onDestroy(() => { ctx.agents.unregisterRuntime("server-http"); });
    ctx.logger.info("runtime-server-http", "server-http runtime registered");
  },
};

export default plugin;
