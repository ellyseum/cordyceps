/**
 * GeminiParser — interprets `gemini -p --output-format stream-json` output.
 *
 * Observed events (gemini-cli 0.38.2):
 *   {"type":"init","session_id":"...","model":"auto-gemini-3"}
 *   {"type":"message","role":"user","content":"..."}
 *   {"type":"message","role":"assistant","content":"ok","delta":true}
 *   {"type":"message","role":"assistant","content":"<final>","delta":false}? (not always)
 *   {"type":"result","status":"success","stats":{"total_tokens":N,"input_tokens":N,"output_tokens":N,...}}
 *
 * Assistant message deltas stream token-by-token when `delta:true`. The
 * parser accumulates them and flushes on the `result` event (which marks
 * end-of-turn). If delta messages arrive without a terminating `result`,
 * the exec child's exit causes an empty feed which flushes the buffer.
 */

import type { DriverParser, ParseResult } from "../api.js";
import type { AgentState, AssistantMessage } from "../../agents/types.js";

interface GeminiEvent {
  type: string;
  timestamp?: string;
  session_id?: string;
  model?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  status?: string;
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
}

interface GeminiScratch {
  messageBuf: string;
  hasPendingMessage: boolean;
}

export class GeminiParser implements DriverParser {
  private scratch: GeminiScratch = { messageBuf: "", hasPendingMessage: false };

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

    // Empty flush at end of stream — emit any pending assistant message
    if (!chunk) {
      if (this.scratch.hasPendingMessage && this.scratch.messageBuf) {
        const text = this.scratch.messageBuf;
        this.scratch.messageBuf = "";
        this.scratch.hasPendingMessage = false;
        const next: AgentState = { ...state, status: "idle", lastMessage: text };
        messages.push({ text, ts: new Date().toISOString() });
        events.push({ kind: "message", data: { text } });
        return { state: next, events, messages };
      }
      return { state, events, messages };
    }

    const trimmed = chunk.trim();
    if (!trimmed) return { state, events, messages };

    let ev: GeminiEvent;
    try {
      ev = JSON.parse(trimmed) as GeminiEvent;
    } catch {
      // Non-JSON banner/warning line — ignore
      return { state, events, messages };
    }

    const next: AgentState = { ...state, extra: { ...(state.extra ?? {}) } };
    let changed = false;

    switch (ev.type) {
      case "init":
        if (ev.model) {
          next.model = ev.model;
          changed = true;
        }
        if (ev.session_id) {
          (next.extra as Record<string, unknown>).sessionId = ev.session_id;
          changed = true;
        }
        next.status = "busy";
        changed = true;
        break;

      case "message":
        if (ev.role === "assistant" && typeof ev.content === "string") {
          if (ev.delta === true) {
            this.scratch.messageBuf += ev.content;
            this.scratch.hasPendingMessage = true;
          } else {
            // Non-delta assistant message: complete turn text. Append and
            // mark pending; result event (or end-of-stream flush) emits it.
            this.scratch.messageBuf += ev.content;
            this.scratch.hasPendingMessage = true;
          }
        }
        break;

      case "result":
        if (this.scratch.hasPendingMessage && this.scratch.messageBuf) {
          const text = this.scratch.messageBuf;
          this.scratch.messageBuf = "";
          this.scratch.hasPendingMessage = false;
          next.lastMessage = text;
          messages.push({
            text,
            ts: new Date().toISOString(),
            tokens: ev.stats?.total_tokens,
          });
          events.push({ kind: "message", data: { text } });
        }
        if (ev.stats) {
          next.tokens = { used: ev.stats.total_tokens ?? 0 };
        }
        next.status = "idle";
        events.push({ kind: "turn.completed", data: ev.stats ?? {} });
        changed = true;
        break;
    }

    return { state: changed ? next : state, events, messages };
  }
}
