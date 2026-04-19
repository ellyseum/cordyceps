/**
 * Core JSON-RPC method handlers (agents.*, drivers.*, bus.*, daemon.*, notifications.*).
 *
 * Plugins register additional methods via `RpcDispatcher.register()` from their
 * own init handlers — they're not in this file.
 */

import type { AgentManager } from "../agents/manager.js";
import type { DriverRegistry } from "../drivers/registry.js";
import type { ServiceBus } from "../core/bus.js";
import type { Logger } from "../core/logger.js";
import type { RpcDispatcher } from "./rpc.js";
import { CordycepsError, JsonRpcMethodError } from "./types.js";

export interface CoreMethodsContext {
  manager: AgentManager;
  drivers: DriverRegistry;
  bus: ServiceBus;
  logger: Logger;
  startedAt: number;
  version: string;
}

interface SpawnParams {
  driverId: string;
  id?: string;
  cwd?: string;
  profile?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface AgentIdParam { id: string }

interface SubmitParams {
  id: string;
  prompt: string;
  timeoutMs?: number;
  expectMessage?: boolean;
  interruptIfBusy?: boolean;
}

interface RawWriteParams {
  id: string;
  data: string;
}

interface BusGetParams { key: string }
interface BusPrefixParams { prefix: string }
interface SubscribeParams { events: string[] }

function requireParams<T>(p: unknown, fields: (keyof T)[]): T {
  if (!p || typeof p !== "object") {
    throw new JsonRpcMethodError(-32602, `Missing params; expected fields: ${fields.join(", ")}`);
  }
  const obj = p as Record<string, unknown>;
  for (const f of fields) {
    if (obj[f as string] === undefined) {
      throw new JsonRpcMethodError(-32602, `Missing required param: ${String(f)}`);
    }
  }
  return p as T;
}

function getAgent(manager: AgentManager, id: string) {
  const agent = manager.get(id);
  if (!agent) {
    throw new JsonRpcMethodError(CordycepsError.AGENT_NOT_FOUND, `Agent not found: ${id}`);
  }
  if (agent.exited) {
    throw new JsonRpcMethodError(CordycepsError.AGENT_EXITED, `Agent has exited: ${id}`);
  }
  return agent;
}

export function registerCoreMethods(rpc: RpcDispatcher, ctx: CoreMethodsContext): void {
  // ── daemon.* ──────────────────────────────────────────────────────────
  rpc.register("daemon.health", async () => ({
    ok: true,
    version: ctx.version,
    pid: process.pid,
    uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
    drivers: ctx.drivers.list().map((d) => d.id),
    methods: rpc.listMethods(),
  }));

  // ── agents.* ──────────────────────────────────────────────────────────
  rpc.register("agents.list", async () => ctx.manager.list());

  rpc.register("agents.spawn", async (params) => {
    const p = requireParams<SpawnParams>(params, ["driverId"]);
    const agent = await ctx.manager.spawn(p.driverId, {
      id: p.id,
      cwd: p.cwd,
      profile: p.profile,
      env: p.env,
    });
    return agent.info();
  });

  rpc.register("agents.get", async (params) => {
    const p = requireParams<AgentIdParam>(params, ["id"]);
    const agent = ctx.manager.get(p.id);
    if (!agent) {
      throw new JsonRpcMethodError(CordycepsError.AGENT_NOT_FOUND, `Agent not found: ${p.id}`);
    }
    return agent.info();
  });

  rpc.register("agents.kill", async (params) => {
    const p = requireParams<AgentIdParam>(params, ["id"]);
    if (!ctx.manager.get(p.id)) {
      throw new JsonRpcMethodError(CordycepsError.AGENT_NOT_FOUND, `Agent not found: ${p.id}`);
    }
    await ctx.manager.kill(p.id);
    return { ok: true };
  });

  rpc.register("agents.state", async (params) => {
    const p = requireParams<AgentIdParam>(params, ["id"]);
    const agent = ctx.manager.get(p.id);
    if (!agent) {
      throw new JsonRpcMethodError(CordycepsError.AGENT_NOT_FOUND, `Agent not found: ${p.id}`);
    }
    return agent.state;
  });

  rpc.register("agents.transcript", async (params) => {
    const p = params as { id: string; last?: number };
    if (!p.id) throw new JsonRpcMethodError(-32602, "Missing param: id");
    const agent = ctx.manager.get(p.id);
    if (!agent) {
      throw new JsonRpcMethodError(CordycepsError.AGENT_NOT_FOUND, `Agent not found: ${p.id}`);
    }
    const transcript = agent.transcript;
    return p.last ? transcript.slice(-p.last) : transcript;
  });

  rpc.register("agents.submit", async (params) => {
    const p = requireParams<SubmitParams>(params, ["id", "prompt"]);
    const agent = getAgent(ctx.manager, p.id);
    return await agent.submit(p.prompt, {
      timeoutMs: p.timeoutMs,
      expectMessage: p.expectMessage,
      interruptIfBusy: p.interruptIfBusy,
    });
  });

  rpc.register("agents.interrupt", async (params) => {
    const p = requireParams<AgentIdParam>(params, ["id"]);
    const agent = getAgent(ctx.manager, p.id);
    await agent.interrupt("rpc");
    return { ok: true };
  });

  rpc.register("agents.approve", async (params) => {
    const p = requireParams<AgentIdParam>(params, ["id"]);
    const agent = getAgent(ctx.manager, p.id);
    await agent.approve();
    return { ok: true };
  });

  rpc.register("agents.reject", async (params) => {
    const p = requireParams<AgentIdParam>(params, ["id"]);
    const agent = getAgent(ctx.manager, p.id);
    await agent.reject();
    return { ok: true };
  });

  rpc.register("agents.raw", async (params) => {
    const p = requireParams<RawWriteParams>(params, ["id", "data"]);
    const agent = getAgent(ctx.manager, p.id);
    agent.rawWrite(p.data);
    return { ok: true };
  });

  // ── drivers.* ─────────────────────────────────────────────────────────
  rpc.register("drivers.list", async () => {
    const probes = await ctx.drivers.probeAll();
    return ctx.drivers.list().map((d) => ({
      id: d.id,
      label: d.label,
      version: d.version,
      aliases: d.aliases ?? [],
      modes: d.modes,
      supportedVersions: d.supportedVersions ?? null,
      probe: probes[d.id],
    }));
  });

  rpc.register("drivers.get", async (params) => {
    const p = requireParams<{ id: string }>(params, ["id"]);
    const driver = ctx.drivers.resolve(p.id);
    if (!driver) {
      throw new JsonRpcMethodError(CordycepsError.DRIVER_UNAVAILABLE, `Driver not found: ${p.id}`);
    }
    const probe = await ctx.drivers.probe(driver.id);
    return {
      id: driver.id,
      label: driver.label,
      version: driver.version,
      aliases: driver.aliases ?? [],
      modes: driver.modes,
      supportedVersions: driver.supportedVersions ?? null,
      probe,
    };
  });

  // ── bus.* ─────────────────────────────────────────────────────────────
  rpc.register("bus.get", async (params) => {
    const p = requireParams<BusGetParams>(params, ["key"]);
    return ctx.bus.get(p.key) ?? null;
  });

  rpc.register("bus.getByPrefix", async (params) => {
    const p = requireParams<BusPrefixParams>(params, ["prefix"]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of ctx.bus.getByPrefix(p.prefix)) {
      out[k] = v;
    }
    return out;
  });

  // ── notifications.* ──────────────────────────────────────────────────
  rpc.register("notifications.subscribe", async (params, handlerCtx) => {
    const p = requireParams<SubscribeParams>(params, ["events"]);
    if (!Array.isArray(p.events)) {
      throw new JsonRpcMethodError(-32602, "events must be an array");
    }
    handlerCtx.session.subscribe(p.events);
    return { ok: true, subscribed: [...handlerCtx.session.subscriptions] };
  });

  rpc.register("notifications.unsubscribe", async (params, handlerCtx) => {
    const p = requireParams<SubscribeParams>(params, ["events"]);
    if (!Array.isArray(p.events)) {
      throw new JsonRpcMethodError(-32602, "events must be an array");
    }
    handlerCtx.session.unsubscribe(p.events);
    return { ok: true, subscribed: [...handlerCtx.session.subscriptions] };
  });
}
