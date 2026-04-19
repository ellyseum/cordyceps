/**
 * council plugin — multi-family code review with synthesis.
 *
 * One RPC method: council.review
 * Spawns N reviewer agents (silo'd — no reviewer sees another's output), gives
 * each the same file + structured prompt, then spawns a chair that reads all
 * reviews and synthesizes a single verdict.
 *
 * The design thesis (see project_council_diversity_thesis.md): inter-family
 * model diversity covers blind spots better than intra-family ensembles. Three
 * reviewers from three different training lineages (Anthropic, OpenAI, Google)
 * have three independent error distributions.
 *
 * Params:
 *   path          — absolute or cwd-relative path to the file being reviewed
 *   panel?        — array of reviewer specs (default: [claude, codex, gemini])
 *                   each spec: { driver: string, profile?: object }
 *   chair?        — chair spec (default: { driver: "claude" })
 *   timeoutMs?    — per-agent submit timeout (default 180_000)
 *
 * Returns:
 *   { target, panel, reviews: [{name, driver, findings?, error?}],
 *     synthesis: string, durationMs }
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CordycepsPlugin, PluginContext } from "../../api.js";
import type { AgentRuntime, AssistantMessage } from "../../../agents/types.js";

interface ReviewerSpec {
  driver: string;
  profile?: Record<string, unknown>;
}

interface CouncilParams {
  path: string;
  panel?: ReviewerSpec[];
  chair?: ReviewerSpec;
  timeoutMs?: number;
}

interface Finding {
  severity?: string;
  category?: string;
  title?: string;
  detail?: string;
  suggested_fix?: string;
}

interface ReviewerResult {
  name: string;
  driver: string;
  findings?: Finding[];
  rawText?: string;
  error?: string;
}

const DEFAULT_PANEL: ReviewerSpec[] = [
  { driver: "claude" },
  { driver: "codex" },
  { driver: "gemini" },
];

// Codex is the default chair: exec-mode drivers return structured JSONL the
// parser extracts cleanly, whereas Claude PTY parsing can truncate long
// synthesis outputs. Override with --chair claude when you want Claude's
// judgment over the chair's output format.
const DEFAULT_CHAIR: ReviewerSpec = { driver: "codex" };

function reviewerPrompt(targetPath: string, source: string): string {
  return `You are a code reviewer on a blind council. You do NOT see other reviewers' output. Your job is to flag real issues in the file below.

Focus areas (in priority order):
  1. Correctness bugs (logic errors, race conditions, unhandled cases)
  2. Security issues (injection, auth bypass, secret leakage, unsafe defaults)
  3. Performance issues (O(n²) where O(n) works, allocation in hot paths, leaks)
  4. Readability / maintainability (only if meaningful — don't nitpick style)

Rules:
  - Skip findings you're <70% confident about
  - Don't invent issues to seem thorough — empty review is fine
  - Each finding is ONE bullet point of real substance

Output a JSON array on the LAST line of your response, with NO prose after it.
Each finding: {"severity": "critical|high|medium|low|info", "category": "correctness|security|performance|style", "title": "short title", "detail": "2-3 sentences explaining the issue and its impact", "suggested_fix": "concrete fix or null"}

If you find nothing: output []

File: ${targetPath}
---
${source}
---

Output your JSON findings array now:`;
}

function chairPrompt(targetPath: string, reviewers: ReviewerResult[]): string {
  const sections = reviewers.map((r) => {
    if (r.error) return `## Reviewer: ${r.name} (driver=${r.driver})\n  ERROR: ${r.error}\n`;
    const findings = JSON.stringify(r.findings ?? [], null, 2);
    return `## Reviewer: ${r.name} (driver=${r.driver})\n\`\`\`json\n${findings}\n\`\`\`\n`;
  }).join("\n");

  const validReviewers = reviewers.filter((r) => !r.error);

  return `You are the chair of a code review council. ${validReviewers.length} of ${reviewers.length} reviewers completed their reviews of the file below. They worked independently — none saw another's findings.

Your job:
  1. Deduplicate — findings that describe the same issue should be collapsed
  2. Categorize — for each unique issue, note which reviewers flagged it (unanimous / majority / minority / unique)
  3. Prioritize — order by severity × agreement
  4. Recommend — one of: approve, request-changes, block-ship
  5. Flag the minority opinions — often where the real blind spots hide

Output a markdown report. Start with a one-line recommendation at the top. Then the deduplicated findings in priority order. Then a short "points of disagreement" section if reviewers saw the same code differently.

File: ${targetPath}

Reviews:
${sections}

Write your verdict now:`;
}

function parseReviewerSpec(s: string): ReviewerSpec {
  const i = s.indexOf(":");
  if (i < 0) return { driver: s };
  return { driver: s.slice(0, i), profile: { model: s.slice(i + 1) } };
}

function parsePanelArg(panel: string): ReviewerSpec[] {
  return panel.split(",").map((s) => s.trim()).filter(Boolean).map(parseReviewerSpec);
}

/**
 * Extract JSON array from a model's response. Accepts:
 *   - Bare JSON array on its own line
 *   - JSON array inside ```json fences
 *   - JSON array at end of response after prose
 */
function extractFindings(text: string): Finding[] {
  if (!text) return [];

  // Strip ```json fences if present
  const fenceMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]) as Finding[]; } catch { /* fall through */ }
  }

  // Find last top-level JSON array in the text
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      try { return JSON.parse(line) as Finding[]; } catch { /* skip */ }
    }
  }

  // Last resort: look for anything bracketed
  const bracketMatch = text.match(/\[\s*(?:\{[\s\S]*?\}\s*,?\s*)*\]/);
  if (bracketMatch) {
    try { return JSON.parse(bracketMatch[0]) as Finding[]; } catch { /* ignore */ }
  }

  return [];
}

async function runOneReviewer(
  ctx: PluginContext,
  spec: ReviewerSpec,
  index: number,
  prompt: string,
  timeoutMs: number,
): Promise<ReviewerResult> {
  const name = `council-reviewer-${index}-${spec.driver}`;
  let agent: AgentRuntime | undefined;
  try {
    const info = await ctx.agents.spawn(spec.driver, {
      id: name,
      profile: spec.profile,
    });
    agent = ctx.agents.get(info.id);
    if (!agent) throw new Error(`spawn succeeded but agent lookup failed`);

    // Let agents that need a warm-up (Claude PTY) settle
    if (info.mode === "pty") {
      await new Promise((r) => setTimeout(r, 1500));
    }

    const result = await agent.submit(prompt, { timeoutMs });
    const rawText = result.message?.text ?? "";
    const findings = extractFindings(rawText);
    return { name, driver: spec.driver, findings, rawText };
  } catch (err) {
    return { name, driver: spec.driver, error: (err as Error).message };
  } finally {
    if (agent) {
      try { await agent.kill(); } catch { /* ignore */ }
      try { ctx.agents.remove(name); } catch { /* ignore */ }
    }
  }
}

async function runChair(
  ctx: PluginContext,
  spec: ReviewerSpec,
  prompt: string,
  timeoutMs: number,
): Promise<{ synthesis: string; error?: string }> {
  const name = "council-chair";
  let agent: AgentRuntime | undefined;
  try {
    const info = await ctx.agents.spawn(spec.driver, {
      id: name,
      profile: spec.profile,
    });
    agent = ctx.agents.get(info.id);
    if (!agent) throw new Error(`chair spawn succeeded but lookup failed`);

    if (info.mode === "pty") {
      await new Promise((r) => setTimeout(r, 1500));
    }

    const result = await agent.submit(prompt, { timeoutMs });
    const msg = result.message as AssistantMessage | undefined;
    return { synthesis: msg?.text ?? "(chair produced no output)" };
  } catch (err) {
    return { synthesis: "", error: (err as Error).message };
  } finally {
    if (agent) {
      try { await agent.kill(); } catch { /* ignore */ }
      try { ctx.agents.remove(name); } catch { /* ignore */ }
    }
  }
}

const plugin: CordycepsPlugin = {
  name: "council",
  description: "Multi-family code review council with chair synthesis",
  version: "1.0.0",
  order: { priority: 20 },

  async init(ctx: PluginContext) {
    ctx.rpc.register("council.review", async (params) => {
      const p = (params ?? {}) as CouncilParams;
      if (!p.path) throw new Error("council.review: path is required");

      const panel = p.panel && p.panel.length ? p.panel : DEFAULT_PANEL;
      const chair = p.chair ?? DEFAULT_CHAIR;
      const timeoutMs = p.timeoutMs ?? 180_000;

      const absPath = resolve(p.path);
      let source: string;
      try {
        source = readFileSync(absPath, "utf-8");
      } catch (err) {
        throw new Error(`council.review: cannot read ${p.path}: ${(err as Error).message}`);
      }

      // Size budget — v1 hard-stops at 40KB. Chunking is phase 2.
      if (source.length > 40_000) {
        throw new Error(`council.review: file too large (${source.length} bytes). v1 limit is 40KB; chunking is phase 2.`);
      }

      const startedAt = Date.now();
      ctx.logger.info("council", `review start: ${absPath} (${panel.length} reviewers, chair=${chair.driver})`);
      ctx.notify("council.start", { target: absPath, panel, chair });

      // Run all reviewers in parallel with allSettled — one failure doesn't tank the review
      const prompt = reviewerPrompt(absPath, source);
      const reviews = await Promise.all(
        panel.map((spec, i) => runOneReviewer(ctx, spec, i, prompt, timeoutMs)),
      );

      const succeeded = reviews.filter((r) => !r.error);
      const failed = reviews.filter((r) => r.error);
      ctx.logger.info(
        "council",
        `reviewers done: ${succeeded.length}/${reviews.length} succeeded` +
        (failed.length ? ` (failed: ${failed.map((f) => f.name).join(", ")})` : ""),
      );
      ctx.notify("council.reviewers.done", {
        target: absPath,
        succeeded: succeeded.length,
        failed: failed.length,
      });

      if (succeeded.length === 0) {
        return {
          target: absPath,
          panel,
          reviews,
          synthesis: "(all reviewers failed — no synthesis)",
          durationMs: Date.now() - startedAt,
        };
      }

      const chairOut = await runChair(
        ctx, chair, chairPrompt(absPath, reviews), Math.max(timeoutMs, 240_000),
      );
      if (chairOut.error) {
        ctx.logger.warn("council", `chair failed: ${chairOut.error}`);
      }

      const durationMs = Date.now() - startedAt;
      ctx.logger.info("council", `review complete in ${durationMs}ms`);
      ctx.notify("council.complete", { target: absPath, durationMs });

      return {
        target: absPath,
        panel,
        reviews,
        synthesis: chairOut.synthesis,
        chairError: chairOut.error ?? null,
        durationMs,
      };
    });

    ctx.onDestroy(() => { ctx.rpc.unregister("council.review"); });
    ctx.logger.info("council", "council plugin ready — `cordy council review <file>`");
  },
};

export { parsePanelArg, parseReviewerSpec };
export default plugin;
