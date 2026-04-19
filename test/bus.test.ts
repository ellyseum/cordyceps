import { describe, it, expect, vi } from "vitest";
import { createServiceBus } from "../src/core/bus.js";

describe("ServiceBus", () => {
  describe("events", () => {
    it("emits to all subscribers", () => {
      const bus = createServiceBus();
      const a = vi.fn();
      const b = vi.fn();
      bus.on("hello", a);
      bus.on("hello", b);
      bus.emit("hello", 42);
      expect(a).toHaveBeenCalledWith(42);
      expect(b).toHaveBeenCalledWith(42);
    });

    it("on returns unsubscribe that actually unsubscribes", () => {
      const bus = createServiceBus();
      const cb = vi.fn();
      const unsub = bus.on("e", cb);
      bus.emit("e", 1);
      unsub();
      bus.emit("e", 2);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(1);
    });

    it("once fires exactly once", () => {
      const bus = createServiceBus();
      const cb = vi.fn();
      bus.once("e", cb);
      bus.emit("e", 1);
      bus.emit("e", 2);
      bus.emit("e", 3);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(1);
    });

    it("once's returned unsubscribe prevents fire", () => {
      const bus = createServiceBus();
      const cb = vi.fn();
      const unsub = bus.once("e", cb);
      unsub();
      bus.emit("e", 1);
      expect(cb).not.toHaveBeenCalled();
    });

    it("off removes listener", () => {
      const bus = createServiceBus();
      const cb = vi.fn();
      bus.on("e", cb);
      bus.off("e", cb);
      bus.emit("e", 1);
      expect(cb).not.toHaveBeenCalled();
    });

    it("emitting with no listeners doesn't crash", () => {
      const bus = createServiceBus();
      expect(() => bus.emit("nobody-listening", "hi")).not.toThrow();
    });

    it("listener throwing doesn't break other listeners or the bus", () => {
      const bus = createServiceBus();
      const good = vi.fn();
      bus.on("e", () => { throw new Error("boom"); });
      bus.on("e", good);
      expect(() => bus.emit("e", 1)).not.toThrow();
      expect(good).toHaveBeenCalledWith(1);
    });

    it("listener unsubscribing during fire doesn't skip other listeners", () => {
      const bus = createServiceBus();
      const calls: string[] = [];
      let unsubA: (() => void) | null = null;
      unsubA = bus.on("e", () => { calls.push("a"); unsubA!(); });
      bus.on("e", () => calls.push("b"));
      bus.emit("e", 1);
      expect(calls).toEqual(["a", "b"]);
      // a should now be gone
      bus.emit("e", 2);
      expect(calls).toEqual(["a", "b", "b"]);
    });
  });

  describe("state", () => {
    it("get/set round-trip", () => {
      const bus = createServiceBus();
      bus.set("k", "v");
      expect(bus.get("k")).toBe("v");
    });

    it("get returns undefined for unknown key", () => {
      const bus = createServiceBus();
      expect(bus.get("never-set")).toBeUndefined();
    });

    it("delete removes key (distinct from set undefined)", () => {
      const bus = createServiceBus();
      bus.set("k", undefined);
      expect(bus.get("k")).toBeUndefined();
      // But the key still exists in the prefix scan
      expect(bus.getByPrefix("").has("k")).toBe(true);
      expect(bus.delete("k")).toBe(true);
      expect(bus.getByPrefix("").has("k")).toBe(false);
      expect(bus.delete("k")).toBe(false);  // gone now
    });

    it("getByPrefix returns only matching keys", () => {
      const bus = createServiceBus();
      bus.set("agent.a.state", { status: "idle" });
      bus.set("agent.b.state", { status: "busy" });
      bus.set("plugin.audit.enabled", true);
      const agents = bus.getByPrefix("agent.");
      expect(agents.size).toBe(2);
      expect(agents.has("agent.a.state")).toBe(true);
      expect(agents.has("agent.b.state")).toBe(true);
      expect(agents.has("plugin.audit.enabled")).toBe(false);
    });

    it("getByPrefix returns a copy — mutation doesn't affect bus", () => {
      const bus = createServiceBus();
      bus.set("x.1", 1);
      const snap = bus.getByPrefix("x.");
      snap.set("x.2", 999);
      expect(bus.get("x.2")).toBeUndefined();
    });
  });

  describe("waitFor", () => {
    it("resolves when event fires", async () => {
      const bus = createServiceBus();
      const p = bus.waitFor<number>("e", undefined, 1000);
      setTimeout(() => bus.emit("e", 42), 5);
      expect(await p).toBe(42);
    });

    it("respects predicate", async () => {
      const bus = createServiceBus();
      const p = bus.waitFor<number>("e", (d) => (d as number) > 5, 1000);
      bus.emit("e", 1);
      bus.emit("e", 2);
      setTimeout(() => bus.emit("e", 10), 5);
      expect(await p).toBe(10);
    });

    it("rejects on timeout", async () => {
      const bus = createServiceBus();
      await expect(bus.waitFor("never", undefined, 20)).rejects.toThrow(/timed out/);
    });

    it("cleans up listener on timeout", async () => {
      const bus = createServiceBus();
      try {
        await bus.waitFor("never", undefined, 20);
      } catch { /* expected */ }
      // No leaked listener: emitting now should be a no-op, no crash
      expect(() => bus.emit("never", "post-timeout")).not.toThrow();
    });

    it("cleans up listener on resolve (no leak)", async () => {
      const bus = createServiceBus();
      const p = bus.waitFor("e", undefined, 1000);
      bus.emit("e", 1);
      await p;
      // Second emit should not try to resolve again (no listener left)
      expect(() => bus.emit("e", 2)).not.toThrow();
    });
  });
});
