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
    it("'untested' when out of range", () => {
      expect(gradeCompat("2.2.0", ">=2.1.100 <2.2.0")).toBe("untested");
    });
  });
});
