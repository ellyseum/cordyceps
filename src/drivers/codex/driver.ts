/**
 * CodexDriver — OpenAI Codex CLI.
 *
 * v1 of this driver ships exec mode only (`codex exec --json`). PTY and
 * server-ws (`codex exec-server --listen ws://...`) modes slot in as later
 * sub-phases without touching the Driver contract.
 *
 * Probe requirements:
 *   - `codex` on PATH
 *   - `codex --version` returns a parseable version
 *   - Authenticated session (`~/.codex/auth.json` exists) — warned if missing
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Driver, DriverMode, DriverProbe, DriverProfile, ExecSpec, ExecTask } from "../api.js";
import { gradeCompat } from "../../core/semver.js";
import { CodexParser } from "./parser.js";
import { CodexControl } from "./control.js";

export interface CodexProfile extends DriverProfile {
  model?: string;                      // --model / -m
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Skip the "is this a git repo?" check — required for captures in temp dirs */
  skipGitRepoCheck?: boolean;
  /** Pass-through: arbitrary `-c key=value` overrides */
  configOverrides?: Record<string, string>;
  /** Additional args appended verbatim to `codex exec ...` */
  extraArgs?: string[];
}

export class CodexDriver implements Driver {
  id = "codex";
  label = "OpenAI Codex";
  version = "1.0.0";
  aliases = ["cx"];
  modes: DriverMode[] = ["exec"];
  supportedVersions = ">=0.120.0 <0.200.0";

  parser = new CodexParser();
  control = new CodexControl();

  async probe(): Promise<DriverProbe> {
    let available = false;
    let version: string | undefined;
    const path: string | undefined = undefined;
    const warnings: string[] = [];

    // Skip `which`; let execFileSync resolve PATH and rely on ENOENT.
    try {
      const out = execFileSync("codex", ["--version"], { encoding: "utf-8", timeout: 5000 }).trim();
      available = true;
      // "codex-cli 0.121.0"
      const m = out.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
      if (m) version = m[1];
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Binary exists but version probe glitched — still treat as available.
        available = true;
        warnings.push(`codex --version failed: ${(err as Error).message}`);
      }
    }

    if (available) {
      // Check for auth
      const authPath = join(homedir(), ".codex", "auth.json");
      try { statSync(authPath); } catch {
        warnings.push("No codex auth detected (~/.codex/auth.json missing). Run `codex login` first.");
      }
    }

    const compat = gradeCompat(version, this.supportedVersions);
    if (compat === "untested" && version) {
      warnings.push(
        `Codex ${version} is outside the tested range (${this.supportedVersions}). ` +
        `Exec JSONL events may have shifted; run \`cordy capture\` if messages don't land.`,
      );
    }

    return {
      available,
      version,
      path,
      capabilities: {
        exec: available,
        pty: false,                   // not shipped yet
        serverWs: false,              // not shipped yet
      },
      warnings,
      supportedModes: available ? ["exec"] : [],
      compat,
    };
  }

  buildExec(profile: CodexProfile, task: ExecTask): ExecSpec {
    const args = ["exec", "--json"];

    if (profile.skipGitRepoCheck !== false) {
      args.push("--skip-git-repo-check");
    }
    if (profile.model) args.push("--model", profile.model);
    if (profile.sandbox) args.push("--sandbox", profile.sandbox);
    if (profile.configOverrides) {
      for (const [k, v] of Object.entries(profile.configOverrides)) {
        args.push("-c", `${k}=${v}`);
      }
    }
    if (profile.extraArgs) args.push(...profile.extraArgs);

    // Pass the prompt as a positional arg. Codex also accepts stdin (`-`) if
    // prompt is extremely long, but for most cases positional is cleaner.
    args.push(task.prompt);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (profile.env) Object.assign(env, profile.env);

    return {
      command: "codex",
      args,
      cwd: profile.cwd ?? process.cwd(),
      env,
      parseOutput: "jsonl",
    };
  }
}
