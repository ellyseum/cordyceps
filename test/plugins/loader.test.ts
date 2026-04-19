import { describe, it, expect } from "vitest";
import { sortPlugins, discoverBuiltins } from "../../src/plugins/loader.js";
import type { CordycepsPlugin } from "../../src/plugins/api.js";

function fake(name: string, order?: CordycepsPlugin["order"]): CordycepsPlugin {
  return { name, description: name, version: "1.0.0", order };
}

describe("plugin loader", () => {
  describe("sortPlugins", () => {
    it("sorts by priority groups (lower first)", () => {
      const out = sortPlugins([
        fake("c", { priority: 10 }),
        fake("a", { priority: -10 }),
        fake("b", { priority: 0 }),
      ]);
      expect(out.map((p) => p.name)).toEqual(["a", "b", "c"]);
    });

    it("topo-sorts within a priority group via after", () => {
      const out = sortPlugins([
        fake("b", { after: ["a"] }),
        fake("a"),
        fake("c", { after: ["b"] }),
      ]);
      expect(out.map((p) => p.name)).toEqual(["a", "b", "c"]);
    });

    it("topo-sorts within a priority group via before", () => {
      const out = sortPlugins([
        fake("c"),
        fake("a", { before: ["b"] }),
        fake("b", { before: ["c"] }),
      ]);
      expect(out.map((p) => p.name)).toEqual(["a", "b", "c"]);
    });

    it("sorts deterministically (alphabetical fallback)", () => {
      const out = sortPlugins([fake("z"), fake("a"), fake("m")]);
      expect(out.map((p) => p.name)).toEqual(["a", "m", "z"]);
    });

    it("throws on circular dependency", () => {
      expect(() => sortPlugins([
        fake("a", { after: ["b"] }),
        fake("b", { after: ["a"] }),
      ])).toThrow(/Circular/);
    });
  });

  describe("discoverBuiltins", () => {
    it("includes audit", async () => {
      const builtins = await discoverBuiltins();
      expect(builtins.find((p) => p.name === "audit")).toBeDefined();
    });
  });
});
