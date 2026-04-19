/**
 * engine-runner — entry for the detached daemon process.
 *
 * Spawned by `cordy daemon start` with `detached: true`. Calls startEngine()
 * and stays alive until SIGTERM.
 */

import { startEngine } from "../engine.js";

async function main(): Promise<void> {
  let port: number | undefined;
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--port" && process.argv[i + 1]) {
      port = parseInt(process.argv[i + 1], 10);
    }
  }

  await startEngine({ port });
  // startEngine wires SIGTERM/SIGINT/SIGHUP handlers — we just stay alive.
}

main().catch((err: Error) => {
  process.stderr.write(`engine-runner: ${err.message}\n`);
  process.exit(1);
});
