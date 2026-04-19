/**
 * GeminiParser tests — stream-json event replay.
 */

import { describe, it, expect } from "vitest";
import { GeminiParser } from "../../src/drivers/gemini/parser.js";

function feed(parser: GeminiParser, lines: string[]) {
  let state = parser.initialState();
  const messages: Array<{ text: string; tokens?: number }> = [];
  for (const line of [...lines, ""]) {
    const r = parser.feed(line, state);
    state = r.state;
    for (const m of r.messages) messages.push(m);
  }
  return { state, messages };
}

describe("GeminiParser", () => {
  it("accumulates assistant deltas until result, then emits one message", () => {
    const p = new GeminiParser();
    const { state, messages } = feed(p, [
      `{"type":"init","session_id":"abc","model":"auto-gemini-3"}`,
      `{"type":"message","role":"user","content":"respond: ok"}`,
      `{"type":"message","role":"assistant","content":"ok","delta":true}`,
      `{"type":"result","status":"success","stats":{"total_tokens":12925,"input_tokens":12626,"output_tokens":35}}`,
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("ok");
    expect(messages[0].tokens).toBe(12925);
    expect(state.status).toBe("idle");
    expect(state.model).toBe("auto-gemini-3");
    expect(state.tokens?.used).toBe(12925);
    expect((state.extra as { sessionId?: string }).sessionId).toBe("abc");
  });

  it("concatenates multiple delta chunks into a single message", () => {
    const p = new GeminiParser();
    const { messages } = feed(p, [
      `{"type":"init","model":"m","session_id":"s"}`,
      `{"type":"message","role":"assistant","content":"hel","delta":true}`,
      `{"type":"message","role":"assistant","content":"lo"," delta":true}`.replace(` delta`, `delta`),
      `{"type":"message","role":"assistant","content":" world","delta":true}`,
      `{"type":"result","status":"success","stats":{"total_tokens":5}}`,
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("hello world");
  });

  it("flushes buffered assistant on empty feed (stream ended without result)", () => {
    const p = new GeminiParser();
    const { state, messages } = feed(p, [
      `{"type":"init","model":"m","session_id":"s"}`,
      `{"type":"message","role":"assistant","content":"ok","delta":true}`,
      // No result event — simulating child exit
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("ok");
    expect(state.status).toBe("idle");
  });

  it("ignores non-JSON lines", () => {
    const p = new GeminiParser();
    const { messages } = feed(p, [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      `{"type":"init","session_id":"s","model":"m"}`,
      `{"type":"message","role":"assistant","content":"ok","delta":true}`,
      `{"type":"result","status":"success","stats":{"total_tokens":5}}`,
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("ok");
  });
});
