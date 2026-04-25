/**
 * engine-runner — entry for the detached daemon process.
 *
 * Spawned by `cordy daemon start` with `detached: true`. Calls startEngine()
 * and stays alive until SIGTERM. Parses the same flags `daemon start`
 * forwards.
 */

import { startEngine, type EngineOpts } from "../engine.js";

function parseArgs(argv: string[]): EngineOpts {
  const opts: EngineOpts = {};
  const auditFlags: Record<string, unknown> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1]) {
      opts.port = parseInt(argv[++i], 10);
    } else if (a === "--audit") {
      auditFlags["--audit"] = true;
    } else if (a === "--audit-dir" && argv[i + 1]) {
      auditFlags["--audit-dir"] = argv[++i];
    }
  }

  if (Object.keys(auditFlags).length > 0) {
    opts.flagOverrides = { audit: auditFlags };
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  await startEngine(opts);
  // startEngine wires SIGTERM/SIGINT/SIGHUP handlers — we just stay alive.
}

main().catch((err: Error) => {
  process.stderr.write(`engine-runner: ${err.message}\n`);
  process.exit(1);
});
