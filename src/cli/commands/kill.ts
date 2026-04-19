import { connect } from "../client.js";

export async function runKill(args: string[]): Promise<number> {
  if (args.length < 1) {
    process.stderr.write("Usage: cordy kill <agent-id>\n");
    return 1;
  }
  const client = await connect();
  try {
    await client.call("agents.kill", { id: args[0] });
    process.stdout.write(`Killed: ${args[0]}\n`);
    return 0;
  } finally {
    client.close();
  }
}
