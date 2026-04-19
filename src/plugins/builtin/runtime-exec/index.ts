/**
 * runtime-exec plugin — registers the "exec" runtime factory with AgentManager.
 *
 * Adding this plugin enables agents whose driver declares `modes: [..., "exec"]`
 * to run one-shot subprocesses via `driver.buildExec()`. No core edits required;
 * this is the pattern that future "server-ws" and "server-http" runtimes will
 * follow (one plugin per mode).
 */

import { ExecAgentController } from "../../../agents/exec-controller.js";
import type { RuntimeFactory } from "../../../agents/manager.js";
import type { CordycepsPlugin, PluginContext } from "../../api.js";

const execFactory: RuntimeFactory = async (opts) => {
  return new ExecAgentController({
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
  name: "runtime-exec",
  description: "Registers the 'exec' runtime — one-shot subprocess per submit",
  version: "1.0.0",
  order: { priority: 5 }, // load before user plugins but after core infra

  async init(ctx: PluginContext) {
    ctx.agents.registerRuntime("exec", execFactory);
    ctx.onDestroy(() => { ctx.agents.unregisterRuntime("exec"); });
    ctx.logger.info("runtime-exec", "exec runtime registered");
  },
};

export default plugin;
