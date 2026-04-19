/**
 * FakeExecDriver — Driver whose exec mode shells out to a bash script that
 * emits known JSONL events. Used to exercise ExecAgentController without
 * needing an external CLI.
 *
 * Emits on stdout:
 *   {"type":"started"}
 *   {"type":"message","text":"<echo>"}
 *   {"type":"done"}
 */

import type {
  Driver,
  DriverControl,
  DriverParser,
  DriverProbe,
  DriverProfile,
  ExecSpec,
  ExecTask,
  ParseResult,
  ControlContext,
} from "../../src/drivers/api.js";
import type { AgentState, AssistantMessage } from "../../src/agents/types.js";

class FakeExecParser implements DriverParser {
  initialState(): AgentState {
    return { status: "starting", mode: "default", model: "fake-exec-1.0" };
  }

  feed(chunk: string, state: AgentState): ParseResult {
    const events: ParseResult["events"] = [];
    const messages: AssistantMessage[] = [];
    const next: AgentState = { ...state };
    let changed = false;

    // Empty flush — no-op for exec parser
    if (!chunk) {
      return { state, events, messages };
    }

    // Each chunk here is expected to be a complete JSONL event line (controller
    // already split on \n for "jsonl" mode). Non-JSON lines are ignored.
    const trimmed = chunk.trim();
    if (!trimmed) return { state, events, messages };

    try {
      const ev = JSON.parse(trimmed) as { type: string; text?: string };
      if (ev.type === "started") {
        next.status = "busy";
        changed = true;
      } else if (ev.type === "message" && typeof ev.text === "string") {
        const text = ev.text;
        next.lastMessage = text;
        messages.push({ text, ts: new Date().toISOString() });
        events.push({ kind: "message", data: { text } });
        changed = true;
      } else if (ev.type === "done") {
        next.status = "idle";
        changed = true;
      }
    } catch {
      // Not a JSON line — ignore
    }

    return { state: changed ? next : state, events, messages };
  }
}

class FakeExecControl implements DriverControl {
  async waitForReady(): Promise<void> { /* no-op */ }
  async submit(): Promise<void> { throw new Error("FakeExecDriver: submit is handled at runtime level (spawn per call)"); }
  async interrupt(): Promise<void> { /* no-op */ }
  async approve(): Promise<void> { /* no-op */ }
  async reject(): Promise<void> { /* no-op */ }
  async quit(): Promise<void> { /* no-op */ }
}

export class FakeExecDriver implements Driver {
  id = "fake-exec";
  label = "Fake Exec Driver (test)";
  version = "0.0.1";
  aliases = ["fkx"];
  modes: ("pty" | "exec" | "server-ws" | "server-http")[] = ["exec"];
  parser = new FakeExecParser();
  control = new FakeExecControl();

  async probe(): Promise<DriverProbe> {
    return {
      available: true,
      version: "fake-exec-1.0",
      capabilities: {},
      warnings: [],
      supportedModes: ["exec"],
    };
  }

  buildExec(profile: DriverProfile, task: ExecTask): ExecSpec {
    // Emit three JSONL events that the parser recognizes, then exit 0.
    // Use printf + sleep to simulate streaming (not all-at-once).
    const escaped = task.prompt.replace(/'/g, "'\\''");
    const script = `
      printf '%s\\n' '{"type":"started"}'
      sleep 0.05
      printf '%s\\n' '{"type":"message","text":"echo: ${escaped}"}'
      sleep 0.05
      printf '%s\\n' '{"type":"done"}'
    `.trim();

    return {
      command: "bash",
      args: ["-c", script],
      cwd: profile.cwd ?? process.cwd(),
      env: { ...process.env, ...(profile.env ?? {}) },
      parseOutput: "jsonl",
    };
  }
}
