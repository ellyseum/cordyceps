/**
 * DriverRegistry — resolves drivers by id or alias, tracks probe results.
 */

import type { Driver, DriverMode, DriverProbe } from "./api.js";

export class DriverRegistry {
  private drivers = new Map<string, Driver>();      // by canonical id
  private aliases = new Map<string, string>();      // alias → id
  private probes = new Map<string, DriverProbe>();  // cached probes

  /** Register a driver. Throws on duplicate id or alias collision. */
  register(driver: Driver): void {
    if (this.drivers.has(driver.id)) {
      throw new Error(`Driver id already registered: ${driver.id}`);
    }
    for (const alias of driver.aliases ?? []) {
      if (this.drivers.has(alias) || this.aliases.has(alias)) {
        throw new Error(`Driver alias collides with existing id/alias: ${alias}`);
      }
    }
    this.drivers.set(driver.id, driver);
    for (const alias of driver.aliases ?? []) {
      this.aliases.set(alias, driver.id);
    }
  }

  /** Unregister a driver by id. Used by plugin teardown. */
  unregister(id: string): boolean {
    const driver = this.drivers.get(id);
    if (!driver) return false;
    this.drivers.delete(id);
    for (const alias of driver.aliases ?? []) {
      this.aliases.delete(alias);
    }
    this.probes.delete(id);
    return true;
  }

  /** Resolve an id-or-alias to the driver. Undefined if not registered. */
  resolve(idOrAlias: string): Driver | undefined {
    const canonical = this.drivers.get(idOrAlias)
      ? idOrAlias
      : this.aliases.get(idOrAlias);
    return canonical ? this.drivers.get(canonical) : undefined;
  }

  /** Get canonical id from alias or id (undefined if unknown). */
  canonicalId(idOrAlias: string): string | undefined {
    if (this.drivers.has(idOrAlias)) return idOrAlias;
    return this.aliases.get(idOrAlias);
  }

  /** List all registered drivers */
  list(): Driver[] {
    return [...this.drivers.values()];
  }

  /** Probe a driver (cached). Force re-probe with `refresh: true`. */
  async probe(idOrAlias: string, refresh = false): Promise<DriverProbe | undefined> {
    const driver = this.resolve(idOrAlias);
    if (!driver) return undefined;
    const id = driver.id;
    if (!refresh && this.probes.has(id)) return this.probes.get(id);
    const result = await driver.probe();
    this.probes.set(id, result);
    return result;
  }

  /** Probe all drivers in parallel. */
  async probeAll(refresh = false): Promise<Record<string, DriverProbe>> {
    const ids = [...this.drivers.keys()];
    const results = await Promise.all(ids.map((id) => this.probe(id, refresh)));
    const out: Record<string, DriverProbe> = {};
    ids.forEach((id, i) => { if (results[i]) out[id] = results[i]!; });
    return out;
  }

  /**
   * Choose a mode for a spawn: prefer `preferred` if set and supported,
   * else fall back to first of driver.modes ∩ probed.supportedModes ∩ registeredRuntimes.
   * Returns undefined if nothing overlaps.
   */
  chooseMode(
    driver: Driver,
    preferred: DriverMode | undefined,
    supportedModes: DriverMode[],
    registeredRuntimes: DriverMode[],
  ): DriverMode | undefined {
    const viable = driver.modes.filter((m) =>
      supportedModes.includes(m) && registeredRuntimes.includes(m),
    );
    if (preferred && viable.includes(preferred)) return preferred;
    return viable[0];
  }
}
