#!/usr/bin/env node
/**
 * Spawn Claude, wait for idle, send a prompt, capture everything.
 */

import { startEngine } from "../dist/cli/engine.js";
import { writeFileSync, appendFileSync } from "node:fs";

const engine = await startEngine();

const OUT = "/tmp/claude-capture.jsonl";
writeFileSync(OUT, "");

const start = Date.now();

function log(entry) {
  entry.t = Date.now() - start;
  appendFileSync(OUT, JSON.stringify(entry) + "\n");
  return entry;
}

engine.bus.on("agent.cc.output", (data) => {
  const s = String(data);
  const printable = s
    .replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, "⟨CSI⟩")
    .replace(/\x1b\][^\x07]*\x07/g, "⟨OSC⟩")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `⟨${c.charCodeAt(0).toString(16)}⟩`);
  log({ kind: "output", len: s.length, hex: Buffer.from(s).toString("hex"), printable });
  process.stderr.write(`[+${String(Date.now() - start).padStart(6)}ms out ${String(s.length).padStart(5)}B] ${printable.slice(0, 100)}\n`);
});

engine.bus.on("agent.cc.state", (state) => {
  log({ kind: "state", state });
  process.stderr.write(`[+${String(Date.now() - start).padStart(6)}ms STATE] ${JSON.stringify(state)}\n`);
});

engine.bus.on("agent.cc.message", (m) => {
  log({ kind: "message", message: m });
  process.stderr.write(`[+${String(Date.now() - start).padStart(6)}ms MSG]   ${JSON.stringify(m).slice(0, 200)}\n`);
});

console.error("spawning claude (cc)");
const agent = await engine.manager.spawn("claude", {
  id: "cc",
  profile: {
    env: { TERM: "xterm-256color", COLUMNS: "120", LINES: "40", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
  },
});

// Wait 8s for Claude to fully render its UI
console.error("waiting 8s for UI...");
await new Promise(r => setTimeout(r, 8000));

console.error("\n=== SENDING PROMPT ===\n");
log({ kind: "action", action: "write-prompt" });

// Write prompt char-by-char via rawWrite to see exactly what happens
agent.rawWrite("\x15");  // Ctrl+U
await new Promise(r => setTimeout(r, 200));
agent.rawWrite("respond with exactly: BANANA-OK");
await new Promise(r => setTimeout(r, 500));
agent.rawWrite("\r");  // Enter

console.error("\n=== WAITING 25s for response ===\n");
await new Promise(r => setTimeout(r, 25_000));

console.error(`\nfinal state: ${JSON.stringify(agent.state)}`);
console.error(`transcript length: ${agent.transcript.length}`);

await agent.kill();
await engine.stop();
process.exit(0);
