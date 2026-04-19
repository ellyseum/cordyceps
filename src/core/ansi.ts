/**
 * ANSI escape-sequence handling.
 *
 * Three flavors:
 *   - `ansiToText`: cursor-forward (CSI <n>C) → n spaces, then strip other escapes.
 *     Preserves visual spacing. USE THIS for parser input — Claude uses cursor
 *     forward (`\x1b[1C`) instead of literal spaces between words like "Opus 4.7"
 *     in the status line, which causes plain `stripAnsi` to collapse "Opus4.7".
 *   - `stripAnsi`: strip all escapes, keep \n \r \t
 *   - `stripAnsiAll`: strip escapes AND all control chars (including whitespace)
 */

// Shared CSI matcher — handles private-mode markers (<=>?) and extended finals (a-z A-Z ~)
const CSI = /\x1b\[[0-9;?<>=!]*[a-zA-Z~]/g;
// OSC (Operating System Command) with either BEL or ESC\ terminator
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
// Charset / keypad / single-char ESC sequences
const CHARSET = /\x1b[()][A-Z0-9]/g;
const KEYPAD = /\x1b[=>]/g;
const SINGLE_ESC = /\x1b[78cDEHMNOZ]/g;

/**
 * Convert ANSI to plain text, substituting cursor-forward (CSI <n>C) with spaces
 * so that tokens separated by cursor movement stay separated.
 * USE THIS for parser input.
 */
export function ansiToText(s: string): string {
  return s
    // Cursor forward with count: \x1b[5C → 5 spaces (default 1 if omitted, cap at 120)
    .replace(/\x1b\[(\d*)C/g, (_m, n) => {
      const count = Math.max(1, Math.min(parseInt(n || "1", 10) || 1, 120));
      return " ".repeat(count);
    })
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(CHARSET, "")
    .replace(KEYPAD, "")
    .replace(SINGLE_ESC, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") // control chars (keep \n \r \t)
    .trim();
}

/** Strip ANSI escape sequences and non-printable control chars (keep \n, \r, \t). */
export function stripAnsi(s: string): string {
  return s
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(CHARSET, "")
    .replace(KEYPAD, "")
    .replace(SINGLE_ESC, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
}

/** Strip ANSI and ALL control chars (including \n, \r, \t). Useful for content detection. */
export function stripAnsiAll(s: string): string {
  return s
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(CHARSET, "")
    .replace(KEYPAD, "")
    .replace(SINGLE_ESC, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}
