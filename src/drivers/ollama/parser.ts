/**
 * OllamaParser — interprets `/api/generate` NDJSON stream events.
 *
 * Each line shape:
 *   {"model":"...", "created_at":"...", "response":"<token>", "done":false}
 *   ...
 *   {"model":"...", "response":"", "done":true, "done_reason":"stop",
 *    "total_duration":..., "prompt_eval_count":N, "eval_count":N, "context":[...]}
 *
 * Streaming: response tokens accumulate into a message buffer. On `done: true`
 * we emit the complete message, record token counts, and settle idle.
 *
 * Non-streaming responses (single JSON, not NDJSON) also work — the controller
 * feeds them as a single chunk and we treat them as `{response, done: true}`.
 */

import type { DriverParser, ParseResult } from "../api.js";
import type { AgentState, AssistantMessage } from "../../agents/types.js";

interface OllamaGenerateEvent {
  model?: string;
  created_at?: string;
  response?: string;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  context?: number[];
}

interface OllamaScratch {
  messageBuf: string;
}

export class OllamaParser implements DriverParser {
  private scratch: OllamaScratch = { messageBuf: "" };

  initialState(): AgentState {
    return {
      status: "starting",
      mode: "default",
      model: "",
      tokens: { used: 0 },
      extra: { mode: "server-http" },
    };
  }

  feed(chunk: string, state: AgentState): ParseResult {
    const events: ParseResult["events"] = [];
    const messages: AssistantMessage[] = [];

    // Empty flush — nothing special to do
    if (!chunk) return { state, events, messages };

    const trimmed = chunk.trim();
    if (!trimmed) return { state, events, messages };

    let ev: OllamaGenerateEvent;
    try {
      ev = JSON.parse(trimmed) as OllamaGenerateEvent;
    } catch {
      return { state, events, messages };
    }

    const next: AgentState = { ...state, extra: { ...(state.extra ?? {}) } };
    let changed = false;

    if (ev.model && !state.model) {
      next.model = ev.model;
      changed = true;
    }

    // Streaming: busy while generating
    if (ev.done === false || (!ev.done && typeof ev.response === "string")) {
      if (state.status !== "busy") {
        next.status = "busy";
        changed = true;
      }
      if (ev.response) {
        this.scratch.messageBuf += ev.response;
      }
    }

    if (ev.done === true) {
      // Final chunk may still carry a tail token in `response` (rare)
      if (ev.response) this.scratch.messageBuf += ev.response;

      const text = this.scratch.messageBuf;
      this.scratch.messageBuf = "";
      if (text) {
        next.lastMessage = text;
        messages.push({
          text,
          ts: new Date().toISOString(),
          tokens: (ev.prompt_eval_count ?? 0) + (ev.eval_count ?? 0),
        });
        events.push({ kind: "message", data: { text } });
      }
      next.status = "idle";
      next.tokens = {
        used: (ev.prompt_eval_count ?? 0) + (ev.eval_count ?? 0),
      };
      changed = true;
    }

    return { state: changed ? next : state, events, messages };
  }
}
