/**
 * `cordy doctor` — minimal v1 health check.
 *
 * Reports daemon status, available drivers, and `/health` HTTP probe.
 * Always runnable without a daemon (some checks just say "not running").
 */

import { findLatestInstance } from "../../daemon/instances.js";
import { connect } from "../client.js";

export async function runDoctor(_args: string[]): Promise<number> {
  let exitCode = 0;
  process.stdout.write("cordy doctor\n");
  process.stdout.write("─────────────\n");

  // Daemon status
  const inst = findLatestInstance();
  if (!inst) {
    process.stdout.write("Daemon:        ✗ not running\n");
    exitCode = 1;
  } else {
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
      const drivers = await client.call<Array<{ id: string; probe: { available: boolean; version?: string; warnings: string[] } }>>("drivers.list");
      for (const d of drivers) {
        const probe = d.probe;
        const status = probe?.available ? "✓" : "✗";
        const ver = probe?.version ?? "(no version)";
        const warn = probe?.warnings.length ? ` — warnings: ${probe.warnings.join("; ")}` : "";
        process.stdout.write(`Driver "${d.id}":${" ".repeat(Math.max(1, 8 - d.id.length))} ${status} ${ver}${warn}\n`);
      }
      client.close();
    } catch (err) {
      process.stdout.write(`Drivers:       ✗ ${(err as Error).message}\n`);
      exitCode = 1;
    }
  }

  return exitCode;
}
