#!/usr/bin/env node
/**
 * `cordy` — entry point for the CLI binary.
 *
 * Routes to subcommand handlers. The daemon-relevant commands (start/stop)
 * live in `commands/daemon.ts`; everything else opens a JSON-RPC client to
 * the latest running daemon.
 */

import { handleDaemonCommand } from "./commands/daemon.js";
import { runSpawn } from "./commands/spawn.js";
import { runSend } from "./commands/send.js";
import { runList } from "./commands/list.js";
import { runState } from "./commands/state.js";
import { runKill } from "./commands/kill.js";
import { runInterrupt } from "./commands/interrupt.js";
import { runApprove, runReject } from "./commands/approve.js";
import { runTranscript } from "./commands/transcript.js";
import { runBus } from "./commands/bus.js";
import { runDoctor } from "./commands/doctor.js";
import { runDriversCmd } from "./commands/drivers.js";
import { runEphemeral } from "./commands/ephemeral.js";
import { runCapture } from "./commands/capture.js";
import { runMcpStdio } from "./commands/mcp-stdio.js";
import { runManager } from "./commands/manager.js";
import { runCouncil } from "./commands/council.js";

const HELP = `cordy — local-first agent harness CLI

Daemon:
  cordy daemon start [--port N]
  cordy daemon stop
  cordy daemon status
  cordy daemon logs [-f]

Agents:
  cordy spawn <driver> [--name N] [--cwd .] [--profile NAME]
  cordy list [--json]
  cordy state <id> [--json]
  cordy transcript <id> [--last N] [--json]
  cordy kill <id>
  cordy interrupt <id>
  cordy approve <id>                  Approve a pending tool / permission request
  cordy reject <id>                   Reject a pending tool / permission request

Interaction:
  cordy send <id> "<prompt>" [--timeout N] [--no-wait]

Diagnostics:
  cordy doctor
  cordy bus [prefix]
  cordy drivers
  cordy capture <id> [--out PATH] [--duration S]   Record PTY output as JSONL fixture

MCP:
  cordy mcp-stdio                     Expose cordy as an MCP server (stdio) — lets a Claude/Codex
                                      session drive peer agents through your daemon

Manager:
  cordy manager [--driver X] [--model M] <task...>
                                      Spawn a cordy-manager agent wired with MCP delegation

Council:
  cordy council review <path> [--panel ...] [--chair ...] [--timeout N] [--no-chunk] [--json]
                                      Review a single file
  cordy council diff [base] [--staged] [--scope PATH]
                                      Review uncommitted/staged changes (default base: HEAD)

Ephemeral:
  cordy --ephemeral <command...>      Spin up a transient daemon for one command

Version:
  cordy --version                     Print version

Help:
  cordy help                          Show this message
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }

  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    const { VERSION } = await import("../core/version.js");
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  // Ephemeral wrapper: `cordy --ephemeral spawn claude ...`
  if (args[0] === "--ephemeral") {
    process.exit(await runEphemeral(args.slice(1)));
  }

  const cmd = args[0];
  const rest = args.slice(1);

  switch (cmd) {
    case "daemon":
      process.exit(await handleDaemonCommand(rest));
    case "spawn":
      process.exit(await runSpawn(rest));
    case "send":
      process.exit(await runSend(rest));
    case "list":
      process.exit(await runList(rest));
    case "state":
      process.exit(await runState(rest));
    case "kill":
      process.exit(await runKill(rest));
    case "interrupt":
      process.exit(await runInterrupt(rest));
    case "approve":
      process.exit(await runApprove(rest));
    case "reject":
      process.exit(await runReject(rest));
    case "transcript":
      process.exit(await runTranscript(rest));
    case "bus":
      process.exit(await runBus(rest));
    case "doctor":
      process.exit(await runDoctor(rest));
    case "drivers":
      process.exit(await runDriversCmd(rest));
    case "capture":
      process.exit(await runCapture(rest));
    case "mcp-stdio":
      process.exit(await runMcpStdio(rest));
    case "manager":
      process.exit(await runManager(rest));
    case "council":
      process.exit(await runCouncil(rest));
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err: Error) => {
  process.stderr.write(`cordy: ${err.message}\n`);
  process.exit(1);
});
