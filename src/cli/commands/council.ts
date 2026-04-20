/**
 * `cordy council review <path> [flags]`   — review a single file
 * `cordy council diff [base] [flags]`     — review uncommitted / branch diff
 *
 * Thin client for the council.review plugin method. Prints the chair's
 * markdown synthesis; with --json, dumps the full structured result.
 *
 * Subcommands:
 *   review <path>                         File-mode review
 *   diff [--staged] [--scope P] [base]    Diff-mode review (base defaults to HEAD)
 *
 * Shared flags: --panel, --chair, --timeout N, --no-chunk, --json
 */

import { connect } from "../client.js";
import { parsePanelArg, parseReviewerSpec } from "../../plugins/builtin/council/index.js";

interface CouncilResult {
  target: string;
  mode?: "file" | "diff";
  panel: Array<{ driver: string; profile?: Record<string, unknown> }>;
  chunks?: number;
  reviews: Array<{
    name: string;
    driver: string;
    chunkIndex?: number;
    chunkStartLine?: number;
    chunkEndLine?: number;
    findings?: unknown[];
    rawText?: string;
    error?: string;
  }>;
  synthesis: string;
  chairError?: string | null;
  durationMs: number;
}

interface Flags {
  panel?: string;
  chair?: string;
  timeoutMs?: number;
  asJson: boolean;
  noChunk: boolean;
  positional: string[];
  staged: boolean;
  scope?: string;
  /** Force inline (paste source) even for tool-capable drivers. Default false — agents Read the file themselves. */
  inline: boolean;
}

function parseFlags(args: string[]): Flags {
  const f: Flags = { asJson: false, noChunk: false, positional: [], staged: false, inline: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--panel" && args[i + 1]) f.panel = args[++i];
    else if (a === "--chair" && args[i + 1]) f.chair = args[++i];
    else if (a === "--timeout" && args[i + 1]) {
      const raw = args[++i];
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--timeout: expected positive integer seconds, got '${raw}'`);
      }
      f.timeoutMs = n * 1000;
    }
    else if (a === "--scope" && args[i + 1]) f.scope = args[++i];
    else if (a === "--json") f.asJson = true;
    else if (a === "--no-chunk") f.noChunk = true;
    else if (a === "--staged") f.staged = true;
    else if (a === "--inline") f.inline = true;
    else f.positional.push(a);
  }
  return f;
}

function printSummary(result: CouncilResult, asJson: boolean) {
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  const chunkNote = (result.chunks ?? 1) > 1 ? ` across ${result.chunks} chunks` : "";
  const modeTag = result.mode ? ` (${result.mode} mode)` : "";
  process.stderr.write(`\n--- Reviewer summary${modeTag} (${result.reviews.filter((r) => !r.error).length}/${result.reviews.length} succeeded${chunkNote}, ${result.durationMs}ms) ---\n`);
  for (const r of result.reviews) {
    const chunkTag = r.chunkIndex !== undefined
      ? ` [c${r.chunkIndex + 1} L${r.chunkStartLine}-${r.chunkEndLine}]`
      : "";
    const status = r.error ? `ERROR: ${r.error}` : `${(r.findings ?? []).length} findings`;
    process.stderr.write(`  ${(r.name + chunkTag).padEnd(60)} ${status}\n`);
  }
  process.stderr.write(`\n--- Chair synthesis ---\n`);
  process.stdout.write(result.synthesis + "\n");
  if (result.chairError) {
    process.stderr.write(`\n⚠ chair error: ${result.chairError}\n`);
  }
}

async function runFileReview(f: Flags): Promise<number> {
  const path = f.positional[0];
  if (!path) {
    process.stderr.write("Usage: cordy council review <path> [--panel ...] [--chair ...] [--timeout N] [--no-chunk] [--json]\n");
    return 1;
  }

  const panel = f.panel ? parsePanelArg(f.panel) : undefined;
  const chair = f.chair ? parseReviewerSpec(f.chair) : undefined;

  const client = await connect();
  try {
    process.stderr.write(`Convening council on ${path}...\n`);
    if (panel) process.stderr.write(`  panel: ${panel.map((p) => p.driver + (p.profile?.model ? ":" + p.profile.model : "")).join(", ")}\n`);
    if (chair) process.stderr.write(`  chair: ${chair.driver}\n`);

    const result = await client.call<CouncilResult>(
      "council.review",
      { path, panel, chair, timeoutMs: f.timeoutMs, noChunk: f.noChunk, forceInline: f.inline },
      (f.timeoutMs ?? 180_000) * 4 + 120_000,
    );
    printSummary(result, f.asJson);
    return 0;
  } finally {
    client.close();
  }
}

async function runDiffReview(f: Flags): Promise<number> {
  const base = f.positional[0]; // optional
  const panel = f.panel ? parsePanelArg(f.panel) : undefined;
  const chair = f.chair ? parseReviewerSpec(f.chair) : undefined;

  const client = await connect();
  try {
    const label = f.staged
      ? "staged changes"
      : base ? `diff vs ${base}` : "diff vs HEAD";
    process.stderr.write(`Convening council on ${label}${f.scope ? ` (scoped to ${f.scope})` : ""}...\n`);
    if (panel) process.stderr.write(`  panel: ${panel.map((p) => p.driver + (p.profile?.model ? ":" + p.profile.model : "")).join(", ")}\n`);
    if (chair) process.stderr.write(`  chair: ${chair.driver}\n`);

    const result = await client.call<CouncilResult>(
      "council.review",
      {
        diff: { base, staged: f.staged, scope: f.scope, cwd: process.cwd() },
        panel, chair, timeoutMs: f.timeoutMs, noChunk: f.noChunk,
      },
      (f.timeoutMs ?? 180_000) * 4 + 120_000,
    );
    printSummary(result, f.asJson);
    return 0;
  } finally {
    client.close();
  }
}

export async function runCouncil(args: string[]): Promise<number> {
  if (args.length === 0) {
    process.stderr.write(`Usage:
  cordy council review <path>           Review a single file
  cordy council diff [base]             Review uncommitted changes (default: vs HEAD)
  cordy council diff --staged           Review only staged changes
  cordy council diff <base..head>       Review a branch comparison

Shared flags:
  --panel D1,D2     Reviewer panel (default: claude,codex,gemini)
  --chair D         Chair driver (default: codex)
  --timeout S       Per-reviewer timeout in seconds (default: 180)
  --inline          Force inline source stuffing even for tool-capable drivers
  --no-chunk        Disable chunking (fails hard if file exceeds single-chunk limit)
  --scope PATH      git diff path filter (diff mode only)
  --json            Emit full result as JSON
`);
    return 1;
  }

  const sub = args[0];
  const f = parseFlags(args.slice(1));

  switch (sub) {
    case "review":
      return runFileReview(f);
    case "diff":
      return runDiffReview(f);
    default:
      process.stderr.write(`Unknown subcommand: ${sub}. Try 'review' or 'diff'.\n`);
      return 1;
  }
}
