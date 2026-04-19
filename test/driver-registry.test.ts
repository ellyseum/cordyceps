import { describe, it, expect } from "vitest";
import { DriverRegistry } from "../src/drivers/registry.js";
import type { Driver, DriverProbe } from "../src/drivers/api.js";

function fakeDriver(id: string, overrides: Partial<Driver> = {}): Driver {
  return {
    id,
    label: id,
    version: "0.1.0",
    modes: ["pty"],
    aliases: [],
    async probe(): Promise<DriverProbe> {
      return { available: true, version: "fake-1.0", capabilities: {}, warnings: [], supportedModes: ["pty"] };
    },
    parser: { initialState: () => ({ status: "unknown" }), feed: (_c, s) => ({ state: s, events: [], messages: [] }) },
    control: {
      waitForReady: async () => {},
      submit: async () => {},
      interrupt: async () => {},
      approve: async () => {},
      reject: async () => {},
      quit: async () => {},
    },
    ...overrides,
  };
}

describe("DriverRegistry", () => {
  it("registers and resolves by id", () => {
    const r = new DriverRegistry();
    const d = fakeDriver("x");
    r.register(d);
    expect(r.resolve("x")).toBe(d);
  });

  it("registers and resolves by alias", () => {
    const r = new DriverRegistry();
    const d = fakeDriver("claude-code", { aliases: ["claude"] });
    r.register(d);
    expect(r.resolve("claude")).toBe(d);
    expect(r.resolve("claude-code")).toBe(d);
    expect(r.canonicalId("claude")).toBe("claude-code");
  });

  it("returns undefined for unknown", () => {
    const r = new DriverRegistry();
    expect(r.resolve("nope")).toBeUndefined();
  });

  it("throws on duplicate id", () => {
    const r = new DriverRegistry();
    r.register(fakeDriver("a"));
    expect(() => r.register(fakeDriver("a"))).toThrow(/already registered/);
  });

  it("throws on alias collision with existing id", () => {
    const r = new DriverRegistry();
    r.register(fakeDriver("claude-code"));
    expect(() => r.register(fakeDriver("x", { aliases: ["claude-code"] }))).toThrow(/collides/);
  });

  it("unregisters and clears aliases", () => {
    const r = new DriverRegistry();
    const d = fakeDriver("claude-code", { aliases: ["claude"] });
    r.register(d);
    expect(r.unregister("claude-code")).toBe(true);
    expect(r.resolve("claude")).toBeUndefined();
    expect(r.resolve("claude-code")).toBeUndefined();
  });

  it("caches probe results", async () => {
    let calls = 0;
    const r = new DriverRegistry();
    r.register(fakeDriver("x", {
      async probe() {
        calls++;
        return { available: true, capabilities: {}, warnings: [], supportedModes: ["pty"] };
      },
    }));
    await r.probe("x");
    await r.probe("x");
    expect(calls).toBe(1);
    await r.probe("x", true);  // refresh
    expect(calls).toBe(2);
  });

  it("probeAll returns all probed drivers", async () => {
    const r = new DriverRegistry();
    r.register(fakeDriver("a"));
    r.register(fakeDriver("b"));
    const probes = await r.probeAll();
    expect(Object.keys(probes).sort()).toEqual(["a", "b"]);
  });

  describe("chooseMode", () => {
    it("returns preferred when supported + registered", () => {
      const r = new DriverRegistry();
      const d = fakeDriver("x", { modes: ["pty", "exec"] });
      expect(r.chooseMode(d, "exec", ["pty", "exec"], ["pty", "exec"])).toBe("exec");
    });

    it("returns first viable when preferred missing", () => {
      const r = new DriverRegistry();
      const d = fakeDriver("x", { modes: ["pty", "exec"] });
      expect(r.chooseMode(d, undefined, ["pty", "exec"], ["pty"])).toBe("pty");
    });

    it("returns undefined when no overlap", () => {
      const r = new DriverRegistry();
      const d = fakeDriver("x", { modes: ["exec"] });
      expect(r.chooseMode(d, undefined, ["exec"], ["pty"])).toBeUndefined();
    });

    it("falls back from preferred to first viable", () => {
      const r = new DriverRegistry();
      const d = fakeDriver("x", { modes: ["pty", "exec"] });
      // Want exec but only pty is registered as a runtime
      expect(r.chooseMode(d, "exec", ["pty", "exec"], ["pty"])).toBe("pty");
    });
  });
});
