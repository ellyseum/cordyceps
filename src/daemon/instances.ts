/**
 * Instance discovery — `~/.cordyceps/instances/{pid}.json`.
 *
 * Per the security posture (§12 of plan):
 *   - `~/.cordyceps/` and `instances/` created with mode 0700
 *   - Instance files written with mode 0600
 *   - Atomic writes (tmp + rename) so external readers never see partial tokens
 *   - On daemon stop, instance file is unlinked
 *   - Stale entries (PID no longer alive) cleaned up on read
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, renameSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CORDYCEPS_DIR = join(homedir(), ".cordyceps");
const INSTANCES_DIR = join(CORDYCEPS_DIR, "instances");

export interface InstanceRecord {
  pid: number;
  url: string;
  token: string;
  port: number;
  startedAt: string;
  version: string;
}

export function instancesDir(): string {
  return INSTANCES_DIR;
}

/** Ensure ~/.cordyceps/ and instances/ exist with 0700 mode. */
export function ensureInstanceDir(): void {
  for (const dir of [CORDYCEPS_DIR, INSTANCES_DIR]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* may fail on some FS — non-fatal */ }
  }
}

/** Write our instance record atomically. Returns the path written. */
export function writeInstance(record: InstanceRecord): string {
  ensureInstanceDir();
  const path = join(INSTANCES_DIR, `${record.pid}.json`);
  const tmp = `${path}.tmp.${process.pid}`;

  writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
  renameSync(tmp, path);
  return path;
}

/** Remove our instance record. */
export function removeInstance(pid: number = process.pid): void {
  const path = join(INSTANCES_DIR, `${pid}.json`);
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** Check if a PID is alive (signal 0 = liveness probe). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read all instance records. Cleans up stale ones (dead PIDs) along the way. */
export function listInstances(): InstanceRecord[] {
  if (!existsSync(INSTANCES_DIR)) return [];
  const out: InstanceRecord[] = [];
  let files: string[];
  try { files = readdirSync(INSTANCES_DIR); } catch { return []; }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(INSTANCES_DIR, file);
    try {
      const raw = readFileSync(path, "utf-8");
      const record = JSON.parse(raw) as InstanceRecord;
      if (!isPidAlive(record.pid)) {
        try { unlinkSync(path); } catch { /* ignore */ }
        continue;
      }
      out.push(record);
    } catch {
      // Corrupt file — clean up
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  }
  return out;
}

/** Find the most-recently-started alive instance. */
export function findLatestInstance(): InstanceRecord | null {
  const records = listInstances();
  if (records.length === 0) return null;
  records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return records[0];
}
