/**
 * FakeDriver — scripted PTY child for deterministic tests.
 *
 * Backed by `bash -c '...'` that emits known output on a timer. Supports
 * the full Driver interface (modes: ["pty"]) so it's interchangeable with
 * the real Claude driver in integration tests.
 */

import type { Driver, DriverParser, DriverControl, DriverProbe, DriverProfile, SpawnSpec, ParseResult, ControlContext } from "../../src/drivers/api.js";
import type { AgentState, AssistantMessage, BlockKind } from "../../src/agents/types.js";

export interface FakeProfile extends DriverProfile {
  /** Bash script the PTY will run. Default: idle prompt loop. */
  script?: string;
}

class FakeParser implements DriverParser {
  initialState(): AgentState {
    return { status: "idle", mode: "default", model: "fake-1.0" };
  }

  feed(chunk: string, state: AgentState): ParseResult {
    const events: ParseResult["events"] = [];
    const messages: AssistantMessage[] = [];
    const next: AgentState = { ...state };
    let changed = false;

    // Recognize `MSG: <text>` lines as messages
    const msgMatch = chunk.match(/MSG:\s*(.+)/);
    if (msgMatch) {
      const text = msgMatch[1].trim();
      next.lastMessage = text;
      messages.push({ text, ts: new Date().toISOString() });
      events.push({ kind: "message", data: { text } });
      changed = true;
    }

    // Recognize `BUSY` and `IDLE` markers
    if (chunk.includes("BUSY")) {
      next.status = "busy";
      next.activity = { label: "fake-activity" };
      changed = true;
    }
    if (chunk.includes("IDLE")) {
      next.status = "idle";
      delete next.activity;
      changed = true;
    }

    // Recognize `BLOCK:<kind>` markers
    const blockMatch = chunk.match(/BLOCK:(\w[\w-]*)/);
    if (blockMatch) {
      next.blocking = { kind: blockMatch[1] as BlockKind };
      next.status = "blocked";
      events.push({ kind: "blocked", data: next.blocking });
      changed = true;
    }
    if (chunk.includes("UNBLOCK")) {
      delete next.blocking;
      next.status = "idle";
      changed = true;
    }

    return { state: changed ? next : state, events, messages };
  }
}

class FakeControl implements DriverControl {
  async waitForReady(_ctx: ControlContext, _timeoutMs: number): Promise<void> {
    // No-op; fake is always ready
  }
  async submit(ctx: ControlContext, text: string): Promise<void> {
    // Lowercase prefix so the bash `submit*` case matches
    ctx.write(`submit ${text}\n`);
  }
  async interrupt(ctx: ControlContext): Promise<void> {
    ctx.write(`interrupt\n`);
  }
  async approve(ctx: ControlContext): Promise<void> {
    ctx.write(`approve\n`);
  }
  async reject(ctx: ControlContext): Promise<void> {
    ctx.write(`reject\n`);
  }
  async quit(ctx: ControlContext): Promise<void> {
    ctx.write(`quit\n`);
  }
}

export class FakeDriver implements Driver {
  id = "fake";
  label = "Fake Driver (test)";
  version = "0.0.1";
  aliases = ["fk"];
  modes: ("pty" | "exec" | "server-ws" | "server-http")[] = ["pty"];
  parser = new FakeParser();
  control = new FakeControl();

  async probe(): Promise<DriverProbe> {
    return {
      available: true,
      version: "fake-1.0",
      capabilities: {},
      warnings: [],
      supportedModes: ["pty"],
    };
  }

  buildPtySpawn(profile: FakeProfile): SpawnSpec {
    // A small bash program that:
    //   1. Echoes "READY"
    //   2. Loops reading stdin and echoing back markers we recognize
    //   3. On `quit\n`, exits
    const script = profile.script ?? `
      echo "READY"
      while IFS= read -r line; do
        case "$line" in
          quit*) echo "BYE"; exit 0;;
          submit*) echo "BUSY"; sleep 0.1; echo "MSG: got $line"; echo "IDLE";;
          ask*) echo "BLOCK:tool-approval";;
          unblock*) echo "UNBLOCK"; echo "IDLE";;
          *) echo "ECHO: $line";;
        esac
      done
    `.trim();

    return {
      command: "bash",
      args: ["-c", script],
      cwd: profile.cwd ?? process.cwd(),
      env: { ...process.env, ...(profile.env ?? {}) },
    };
  }
}
