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

    // Stream message + exited events so the user sees progress live.
    await client.subscribe(["agent.message", "agent.exited"]);

    let exited = false;
    client.on("agent.message", (params) => {
      const p = params as { agentId: string; message: { text: string } };
      if (p.agentId !== id) return;
      process.stdout.write(`\n[${id}] ${p.message.text}\n`);
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

    // Block until agent exits. No hard timeout — manager sessions can be long.
    while (!exited) {
      await new Promise((r) => setTimeout(r, 500));
    }
    process.off("SIGINT", onSig);

    return 0;
  } finally {
    client.close();
  }
}
