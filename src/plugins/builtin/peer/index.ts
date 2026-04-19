/**
 * peer plugin — thin sugar over agents.submit that tags submissions with
 * from/to metadata and emits a bus event for auditability.
 *
 * Methods:
 *   peer.ask     — from agent A asks agent B a question, awaits the reply
 *   peer.tell    — fire-and-forget notification (no reply expected)
 *
 * Bus events:
 *   peer.message { from, to, text, ts }   — emitted on every peer submission
 *   peer.reply   { from, to, text, ts }   — emitted when peer.ask gets a reply
 *
 * This is minimal glue. The real power is that any plugin can listen to
 * `peer.message` / `peer.reply` and build richer coordination on top —
 * council voting, gatekeepers, reply routing, etc.
 */

import type { CordycepsPlugin, PluginContext } from "../../api.js";
import type { AssistantMessage } from "../../../agents/types.js";

const plugin: CordycepsPlugin = {
  name: "peer",
  description: "Inter-agent peer messaging — structured from/to over agents.submit",
  version: "1.0.0",
  order: { priority: 20 },

  async init(ctx: PluginContext) {
    ctx.rpc.register("peer.ask", async (params) => {
      const p = (params ?? {}) as { from?: string; to?: string; text?: string; timeoutMs?: number };
      if (!p.from || !p.to || !p.text) {
        throw new Error("peer.ask requires { from, to, text }");
      }
      const fromRuntime = ctx.agents.get(p.from);
      const toRuntime = ctx.agents.get(p.to);
      if (!fromRuntime) throw new Error(`peer.ask: from agent '${p.from}' not found`);
      if (!toRuntime) throw new Error(`peer.ask: to agent '${p.to}' not found`);

      const wrapped = `[from peer '${p.from}'] ${p.text}`;
      const ts = new Date().toISOString();
      ctx.bus.emit("peer.message", { from: p.from, to: p.to, text: p.text, ts });
      ctx.notify("peer.message", { from: p.from, to: p.to, text: p.text, ts });

      const result = await toRuntime.submit(wrapped, { timeoutMs: p.timeoutMs ?? 120_000 });
      if (result.message) {
        const reply = result.message as AssistantMessage;
        const replyTs = new Date().toISOString();
        ctx.bus.emit("peer.reply", { from: p.to, to: p.from, text: reply.text, ts: replyTs });
        ctx.notify("peer.reply", { from: p.to, to: p.from, text: reply.text, ts: replyTs });
        return { ok: true, reply: reply.text };
      }
      return { ok: true, reply: null };
    });

    ctx.rpc.register("peer.tell", async (params) => {
      const p = (params ?? {}) as { from?: string; to?: string; text?: string };
      if (!p.from || !p.to || !p.text) {
        throw new Error("peer.tell requires { from, to, text }");
      }
      const toRuntime = ctx.agents.get(p.to);
      if (!toRuntime) throw new Error(`peer.tell: to agent '${p.to}' not found`);

      const wrapped = `[from peer '${p.from}'] ${p.text}`;
      const ts = new Date().toISOString();
      ctx.bus.emit("peer.message", { from: p.from, to: p.to, text: p.text, ts });
      ctx.notify("peer.message", { from: p.from, to: p.to, text: p.text, ts });

      void toRuntime.submit(wrapped, { timeoutMs: 120_000, expectMessage: false });
      return { ok: true };
    });

    ctx.onDestroy(() => { ctx.rpc.unregister("peer.ask"); });
    ctx.onDestroy(() => { ctx.rpc.unregister("peer.tell"); });
    ctx.logger.info("peer", "peer messaging enabled (peer.ask, peer.tell)");
  },
};

export default plugin;
