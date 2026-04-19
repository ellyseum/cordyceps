import { connect } from "../client.js";

export async function runState(args: string[]): Promise<number> {
  if (args.length < 1) {
    process.stderr.write("Usage: cordy state <agent-id> [--json]\n");
    return 1;
  }
  const id = args[0];
  const json = args.includes("--json");
  const client = await connect();
  try {
    const state = await client.call<Record<string, unknown>>("agents.state", { id });
    if (json) {
      process.stdout.write(JSON.stringify(state, null, 2) + "\n");
    } else {
      for (const [k, v] of Object.entries(state)) {
        const s = typeof v === "object" ? JSON.stringify(v) : String(v);
        process.stdout.write(`${k.padEnd(20)} ${s}\n`);
      }
    }
    return 0;
  } finally {
    client.close();
  }
}
