/**
 * FakeServerHttpDriver — Driver whose server-http mode hits an endpoint the
 * test harness boots on a random port. Exercises ServerHttpAgentController
 * without needing an external service.
 */

import type {
  Driver,
  DriverControl,
  DriverParser,
  DriverProbe,
  DriverProfile,
  ParseResult,
  ServerHttpSpec,
  ControlContext,
} from "../../src/drivers/api.js";
import type { AgentState, AssistantMessage } from "../../src/agents/types.js";

class FakeHttpParser implements DriverParser {
  initialState(): AgentState {
    return { status: "starting", mode: "default", model: "fake-http-1.0" };
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

class FakeHttpControl implements DriverControl {
  async waitForReady(): Promise<void> { /* no-op */ }
  async submit(ctx: ControlContext, text: string): Promise<void> {
    ctx.write(JSON.stringify({ prompt: text }));
  }
  async interrupt(): Promise<void> { /* no-op */ }
  async approve(): Promise<void> { /* no-op */ }
  async reject(): Promise<void> { /* no-op */ }
  async quit(): Promise<void> { /* no-op */ }
}

export interface FakeHttpProfile extends DriverProfile {
  baseUrl?: string;
}

export class FakeServerHttpDriver implements Driver {
  id = "fake-http";
  label = "Fake Server-HTTP Driver (test)";
  version = "0.0.1";
  aliases = ["fkh"];
  modes: ("pty" | "exec" | "server-ws" | "server-http")[] = ["server-http"];
  parser = new FakeHttpParser();
  control = new FakeHttpControl();

  async probe(): Promise<DriverProbe> {
    return {
      available: true,
      version: "fake-http-1.0",
      capabilities: {},
      warnings: [],
      supportedModes: ["server-http"],
    };
  }

  buildServerHttp(profile: FakeHttpProfile): ServerHttpSpec {
    const baseUrl = profile.baseUrl;
    if (!baseUrl) throw new Error("FakeServerHttpDriver requires profile.baseUrl");
    return {
      baseUrl,
      submitPath: "/generate",
    };
  }
}
