/**
 * GeminiDriver — Google Gemini CLI.
 *
 * v1 of this driver ships exec mode only (`gemini -p <prompt> -y
 * --output-format stream-json`). Live interactive mode is also supported
 * by gemini-cli but captures would need parser work — deferred.
 *
 * Auth: requires GEMINI_API_KEY (preferred) or a configured Google account.
 * The daemon inherits its own env, so the user must `source gemini.env &&
 * export GEMINI_API_KEY` before launching the daemon.
 */

import { execFileSync } from "node:child_process";
import type { Driver, DriverMode, DriverProbe, DriverProfile, ExecSpec, ExecTask } from "../api.js";
import { gradeCompat } from "../../core/semver.js";
import { GeminiParser } from "./parser.js";
import { GeminiControl } from "./control.js";

export interface GeminiProfile extends DriverProfile {
  /** Model override (-m / --model) */
  model?: string;
  /** Default: "yolo" — `-y` + --approval-mode yolo so tools auto-run */
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  /** Extra args appended verbatim */
  extraArgs?: string[];
}

export class GeminiDriver implements Driver {
  id = "gemini";
  label = "Google Gemini";
  version = "1.0.0";
  aliases = ["gm"];
  modes: DriverMode[] = ["exec"];
  supportedVersions = ">=0.38.0 <1.0.0";

  parser = new GeminiParser();
  control = new GeminiControl();

  async probe(): Promise<DriverProbe> {
    let available = false;
    let version: string | undefined;
    let path: string | undefined;
    const warnings: string[] = [];

    try {
      const which = execFileSync("which", ["gemini"], { encoding: "utf-8" }).trim();
      if (which) { path = which; available = true; }
    } catch { /* not on PATH */ }

    if (available) {
      try {
        const out = execFileSync("gemini", ["--version"], { encoding: "utf-8" }).trim();
        const m = out.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
        if (m) version = m[1];
      } catch { /* ignore */ }

      // Soft-check auth. We can't verify without making an API call; just
      // warn if GEMINI_API_KEY is missing from the daemon's own env.
      if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENAI_USE_VERTEXAI && !process.env.GOOGLE_GENAI_USE_GCA) {
        warnings.push(
          "No Gemini auth detected. Export GEMINI_API_KEY before launching the daemon (or use Vertex/GCA).",
        );
      }
    }

    const compat = gradeCompat(version, this.supportedVersions);
    if (compat === "untested" && version) {
      warnings.push(
        `Gemini ${version} is outside the tested range (${this.supportedVersions}). ` +
        `Stream-JSON event shape may have changed; run \`cordy capture\` if messages don't land.`,
      );
    }

    return {
      available,
      version,
      path,
      capabilities: { exec: available },
      warnings,
      supportedModes: available ? ["exec"] : [],
      compat,
    };
  }

  buildExec(profile: GeminiProfile, task: ExecTask): ExecSpec {
    // Exact invocation that's been verified live:
    //   gemini -p <prompt> -y --output-format stream-json
    // Adding --approval-mode together with -y makes gemini exit 1 (shows help)
    // on 0.38.2, so we use -y alone for the "yolo" default.
    const args = ["-p", task.prompt, "--output-format", "stream-json"];
    const approval = profile.approvalMode ?? "yolo";
    if (approval === "yolo") {
      args.push("-y");
    } else {
      args.push("--approval-mode", approval);
    }
    if (profile.model) args.push("-m", profile.model);
    if (profile.extraArgs) args.push(...profile.extraArgs);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (profile.env) Object.assign(env, profile.env);

    return {
      command: "gemini",
      args,
      cwd: profile.cwd ?? process.cwd(),
      env,
      parseOutput: "jsonl",
    };
  }
}
