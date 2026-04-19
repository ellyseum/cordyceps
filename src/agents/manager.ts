/**
 * AgentManager — owns live agents + the runtime factory registry.
 *
 * Runtime factories are registered per-mode. v1 only registers `pty`. Phase 2+
 * runtime plugins (exec, server-ws, server-http) call `registerRuntime(mode,
 * factory)` to add their backend without touching this code.
 *
 * Spawn flow:
 *   1. Resolve driver by id-or-alias
 *   2. Probe driver if not cached
 *   3. Pick mode: profile.mode > first of (driver.modes ∩ supportedModes ∩ registered factories)
 *   4. Call factory → AgentRuntime
 *   5. Track + emit `agent.created`
 */

import { EventEmitter } from "node:events";
import { generateName } from "../core/names.js";
import type { ServiceBus } from "../core/bus.js";
import type { Logger } from "../core/logger.js";
import type { DriverRegistry } from "../drivers/registry.js";
import type { AgentInfo, AgentRuntime, DriverMode } from "./types.js";

export interface SpawnOptions {
  id?: string;
  cwd?: string;
  profile?: Record<string, unknown>;
  env?: Record<string, string>;
}

export interface RuntimeFactoryOpts {
  id: string;
  driver: import("../drivers/api.js").Driver;
  profile: import("../drivers/api.js").DriverProfile;
  cwd: string;
  env: Record<string, string>;
  bus: ServiceBus;
  logger: Logger;
}

export type RuntimeFactory = (opts: RuntimeFactoryOpts) => Promise<AgentRuntime>;

export interface AgentManagerOpts {
  bus: ServiceBus;
  logger: Logger;
  drivers: DriverRegistry;
}

export class AgentManager extends EventEmitter {
  private agents = new Map<string, AgentRuntime>();
  private runtimes = new Map<DriverMode, RuntimeFactory>();
  private readonly bus: ServiceBus;
  private readonly logger: Logger;
  private readonly drivers: DriverRegistry;

  constructor(opts: AgentManagerOpts) {
    super();
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.drivers = opts.drivers;
  }

  /** Register a runtime factory for a transport mode. v1 wires `pty`. */
  registerRuntime(mode: DriverMode, factory: RuntimeFactory): void {
    if (this.runtimes.has(mode)) {
      throw new Error(`Runtime factory for mode "${mode}" is already registered`);
    }
    this.runtimes.set(mode, factory);
    this.logger.info("agents", `runtime factory registered: ${mode}`);
  }

  /** Unregister a runtime factory (used by plugin teardown). */
  unregisterRuntime(mode: DriverMode): boolean {
    return this.runtimes.delete(mode);
  }

  /** Modes this manager currently knows how to construct */
  registeredModes(): DriverMode[] {
    return [...this.runtimes.keys()];
  }

  async spawn(driverIdOrAlias: string, opts: SpawnOptions = {}): Promise<AgentRuntime> {
    const driver = this.drivers.resolve(driverIdOrAlias);
    if (!driver) {
      throw new Error(`Unknown driver: "${driverIdOrAlias}". Registered: ${this.drivers.list().map(d => d.id).join(", ")}`);
    }

    const probe = await this.drivers.probe(driver.id);
    if (!probe || !probe.available) {
      throw new Error(`Driver ${driver.id} is not available on this machine: ${probe?.warnings.join("; ") ?? "no probe result"}`);
    }

    const preferred = opts.profile?.mode as DriverMode | undefined;
    const registered = this.registeredModes();
    const mode = this.drivers.chooseMode(driver, preferred, probe.supportedModes, registered);
    if (!mode) {
      throw new Error(
        `No runtime available for driver ${driver.id}. ` +
        `Driver modes: [${driver.modes.join(", ")}]. ` +
        `Probe supports: [${probe.supportedModes.join(", ")}]. ` +
        `Registered runtimes: [${registered.join(", ")}].`,
      );
    }

    const factory = this.runtimes.get(mode);
    if (!factory) {
      // Defensive — chooseMode shouldn't have returned this
      throw new Error(`No factory for mode ${mode} (internal error)`);
    }

    const id = opts.id ?? this.uniqueName();
    if (this.agents.has(id)) {
      throw new Error(`Agent id "${id}" is already in use`);
    }

    const cwd = opts.cwd ?? process.cwd();
    const env = opts.env ?? {};
    const profile = { ...(opts.profile ?? {}), mode };

    this.logger.info("agents", `spawning ${id} (driver=${driver.id}, mode=${mode}, cwd=${cwd})`);

    const runtime = await factory({
      id, driver, profile, cwd, env, bus: this.bus, logger: this.logger,
    });

    this.agents.set(id, runtime);

    // Mirror lifecycle to manager events + bus
    runtime.on("exit", () => {
      // Keep the agent in the list briefly so callers can read final state;
      // explicit `kill` or a future GC step removes it. For v1 we keep until
      // explicitly removed via a future API.
      this.emit("agent.exited", runtime.info());
    });

    this.emit("agent.created", runtime.info());
    this.bus.emit("agent.created", runtime.info());

    return runtime;
  }

  get(id: string): AgentRuntime | undefined {
    return this.agents.get(id);
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map((r) => r.info());
  }

  async kill(id: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    await agent.kill(signal);
  }

  /** Remove an exited agent from the registry (frees the id). */
  remove(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (!agent.exited) {
      throw new Error(`Cannot remove ${id} — still running. Kill first.`);
    }
    return this.agents.delete(id);
  }

  /** Terminate all live agents (used by daemon shutdown). */
  async killAll(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const live = [...this.agents.values()].filter((a) => !a.exited);
    await Promise.all(live.map((a) => a.kill(signal).catch(() => {})));
  }

  private uniqueName(): string {
    for (let i = 0; i < 50; i++) {
      const name = generateName();
      if (!this.agents.has(name)) return name;
    }
    // Statistically vanishingly unlikely
    return `agent-${Date.now()}`;
  }
}
