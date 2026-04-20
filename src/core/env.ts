/**
 * Env-file loader for the daemon.
 *
 * At daemon startup, loads environment variables from (in order):
 *   1. `$CORDY_ENV_FILE` — explicit override path
 *   2. `~/.cordyceps/env` — default per-user config
 *   3. `<cwd>/.cordyceps/env` — per-project override (takes precedence)
 *
 * Values already present in process.env are NOT overwritten — the shell
 * environment wins. This is so a user who has `GEMINI_API_KEY` exported in
 * their shell keeps it, and the env file only fills gaps.
 *
 * File format is shell-env:
 *   # Comments with hash
 *   KEY=value                    (unquoted)
 *   KEY="value with spaces"      (double-quoted)
 *   KEY='value with $special'    (single-quoted, literal)
 *   export KEY=value             (export prefix stripped)
 *
 * Exports only — no substitution, no command execution. Safer than sourcing.
 *
 * The loader NEVER logs values. It logs the count of keys loaded and their
 * names (keys are fine — names aren't secrets; values are).
 */

import { existsSync, readFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "./logger.js";

export interface EnvLoadResult {
  path: string;
  loaded: string[];        // key names loaded (no values)
  skippedAlreadySet: string[];  // key names already in process.env
}

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Parse one line. Returns { key, value } or null for blank/comment lines.
 * Throws on clearly malformed lines.
 */
function parseLine(raw: string): { key: string; value: string } | null {
  const line = raw.replace(/\r$/, "");
  if (!line.trim() || line.trim().startsWith("#")) return null;
  const m = line.match(LINE_RE);
  if (!m) return null; // silently skip unparseable lines rather than fail
  const key = m[1];
  let value = m[2];

  // Strip trailing inline comments ONLY when the value starts unquoted.
  // If the value is quoted, preserve everything inside the quotes.
  if (value.startsWith('"') && value.length > 1) {
    const end = value.indexOf('"', 1);
    if (end > 0) value = value.slice(1, end);
    else value = value.slice(1); // unclosed; take the rest
  } else if (value.startsWith("'") && value.length > 1) {
    const end = value.indexOf("'", 1);
    if (end > 0) value = value.slice(1, end);
    else value = value.slice(1);
  } else {
    // Unquoted — strip inline comment after whitespace
    const hashIdx = value.indexOf(" #");
    if (hashIdx > 0) value = value.slice(0, hashIdx);
    value = value.trim();
  }

  return { key, value };
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const parsed = parseLine(raw);
    if (parsed) out[parsed.key] = parsed.value;
  }
  return out;
}

/**
 * Load env vars from the first existing candidate path.
 * Fills gaps in process.env; does not overwrite existing values.
 * Returns a summary for logging. Never returns values.
 */
export function loadEnvFile(cwd: string, logger: Logger): EnvLoadResult | null {
  const candidates: string[] = [];
  if (process.env.CORDY_ENV_FILE) candidates.push(process.env.CORDY_ENV_FILE);
  candidates.push(join(cwd, ".cordyceps", "env"));
  candidates.push(join(homedir(), ".cordyceps", "env"));

  for (const path of candidates) {
    if (!existsSync(path)) continue;

    // Chmod to 0600 on read if world-readable. Env files likely contain secrets;
    // don't leave them with default perms.
    try {
      const st = statSync(path);
      if ((st.mode & 0o077) !== 0) {
        chmodSync(path, 0o600);
        logger.info("env", `tightened permissions on ${path} → 0600`);
      }
    } catch { /* ignore perm errors — not load-blocking */ }

    let content: string;
    try { content = readFileSync(path, "utf-8"); } catch (err) {
      logger.warn("env", `failed to read ${path}: ${(err as Error).message}`);
      continue;
    }

    const parsed = parseEnvFile(content);
    const loaded: string[] = [];
    const skippedAlreadySet: string[] = [];

    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] !== undefined) {
        skippedAlreadySet.push(k);
        continue;
      }
      process.env[k] = v;
      loaded.push(k);
    }

    logger.info(
      "env",
      `loaded ${loaded.length} vars from ${path}` +
      (loaded.length > 0 ? ` (${loaded.join(", ")})` : "") +
      (skippedAlreadySet.length > 0 ? ` — skipped ${skippedAlreadySet.length} already in shell env (${skippedAlreadySet.join(", ")})` : ""),
    );

    return { path, loaded, skippedAlreadySet };
  }

  return null;
}
