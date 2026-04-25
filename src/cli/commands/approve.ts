import { connect } from "../client.js";

export async function runApprove(args: string[]): Promise<number> {
  if (args.length < 1) {
    process.stderr.write("Usage: cordy approve <agent-id>\n");
    return 1;
  }
  const client = await connect();
  try {
    await client.call("agents.approve", { id: args[0] });
    process.stdout.write(`Approved: ${args[0]}\n`);
    return 0;
  } finally {
    client.close();
  }
}

export async function runReject(args: string[]): Promise<number> {
  if (args.length < 1) {
    process.stderr.write("Usage: cordy reject <agent-id>\n");
    return 1;
  }
  const client = await connect();
  try {
    await client.call("agents.reject", { id: args[0] });
    process.stdout.write(`Rejected: ${args[0]}\n`);
    return 0;
  } finally {
    client.close();
  }
}
