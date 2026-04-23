/**
 * ClaudeDriver — the v1 flagship driver.
 *
 * Modes: ["pty", "exec"]
 *
 *   pty  (EXPERIMENTAL):  drives the full Claude Code TUI — interactive
 *                         sessions, tool use, streamed output via terminal
 *                         escape codes. Powerful but the parser must walk
 *                         escape sequences (spinners, "Herding…" status
 *                         redraws, animated thinking glyphs) and under load
 *                         it loses sync — captured transcripts come back as
 *                         fragmented character soup (`r ✻`, `H d`, etc.).
 *                         Reliability improves over time but treat as
 *                         experimental for headless / scripted use until
 *                         the parser gets a hardening pass. For council /
 *                         automated review use, prefer exec mode.
 *
 *   exec (RECOMMENDED for one-shot):  uses `claude --print <prompt>` for
 *                         non-interactive answers. Stdout is plain text,
 *                         no TUI animation, no escape codes to walk —
 *                         ExecAgentController emits stdout verbatim as a
 *                         single AssistantMessage. Far more reliable than
 *                         PTY for headless prompts. Pass --mode=exec on
 *                         spawn (with equals — space-separated may
 *                         mis-parse).
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
import type { Driver, DriverMode, DriverProbe, DriverProfile, ExecSpec, ExecTask, SpawnSpec } from "../api.js";

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
  /** Append to Claude's system prompt (per Claude Code --append-system-prompt) */
  appendSystemPrompt?: string;

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
  version = "0.2.0";  // bumped on adding exec mode (was 0.1.0 / pty-only)
  aliases = ["claude"];
  modes: DriverMode[] = ["pty", "exec"];
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
      capabilities.printMode = /--print|^\s*-p,/m.test(help);
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

    // Modes available on this machine: PTY always (if binary present); exec
    // requires --print support which probably exists in any modern claude
    // (>=1.0.x), but we gate on the help-text probe to be defensive.
    const supportedModes: DriverMode[] = ["pty"];
    if (capabilities.printMode !== false) supportedModes.push("exec");

    return {
      available: true,
      version,
      path,
      capabilities,
      warnings,
      supportedModes,
      compat,
    };
  }

  /**
   * PTY mode (EXPERIMENTAL).
   *
   * Drives the live Claude Code TUI by writing prompts to a pseudo-terminal
   * and capturing the rendered output. Required for interactive sessions or
   * any case that needs Claude's tool use (Read/Grep/Bash) inside the agent.
   *
   * Caveat: ClaudeParser walks TUI escape sequences (animated spinners,
   * "Herding…" status redraws, thinking-glyph rotations). Under load, the
   * stream can fragment and the captured transcript comes back as character
   * soup — symptoms include partial words, repeated chunks, missing
   * sections, and apparent hangs where the agent is actually idle. Don't
   * rely on PTY for headless / scripted council prompts; use exec mode.
   */
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
    if (profile.appendSystemPrompt) args.push("--append-system-prompt", profile.appendSystemPrompt);
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

  /**
   * Exec mode — `claude -p <prompt>` for one-shot non-interactive answers.
   * Stdout is plain text (the assistant's response), no TUI animation, no
   * spinner redraws, no escape-code parsing. Vastly more reliable than PTY
   * for council-style use where we just want a single response.
   *
   * Most PTY profile fields carry over: --model, --effort, --bare,
   * --permission-mode, --allowedTools, --disallowedTools, --mcp-config,
   * --add-dir, --append-system-prompt, --agents. Session flags (--resume,
   * --continue, --session-id) are intentionally omitted because exec is
   * one-shot and shouldn't accidentally mutate user history.
   */
  buildExec(profile: ClaudeProfile, task: ExecTask): ExecSpec {
    const args: string[] = ["--print", task.prompt];

    if (profile.bare) args.push("--bare");
    if (profile.model) args.push("--model", profile.model);
    if (profile.permissionMode) args.push("--permission-mode", profile.permissionMode);
    if (profile.allowedTools && profile.allowedTools.length) {
      args.push("--allowedTools", profile.allowedTools.join(","));
    }
    if (profile.disallowedTools && profile.disallowedTools.length) {
      args.push("--disallowedTools", profile.disallowedTools.join(","));
    }
    if (profile.addDirs) profile.addDirs.forEach((d) => args.push("--add-dir", d));
    if (profile.mcpConfig) args.push("--mcp-config", JSON.stringify(profile.mcpConfig));
    if (profile.effort) args.push("--effort", profile.effort);
    if (profile.agents) args.push("--agents", JSON.stringify(profile.agents));
    if (profile.appendSystemPrompt) args.push("--append-system-prompt", profile.appendSystemPrompt);
    if (profile.extraArgs) args.push(...profile.extraArgs);

    const cwd = profile.cwd ?? process.cwd();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (profile.env) Object.assign(env, profile.env);

    return {
      command: "claude",
      args,
      cwd,
      env,
      parseOutput: "text",
    };
  }
}

export default ClaudeDriver;
