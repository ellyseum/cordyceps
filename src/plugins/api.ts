/**
 * Plugin API — what an extension supplies to be loaded by cordyceps.
 *
 * Plugins compose with the rest of the system through:
 *   - `methods` — JSON-RPC handlers, namespaced by plugin name (e.g. `audit.tail`)
 *   - `subcommands` — `cordy <plugin-name> <verb>` shell entry points
 *   - `flags` — per-plugin CLI flags surfaced in `cordy --help`
 *   - `init(ctx)` — wire bus subscriptions, register methods, allocate resources
 *   - `destroy()` — cleanup (most resources auto-cleaned via ctx.subscribe / ctx.onDestroy)
 *
 * Plugins do NOT import each other. Coordination goes through the bus.
 */

import type { ServiceBus, Unsubscribe } from "../core/bus.js";
import type { Logger } from "../core/logger.js";
import type { AgentManager } from "../agents/manager.js";
import type { DriverRegistry } from "../drivers/index.js";
import type { JsonRpcHandler, RpcDispatcher } from "../transport/rpc.js";

export interface CordycepsPlugin {
  name: string;
  description: string;
  version: string;

  /** Load order — lower priority runs first; before/after for topo sort within a priority group */
  order?: PluginOrder;

  /** Subcommands the plugin adds (e.g. `cordy <plugin-name> <verb>`) */
  subcommands?: Record<string, SubcommandDef>;

  /** Plugin-specific flags (appear in `cordy --help`) */
  flags?: FlagDef[];

  /** JSON-RPC methods this plugin exposes — namespaced by plugin name (e.g. "audit.tail") */
  methods?: Record<string, JsonRpcHandler>;

  /** Lifecycle */
  init?(ctx: PluginContext): Promise<void>;
  destroy?(): Promise<void>;
}

export interface PluginOrder {
  priority?: number;       // default 0; lower runs first
  after?: string[];        // plugin names that must init before this one
  before?: string[];       // plugin names that must init after this one
}

export interface FlagDef {
  /** Flag name including leading dashes, e.g. "--audit-dir" */
  name: string;
  type: "boolean" | "string" | "number";
  description: string;
  default?: unknown;
}

export interface SubcommandDef {
  description: string;
  usage?: string;
  /** Returns void (handled) or new args (rewritten and re-dispatched). */
  handler(args: string[], ctx: PluginContext): Promise<string[] | void>;
}

export interface PluginContext {
  bus: ServiceBus;
  agents: AgentManager;
  drivers: DriverRegistry;
  rpc: RpcContext;
  config: PluginConfig;
  logger: Logger;
  cwd: string;

  /** Sugar for ctx.bus.emit */
  emit(event: string, data?: unknown): void;
  /** Sugar for ctx.rpc.broadcast */
  notify(method: string, params?: unknown): void;
  /** Subscribe to bus event with auto-cleanup on plugin destroy */
  subscribe<T = unknown>(event: string, cb: (data?: T) => void): Unsubscribe;
  /** Register a disposable to run on plugin destroy */
  onDestroy(fn: () => void | Promise<void>): void;
}

export interface RpcContext {
  /** Register a method handler (plugins normally use the `methods` field instead) */
  register(method: string, handler: JsonRpcHandler): void;
  /** Broadcast a notification to all subscribed clients */
  broadcast(method: string, params?: unknown): void;
  /** Direct send to a specific client */
  send(clientId: string, method: string, params?: unknown): boolean;
}

export interface PluginConfig {
  /** Whether the plugin is enabled. Default true unless `plugins.<name>.enabled === false`. */
  enabled: boolean;
  /** CLI flag overrides, keyed by flag name (e.g. `"--audit-dir": "/tmp/x"`) */
  flags: Record<string, unknown>;
  /** Plugin-specific settings from `~/.cordyceps/config.json` under `plugins.<name>.settings` */
  settings: Record<string, unknown>;
}

/** Wraps the dispatcher so plugins can register methods + send notifications. */
export function createRpcContext(dispatcher: RpcDispatcher): RpcContext {
  return {
    register: (method, handler) => dispatcher.register(method, handler),
    broadcast: (method, params) => dispatcher.broadcast(method, params),
    send: (clientId, method, params) => dispatcher.send(clientId, method, params),
  };
}
