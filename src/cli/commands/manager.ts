/**
 * `cordy manager [options] <task>` — spin up a cordy-manager agent and
 * stream its work.
 *
 * Thin client wrapper around the `manager.spawn` RPC method (registered by
 * the manager plugin). Subscribes to the new agent's output + message events
 * and prints them to the user's terminal as the manager does its thing.
 */

import { connect } from "../client.js";

interface ManagerSpawnResult {
  id: string;
}

export async function runManager(args: string[]): Promise<number> {
  let driverId = "claude";
  let model: string | undefined;
  let name: string | undefined;
  const taskParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--driver" || a === "-d") && args[i + 1]) { driverId = args[++i]; }
    else if ((a === "--model" || a === "-m") && args[i + 1]) { model = args[++i]; }
    else if ((a === "--name" || a === "-n") && args[i + 1]) { name = args[++i]; }
    else taskParts.push(a);
  }
  const task = taskParts.join(" ").trim();
  if (!task) {
    process.stderr.write("Usage: cordy manager [--driver X] [--model M] [--name N] <task>\n");
    return 1;
  }

  const client = await connect();
  try {
    process.stdout.write(`Starting cordy-manager (driver=${driverId})...\n`);
    const { id } = await client.call<ManagerSpawnResult>("manager.spawn", {
      driverId, task, model, name,
    });
    process.stdout.write(`Manager agent: ${id}\n\n`);

    // Stream message + state + exited events so the user sees progress live
    // and we can return as soon as the task is done (without killing the
    // agent's PTY — future multi-turn use cases will want it alive).
    await client.subscribe(["agent.message", "agent.state", "agent.exited"]);

    let exited = false;
    let taskDone = false;
    let sawBusy = false;
    let gotMessage = false;
    let currentStatus = "unknown";
    let lastActivityAt = Date.now();
    let lastPrinted = "";        // dedup: the exact text we last printed
    let lastPrintedAt = 0;

    client.on("agent.message", (params) => {
      const p = params as { agentId: string; message: { text: string; ts?: string } };
      if (p.agentId !== id) return;
      const text = p.message.text;
      // Dedup against the last-printed text within a short window — the Claude
      // PTY parser occasionally emits the same message twice under heavy
      // status-redraw pressure. Rather than guard with (text, ts), which
      // leaks through because timestamps differ, key on text with a short
      // collision window so genuinely-repeat-questions like "4. 4." still land.
      const now = Date.now();
      if (text === lastPrinted && now - lastPrintedAt < 5_000) return;
      lastPrinted = text;
      lastPrintedAt = now;
      gotMessage = true;
      lastActivityAt = now;
      process.stdout.write(`\n[${id}] ${text}\n`);
      // If status is already idle when the message lands (fast response, no
      // spinner), flag done right here — no state transition will follow.
      if (currentStatus === "idle") taskDone = true;
    });

    client.on("agent.state", (params) => {
      const p = params as { agentId: string; state: { status: string } };
      if (p.agentId !== id) return;
      currentStatus = p.state.status;
      if (p.state.status === "busy") sawBusy = true;
      // Primary signal: busy→idle after a message landed
      if (sawBusy && p.state.status === "idle") taskDone = true;
      // Fallback: fast replies can skip the spinner entirely (no busy state
      // ever fires). Treat "any message observed + currently idle" as done.
      if (gotMessage && p.state.status === "idle") taskDone = true;
    });

    client.on("agent.exited", (params) => {
      const p = params as { agentId: string; code: number };
      if (p.agentId !== id) return;
      exited = true;
      process.stdout.write(`\n[${id}] exited (code ${p.code})\n`);
    });

    // Handle Ctrl+C gracefully — kill the manager before returning
    const onSig = async () => {
      try { await client.call("agents.kill", { id }); } catch { /* ignore */ }
      process.exit(130);
    };
    process.on("SIGINT", onSig);

    // Return when the task is done (busy→idle) OR the agent exits. We leave
    // the manager agent alive by default — users can chain more work against
    // the same session via `cordy send ${id} "..."`. `cordy kill ${id}` tears
    // it down explicitly.
    while (!taskDone && !exited) {
      await new Promise((r) => setTimeout(r, 250));
    }
    process.off("SIGINT", onSig);

    if (taskDone && !exited) {
      process.stdout.write(`\n[${id}] task complete — agent still alive. Use \`cordy send ${id} "..."\` to continue, \`cordy kill ${id}\` to tear down.\n`);
    }

    return 0;
  } finally {
    client.close();
  }
}
