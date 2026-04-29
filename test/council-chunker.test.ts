/**
 * Unit tests for the council plugin's line-based chunker. The chunker is
 * deliberately exposed only indirectly (through council.review), so we pull it
 * out via dynamic import from the built dist since it isn't in the plugin's
 * public export surface. The logic is simple enough that behavior-level
 * testing is enough.
 */

import { describe, it, expect } from "vitest";
// Import the module to get a handle on the chunker via source re-export.
// We add a named export of `chunkByLines` just for testability.
import { __testables__ } from "../src/plugins/builtin/council/index.js";

const { chunkByLines, driverSupportsTools, defaultModeFor } = __testables__;

describe("council chunker", () => {
  it("returns a single chunk for small files", () => {
    const chunks = chunkByLines("hello\nworld", 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(2);
    expect(chunks[0].total).toBe(1);
  });

  it("splits when size exceeds maxBytes", () => {
    // Each line is ~10 bytes incl. newline. 10 lines = ~100 bytes.
    const text = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join("\n");
    const chunks = chunkByLines(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startLine).toBe(1);
    // Last chunk should end at the last line
    const last = chunks[chunks.length - 1];
    expect(last.endLine).toBeGreaterThanOrEqual(90);
  });

  it("prefers blank-line boundaries when they exist within the budget", () => {
    const block1 = "a\nb\nc\nd\ne\nf\ng\nh";         // 8 lines, ~16 bytes
    const block2 = "w\nx\ny\nz\n1\n2\n3\n4";         // 8 lines, ~16 bytes
    const text = `${block1}\n\n${block2}`;           // ~35 bytes, 17 lines
    const chunks = chunkByLines(text, 20);

    expect(chunks.length).toBeGreaterThan(1);
    // Verify the first chunk's final non-empty content is in block1
    const firstChunkText = chunks[0].text;
    expect(firstChunkText.includes("h")).toBe(true);
  });

  it("line numbers are contiguous across chunks", () => {
    const text = Array.from({ length: 50 }, (_, i) => `x${i}`).join("\n");
    const chunks = chunkByLines(text, 30);
    let expectedStart = 1;
    for (const c of chunks) {
      expect(c.startLine).toBe(expectedStart);
      expectedStart = c.endLine + 1;
    }
    const last = chunks[chunks.length - 1];
    expect(last.endLine).toBe(50);
  });

  it("index + total are populated correctly", () => {
    const text = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const chunks = chunkByLines(text, 40);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
      expect(chunks[i].total).toBe(chunks.length);
    }
  });
});

describe("council driver capability routing", () => {
  it("Claude PTY has tools", () => {
    expect(driverSupportsTools("claude-code", "pty")).toBe(true);
    expect(driverSupportsTools("claude", "pty")).toBe(true);
  });

  it("Codex + Gemini exec have tools", () => {
    expect(driverSupportsTools("codex", "exec")).toBe(true);
    expect(driverSupportsTools("gemini", "exec")).toBe(true);
  });

  it("Ollama server-http does NOT have tools", () => {
    expect(driverSupportsTools("ollama", "server-http")).toBe(false);
  });

  it("Claude in exec mode HAS tools (claude --print runs full agent)", () => {
    // 0.5.3+: Claude exec mode runs the full Claude Code agent with file-tool
    // access, so council reviewers in exec mode can read the target via their
    // own tools rather than getting an inlined prompt.
    expect(driverSupportsTools("claude-code", "exec")).toBe(true);
    expect(driverSupportsTools("claude", "exec")).toBe(true);
  });

  it("unknown driver does NOT have tools (fail-safe)", () => {
    expect(driverSupportsTools("unknown-driver", "exec")).toBe(false);
  });

  it("defaultModeFor picks the builtin default for each driver", () => {
    // 0.5.3: Claude defaults to exec for council use. PTY remains experimental
    // for headless review work — TUI output parsing was unreliable and
    // silently dropped reviewer findings in real-world panels.
    expect(defaultModeFor("claude")).toBe("exec");
    expect(defaultModeFor("claude-code")).toBe("exec");
    expect(defaultModeFor("codex")).toBe("exec");
    expect(defaultModeFor("gemini")).toBe("exec");
    expect(defaultModeFor("ollama")).toBe("server-http");
    expect(defaultModeFor("unknown-driver")).toBe("exec"); // conservative default
  });
});
