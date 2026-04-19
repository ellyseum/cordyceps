/**
 * CodexParser — interprets `codex exec --json` JSONL events.
 *
 * Events observed against codex-cli 0.121.0:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
 *
 * The controller feeds each JSONL line individually (parseOutput: "jsonl").
 *
 * This parser currently supports exec mode only. PTY and server-ws parsing
 * are future sub-phases — the controller dispatch would branch on
 * `state.extra.mode` to pick the right parse path.
 */

import type { DriverParser, ParseResult } from "../api.js";
import type { AgentState, AssistantMessage } from "../../agents/types.js";

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

export class CodexParser implements DriverParser {
  initialState(): AgentState {
    return {
      status: "starting",
      mode: "default",
      model: "",
      tokens: { used: 0 },
      extra: { mode: "exec" },
    };
  }

  feed(chunk: string, state: AgentState): ParseResult {
    const events: ParseResult["events"] = [];
    const messages: AssistantMessage[] = [];
    const trimmed = chunk.trim();
    if (!trimmed) return { state, events, messages };

    let ev: CodexEvent;
    try {
      ev = JSON.parse(trimmed) as CodexEvent;
    } catch {
      // Not a JSON line — ignore. Codex exec --json should only emit JSON lines
      // on stdout, but be defensive about cold-start banners, warnings, etc.
      return { state, events, messages };
    }

    const next: AgentState = { ...state, extra: { ...(state.extra ?? {}) } };
    let changed = false;

    switch (ev.type) {
      case "thread.started":
        if (ev.thread_id) {
          (next.extra as Record<string, unknown>).threadId = ev.thread_id;
          changed = true;
        }
        break;

      case "turn.started":
        next.status = "busy";
        changed = true;
        events.push({ kind: "turn.started", data: {} });
        break;

      case "item.completed":
        if (ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
          const text = ev.item.text;
          next.lastMessage = text;
          messages.push({ text, ts: new Date().toISOString() });
          events.push({ kind: "message", data: { text } });
          changed = true;
        }
        break;

      case "turn.completed":
        next.status = "idle";
        if (ev.usage) {
          const used =
            (ev.usage.input_tokens ?? 0) +
            (ev.usage.output_tokens ?? 0);
          next.tokens = { used };
        }
        events.push({ kind: "turn.completed", data: ev.usage ?? {} });
        changed = true;
        break;
    }

    return { state: changed ? next : state, events, messages };
  }
}
