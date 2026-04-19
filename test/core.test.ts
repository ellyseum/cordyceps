import { describe, it, expect } from "vitest";
import { stripAnsi, stripAnsiAll } from "../src/core/ansi.js";
import { generateName, isValidName } from "../src/core/names.js";
import { loadConfig } from "../src/core/config.js";
import { PtyProcess } from "../src/core/pty.js";

describe("ansi", () => {
  it("strips CSI sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("strips OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07hello")).toBe("hello");
  });

  it("keeps newlines and tabs in stripAnsi", () => {
    expect(stripAnsi("a\nb\tc")).toBe("a\nb\tc");
  });

  it("stripAnsiAll removes whitespace controls too", () => {
    expect(stripAnsiAll("\x1b[31ma\nb\tc\x1b[0m")).toBe("abc");
  });

  it("handles real-world Claude glyph chunks", () => {
    const sample = "\x1b[?25l\x1b[2K\r\x1b[36m●\x1b[0m Hello world\r\n";
    expect(stripAnsi(sample)).toContain("● Hello world");
  });
});

describe("names", () => {
  it("generates adjective-noun combo", () => {
    const name = generateName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("validates good names", () => {
    expect(isValidName("abc")).toBe(true);
    expect(isValidName("reviewer-1")).toBe(true);
    expect(isValidName("goofy_sturgeon")).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(isValidName("")).toBe(false);
    expect(isValidName("-starts-with-hyphen")).toBe(false);
    expect(isValidName("has spaces")).toBe(false);
    expect(isValidName("has.dot")).toBe(false);
    expect(isValidName("x".repeat(32))).toBe(false);  // too long
  });
});

describe("config", () => {
  it("returns defaults when file doesn't exist", () => {
    const cfg = loadConfig("/definitely/not/here.json");
    expect(cfg.drivers?.["claude-code"]?.defaultProfile).toBe("default");
    expect(cfg.plugins?.audit?.enabled).toBe(true);
  });

  it("returns deterministic profile preset in defaults", () => {
    const cfg = loadConfig("/nope.json");
    const deterministic = cfg.drivers?.["claude-code"]?.profiles?.deterministic;
    expect(deterministic).toMatchObject({
      bare: true,
      permissionMode: "plan",
    });
  });
});

describe("PtyProcess", () => {
  it("spawns bash, emits data, exits cleanly", async () => {
    const p = new PtyProcess({
      command: "bash",
      args: ["-c", 'echo "hello-pty"; exit 0'],
    });

    let output = "";
    p.on("data", (d) => { output += d; });
    const exitPromise = new Promise<{ code: number; signal: number }>((resolve) => {
      p.on("exit", resolve);
    });

    p.spawn();
    const { code } = await exitPromise;

    expect(code).toBe(0);
    expect(output).toContain("hello-pty");
    expect(p.exited).toBe(true);
  });

  it("can write to stdin", async () => {
    const p = new PtyProcess({
      command: "bash",
      args: ["--norc", "--noprofile", "-i"],
    });

    let output = "";
    p.on("data", (d) => { output += d; });
    const exitPromise = new Promise<void>((resolve) => {
      p.on("exit", () => resolve());
    });

    p.spawn();
    await new Promise((r) => setTimeout(r, 100));  // let shell start
    p.write("echo 'cordy-echo'\n");
    await new Promise((r) => setTimeout(r, 200));
    p.write("exit\n");
    await exitPromise;

    expect(output).toContain("cordy-echo");
  });
});
