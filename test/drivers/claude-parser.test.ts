import { describe, it, expect } from "vitest";
import { ClaudeParser } from "../../src/drivers/claude/parser.js";

describe("ClaudeParser", () => {
  it("initial state is starting", () => {
    const p = new ClaudeParser();
    expect(p.initialState().status).toBe("starting");
  });

  it("detects assistant message (● marker)", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    // Start message
    const r1 = p.feed("● Hello from Claude", s);
    s = r1.state;
    // End it with blank line
    const r2 = p.feed("\n", s);
    s = r2.state;
    const r3 = p.feed("", s);

    // Message might fire on r2 or r3 depending on flush logic
    const allMessages = [...r1.messages, ...r2.messages, ...r3.messages];
    expect(allMessages.length).toBeGreaterThan(0);
    expect(allMessages[0].text).toContain("Hello from Claude");
  });

  it("detects spinner activity", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    const r = p.feed("\u2722 Thinking (1.2k tokens · 5s)", s);
    expect(r.state.activity).toBeDefined();
    expect(r.state.activity?.label).toBe("Thinking");
    expect(r.state.status).toBe("busy");
  });

  it("detects tool approval block", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    const r = p.feed("Allow Edit to src/foo.ts? (y/N)", s);
    expect(r.state.status).toBe("blocked");
    expect(r.state.blocking?.kind).toBe("tool-approval");
  });

  it("detects plan-approval block", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    const r = p.feed("exit plan mode? approve the plan", s);
    expect(r.state.blocking?.kind).toBe("plan-approval");
  });

  it("detects model from output", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    const r = p.feed("  Opus 4.7 with xhigh effort · Claude Max", s);
    expect(r.state.model).toMatch(/opus/i);
  });

  it("parses context-remaining percentage", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    const r = p.feed("Context left until auto-compact: 42%", s);
    expect(r.state.tokens?.contextRemaining).toBe(42);
  });

  it("parses permission mode (bypass)", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    const r = p.feed("\u23F5\u23F5 bypass permissions on main \u00B7 12 files +4 -3", s);
    expect(r.state.mode).toBe("bypassPermissions");
    expect((r.state.extra as { files: { count: number; added: number; removed: number } }).files).toEqual({
      count: 12, added: 4, removed: 3,
    });
  });

  it("parses plan mode", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    const r = p.feed("\u23F8 plan mode on main \u00B7 3 files +0 -0", s);
    expect(r.state.mode).toBe("plan");
  });

  it("emits mode.changed event on transition", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    s.mode = "default";
    const r = p.feed("\u23F5\u23F5 bypass permissions on main \u00B7 0 files +0 -0", s);
    const changed = r.events.find((e) => e.kind === "mode.changed");
    expect(changed).toBeDefined();
    expect((changed!.data as { to: string }).to).toBe("bypassPermissions");
  });

  it("tracks tokens from activity (non-regressing)", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    let r = p.feed("\u2722 Thinking (500 tokens · 1s)", s);
    expect(r.state.tokens?.used).toBe(500);
    r = p.feed("\u2722 Thinking (1.2k tokens · 2s)", r.state);
    expect(r.state.tokens?.used).toBe(1200);
    r = p.feed("\u2722 Thinking (800 tokens · 3s)", r.state);
    expect(r.state.tokens?.used).toBe(1200);  // doesn't regress
  });

  it("handles multiple chunks building up a message", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    const r1 = p.feed("● First line", s); s = r1.state;
    const r2 = p.feed("second line continues", s); s = r2.state;
    const r3 = p.feed("third line", s); s = r3.state;
    // Blank line terminates message
    const r4 = p.feed("", s); s = r4.state;
    const all = [...r1.messages, ...r2.messages, ...r3.messages, ...r4.messages];
    expect(all.length).toBe(1);
    expect(all[0].text).toContain("First line");
    expect(all[0].text).toContain("second line continues");
    expect(all[0].text).toContain("third line");
  });

  it("strips ANSI from chunks", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    const r = p.feed("\x1b[36m\u25CF Hello\x1b[0m", s);
    expect(r.state.lastMessage).toBeUndefined(); // still capturing
    // Flush
    const r2 = p.feed("", r.state);
    const all = [...r.messages, ...r2.messages];
    expect(all[0].text).toBe("Hello");
  });

  it("ignores empty chunks without state change", () => {
    const p = new ClaudeParser();
    let s = p.initialState();
    const r = p.feed("", s);
    expect(r.state).toBe(s);  // identity — no change
  });
});
