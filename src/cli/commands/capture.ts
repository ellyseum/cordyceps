/**
 * `cordy capture <agent-id> [--out PATH] [--duration SECONDS]`
 *
 * Subscribes to `agent.output` + `agent.state` for a running agent and writes
 * them as JSONL to `.cordyceps/captures/<agent-id>-<ts>.jsonl`. Intended for
 * generating regression fixtures.
 *
 * Fixture line format (one per PTY chunk or state change):
 *   { kind: "output",  t: <ms since start>, len: <bytes>, hex: <hex>, printable: <redacted> }
 *   { kind: "state",   t: <ms>, state: AgentState }
 *   { kind: "message", t: <ms>, message: AssistantMessage }
 *   { kind: "meta",    driver: <id>, driverVersion: <ver>, supportedVersions: <range>, capturedAt: <iso> }
 */

import { mkdirSync, writeFileSync, appendFileSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect } from "../client.js";

export async function runCapture(args: string[]): Promise<number> {
  if (args.length < 1) {
    process.stderr.write("Usage: cordy capture <agent-id> [--out PATH] [--duration SECONDS]\n");
    return 1;
  }

  const id = args[0];
  let outPath: string | undefined;
  let durationSec = 60;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) outPath = args[++i];
    else if (args[i] === "--duration" && args[i + 1]) durationSec = parseInt(args[++i], 10) || 60;
  }

  const client = await connect();
  try {
    const agent = await client.call<{
      id: string;
      driverId: string;
      mode: string;
      cwd: string;
    }>("agents.get", { id });

    const drivers = await client.call<Array<{
      id: string;
      version: string;
      supportedVersions?: string | null;
      probe?: { version?: string };
    }>>("drivers.list");
    const driver = drivers.find((d) => d.id === agent.driverId);

    const path = outPath ?? defaultCapturePath(agent.cwd, id);
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Self-ignoring .cordyceps dir — never mutate the repo's .gitignore (decision #17)
    ensureSelfIgnore(agent.cwd);

    writeFileSync(path, "");
    try { chmodSync(path, 0o600); } catch { /* ignore */ }

    const start = Date.now();
    appendFileSync(path, JSON.stringify({
      kind: "meta",
      agentId: id,
      driver: agent.driverId,
      driverMode: agent.mode,
      driverVersion: driver?.version,
      cliVersion: driver?.probe?.version,
      supportedVersions: driver?.supportedVersions ?? null,
      cwd: agent.cwd,
      capturedAt: new Date().toISOString(),
    }) + "\n");

    process.stderr.write(`Capturing ${id} → ${path} for ${durationSec}s...\n`);

    await client.subscribe(["agent.output", "agent.state", "agent.message"]);

    client.on("agent.output", (params) => {
      const p = params as { agentId: string; data: string };
      if (p.agentId !== id) return;
      appendFileSync(path, JSON.stringify({
        kind: "output",
        t: Date.now() - start,
        len: p.data.length,
        hex: Buffer.from(p.data).toString("hex"),
        printable: toPrintable(p.data),
      }) + "\n");
    });

    client.on("agent.state", (params) => {
      const p = params as { agentId: string; state: unknown };
      if (p.agentId !== id) return;
      appendFileSync(path, JSON.stringify({
        kind: "state",
        t: Date.now() - start,
        state: p.state,
      }) + "\n");
    });

    client.on("agent.message", (params) => {
      const p = params as { agentId: string; message: unknown };
      if (p.agentId !== id) return;
      appendFileSync(path, JSON.stringify({
        kind: "message",
        t: Date.now() - start,
        message: p.message,
      }) + "\n");
    });

    // Honor SIGINT for early exit
    let stop = false;
    const onSig = () => { stop = true; };
    process.on("SIGINT", onSig);
    const endAt = start + durationSec * 1000;
    while (!stop && Date.now() < endAt) {
      await new Promise((r) => setTimeout(r, 250));
    }
    process.off("SIGINT", onSig);

    const ms = Date.now() - start;
    process.stderr.write(`Captured ${ms}ms → ${path}\n`);
    return 0;
  } finally {
    client.close();
  }
}

function defaultCapturePath(cwd: string, agentId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return resolve(join(cwd, ".cordyceps", "captures", `${agentId}-${stamp}.jsonl`));
}

function ensureSelfIgnore(cwd: string): void {
  const dir = resolve(join(cwd, ".cordyceps"));
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) {
    try { writeFileSync(gi, "*\n"); } catch { /* ignore */ }
  }
}

function toPrintable(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]/g, "⟨CSI⟩")
    .replace(/\x1b\][^\x07]*\x07/g, "⟨OSC⟩")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `⟨${c.charCodeAt(0).toString(16)}⟩`);
}
