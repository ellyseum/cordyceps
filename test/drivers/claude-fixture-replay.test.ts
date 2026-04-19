/**
 * Fixture replay — feed a real captured Claude session through ClaudeParser
 * and assert the same shape of state + messages comes back out.
 *
 * When Claude Code changes (new glyph, new mode line shape, spinner rotation),
 * one of these asserts fails — and the fix lives in `src/drivers/claude/`.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ClaudeParser } from "../../src/drivers/claude/parser.js";
import { loadCapture, replay } from "../fixtures/replay.js";

const FIXTURE_DIR = join(__dirname, "../fixtures/claude/v2.1.114");

function fixture(name: string): string {
  return join(FIXTURE_DIR, name);
}

describe("claude parser — v2.1.114 fixtures", () => {
  it("basic-hello.jsonl: extracts a message with 'hello' and settles idle", () => {
    const path = fixture("basic-hello.jsonl");
    if (!existsSync(path)) {
      throw new Error(`Fixture missing: ${path} — regenerate with \`cordy capture\``);
    }

    const cap = loadCapture(path);
    expect(cap.meta.driver).toBe("claude-code");
    expect(cap.meta.cliVersion).toMatch(/^2\.1\.\d+$/);

    const parser = new ClaudeParser();
    const result = replay(cap, parser);

    // The live capture extracted exactly "hello". Parser must extract the
    // same — anything else means the message-start glyph or its terminator
    // changed.
    const texts = result.messages.map((m) => m.text.trim());
    expect(texts).toContain("hello");

    // Final state should reflect an assistant message having landed.
    expect(result.finalState.lastMessage).toBe("hello");

    // Model should have been pulled from the status line at some point.
    // Claude Code 2.1.114 renders "Opus 4.7" in the mode line.
    expect(result.finalState.model?.toLowerCase()).toContain("opus");
  });

  it("basic-hello.jsonl: live capture state trace matches replay final state", () => {
    const cap = loadCapture(fixture("basic-hello.jsonl"));
    const parser = new ClaudeParser();
    const result = replay(cap, parser);

    // The last state recorded live should be convergent with the replayed state
    // on the fields the parser owns (status, mode, model, lastMessage). Extra
    // fields may diverge (e.g. uiReady was removed but lives in old captures).
    const last = cap.states[cap.states.length - 1]?.state;
    if (last) {
      expect(result.finalState.status).toBe(last.status);
      if (last.model) expect(result.finalState.model).toBe(last.model);
      if (last.lastMessage) expect(result.finalState.lastMessage).toBe(last.lastMessage);
    }
  });
});
