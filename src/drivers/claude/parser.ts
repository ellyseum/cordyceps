/**
 * ClaudeParser — interprets Claude Code's TUI output into AgentState + messages.
 *
 * State machine driven by four glyph families:
 *   ●   — message start (assistant text)
 *   ⎿   — result (tool/agent completion with stats)
 *   ✢/✶/braille dots — spinner (busy; stats on the same line)
 *   ⏵/⏸ — mode indicator (permission mode + file counts)
 *
 * Plus task glyphs (◼/◻/✔) and blocking detection (y/n prompts).
 *
 * Ported from claudio/src/builtin/session-parser.ts. Key changes:
 *   - No bus-publish side effects — returns ParseResult instead
 *   - Stateless interface: state lives on the runtime, parser mutates a copy
 *   - Updated for Claude Code 2.x 6-mode permission surface
 */

import { ansiToText } from "../../core/ansi.js";
import type { AgentState, AssistantMessage, BlockKind } from "../../agents/types.js";
import type { DriverParser, ParseResult, ParserEvent } from "../api.js";
import { CLAUDE_TUI } from "./tui.js";

// ── Regexes lifted from claudio session-parser ──────────────────────────

// Full mode line with file counts (seen when Claude has edited/read files):
//   "⏵⏵ bypass permissions on main · 12 files +4 -3"
const MODE_RE_FULL =
  /([\u23F5\u23F8]+)\s+(bypass permissions|accept edits|plan mode|default|auto|don['\u2019]t ask)\s+\w+.*?(\d+)\s+files?\s+\+(\d+)\s+-(\d+)/;

// Minimal mode line (fresh session, no file stats yet):
//   "⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt"
const MODE_RE_MIN =
  /([\u23F5\u23F8]+)\s+(bypass permissions|accept edits|plan mode|default|auto mode|don['\u2019]t ask)\b/;

const ACTIVITY_RE =
  /[\u2722\u2736\u273D\u273B\u2726\u2727\u2723\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F\u28BE\u28BD\u28BB\u28BF\u28FF\u28DF\u28EF\u28F7]\s+(.+?)\s*\(([^)]+)\)/;

const RESULT_RE = /\u23BF\s+(\S.*?)\s*\(([^)]+)\)/;

const MSG_START_RE = /\u25CF\s+/;

const TOOL_BLOCK_RE = /(?:Allow|Approve).*\?\s*\(?[yYnN]/;
const PLAN_BLOCK_RE = /plan\b.*\bapprove|exit plan mode|ExitPlanMode/i;
const CONFIRM_BLOCK_RE = /Do you want to proceed|Are you sure|Continue\?/i;

const TASK_LINE_RE = /^\s*([\u25FC\u25FB\u2714\u2713\u2611])\s+(.+)/;

const MODEL_RE = /(?:claude-)?(?:opus|sonnet|haiku)[\s-][\d.]+/i;

const CONTEXT_RE = /Context left until auto-compact:\s*(\d+)%/;

// ── Parser ──────────────────────────────────────────────────────────────

interface ParserScratch {
  /** Rolling buffer for patterns that span chunks (4KB) */
  buffer: string;
  /** Whether we're accumulating an assistant message */
  capturingMessage: boolean;
  /** Message accumulator */
  messageBuf: string;
  /** Task glyph map — status per task name */
  tasks: Map<string, "pending" | "in_progress" | "completed">;
}

export class ClaudeParser implements DriverParser {
  private scratch: ParserScratch = {
    buffer: "",
    capturingMessage: false,
    messageBuf: "",
    tasks: new Map(),
  };

  initialState(): AgentState {
    return {
      status: "starting",
      mode: "default",
      model: "",
      tokens: { used: 0 },
      extra: { files: { count: 0, added: 0, removed: 0 } },
    };
  }

  feed(chunk: string, state: AgentState): ParseResult {
    // Use ansiToText so cursor-forward (`\x1b[<n>C`) becomes spaces — otherwise
    // Claude's "Opus⟨CSI⟩4.7" style layout collapses to "Opus4.7" and breaks the
    // model regex. Same issue shows up in "●<cursor-forward>BANANA" message output.
    const clean = ansiToText(chunk);
    const events: ParserEvent[] = [];
    const messages: AssistantMessage[] = [];

    // Empty chunk — flush any pending message buffer (end-of-segment signal).
    // Without this, messages hang until the next glyph arrives.
    if (!clean) {
      if (this.scratch.capturingMessage && this.scratch.messageBuf.trim()) {
        const text = this.scratch.messageBuf.trim();
        const next: AgentState = { ...state, lastMessage: text };
        messages.push({ text, ts: new Date().toISOString() });
        events.push({ kind: "message", data: { text } });
        this.scratch.capturingMessage = false;
        this.scratch.messageBuf = "";
        return { state: next, events, messages };
      }
      return { state, events, messages };
    }

    // Rolling buffer bounded at 4KB
    this.scratch.buffer += clean + "\n";
    if (this.scratch.buffer.length > 4096) {
      this.scratch.buffer = this.scratch.buffer.slice(-2048);
    }

    // Work on a copy — callers expect state to be a new object if changed
    const next: AgentState = { ...state, extra: { ...(state.extra ?? {}) } };
    let changed = false;

    changed = this.parseMode(clean, next, events) || changed;
    changed = this.parseActivity(clean, next, events) || changed;
    changed = this.parseResult(clean, next, events) || changed;
    changed = this.parseMessage(clean, next, events, messages) || changed;
    changed = this.parseBlocking(clean, next, events) || changed;
    changed = this.parseTasks(clean, next, events) || changed;
    changed = this.parseModel(clean, next, events) || changed;
    changed = this.parseContextRemaining(clean, next) || changed;

    // Update status based on other signals.
    // starting → idle when `❯` appears. The mode line only renders after first
    // interaction, so we can't gate on it. ClaudeControl.submit adds a small
    // post-idle settle delay to handle residual banner redraws.
    if (next.activity) next.status = "busy";
    else if (next.blocking) next.status = "blocked";
    else if (next.status === "starting" && CLAUDE_TUI.patterns.promptReady.test(clean)) {
      next.status = "idle";
      changed = true;
    } else if (next.status === "busy" && !next.activity) {
      next.status = "idle";
      changed = true;
    }

    return { state: changed ? next : state, events, messages };
  }

  // ── Individual parsers ────────────────────────────────────────────────

  private parseMode(clean: string, next: AgentState, events: ParserEvent[]): boolean {
    // Try the full line first (mode + file counts); fall back to the minimal form
    // (fresh session — no file activity yet).
    const full = clean.match(MODE_RE_FULL);
    const min = full ? null : clean.match(MODE_RE_MIN);
    const m = full ?? min;
    if (!m) return false;

    const glyphs = m[1];
    const label = m[2].toLowerCase();

    let mode: string = "default";
    if (glyphs === "\u23F5\u23F5" || label.includes("bypass")) mode = "bypassPermissions";
    else if (label.includes("auto")) mode = "auto";
    else if (glyphs === "\u23F8" || label.includes("plan")) mode = "plan";
    else if (label.includes("accept")) mode = "acceptEdits";
    else if (label.includes("don")) mode = "dontAsk";

    const prevMode = next.mode;
    next.mode = mode;
    // Mark UI-ready so idle transitions only fire after a real mode line.
    (next.extra as Record<string, unknown>).uiReady = true;

    if (full) {
      const files = {
        count: parseInt(full[3], 10),
        added: parseInt(full[4], 10),
        removed: parseInt(full[5], 10),
      };
      (next.extra as Record<string, unknown>).files = files;
    }

    if (prevMode !== mode) {
      events.push({ kind: "mode.changed", data: { from: prevMode, to: mode } });
    }
    return true;
  }

  private parseActivity(clean: string, next: AgentState, events: ParserEvent[]): boolean {
    const m = clean.match(ACTIVITY_RE);
    if (!m) return false;

    const label = m[1];
    const raw = m[2];
    const stats = this.parseStats(raw);

    next.activity = {
      label,
      duration: stats.duration,
      tokens: stats.tokens,
    };

    if (stats.tokens) {
      const count = this.parseTokenCount(stats.tokens);
      if (!next.tokens) next.tokens = { used: 0 };
      if (count > next.tokens.used) next.tokens.used = count;
    }

    // Activity = cleared blocking
    if (next.blocking) delete next.blocking;

    events.push({ kind: "activity", data: { label, stats } });
    return true;
  }

  private parseResult(clean: string, next: AgentState, events: ParserEvent[]): boolean {
    const m = clean.match(RESULT_RE);
    if (!m) return false;

    const summary = m[1];
    const raw = m[2];
    const stats = this.parseStats(raw);

    if (stats.tokens) {
      const count = this.parseTokenCount(stats.tokens);
      if (!next.tokens) next.tokens = { used: 0 };
      if (count > next.tokens.used) next.tokens.used = count;
    }

    delete next.activity;
    events.push({ kind: "result", data: { summary, stats } });
    return true;
  }

  private parseMessage(
    clean: string,
    next: AgentState,
    events: ParserEvent[],
    messages: AssistantMessage[],
  ): boolean {
    if (MSG_START_RE.test(clean)) {
      // Finalize previous message if we were capturing
      if (this.scratch.capturingMessage && this.scratch.messageBuf.trim()) {
        const text = this.scratch.messageBuf.trim();
        next.lastMessage = text;
        messages.push({ text, ts: new Date().toISOString() });
        events.push({ kind: "message", data: { text } });
      }
      this.scratch.capturingMessage = true;
      // Extract text from ● up to the first status-frame terminator.
      // Claude re-renders its status line (spinner + mode) every ~100ms in the
      // same stream, so the message chunk often looks like:
      //   "● BANANA-OK   \r✢ Architecting…   \r   ⏵⏵ auto mode ..."
      // We want just "BANANA-OK". Terminators: carriage return (\r), or any
      // status/result/mode glyph (⎿ ✢ ✶ etc., ⏵ ⏸).
      const afterMarker = clean.replace(MSG_START_RE, "");
      const terminated = afterMarker.match(
        /^([^\r\u23BF\u23F5\u23F8\u2722\u2736\u273D\u273B\u2726\u2727\u2723\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]*)/,
      );
      const firstText = (terminated?.[1] ?? afterMarker).trim();
      this.scratch.messageBuf = firstText;

      // If the rest of the chunk contains a terminator, emit the message now.
      // The status-frame noise will be handled by the other parsers.
      const consumed = (terminated?.[1] ?? "").length;
      const remaining = afterMarker.slice(consumed);
      if (firstText && remaining.length > 0) {
        // In-chunk termination
        next.lastMessage = firstText;
        messages.push({ text: firstText, ts: new Date().toISOString() });
        events.push({ kind: "message", data: { text: firstText } });
        this.scratch.capturingMessage = false;
        this.scratch.messageBuf = "";
      }

      if (next.blocking) delete next.blocking;
      return true;
    }

    if (this.scratch.capturingMessage) {
      // End-of-message triggers: blank line or a new glyph marker
      if (clean === "" || /^[\u23BF\u2722\u2736\u23F5\u23F8\u25CF]/.test(clean)) {
        const text = this.scratch.messageBuf.trim();
        if (text) {
          next.lastMessage = text;
          messages.push({ text, ts: new Date().toISOString() });
          events.push({ kind: "message", data: { text } });
        }
        this.scratch.capturingMessage = false;
        this.scratch.messageBuf = "";
        return true;
      }
      this.scratch.messageBuf += "\n" + clean;
    }

    return false;
  }

  private parseBlocking(clean: string, next: AgentState, events: ParserEvent[]): boolean {
    let kind: BlockKind | null = null;
    if (TOOL_BLOCK_RE.test(clean)) kind = "tool-approval";
    else if (PLAN_BLOCK_RE.test(clean)) kind = "plan-approval";
    else if (CONFIRM_BLOCK_RE.test(clean)) kind = "confirmation";
    if (!kind) return false;

    next.blocking = { kind, prompt: clean.slice(0, 200) };
    next.status = "blocked";
    events.push({ kind: "blocked", data: { kind } });
    return true;
  }

  private parseTasks(clean: string, next: AgentState, events: ParserEvent[]): boolean {
    const lines = clean.split("\n");
    let foundAny = false;
    for (const line of lines) {
      const m = line.match(TASK_LINE_RE);
      if (!m) continue;
      foundAny = true;
      const glyph = m[1];
      const name = m[2].trim();
      let status: "pending" | "in_progress" | "completed" = "pending";
      if (glyph === "\u25FC") status = "in_progress";
      else if (glyph === "\u2714" || glyph === "\u2713" || glyph === "\u2611") status = "completed";
      this.scratch.tasks.set(name, status);
    }
    if (!foundAny) return false;

    const items = [...this.scratch.tasks.entries()].map(([name, status]) => ({ name, status }));
    const tasks = {
      total: items.length,
      completed: items.filter((t) => t.status === "completed").length,
      inProgress: items.filter((t) => t.status === "in_progress").length,
      pending: items.filter((t) => t.status === "pending").length,
      items,
    };
    (next.extra as Record<string, unknown>).tasks = tasks;
    events.push({ kind: "tasks", data: tasks });
    return true;
  }

  private parseModel(clean: string, next: AgentState, events: ParserEvent[]): boolean {
    const m = clean.match(MODEL_RE);
    if (!m) return false;
    const model = m[0].toLowerCase();
    if (model !== next.model) {
      const prev = next.model;
      next.model = model;
      events.push({ kind: "model.changed", data: { from: prev, to: model } });
      return true;
    }
    return false;
  }

  private parseContextRemaining(clean: string, next: AgentState): boolean {
    const m = clean.match(CONTEXT_RE);
    if (!m) return false;
    const pct = parseInt(m[1], 10);
    if (!next.tokens) next.tokens = { used: 0 };
    if (next.tokens.contextRemaining !== pct) {
      next.tokens.contextRemaining = pct;
      return true;
    }
    return false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private parseStats(raw: string): { duration?: string; tokens?: string; thought?: string; toolUses?: number } {
    const segments = raw.split("\u00b7").map((s) => s.trim());
    const out: { duration?: string; tokens?: string; thought?: string; toolUses?: number } = {};
    for (const seg of segments) {
      if (/^\d+\s+tool\s+uses?$/.test(seg)) out.toolUses = parseInt(seg, 10);
      else if (/tokens$/.test(seg)) out.tokens = seg;
      else if (/^thought\s+for\s+/.test(seg) || /thinking$/.test(seg)) out.thought = seg;
      else if (/^\d+[smh]$|^\d+m\s*\d+s$/.test(seg)) out.duration = seg;
    }
    return out;
  }

  private parseTokenCount(s: string): number {
    const m = s.match(/([\d.]+)(k?)\s*tokens/);
    if (!m) return 0;
    const val = parseFloat(m[1]);
    return m[2] === "k" ? val * 1000 : val;
  }
}
