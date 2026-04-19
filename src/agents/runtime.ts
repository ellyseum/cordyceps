/**
 * Runtime factory wiring — registers the v1 PTY runtime with an AgentManager.
 *
 * Phase 2+ runtime plugins (exec, server-ws, server-http) follow the same
 * shape: a function that takes RuntimeFactoryOpts, returns AgentRuntime.
 */

import { PtyAgentController } from "./pty-controller.js";
import type { AgentManager, RuntimeFactory } from "./manager.js";

export const ptyRuntimeFactory: RuntimeFactory = async (opts) => {
  const controller = new PtyAgentController({
    id: opts.id,
    driver: opts.driver,
    profile: opts.profile,
    cwd: opts.cwd,
    bus: opts.bus,
    logger: opts.logger,
  });
  controller.start();
  return controller;
};

/** Convenience: register only the v1 runtime (PTY). */
export function registerBuiltinRuntimes(manager: AgentManager): void {
  manager.registerRuntime("pty", ptyRuntimeFactory);
}
