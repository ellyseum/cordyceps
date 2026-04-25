/**
 * ClaudeControl — high-level operations for the Claude driver.
 *
 * Each method is a small script: clear input, type, enter, wait for state
 * to transition. Timing constants are calibrated against Claude Code 2.x.
 *
 * Permission-mode handling uses `switchMode` (runtime Shift+Tab); prefer
 * `--permission-mode` at spawn time where possible (six valid values — see
 * CLAUDE_TUI.permissionModes).
 */

import type { AgentState } from "../../agents/types.js";
import type { ControlContext, DriverControl } from "../api.js";
import { CLAUDE_TUI } from "./tui.js";

const SETTLE_MS = 150;
const CLEAR_WAIT_MS = 100;
const TYPE_WAIT_MS = 150;
const MODE_WAIT_MS = 200;
/** Extra wait after `starting → idle` to let banner redraws settle. Without
 *  this, the first Ctrl+U can race with the banner render and get lost. */
const FIRST_IDLE_SETTLE_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIdle(state: AgentState): boolean {
  return state.status === "idle";
}

export class ClaudeControl implements DriverControl {
  async waitForReady(ctx: ControlContext, timeoutMs: number): Promise<void> {
    if (isIdle(ctx.state)) return;
    await ctx.bus.waitFor(
      `agent.${ctx.agentId}.state`,
      (data) => {
        const s = data as AgentState | undefined;
        return !!s && isIdle(s);
      },
      timeoutMs,
    );
  }

  async submit(ctx: ControlContext, text: string): Promise<void> {
    // Ensure the TUI is actually ready — otherwise keystrokes land in the
    // welcome banner and get discarded.
    const wasStarting = ctx.state.status === "starting";
    await this.waitForReady(ctx, 10_000);
    // First idle after starting needs extra settle time — the banner may still
    // be redrawing right after `❯` first appears.
    if (wasStarting) await sleep(FIRST_IDLE_SETTLE_MS);
    // Clear input line so any partial text is gone
    ctx.write(CLAUDE_TUI.keys.ctrlU);
    await sleep(CLEAR_WAIT_MS);
    // Type prompt
    ctx.write(text);
    await sleep(TYPE_WAIT_MS);
    // Submit
    ctx.write(CLAUDE_TUI.keys.enter);
    // Caller is expected to wait for a message; we don't block here.
  }

  async interrupt(ctx: ControlContext): Promise<void> {
    ctx.write(CLAUDE_TUI.keys.escape);
    // Wait briefly for the interrupt to land
    await sleep(SETTLE_MS);
  }

  async approve(ctx: ControlContext): Promise<void> {
    const kind = ctx.state.blocking?.kind;
    if (!kind) {
      throw new Error(`approve() called but agent is not blocked (status=${ctx.state.status})`);
    }
    ctx.write("y");
    ctx.write(CLAUDE_TUI.keys.enter);
    await sleep(SETTLE_MS);
  }

  async reject(ctx: ControlContext): Promise<void> {
    const kind = ctx.state.blocking?.kind;
    if (!kind) {
      throw new Error(`reject() called but agent is not blocked (status=${ctx.state.status})`);
    }
    ctx.write("n");
    ctx.write(CLAUDE_TUI.keys.enter);
    await sleep(SETTLE_MS);
  }

  /**
   * Switch model via the `/model` slash command.
   * Best-effort — may fail if the picker UI changes across releases.
   * Prefer setting `--model <name>` at spawn time when possible.
   */
  async switchModel(ctx: ControlContext, model: string): Promise<void> {
    const normalized = model.toLowerCase().replace(/^claude[-\s]?/, "");

    // Dismiss any current state + clear input
    ctx.write(CLAUDE_TUI.keys.escape);
    ctx.write(CLAUDE_TUI.keys.ctrlU);
    await sleep(MODE_WAIT_MS);

    // Open picker
    ctx.write("/model");
    ctx.write(CLAUDE_TUI.keys.enter);

    // Wait for picker to render (short — if it doesn't show, we proceed anyway)
    try {
      await ctx.bus.waitFor(
        `agent.${ctx.agentId}.output`,
        (data) => /model|select|opus|sonnet|haiku/i.test(String(data ?? "")),
        3000,
      );
    } catch {
      // No picker visible — try direct type anyway
    }

    // Type filter + confirm
    ctx.write(normalized);
    await sleep(MODE_WAIT_MS + 100);
    ctx.write(CLAUDE_TUI.keys.enter);
    await sleep(MODE_WAIT_MS);
  }

  /**
   * Switch permission mode via Shift+Tab cycling.
   *
   * Cycle order is driver-derived — we press Shift+Tab, watch for a mode
   * change via the parser's `mode.changed` event, and stop when we hit
   * `target` or press 6 times (one full cycle).
   *
   * NOTE: prefer `--permission-mode <mode>` at spawn time.
   */
  async switchMode(ctx: ControlContext, target: string): Promise<void> {
    if (!CLAUDE_TUI.permissionModes.includes(target as never)) {
      throw new Error(
        `Invalid mode "${target}". Valid: ${CLAUDE_TUI.permissionModes.join(", ")}`,
      );
    }
    if (ctx.state.mode === target) return;

    const maxPresses = CLAUDE_TUI.permissionModes.length;
    for (let i = 0; i < maxPresses; i++) {
      ctx.write(CLAUDE_TUI.keys.shiftTab);
      // Wait up to 2s for a mode change
      try {
        await ctx.bus.waitFor<{ from: unknown; to: unknown }>(
          `agent.${ctx.agentId}.mode.changed`,
          undefined,
          2000,
        );
      } catch {
        // No change detected — continue
      }
      if (ctx.state.mode === target) return;
    }
    // If we're here, we didn't hit the target. Leave it as best-effort.
  }

  async quit(ctx: ControlContext): Promise<void> {
    ctx.write("/exit");
    ctx.write(CLAUDE_TUI.keys.enter);
    // Don't wait — caller handles exit via PTY exit event
  }
}
