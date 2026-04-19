import { describe, it, expect } from "vitest";
import { parseVersion, satisfies, gradeCompat } from "../src/core/semver.js";

describe("semver", () => {
  describe("parseVersion", () => {
    it("parses X.Y.Z", () => {
      expect(parseVersion("2.1.114")).toEqual({ major: 2, minor: 1, patch: 114 });
    });
    it("ignores pre-release tags", () => {
      expect(parseVersion("2.1.114-rc.1")).toEqual({ major: 2, minor: 1, patch: 114 });
    });
    it("returns null on garbage", () => {
      expect(parseVersion("not-a-version")).toBeNull();
      expect(parseVersion("2.1")).toBeNull();
    });
    it("rejects trailing garbage (regression: council 2026-04-19)", () => {
      expect(parseVersion("2.1.114junk")).toBeNull();
      expect(parseVersion("2.1.114.0")).toBeNull();
      expect(parseVersion("2.1.114 extra")).toBeNull();
    });
    it("still accepts build/prerelease suffixes", () => {
      expect(parseVersion("1.2.3-rc.1")).toEqual({ major: 1, minor: 2, patch: 3 });
      expect(parseVersion("1.2.3+sha.abc")).toEqual({ major: 1, minor: 2, patch: 3 });
    });
  });

  describe("satisfies", () => {
    it("matches >= constraint", () => {
      expect(satisfies("2.1.100", ">=2.1.100")).toBe(true);
      expect(satisfies("2.1.99", ">=2.1.100")).toBe(false);
    });

    it("matches < constraint", () => {
      expect(satisfies("2.1.114", "<2.2.0")).toBe(true);
      expect(satisfies("2.2.0", "<2.2.0")).toBe(false);
    });

    it("matches multi-term range", () => {
      const range = ">=2.1.100 <2.2.0";
      expect(satisfies("2.1.100", range)).toBe(true);
      expect(satisfies("2.1.114", range)).toBe(true);
      expect(satisfies("2.1.999", range)).toBe(true);
      expect(satisfies("2.0.999", range)).toBe(false);
      expect(satisfies("2.2.0", range)).toBe(false);
    });

    it("matches = exact", () => {
      expect(satisfies("2.1.114", "=2.1.114")).toBe(true);
      expect(satisfies("2.1.115", "=2.1.114")).toBe(false);
    });

    it("returns false on malformed range", () => {
      expect(satisfies("2.1.114", "bogus")).toBe(false);
    });
    it("whitespace-only range is malformed, not match-all (regression: council 2026-04-19)", () => {
      expect(satisfies("2.1.114", "")).toBe(false);
      expect(satisfies("2.1.114", "   ")).toBe(false);
      expect(satisfies("2.1.114", "\t\n")).toBe(false);
    });
    it("rejects range terms with trailing garbage (regression: council 2026-04-19)", () => {
      expect(satisfies("2.1.114", ">=1.0.0xxx")).toBe(false);
      expect(satisfies("2.1.114", ">=1.0.0 garbage")).toBe(false);
    });
  });

  describe("gradeCompat", () => {
    it("'any' when no range", () => {
      expect(gradeCompat("2.1.114", undefined)).toBe("any");
    });
    it("'untested' when no version detected but range declared", () => {
      expect(gradeCompat(undefined, ">=2.1.100")).toBe("untested");
    });
    it("'supported' when in range", () => {
      expect(gradeCompat("2.1.114", ">=2.1.100 <2.2.0")).toBe("supported");
    });
    it("'unsupported' when version is known and out of range (regression: council 2026-04-19)", () => {
      // Previously returned "untested" — the "unsupported" branch was unreachable.
      expect(gradeCompat("2.2.0", ">=2.1.100 <2.2.0")).toBe("unsupported");
      expect(gradeCompat("1.0.0", ">=2.0.0")).toBe("unsupported");
    });
    it("'untested' kept for no-version case only", () => {
      expect(gradeCompat(undefined, ">=2.1.100 <2.2.0")).toBe("untested");
    });
  });
});
