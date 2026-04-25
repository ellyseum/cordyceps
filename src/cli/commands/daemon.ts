/**
 * `cordy daemon` — lifecycle management.
 *
 * `start` forks a detached cordyceps engine. `stop` reads the latest
 * instance and sends SIGTERM. `status` lists alive instances. `logs`
 * tails ~/.cordyceps/logs/cordyceps.log.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, openSync, readFileSync, watch, statSync, openSync as openSyncRead, readSync, closeSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { findLatestInstance, listInstances, isPidAlive, ensureInstanceDir } from "../../daemon/instances.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_RUNNER = join(__dirname, "engine-runner.js");
const LOG_PATH = join(homedir(), ".cordyceps", "logs", "cordyceps.log");

function pollUntil(check: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export async function handleDaemonCommand(args: string[]): Promise<number> {
  const verb = args[0] ?? "status";
  const rest = args.slice(1);

  switch (verb) {
    case "start":   return start(rest);
    case "stop":    return stop();
    case "status":  return status();
    case "restart": return restart(rest);
    case "logs":    return logs(rest);
    default:
      process.stderr.write(`Unknown daemon command: ${verb}\n`);
      process.stderr.write("Usage: cordy daemon [start|stop|status|restart|logs]\n");
      return 1;
  }
}

async function start(args: string[]): Promise<number> {
  ensureInstanceDir();

  // Already running?
  const existing = findLatestInstance();
  if (existing) {
    process.stderr.write(`Daemon already running (PID ${existing.pid}, ${existing.url}).\n`);
    return 1;
  }

  // Build forwarded args. Audit defaults to off; --audit / --audit-dir opt in.
  const forwardedArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) {
      forwardedArgs.push("--port", args[++i]);
    } else if (a === "--audit") {
      forwardedArgs.push("--audit");
    } else if (a === "--audit-dir" && args[i + 1]) {
      forwardedArgs.push("--audit-dir", args[++i]);
    }
  }

  // Ensure log dir exists with 0700 before opening the log file
  const logDir = join(homedir(), ".cordyceps", "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  try { chmodSync(logDir, 0o700); } catch { /* ignore */ }

  // Open log fd for stdio inheritance
  const logFd = openSync(LOG_PATH, "a");

  const child = spawn(process.execPath, [ENGINE_RUNNER, ...forwardedArgs], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, CORDY_DAEMON: "1" },
  });

  const pid = child.pid;
  if (!pid) {
    process.stderr.write("Failed to fork daemon process.\n");
    return 1;
  }

  child.unref();

  process.stderr.write(`Daemon starting (PID ${pid})...\n`);

  // Poll for instance file with our PID
  const ready = await pollUntil(() => {
    const inst = listInstances().find((i) => i.pid === pid);
    return !!inst;
  }, 8_000, 100);

  if (!ready) {
    process.stderr.write(`Daemon forked (PID ${pid}) but didn't write instance file in 8s.\n`);
    process.stderr.write(`Check logs: cordy daemon logs\n`);
    return 1;
  }

  const inst = listInstances().find((i) => i.pid === pid)!;
  process.stderr.write(`Daemon ready.\n`);
  process.stderr.write(`  URL:   ${inst.url}\n`);
  process.stderr.write(`  PID:   ${inst.pid}\n`);
  process.stderr.write(`  Token: ${inst.token}\n`);
  process.stderr.write(`  Log:   ${LOG_PATH}\n`);
  return 0;
}

async function stop(): Promise<number> {
  const inst = findLatestInstance();
  if (!inst) {
    process.stderr.write("No daemon running.\n");
    return 0;
  }
  process.stderr.write(`Stopping daemon (PID ${inst.pid})...\n`);
  try { process.kill(inst.pid, "SIGTERM"); } catch { /* already gone */ }
  const dead = await pollUntil(() => !isPidAlive(inst.pid), 8_000, 200);
  if (!dead) {
    process.stderr.write("Did not stop within 8s, sending SIGKILL...\n");
    try { process.kill(inst.pid, "SIGKILL"); } catch { /* already dead */ }
  }
  process.stderr.write("Daemon stopped.\n");
  return 0;
}

async function status(): Promise<number> {
  const records = listInstances();
  if (records.length === 0) {
    process.stderr.write("No daemon running.\n");
    return 1;
  }
  for (const r of records) {
    process.stderr.write(`PID ${r.pid}  ${r.url}  (started ${r.startedAt}, version ${r.version})\n`);
  }
  return 0;
}

async function restart(args: string[]): Promise<number> {
  const code = await stop();
  if (code !== 0) return code;
  await new Promise((r) => setTimeout(r, 500));
  return start(args);
}

async function logs(args: string[]): Promise<number> {
  const follow = args.includes("-f") || args.includes("--follow");

  if (!existsSync(LOG_PATH)) {
    process.stderr.write(`No log file at ${LOG_PATH}\n`);
    return 1;
  }

  let content: string;
  try {
    content = readFileSync(LOG_PATH, "utf-8");
  } catch (err) {
    process.stderr.write(`Failed to read log: ${(err as Error).message}\n`);
    return 1;
  }

  if (!follow) {
    const lines = content.split("\n");
    process.stdout.write(lines.slice(-100).join("\n"));
    if (!content.endsWith("\n")) process.stdout.write("\n");
    return 0;
  }

  process.stdout.write(content);
  let position = Buffer.byteLength(content, "utf-8");

  return new Promise((resolve) => {
    const watcher = watch(LOG_PATH, () => {
      try {
        const stat = statSync(LOG_PATH);
        if (stat.size > position) {
          const fd = openSyncRead(LOG_PATH, "r");
          const buf = Buffer.alloc(stat.size - position);
          readSync(fd, buf, 0, buf.length, position);
          closeSync(fd);
          process.stdout.write(buf.toString("utf-8"));
          position = stat.size;
        }
      } catch {
        // File may have been rotated
      }
    });
    process.on("SIGINT", () => {
      watcher.close();
      resolve(0);
    });
  });
}
