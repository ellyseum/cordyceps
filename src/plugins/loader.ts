/**
 * Plugin loader — discovery + topological sort + lifecycle.
 *
 * 1. `discoverBuiltins()` returns the in-tree plugin set
 * 2. `sortPlugins(list)` orders by priority groups, then topological sort within
 * 3. `loadPlugin(plugin, ctx)` runs init, registers methods on the dispatcher,
 *    tracks unsubscribes/destroyers for clean teardown
 */

import type { CordycepsPlugin, PluginConfig, PluginContext } from "./api.js";
import { createRpcContext } from "./api.js";
import type { ServiceBus, Unsubscribe } from "../core/bus.js";
import type { Logger } from "../core/logger.js";
import type { AgentManager } from "../agents/manager.js";
import type { DriverRegistry } from "../drivers/index.js";
import type { RpcDispatcher } from "../transport/rpc.js";

export interface LoadedPlugin {
  plugin: CordycepsPlugin;
  /** Method names this plugin registered on the dispatcher */
  registeredMethods: string[];
  /** Unsubscribe handles + custom destroyers from PluginContext */
  disposables: Array<() => void | Promise<void>>;
}

export interface LoaderOpts {
  bus: ServiceBus;
  agents: AgentManager;
  drivers: DriverRegistry;
  rpc: RpcDispatcher;
  logger: Logger;
  cwd: string;
  /** From global config — `plugins[<name>]` slice per plugin */
  pluginConfigs: Record<string, { enabled?: boolean; settings?: Record<string, unknown> }>;
  /** CLI flag overrides per plugin name (or "*" applies to all) */
  flagOverrides?: Record<string, Record<string, unknown>>;
}

/** Discover the built-in plugin set. */
export async function discoverBuiltins(): Promise<CordycepsPlugin[]> {
  const audit = await import("./builtin/audit/index.js");
  const runtimeExec = await import("./builtin/runtime-exec/index.js");
  return [audit.default, runtimeExec.default];
}

/**
 * Sort plugins:
 *   1. Group by `order.priority` (default 0); lower numbers first
 *   2. Within each group, topologically sort by `order.after` / `order.before`
 *   3. Throw on circular dependency
 */
export function sortPlugins(plugins: CordycepsPlugin[]): CordycepsPlugin[] {
  const groups = new Map<number, CordycepsPlugin[]>();
  for (const p of plugins) {
    const pri = p.order?.priority ?? 0;
    let list = groups.get(pri);
    if (!list) { list = []; groups.set(pri, list); }
    list.push(p);
  }

  const sorted: CordycepsPlugin[] = [];
  for (const pri of [...groups.keys()].sort((a, b) => a - b)) {
    sorted.push(...topoSort(groups.get(pri)!, plugins));
  }
  return sorted;
}

function topoSort(group: CordycepsPlugin[], all: CordycepsPlugin[]): CordycepsPlugin[] {
  const nameSet = new Set(group.map((p) => p.name));
  const byName = new Map(all.map((p) => [p.name, p]));
  const edges = new Map<string, Set<string>>();
  for (const p of group) edges.set(p.name, new Set());

  for (const p of group) {
    for (const dep of p.order?.after ?? []) {
      // dep must come before p
      if (nameSet.has(dep)) edges.get(dep)!.add(p.name);
    }
    for (const target of p.order?.before ?? []) {
      // p must come before target
      if (nameSet.has(target)) edges.get(p.name)!.add(target);
    }
    // Cross-group hints (other plugin says "before/after p")
    for (const other of all) {
      if (other === p || !nameSet.has(other.name)) continue;
      if (other.order?.before?.includes(p.name)) edges.get(other.name)!.add(p.name);
      if (other.order?.after?.includes(p.name)) edges.get(p.name)!.add(other.name);
    }
  }

  const inDegree = new Map<string, number>();
  for (const name of nameSet) inDegree.set(name, 0);
  for (const [, targets] of edges) {
    for (const t of targets) {
      if (inDegree.has(t)) inDegree.set(t, inDegree.get(t)! + 1);
    }
  }

  const queue = [...nameSet].filter((n) => inDegree.get(n) === 0).sort();
  const result: CordycepsPlugin[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    result.push(byName.get(name)!);
    for (const target of edges.get(name) ?? []) {
      if (!inDegree.has(target)) continue;
      const deg = inDegree.get(target)! - 1;
      inDegree.set(target, deg);
      if (deg === 0) {
        const idx = queue.findIndex((q) => q > target);
        if (idx === -1) queue.push(target); else queue.splice(idx, 0, target);
      }
    }
  }

  if (result.length !== group.length) {
    const missing = [...nameSet].filter((n) => !result.some((r) => r.name === n));
    throw new Error(`Circular plugin dependency: ${missing.join(", ")}`);
  }
  return result;
}

/** Build a PluginConfig for one plugin from the merged config + flag overrides. */
function buildPluginConfig(
  plugin: CordycepsPlugin,
  globalSlice: { enabled?: boolean; settings?: Record<string, unknown> } | undefined,
  flagOverrides: Record<string, unknown> | undefined,
): PluginConfig {
  return {
    enabled: globalSlice?.enabled !== false,
    settings: globalSlice?.settings ?? {},
    flags: flagOverrides ?? {},
  };
}

/** Load a single plugin. Returns a record so the caller can later destroy it. */
export async function loadPlugin(plugin: CordycepsPlugin, opts: LoaderOpts): Promise<LoadedPlugin> {
  const disposables: Array<() => void | Promise<void>> = [];
  const registeredMethods: string[] = [];

  const cfg = buildPluginConfig(
    plugin,
    opts.pluginConfigs[plugin.name],
    opts.flagOverrides?.[plugin.name] ?? opts.flagOverrides?.["*"],
  );

  // If the plugin is disabled in config, skip init but still return a record
  // (so the loader's accounting is consistent).
  if (!cfg.enabled) {
    opts.logger.info("plugins", `skipping disabled plugin: ${plugin.name}`);
    return { plugin, registeredMethods, disposables };
  }

  // Register methods up front (so init can rely on them being in place if it
  // calls them or queries the dispatcher).
  for (const [name, handler] of Object.entries(plugin.methods ?? {})) {
    opts.rpc.register(name, handler);
    registeredMethods.push(name);
  }

  const ctx: PluginContext = {
    bus: opts.bus,
    agents: opts.agents,
    drivers: opts.drivers,
    rpc: createRpcContext(opts.rpc),
    config: cfg,
    logger: opts.logger,
    cwd: opts.cwd,
    emit: (event, data) => opts.bus.emit(event, data),
    notify: (method, params) => opts.rpc.broadcast(method, params),
    subscribe: (event, cb) => {
      const unsub = opts.bus.on(event, cb as (data?: unknown) => void);
      disposables.push(unsub);
      return unsub;
    },
    onDestroy: (fn) => { disposables.push(fn); },
  };

  if (plugin.init) {
    try {
      await plugin.init(ctx);
    } catch (err) {
      opts.logger.error("plugins", `${plugin.name} init failed: ${(err as Error).message}`);
      throw err;
    }
  }

  opts.bus.emit("plugin.ready", { name: plugin.name });
  opts.logger.info("plugins", `loaded ${plugin.name} v${plugin.version}`);
  return { plugin, registeredMethods, disposables };
}

/** Tear down a loaded plugin: unsubscribe, unregister methods, run destroy. */
export async function destroyPlugin(loaded: LoadedPlugin, opts: { rpc: RpcDispatcher; logger: Logger }): Promise<void> {
  for (const dispose of loaded.disposables) {
    try { await dispose(); } catch (err) {
      opts.logger.warn("plugins", `${loaded.plugin.name} dispose failed: ${(err as Error).message}`);
    }
  }
  for (const method of loaded.registeredMethods) {
    opts.rpc.unregister(method);
  }
  if (loaded.plugin.destroy) {
    try { await loaded.plugin.destroy(); } catch (err) {
      opts.logger.warn("plugins", `${loaded.plugin.name} destroy failed: ${(err as Error).message}`);
    }
  }
  opts.logger.info("plugins", `destroyed ${loaded.plugin.name}`);
}

/** Load all plugins in sorted order. */
export async function loadAll(plugins: CordycepsPlugin[], opts: LoaderOpts): Promise<LoadedPlugin[]> {
  const sorted = sortPlugins(plugins);
  const out: LoadedPlugin[] = [];
  for (const p of sorted) {
    out.push(await loadPlugin(p, opts));
  }
  return out;
}
