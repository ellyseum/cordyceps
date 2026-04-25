/**
 * Audit plugin — JSONL trail of agent activity.
 *
 * **Default: disabled.** Audit logging persists agent messages to disk; that
 * surprises users who don't expect it. Opt in explicitly via `--audit` or by
 * passing `--audit-dir <path>`. Programmatic use: set `auditDir` or
 * `enabled: true` in the plugins.audit settings block.
 *
 * Reference implementation showing both halves of the plugin contract:
 *   - bus subscriptions (auto-cleaned via ctx.subscribe)
 *   - method registration (audit.tail) for client queries
 *   - notification emission (audit.entry.written) for live-tailing dashboards
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CordycepsPlugin, PluginContext } from "../../api.js";

/** Computed lazily so tests can redirect via process.env.HOME. */
function defaultAuditDir(): string {
  return join(homedir(), ".cordyceps", "audit");
}

interface AuditEntry {
  ts: string;
  kind: string;
  data: unknown;
}

let auditDir: string | undefined;

const plugin: CordycepsPlugin = {
  name: "audit",
  description: "JSONL audit trail for agent activity (opt-in)",
  version: "1.0.0",
  order: { priority: 10 },  // load after core/transport, before user plugins

  flags: [
    { name: "--audit", type: "boolean", default: false, description: "Enable audit logging (default: disabled)" },
    { name: "--audit-dir", type: "string", description: "Enable audit logging and write to this directory" },
  ],

  methods: {
    /** audit.tail — fetch most recent N entries, optionally filtered by kind. Empty if audit is disabled. */
    async "audit.tail"(params) {
      if (!auditDir) return [];
      const p = (params ?? {}) as { limit?: number; kind?: string };
      const limit = Math.min(Math.max(p.limit ?? 50, 1), 1000);
      return readRecent(auditDir, limit, p.kind);
    },
  },

  async init(ctx: PluginContext) {
    // Single enable switch:
    //   --audit                    boolean flag → enable, default audit dir
    //   --audit-dir <path>         flag → enable, custom dir
    //   plugins.audit.auditDir     config setting → enable, custom dir
    // The plugin-loader's `enabled: false` already prevents init from running
    // at all, so we don't double-up on a settings.enabled bit here.
    const explicitDir =
      (ctx.config.flags["--audit-dir"] as string | undefined) ??
      (ctx.config.settings["auditDir"] as string | undefined);
    const enabled = ctx.config.flags["--audit"] === true || explicitDir != null;

    if (!enabled) {
      ctx.logger.info("audit", "disabled (pass --audit or --audit-dir to enable)");
      return;
    }

    const dir = explicitDir ?? defaultAuditDir();
    auditDir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }

    const writeDir = dir;
    const write = (kind: string, data: unknown) => {
      const ts = new Date().toISOString();
      const entry: AuditEntry = { ts, kind, data };
      const file = join(writeDir, `${ts.slice(0, 10)}.jsonl`);
      try {
        appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
        ctx.notify("audit.entry.written", entry);
      } catch (err) {
        ctx.logger.warn("audit", `write failed: ${(err as Error).message}`);
      }
    };

    // Auto-cleanup on plugin destroy via ctx.subscribe
    ctx.subscribe("agent.created", (d) => write("agent.created", d));
    ctx.subscribe("agent.exited", (d) => write("agent.exited", d));

    // Per-agent message events use dynamic names — wire them when agents are created.
    // The dispatcher already broadcasts `agent.message` as a notification, but the
    // bus event name is `agent.{id}.message`. Subscribe to that pattern.
    ctx.subscribe("agent.created", (info) => {
      const agentId = (info as { id?: string })?.id;
      if (!agentId) return;
      const unsubMsg = ctx.bus.on(`agent.${agentId}.message`, (m) => {
        write("agent.message", { agentId, message: m });
      });
      const unsubBlock = ctx.bus.on(`agent.${agentId}.blocked`, (b) => {
        write("agent.blocked", { agentId, blocking: b });
      });
      ctx.onDestroy(unsubMsg);
      ctx.onDestroy(unsubBlock);
    });

    ctx.logger.info("audit", `enabled, writing to ${dir}`);
  },
};

/** Read up to `limit` most-recent entries, optionally filtered by kind. */
function readRecent(dir: string, limit: number, kind?: string): AuditEntry[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse(); } catch { return []; }
  const out: AuditEntry[] = [];
  for (const f of files) {
    let lines: string[];
    try { lines = readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).reverse(); } catch { continue; }
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (!kind || e.kind === kind) out.push(e);
        if (out.length >= limit) return out;
      } catch { /* skip malformed */ }
    }
  }
  return out;
}

export default plugin;
