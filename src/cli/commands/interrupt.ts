import { connect } from "../client.js";

export async function runInterrupt(args: string[]): Promise<number> {
  if (args.length < 1) {
    process.stderr.write("Usage: cordy interrupt <agent-id>\n");
    return 1;
  }
  const client = await connect();
  try {
    await client.call("agents.interrupt", { id: args[0] });
    process.stdout.write(`Interrupted: ${args[0]}\n`);
    return 0;
  } finally {
    client.close();
  }
}
