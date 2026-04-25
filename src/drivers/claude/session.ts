/**
 * Claude session isolation helpers.
 *
 * Every cordyceps-spawned Claude agent gets a fresh UUID for --session-id
 * (unless the user explicitly sets resume/continue/sessionId). This keeps
 * JSONLs per-agent-per-cwd deterministic, which prevents the commingling
 * claudio solved via its CLAUDE_CONFIG_DIR sandbox.
 *
 * Optional CLAUDE_CONFIG_DIR sandbox is available via `profile.isolateConfig`
 * — it creates a per-agent directory with symlinks to ~/.claude/ (skipping
 * projects/, .credentials.json, .claude.json, settings.json) and a copy of
 * settings.json. Cheaper than claudio's version (no cred copy unless asked).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync, copyFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Generate a fresh session UUID for a new agent. */
export function freshSessionId(): string {
  return randomUUID();
}

/**
 * Sanity-check session IDs that flow into a filesystem path. Authenticated
 * callers can already arrange shell-equivalent execution via spawn args, but
 * we still want a clean public API shape — `../../etc` should never reach
 * `path.join` for the agent sandbox.
 */
const VALID_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
function assertValidSessionId(id: string): void {
  if (!VALID_SESSION_ID.test(id)) {
    throw new Error(
      `Invalid sessionId: must match ${VALID_SESSION_ID.source}`,
    );
  }
}

export interface IsolatedConfigResult {
  /** Directory to pass via CLAUDE_CONFIG_DIR */
  configDir: string;
  /** Whether this directory was newly created (false if reused) */
  created: boolean;
}

/**
 * Create (or reuse) a per-agent Claude config sandbox at
 * ~/.cordyceps/agents/{sessionId}/.
 *
 * Symlinks most of ~/.claude/ in (zero cost), copies settings.json (so
 * per-agent hooks can be injected later), creates an empty projects/{slug}/
 * to prevent JSONL commingling.
 *
 * If `isolateAuth === true`, copies `.credentials.json` too; otherwise the
 * agent inherits auth from ~/.claude/.credentials.json via symlink.
 */
export function isolateClaudeConfig(
  sessionId: string,
  cwd: string,
  opts: { isolateAuth?: boolean } = {},
): IsolatedConfigResult {
  assertValidSessionId(sessionId);
  const claudeDir = join(homedir(), ".claude");
  const sandboxDir = join(homedir(), ".cordyceps", "agents", sessionId);
  const created = !existsSync(sandboxDir);

  mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });

  if (created) {
    const skip = new Set(["projects", ".claudio", ".cordyceps", "settings.json", ".credentials.json", ".claude.json"]);
    let entries: string[] = [];
    try { entries = readdirSync(claudeDir); } catch { /* claude not set up yet */ }

    for (const entry of entries) {
      if (skip.has(entry)) continue;
      const target = join(claudeDir, entry);
      const link = join(sandboxDir, entry);
      try {
        symlinkSync(target, link);
      } catch {
        // Target may not exist or link may already exist — ignore
      }
    }

    // Per-agent projects/{slug}/ — empty JSONL namespace
    const slug = cwd.replace(/\//g, "-");
    const projDir = join(sandboxDir, "projects", slug);
    mkdirSync(projDir, { recursive: true });

    // Optionally copy credentials for strict isolation
    if (opts.isolateAuth) {
      const credSrc = join(claudeDir, ".credentials.json");
      if (existsSync(credSrc)) {
        try {
          copyFileSync(credSrc, join(sandboxDir, ".credentials.json"));
        } catch { /* non-fatal */ }
      }
    } else {
      // Symlink credentials so OAuth/keychain stays available
      const credSrc = join(claudeDir, ".credentials.json");
      if (existsSync(credSrc)) {
        try { symlinkSync(credSrc, join(sandboxDir, ".credentials.json")); } catch { /* ignore */ }
      }
    }

    // Seed .claude.json to skip onboarding
    const stateFile = join(sandboxDir, ".claude.json");
    try {
      writeFileSync(stateFile, JSON.stringify({ hasCompletedOnboarding: true, theme: "dark" }, null, 2));
    } catch { /* non-fatal */ }
  }

  // Always re-copy settings.json so global updates propagate
  const settingsSrc = join(claudeDir, "settings.json");
  const settingsDst = join(sandboxDir, "settings.json");
  if (existsSync(settingsSrc)) {
    try { copyFileSync(settingsSrc, settingsDst); } catch { /* non-fatal */ }
  }

  return { configDir: sandboxDir, created };
}
