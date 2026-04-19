/**
 * CodexParser tests — replays known JSONL event sequences.
 */

import { describe, it, expect } from "vitest";
import { CodexParser } from "../../src/drivers/codex/parser.js";

function feedLines(parser: CodexParser, lines: string[]) {
  let state = parser.initialState();
  const messages: Array<{ text: string }> = [];
  const events: Array<{ kind: string; data: unknown }> = [];
  for (const line of [...lines, ""]) {
    const r = parser.feed(line, state);
    state = r.state;
    for (const m of r.messages) messages.push(m);
    for (const e of r.events) events.push(e);
  }
  return { state, messages, events };
}

describe("CodexParser", () => {
  it("thread.started sets threadId without changing status", () => {
    const p = new CodexParser();
    const { state } = feedLines(p, [
      `{"type":"thread.started","thread_id":"019da69c-ebf5-7f91-af14-0a54fc775711"}`,
    ]);
    expect(state.status).toBe("starting");
    expect((state.extra as { threadId?: string }).threadId).toBe("019da69c-ebf5-7f91-af14-0a54fc775711");
  });

  it("turn.started → busy", () => {
    const p = new CodexParser();
    const { state } = feedLines(p, [
      `{"type":"thread.started","thread_id":"t1"}`,
      `{"type":"turn.started"}`,
    ]);
    expect(state.status).toBe("busy");
  });

  it("item.completed extracts agent_message", () => {
    const p = new CodexParser();
    const { messages } = feedLines(p, [
      `{"type":"thread.started","thread_id":"t1"}`,
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}`,
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("ok");
  });

  it("turn.completed → idle and records tokens", () => {
    const p = new CodexParser();
    const { state } = feedLines(p, [
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20}}`,
    ]);
    expect(state.status).toBe("idle");
    expect(state.tokens?.used).toBe(120); // input + output (cached is a subset)
    expect(state.lastMessage).toBe("ok");
  });

  it("ignores non-JSON lines (banner, warnings)", () => {
    const p = new CodexParser();
    const { state, messages } = feedLines(p, [
      `Reading additional input from stdin...`,
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}`,
      `{"type":"turn.completed"}`,
    ]);
    expect(state.status).toBe("idle");
    expect(messages).toHaveLength(1);
  });

  it("ignores unknown item types", () => {
    const p = new CodexParser();
    const { messages } = feedLines(p, [
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"type":"tool_call","text":"internal"}}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"final"}}`,
      `{"type":"turn.completed"}`,
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("final");
  });
});
