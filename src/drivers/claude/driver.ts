/**
 * ClaudeDriver — the v1 flagship driver.
 *
 * Modes: ["pty"]. Exec + server-ws will be added when the runtime plugins
 * for those modes land in phase 2+.
 *
 * Aliases: ["claude"] so `cordy spawn claude` works.
 *
 * Default profile preserves the user's normal Claude environment (OAuth,
 * keychain, auto-memory, CLAUDE.md, hooks). The `deterministic` preset
 * (shipped in config) enables `--bare` + restricted tools — intended for
 * automated scenarios like phase 2 council reviewers.
 */

import { execFileSync } from "node:child_process";
import { freshSessionId, isolateClaudeConfig } from "./session.js";
import { ClaudeParser } from "./parser.js";
import { ClaudeControl } from "./control.js";
import { gradeCompat } from "../../core/semver.js";
import type { Driver, DriverMode, DriverProbe, DriverProfile, SpawnSpec } from "../api.js";

export interface ClaudeProfile extends DriverProfile {
  /** Skip hooks/LSP/plugin sync/auto-memory/CLAUDE.md/keychain. Requires API-key auth. */
  bare?: boolean;
  /** Model alias ("opus", "sonnet", "haiku") or full name */
  model?: string;
  /** One of: acceptEdits | auto | bypassPermissions | default | dontAsk | plan */
  permissionMode?: string;
  /** Comma-joined (passed as single value) or array (we join) */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Display name in the Claude prompt */
  name?: string;
  /** Additional dirs with tool access */
  addDirs?: string[];
  /** Inline MCP config object (serialized as JSON for --mcp-config) */
  mcpConfig?: unknown;
  /** Effort level: low | medium | high | xhigh | max */
  effort?: string;
  /** Custom agents JSON (per Claude Code --agents) */
  agents?: unknown;

  // Session handling — precedence: resume > continue > sessionId > fresh
  resume?: string;         // --resume <uuid>
  continue?: boolean;      // --continue
  sessionId?: string;      // explicit user-supplied UUID
  /** If true, create a per-agent CLAUDE_CONFIG_DIR sandbox at spawn */
  isolateConfig?: boolean;
  /** If true (with isolateConfig), also isolate credentials (copy instead of symlink) */
  isolateAuth?: boolean;

  /** Raw extra args appended at the end */
  extraArgs?: string[];
}

export class ClaudeDriver implements Driver {
  id = "claude-code";
  label = "Claude Code";
  version = "0.1.0";
  aliases = ["claude"];
  modes: DriverMode[] = ["pty"];
  /** CLI versions we've tested against + keep fixtures for. */
  supportedVersions = ">=2.1.100 <2.2.0";

  parser = new ClaudeParser();
  control = new ClaudeControl();

  async probe(): Promise<DriverProbe> {
    const warnings: string[] = [];
    const capabilities: Record<string, boolean> = {};
    let version: string | undefined;
    let path: string | undefined;

    try {
      path = execFileSync("which", ["claude"], { encoding: "utf-8" }).trim() || undefined;
    } catch {
      return { available: false, capabilities, warnings: ["claude binary not found on PATH"], supportedModes: [] };
    }

    try {
      const out = execFileSync("claude", ["--version"], { encoding: "utf-8", timeout: 5000 });
      const m = out.match(/(\d+\.\d+\.\d+)/);
      if (m) version = m[1];
    } catch (err) {
      warnings.push(`claude --version failed: ${(err as Error).message}`);
    }

    // Capability detection from --help
    try {
      const help = execFileSync("claude", ["--help"], { encoding: "utf-8", timeout: 5000 });
      capabilities.bareMode = /--bare/.test(help);
      capabilities.sessionId = /--session-id/.test(help);
      capabilities.mcpConfig = /--mcp-config/.test(help);
      capabilities.agentsFlag = /--agents/.test(help);
      capabilities.effort = /--effort/.test(help);
      capabilities.permissionMode = /--permission-mode/.test(help);
    } catch {
      warnings.push("could not parse `claude --help` for capability detection");
    }

    const compat = gradeCompat(version, this.supportedVersions);
    if (compat === "untested" && version) {
      warnings.push(
        `Claude Code ${version} is outside the tested range (${this.supportedVersions}). ` +
        `Parser drift is possible; run \`cordy capture\` if you hit issues.`,
      );
    }

    return {
      available: true,
      version,
      path,
      capabilities,
      warnings,
      supportedModes: ["pty"],
      compat,
    };
  }

  buildPtySpawn(profile: ClaudeProfile): SpawnSpec {
    const args: string[] = [];

    // Session handling precedence (§9.1 of plan):
    //   1. profile.resume <uuid>     → attach to that session (no --session-id)
    //   2. profile.continue          → continue most recent in CWD (no --session-id)
    //   3. profile.sessionId         → user-supplied UUID (explicit takeover)
    //   4. default                   → generate fresh UUID for isolation
    if (profile.resume) {
      args.push("--resume", profile.resume);
    } else if (profile.continue) {
      args.push("--continue");
    } else if (profile.sessionId) {
      args.push("--session-id", profile.sessionId);
    } else {
      args.push("--session-id", freshSessionId());
    }

    if (profile.bare) args.push("--bare");
    if (profile.model) args.push("--model", profile.model);
    if (profile.permissionMode) args.push("--permission-mode", profile.permissionMode);
    if (profile.allowedTools && profile.allowedTools.length) {
      args.push("--allowedTools", profile.allowedTools.join(","));
    }
    if (profile.disallowedTools && profile.disallowedTools.length) {
      args.push("--disallowedTools", profile.disallowedTools.join(","));
    }
    if (profile.name) args.push("--name", profile.name);
    if (profile.addDirs) profile.addDirs.forEach((d) => args.push("--add-dir", d));
    if (profile.mcpConfig) args.push("--mcp-config", JSON.stringify(profile.mcpConfig));
    if (profile.effort) args.push("--effort", profile.effort);
    if (profile.agents) args.push("--agents", JSON.stringify(profile.agents));
    if (profile.extraArgs) args.push(...profile.extraArgs);

    const cwd = profile.cwd ?? process.cwd();
    const env: Record<string, string> = { ...(profile.env ?? {}) };

    // Optional config isolation — uses profile.sessionId when available, else
    // the one we just pushed into args (extract it back for sandbox naming).
    if (profile.isolateConfig) {
      const sid = profile.sessionId
        ?? (profile.resume ?? (profile.continue ? `continue-${Date.now()}` : args[args.indexOf("--session-id") + 1]));
      const { configDir } = isolateClaudeConfig(sid, cwd, { isolateAuth: profile.isolateAuth });
      env.CLAUDE_CONFIG_DIR = configDir;
    }

    return {
      command: "claude",
      args,
      cwd,
      env,
    };
  }
}

export default ClaudeDriver;
