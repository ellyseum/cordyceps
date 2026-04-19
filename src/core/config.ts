/**
 * Config loader — minimal, reads ~/.cordyceps/config.json on demand.
 *
 * Missing file or invalid JSON → default config. Never throws.
 *
 * Schema is intentionally loose (plugins own their own slice). See §11.2
 * of the plan for the canonical shape.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CordycepsConfig {
  daemon?: {
    port?: number;
  };
  drivers?: Record<string, DriverConfig>;
  plugins?: Record<string, PluginConfigSlice>;
}

export interface DriverConfig {
  profiles?: Record<string, Record<string, unknown>>;
  defaultProfile?: string;
}

export interface PluginConfigSlice {
  enabled?: boolean;
  settings?: Record<string, unknown>;
}

const DEFAULT_PATH = join(homedir(), ".cordyceps", "config.json");

const DEFAULT_CONFIG: CordycepsConfig = {
  daemon: { port: 0 },        // 0 = auto-probe
  drivers: {
    "claude-code": {
      profiles: {
        default: { bare: false, effort: "medium" },
        deterministic: {
          bare: true,
          effort: "xhigh",
          permissionMode: "plan",
          disallowedTools: ["Edit", "Write", "MultiEdit"],
        },
      },
      defaultProfile: "default",
    },
  },
  plugins: {
    audit: { enabled: true },
  },
};

/** Load config from customPath (or ~/.cordyceps/config.json). Merges over defaults. */
export function loadConfig(customPath?: string): CordycepsConfig {
  const path = customPath ?? DEFAULT_PATH;
  if (!existsSync(path)) return cloneDefaults();

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CordycepsConfig>;
    return mergeConfig(cloneDefaults(), parsed);
  } catch {
    // Corrupt file — fall back to defaults. Caller can log.
    return cloneDefaults();
  }
}

function cloneDefaults(): CordycepsConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as CordycepsConfig;
}

/** Shallow merge with `drivers` and `plugins` merged one level deep. */
function mergeConfig(base: CordycepsConfig, override: Partial<CordycepsConfig>): CordycepsConfig {
  const out: CordycepsConfig = { ...base };
  if (override.daemon) out.daemon = { ...base.daemon, ...override.daemon };
  if (override.drivers) {
    out.drivers = { ...base.drivers };
    for (const [id, cfg] of Object.entries(override.drivers)) {
      out.drivers[id] = { ...(base.drivers?.[id] ?? {}), ...cfg };
    }
  }
  if (override.plugins) {
    out.plugins = { ...base.plugins };
    for (const [name, cfg] of Object.entries(override.plugins)) {
      out.plugins[name] = { ...(base.plugins?.[name] ?? {}), ...cfg };
    }
  }
  return out;
}
