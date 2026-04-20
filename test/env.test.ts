/**
 * Tests for the daemon env-file parser. Uses the pure parseEnvFile function
 * so we don't touch process.env or the filesystem.
 */

import { describe, it, expect } from "vitest";
import { parseEnvFile } from "../src/core/env.js";

describe("parseEnvFile", () => {
  it("parses simple KEY=value", () => {
    expect(parseEnvFile("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("ignores blank lines and comments", () => {
    const content = `
# this is a comment
FOO=bar

# another comment
BAZ=qux
`;
    expect(parseEnvFile(content)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips optional export prefix", () => {
    expect(parseEnvFile("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("handles double-quoted values with spaces", () => {
    expect(parseEnvFile('FOO="hello world"')).toEqual({ FOO: "hello world" });
  });

  it("handles single-quoted values literally", () => {
    expect(parseEnvFile("FOO='hello $world'")).toEqual({ FOO: "hello $world" });
  });

  it("strips inline comments after unquoted values", () => {
    expect(parseEnvFile("FOO=bar # trailing")).toEqual({ FOO: "bar" });
  });

  it("preserves hash inside quoted values", () => {
    expect(parseEnvFile('FOO="hash#inside"')).toEqual({ FOO: "hash#inside" });
  });

  it("last definition wins", () => {
    expect(parseEnvFile("FOO=first\nFOO=second")).toEqual({ FOO: "second" });
  });

  it("handles CRLF line endings", () => {
    expect(parseEnvFile("FOO=bar\r\nBAZ=qux\r\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips malformed lines silently", () => {
    const content = `
GOOD=1
not a valid line
ANOTHER=2
===
THIRD=3
`;
    expect(parseEnvFile(content)).toEqual({ GOOD: "1", ANOTHER: "2", THIRD: "3" });
  });

  it("handles realistic API key file", () => {
    const content = `
# Gemini API key (do not commit)
GEMINI_API_KEY=AIzaSyABCDEF_notarealkey_1234567890
# Fallback model override
# GEMINI_MODEL=gemini-2.5-pro
`;
    expect(parseEnvFile(content)).toEqual({
      GEMINI_API_KEY: "AIzaSyABCDEF_notarealkey_1234567890",
    });
  });

  it("allows empty value", () => {
    expect(parseEnvFile("FOO=")).toEqual({ FOO: "" });
  });

  it("accepts underscores and digits in keys", () => {
    expect(parseEnvFile("ABC_123=ok\n_LEADING=ok")).toEqual({ ABC_123: "ok", _LEADING: "ok" });
  });
});
