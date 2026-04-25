// Minimal example: connect to a running cordy daemon, spawn a Claude
// agent, submit a prompt, print the response, tear down.
//
// Prereqs:
//   1. cordy installed (npm i -g @ellyseum/cordyceps)
//   2. claude CLI installed and authenticated
//   3. cordy daemon running (cordy daemon start)
//
// Run: node examples/basic-agent/index.mjs

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";

// ── 1. Discover the running daemon ───────────────────────────────────────
const instancesDir = join(homedir(), ".cordyceps", "instances");
if (!existsSync(instancesDir)) {
  throw new Error("no daemon running — run `cordy daemon start`");
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const files = readdirSync(instancesDir).filter((f) => f.endsWith(".json"));
const instances = files
  .map((f) => {
    try { return JSON.parse(readFileSync(join(instancesDir, f), "utf8")); }
    catch { return null; }
  })
  .filter((r) => r && isAlive(r.pid));
if (instances.length === 0) {
  throw new Error("no daemon running — run `cordy daemon start`");
}
instances.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
const inst = instances[0];

console.log(`→ daemon ${inst.url} (pid ${inst.pid}, version ${inst.version})`);

// ── 2. Open a JSON-RPC client over the WS ───────────────────────────────
const ws = new WebSocket(inst.url, {
  headers: { Authorization: `Bearer ${inst.token}` },
});

let nextId = 1;
const pending = new Map();

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(msg.error) : resolve(msg.result);
  } else if (msg.method === "agent.message") {
    // live-tail: print message events as they arrive
    const text = msg.params?.message?.text;
    if (text) console.log(`← ${text}`);
  }
});

await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

// ── 3. Spawn an agent, submit a prompt, kill ────────────────────────────
try {
  const info = await call("agents.spawn", {
    driverId: "claude-code",
    id: "demo",
    cwd: process.cwd(),
    profile: { mode: "exec" },   // exec is faster + cleaner than PTY for one-shot
  });
  console.log(`→ spawned ${info.id} (${info.driverId} ${info.mode})`);

  const result = await call("agents.submit", {
    id: "demo",
    prompt: "respond with just the word: pong",
    timeoutMs: 30_000,
  });
  console.log(`→ final transcript: ${JSON.stringify(result, null, 2)}`);

  await call("agents.kill", { id: "demo" });
  console.log(`→ killed`);
} finally {
  ws.close();
}
