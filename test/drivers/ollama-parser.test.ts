/**
 * OllamaParser tests — streaming generate NDJSON.
 */

import { describe, it, expect } from "vitest";
import { OllamaParser } from "../../src/drivers/ollama/parser.js";

function feed(parser: OllamaParser, lines: string[]) {
  let state = parser.initialState();
  const messages: Array<{ text: string; tokens?: number }> = [];
  const events: Array<{ kind: string; data: unknown }> = [];
  for (const line of [...lines, ""]) {
    const r = parser.feed(line, state);
    state = r.state;
    for (const m of r.messages) messages.push(m);
    for (const e of r.events) events.push(e);
  }
  return { state, messages, events };
}

describe("OllamaParser", () => {
  it("accumulates streaming tokens into a single message on done:true", () => {
    const p = new OllamaParser();
    const { state, messages } = feed(p, [
      `{"model":"qwen2.5:7b","response":"hel","done":false}`,
      `{"model":"qwen2.5:7b","response":"lo","done":false}`,
      `{"model":"qwen2.5:7b","response":"","done":true,"prompt_eval_count":10,"eval_count":5}`,
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("hello");
    expect(messages[0].tokens).toBe(15);
    expect(state.status).toBe("idle");
    expect(state.tokens?.used).toBe(15);
    expect(state.lastMessage).toBe("hello");
  });

  it("sets model from first event", () => {
    const p = new OllamaParser();
    const { state } = feed(p, [
      `{"model":"qwen2.5:7b","response":"x","done":false}`,
    ]);
    expect(state.model).toBe("qwen2.5:7b");
    expect(state.status).toBe("busy");
  });

  it("non-streaming (single JSON with done:true) still works", () => {
    const p = new OllamaParser();
    const { messages, state } = feed(p, [
      `{"model":"qwen2.5:7b","response":"one-shot","done":true,"prompt_eval_count":5,"eval_count":3}`,
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("one-shot");
    expect(state.status).toBe("idle");
  });

  it("ignores non-JSON garbage", () => {
    const p = new OllamaParser();
    const { state, messages } = feed(p, [
      "not json",
      `{"model":"m","response":"ok","done":true}`,
    ]);
    expect(state.status).toBe("idle");
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("ok");
  });
});
