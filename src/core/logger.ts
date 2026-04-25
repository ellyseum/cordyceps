/**
 * Logger — append-only, rotating file log.
 *
 * File: ~/.cordyceps/logs/cordyceps.log (mode 0600)
 * Rotation: 5MB × 3 backups (.1 .2 .3)
 * Format: [ISO-ts] [LEVEL] [source] message
 *
 * Uses `appendFileSync` so a crash can't lose the last lines. Rotation is
 * lazy — checked on `initLogger` and on every 100th write.
 */

import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

const MAX_SIZE = 5 * 1024 * 1024;  // 5MB
const MAX_BACKUPS = 3;
const ROTATE_CHECK_INTERVAL = 100;  // check size every N writes

let logPath = "";
let initialized = false;
let writeCount = 0;

export interface Logger {
  debug(source: string, message: string): void;
  info(source: string, message: string): void;
  warn(source: string, message: string): void;
  error(source: string, message: string): void;
  fatal(source: string, message: string): void;
  log(level: LogLevel, source: string, message: string): void;
}

/** Initialize the file logger. Call once at daemon startup. */
export function initLogger(customPath?: string): void {
  logPath = customPath ?? join(homedir(), ".cordyceps", "logs", "cordyceps.log");
  const dir = logPath.slice(0, logPath.lastIndexOf("/"));

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Ensure 0700 even if dir already existed with looser perms
    try { chmodSync(dir, 0o700); } catch { /* ignore — may fail on some mounts */ }
  } catch { /* can't create — log calls will silently fail */ }

  rotate();
  initialized = true;
}

/** Write a formatted log line. No-op if not initialized. */
export function log(level: LogLevel, source: string, message: string): void {
  if (!initialized) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${source}] ${message}\n`;
  try {
    appendFileSync(logPath, line, { mode: 0o600 });
    // Best-effort chmod on the file itself (first write creates it)
    if (writeCount === 0) {
      try { chmodSync(logPath, 0o600); } catch { /* ignore */ }
    }
    writeCount++;
    if (writeCount % ROTATE_CHECK_INTERVAL === 0) rotate();
  } catch {
    // Logging must never crash the daemon.
  }
}

/** Convenience accessors. */
export const logger: Logger = {
  debug: (source, message) => log("DEBUG", source, message),
  info: (source, message) => log("INFO", source, message),
  warn: (source, message) => log("WARN", source, message),
  error: (source, message) => log("ERROR", source, message),
  fatal: (source, message) => log("FATAL", source, message),
  log,
};

/** Close the logger (no-op for sync writes; here for future async backends). */
export function closeLogger(): void {
  initialized = false;
}

/** Rotate if current log exceeds MAX_SIZE. */
function rotate(): void {
  if (!logPath) return;
  try {
    if (!existsSync(logPath)) return;
    const stat = statSync(logPath);
    if (stat.size < MAX_SIZE) return;

    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const from = `${logPath}.${i}`;
      const to = `${logPath}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(logPath, `${logPath}.1`);
  } catch {
    // Rotation failure is non-fatal.
  }
}
