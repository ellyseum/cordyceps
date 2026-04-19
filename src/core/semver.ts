/**
 * Minimal semver + range helper — just enough for driver compat checks.
 *
 * Supports:
 *   - versions: "X.Y.Z" (pre-release tags ignored: "X.Y.Z-rc.1" → X.Y.Z)
 *   - range operators: ">=", ">", "<=", "<", "="
 *   - multi-term range: ">=2.1.100 <2.2.0"
 *
 * Does NOT support caret (^), tilde (~), `||`, or exotic qualifiers.
 * That's deliberate — simple is better here. Drivers can always use a custom
 * probe-level check for anything weird.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(v: string): ParsedVersion | null {
  // Anchored on both ends; optional pre-release (`-rc.1`, `-beta2`) and
  // build-metadata (`+sha.abc`) suffixes are allowed but ignored.
  // Without the `$` anchor, `2.1.114junk` was being accepted (council flagged).
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Check if `version` satisfies `range`.
 * Range is space-separated terms, all of which must match.
 * Returns false on any parse failure.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;

  const terms = range.trim().split(/\s+/).filter(Boolean);
  // Empty/whitespace-only range used to satisfy everything (council flagged).
  // Treat as malformed — callers who want "any" should pass undefined to gradeCompat.
  if (terms.length === 0) return false;
  for (const term of terms) {
    // Term regex is anchored on both ends; no trailing slop like ">=1.2.3xxx".
    const m = term.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
    if (!m) return false;
    const op = m[1] || "=";
    const target = parseVersion(m[2]);
    if (!target) return false;
    const cmp = compareVersions(v, target);
    switch (op) {
      case ">=": if (cmp < 0) return false; break;
      case ">":  if (cmp <= 0) return false; break;
      case "<=": if (cmp > 0) return false; break;
      case "<":  if (cmp >= 0) return false; break;
      case "=":  if (cmp !== 0) return false; break;
    }
  }
  return true;
}

/**
 * Grade a version against a supportedVersions range.
 */
export function gradeCompat(
  detectedVersion: string | undefined,
  supportedRange: string | undefined,
): "supported" | "untested" | "unsupported" | "any" {
  if (!supportedRange) return "any";
  if (!detectedVersion) return "untested";
  // If we have both a detected version AND a declared range, a mismatch is
  // *unsupported*, not untested. Previously returned "untested" regardless
  // (council flagged: made the "unsupported" return path unreachable).
  return satisfies(detectedVersion, supportedRange) ? "supported" : "unsupported";
}
