/**
 * Claude Code TUI catalogue — key sequences, output patterns, mode vocabulary.
 *
 * Derived empirically from `--tui-capture` sessions against Claude Code 2.x.
 * When Claude ships a new TUI variant, the fix is here: update a regex or add
 * a key sequence, rebuild, tests pass, driver keeps working.
 *
 * Ported from claudio/src/tui-sequences.ts with updates for Claude Code 2.1.x
 * (6-mode permission surface, updated glyph set).
 */

export const CLAUDE_TUI = {
  /** Raw byte sequences to write into the PTY */
  keys: {
    arrowDown: "\x1b[B",
    arrowUp: "\x1b[A",
    arrowRight: "\x1b[C",
    arrowLeft: "\x1b[D",
    enter: "\r",
    escape: "\x1b",
    shiftTab: "\x1b[Z",
    ctrlU: "\x15",
    ctrlC: "\x03",
    ctrlK: "\x0b",
    tab: "\t",
    backspace: "\x7f",
  },

  /** Regex patterns matched against stripped-ANSI output */
  patterns: {
    /** Inverse video selection (Claude model/mode pickers): \x1b[7m ... \x1b[27m */
    selectedItem: /\x1b\[7m(.+?)\x1b\[(?:27m|0m)/,

    /** Model name as it appears in status / pickers */
    modelName: /(?:claude-)?(?:opus|sonnet|haiku)[\s-][\d.]+/i,

    /** Model picker visible */
    modelPickerOpen: /(?:Select a model|Model:)/i,

    /** Thinking level indicator */
    thinkingLevel: /thinking:\s*(\d+|off|extended)/i,

    /** Permission mode line glyphs (Claude Code 2.x shows one of these) */
    modeBypass: /\u23F5\u23F5\s+bypass/i,
    modePlan: /\u23F8.*plan/i,
    modeAcceptEdits: /\u23F5\s+accept/i,
    modeDefault: /\u23F5\s+default/i,
    modeAuto: /\u23F5\u23F5\s+auto/i,
    modeDontAsk: /\u23F5\s+don['\u2019]t\s+ask/i,

    /** Prompt ready: cursor parked at `❯` */
    promptReady: /\u276F\s*$/m,

    /** Spinner (any of these glyphs + trailing space) */
    spinnerActive: /[\u2722\u2736\u273D\u273B\u2726\u2727\u2723\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F\u28BE\u28BD\u28BB\u28BF\u28FF\u28DF\u28EF\u28F7]\s+/,

    /** Result line marker */
    resultDone: /\u23BF\s+Done\s*\(/,

    /** Blocking prompts */
    toolApproval: /(?:Allow|Approve).*\?\s*\(?[yYnN]/,
    planApproval: /plan\b.*\bapprove|exit plan mode|ExitPlanMode/i,
    confirmPrompt: /Do you want to proceed|Are you sure|Continue\?/i,

    /** Context-remaining indicator: "Context left until auto-compact: NN%" */
    contextRemaining: /Context left until auto-compact:\s*(\d+)%/,
  },

  /** Glyph markers driving the parser state machine */
  glyphs: {
    /** ● — assistant message start */
    message: "\u25CF",
    /** ⎿ — tool/agent result */
    result: "\u23BF",
    /** ⏵ — mode indicator */
    modeMarker: "\u23F5",
    /** ⏸ — paused (plan mode) */
    modePaused: "\u23F8",
    /** ❯ — prompt ready */
    promptReady: "\u276F",
  },

  /**
   * Six permission modes accepted by `claude --permission-mode <mode>`
   * (verified against Claude Code 2.1.114 `--help`).
   * Prefer spawning with one of these values; runtime Shift+Tab cycling is
   * best-effort and derived from parser state, not a hardcoded sequence.
   */
  permissionModes: [
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "default",
    "dontAsk",
    "plan",
  ] as const,

  /** Model name normalization (user spelling → canonical matches in TUI output) */
  modelAliases: new Map<string, string[]>([
    ["opus", ["opus", "claude-opus"]],
    ["sonnet", ["sonnet", "claude-sonnet"]],
    ["haiku", ["haiku", "claude-haiku"]],
  ]),
} as const;

export type ClaudePermissionMode = typeof CLAUDE_TUI.permissionModes[number];
