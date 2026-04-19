/**
 * FakeServerWsDriver — Driver whose server-ws mode connects to a test WS
 * server controlled by the test harness. Exercises ServerWsAgentController
 * without needing an external process.
 *
 * Protocol (fake):
 *   Client → Server: {"type":"submit","text":"<prompt>"}
 *   Server → Client: {"type":"started"}
 *                    {"type":"message","text":"echo: <prompt>"}
 *                    {"type":"done"}
 *
 * Control's interrupt sends {"type":"interrupt"}; the test server ignores it.
 */

import type {
  Driver,
  DriverControl,
  DriverParser,
  DriverProbe,
  DriverProfile,
  ParseResult,
  ServerWsSpec,
  ControlContext,
} from "../../src/drivers/api.js";
import type { AgentState, AssistantMessage } from "../../src/agents/types.js";

class FakeWsParser implements DriverParser {
  initialState(): AgentState {
    return { status: "starting", mode: "default", model: "fake-ws-1.0" };
  }

  feed(chunk: string, state: AgentState): ParseResult {
    const events: ParseResult["events"] = [];
    const messages: AssistantMessage[] = [];
    const next: AgentState = { ...state };
    let changed = false;

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
      // ignore
    }

    return { state: changed ? next : state, events, messages };
  }
}

class FakeWsControl implements DriverControl {
  async waitForReady(): Promise<void> { /* no-op; ws-open gates readiness */ }
  async submit(ctx: ControlContext, text: string): Promise<void> {
    ctx.write(JSON.stringify({ type: "submit", text }));
  }
  async interrupt(ctx: ControlContext): Promise<void> {
    ctx.write(JSON.stringify({ type: "interrupt" }));
  }
  async approve(ctx: ControlContext): Promise<void> {
    ctx.write(JSON.stringify({ type: "approve" }));
  }
  async reject(ctx: ControlContext): Promise<void> {
    ctx.write(JSON.stringify({ type: "reject" }));
  }
  async quit(ctx: ControlContext): Promise<void> {
    ctx.write(JSON.stringify({ type: "quit" }));
  }
}

export interface FakeWsProfile extends DriverProfile {
  /** Override — test harness sets this after starting a server on a random port */
  wsUrl?: string;
}

export class FakeServerWsDriver implements Driver {
  id = "fake-ws";
  label = "Fake Server-WS Driver (test)";
  version = "0.0.1";
  aliases = ["fkw"];
  modes: ("pty" | "exec" | "server-ws" | "server-http")[] = ["server-ws"];
  parser = new FakeWsParser();
  control = new FakeWsControl();

  async probe(): Promise<DriverProbe> {
    return {
      available: true,
      version: "fake-ws-1.0",
      capabilities: {},
      warnings: [],
      supportedModes: ["server-ws"],
    };
  }

  buildServerWs(profile: FakeWsProfile): ServerWsSpec {
    const url = profile.wsUrl;
    if (!url) throw new Error("FakeServerWsDriver requires profile.wsUrl (set by test harness)");
    return { url };
  }
}
