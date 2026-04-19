/**
 * `cordy doctor` — minimal v1 health check.
 *
 * Reports daemon status, available drivers, version compatibility, and
 * `/health` HTTP probe. Always runnable without a daemon.
 */

import { findLatestInstance } from "../../daemon/instances.js";
import { connect } from "../client.js";

type Compat = "supported" | "untested" | "unsupported" | "any";

function badgeForCompat(compat: Compat | undefined, available: boolean | undefined): string {
  if (!available) return "✗";
  switch (compat) {
    case "supported":   return "✓";
    case "untested":    return "⚠";
    case "unsupported": return "✗";
    default:            return "✓";
  }
}

export async function runDoctor(_args: string[]): Promise<number> {
  let exitCode = 0;
  process.stdout.write("cordy doctor\n");
  process.stdout.write("─────────────\n");

  // Daemon status
  const inst = findLatestInstance();
  if (!inst) {
    process.stdout.write("Daemon:        ✗ not running\n");
    exitCode = 1;
    return exitCode;
  }

  process.stdout.write(`Daemon:        ✓ running (PID ${inst.pid}, ${inst.url})\n`);

  // /health probe
  try {
    const url = inst.url.replace(/^ws/, "http").replace("/rpc", "/health");
    const res = await fetch(url);
    if (res.ok) {
      const body = await res.json() as { version: string; uptime: number };
      process.stdout.write(`Health:        ✓ ${body.version} (uptime ${body.uptime}s)\n`);
    } else {
      process.stdout.write(`Health:        ✗ HTTP ${res.status}\n`);
      exitCode = 1;
    }
  } catch (err) {
    process.stdout.write(`Health:        ✗ ${(err as Error).message}\n`);
    exitCode = 1;
  }

  // Drivers via JSON-RPC
  try {
    const client = await connect({ url: inst.url, token: inst.token });
    const drivers = await client.call<Array<{
      id: string;
      supportedVersions?: string;
      probe?: {
        available: boolean;
        version?: string;
        warnings: string[];
        compat?: Compat;
      };
    }>>("drivers.list");

    for (const d of drivers) {
      const probe = d.probe;
      const ver = probe?.version ?? "(no version)";
      const badge = badgeForCompat(probe?.compat, probe?.available);
      const compatLabel = probe?.compat && probe.compat !== "any"
        ? ` [${probe.compat}]`
        : "";
      const range = d.supportedVersions ? `  tested: ${d.supportedVersions}` : "";
      const idPad = d.id.padEnd(12);
      process.stdout.write(`Driver ${idPad} ${badge} ${ver}${compatLabel}${range}\n`);
      if (probe?.warnings?.length) {
        for (const w of probe.warnings) {
          process.stdout.write(`  ⚠  ${w}\n`);
        }
      }
    }
    client.close();
  } catch (err) {
    process.stdout.write(`Drivers:       ✗ ${(err as Error).message}\n`);
    exitCode = 1;
  }

  return exitCode;
}
