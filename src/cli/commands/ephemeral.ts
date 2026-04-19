/**
 * `cordy --ephemeral <command...>` — spin up a transient daemon, run the
 * command, tear it down. Useful for scripts and pre-commit hooks.
 *
 * Implementation: starts an in-process engine, then routes the command to
 * the right handler (which connects to localhost:port via the regular client).
 */

import { startEngine } from "../engine.js";
import { runSpawn } from "./spawn.js";
import { runSend } from "./send.js";
import { runList } from "./list.js";
import { runState } from "./state.js";
import { runKill } from "./kill.js";
import { runInterrupt } from "./interrupt.js";
import { runTranscript } from "./transcript.js";
import { runBus } from "./bus.js";
import { runDoctor } from "./doctor.js";
import { runDriversCmd } from "./drivers.js";

export async function runEphemeral(args: string[]): Promise<number> {
  if (args.length === 0) {
    process.stderr.write("Usage: cordy --ephemeral <command...>\n");
    return 1;
  }

  const engine = await startEngine();

  try {
    const cmd = args[0];
    const rest = args.slice(1);
    switch (cmd) {
      case "spawn":      return await runSpawn(rest);
      case "send":       return await runSend(rest);
      case "list":       return await runList(rest);
      case "state":      return await runState(rest);
      case "kill":       return await runKill(rest);
      case "interrupt":  return await runInterrupt(rest);
      case "transcript": return await runTranscript(rest);
      case "bus":        return await runBus(rest);
      case "doctor":     return await runDoctor(rest);
      case "drivers":    return await runDriversCmd(rest);
      default:
        process.stderr.write(`Unknown ephemeral command: ${cmd}\n`);
        return 1;
    }
  } finally {
    await engine.stop();
  }
}
