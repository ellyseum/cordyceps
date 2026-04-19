/**
 * Built-in driver bootstrap.
 */

import { DriverRegistry } from "./registry.js";
import { ClaudeDriver } from "./claude/driver.js";
import { CodexDriver } from "./codex/driver.js";

export function createBuiltinDriverRegistry(): DriverRegistry {
  const registry = new DriverRegistry();
  registry.register(new ClaudeDriver());
  registry.register(new CodexDriver());
  return registry;
}

export { DriverRegistry } from "./registry.js";
export * from "./api.js";
