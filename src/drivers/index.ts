/**
 * Built-in driver bootstrap.
 */

import { DriverRegistry } from "./registry.js";
import { ClaudeDriver } from "./claude/driver.js";
import { CodexDriver } from "./codex/driver.js";
import { OllamaDriver } from "./ollama/driver.js";
import { GeminiDriver } from "./gemini/driver.js";

export function createBuiltinDriverRegistry(): DriverRegistry {
  const registry = new DriverRegistry();
  registry.register(new ClaudeDriver());
  registry.register(new CodexDriver());
  registry.register(new OllamaDriver());
  registry.register(new GeminiDriver());
  return registry;
}

export { DriverRegistry } from "./registry.js";
export * from "./api.js";
