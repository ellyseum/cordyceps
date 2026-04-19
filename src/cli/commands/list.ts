import { connect } from "../client.js";

export async function runList(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const client = await connect();
  try {
    const list = await client.call<Array<{ id: string; driverId: string; mode: string; cwd: string; status: string }>>("agents.list");
    if (json) {
      process.stdout.write(JSON.stringify(list, null, 2) + "\n");
      return 0;
    }
    if (list.length === 0) {
      process.stdout.write("(no agents)\n");
      return 0;
    }
    for (const a of list) {
      process.stdout.write(`${a.id.padEnd(24)}  ${a.driverId.padEnd(14)}  ${a.mode.padEnd(8)}  ${a.status.padEnd(10)}  ${a.cwd}\n`);
    }
    return 0;
  } finally {
    client.close();
  }
}
