/**
 * Single source of truth for the package version.
 *
 * Reads from package.json at module load. Layout invariant: this file lives at
 * `<root>/src/core/version.ts` and `<root>/dist/core/version.js` — both two
 * directories up from the package root, so the same relative path works for
 * source and built artifacts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "..", "package.json"), "utf8"),
) as { version: string };

export const VERSION: string = pkg.version;
