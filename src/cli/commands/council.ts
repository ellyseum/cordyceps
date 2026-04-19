/**
 * `cordy council review <path> [--panel X,Y] [--chair Z] [--timeout N] [--json]`
 *
 * Thin client for the council.review plugin method. Prints the chair's
 * markdown synthesis; with --json, dumps the full structured result.
 */

import { connect } from "../client.js";
import { parsePanelArg, parseReviewerSpec } from "../../plugins/builtin/council/index.js";

interface CouncilResult {
  target: string;
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

export async function runCouncil(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] !== "review") {
    process.stderr.write("Usage: cordy council review <path> [--panel claude,codex,gemini] [--chair claude] [--timeout N] [--json]\n");
    return 1;
  }

  const rest = args.slice(1);
  if (rest.length === 0) {
    process.stderr.write("Usage: cordy council review <path> [--panel ...] [--chair ...] [--timeout N] [--json]\n");
    return 1;
  }

  let path: string | undefined;
  let panelArg: string | undefined;
  let chairArg: string | undefined;
  let timeoutMs: number | undefined;
  let asJson = false;
  let noChunk = false;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--panel" && rest[i + 1]) { panelArg = rest[++i]; }
    else if (a === "--chair" && rest[i + 1]) { chairArg = rest[++i]; }
    else if (a === "--timeout" && rest[i + 1]) { timeoutMs = parseInt(rest[++i], 10) * 1000; }
    else if (a === "--json") { asJson = true; }
    else if (a === "--no-chunk") { noChunk = true; }
    else if (!path) { path = a; }
  }

  if (!path) {
    process.stderr.write("Usage: cordy council review <path> [--panel ...] [--chair ...] [--timeout N] [--json]\n");
    return 1;
  }

  const panel = panelArg ? parsePanelArg(panelArg) : undefined;
  const chair = chairArg ? parseReviewerSpec(chairArg) : undefined;

  const client = await connect();
  try {
    process.stderr.write(`Convening council on ${path}...\n`);
    if (panel) {
      process.stderr.write(`  panel: ${panel.map((p) => p.driver + (p.profile?.model ? ":" + p.profile.model : "")).join(", ")}\n`);
    }
    if (chair) {
      process.stderr.write(`  chair: ${chair.driver}\n`);
    }

    const result = await client.call<CouncilResult>(
      "council.review",
      { path, panel, chair, timeoutMs, noChunk },
      (timeoutMs ?? 180_000) * 4 + 120_000, // chunking can multiply total wall time
    );

    if (asJson) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      const chunkNote = (result.chunks ?? 1) > 1 ? ` across ${result.chunks} chunks` : "";
      process.stderr.write(`\n--- Reviewer summary (${result.reviews.filter((r) => !r.error).length}/${result.reviews.length} succeeded${chunkNote}, ${result.durationMs}ms) ---\n`);
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
    return 0;
  } finally {
    client.close();
  }
}
