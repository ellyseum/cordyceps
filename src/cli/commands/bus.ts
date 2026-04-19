import { connect } from "../client.js";

export async function runBus(args: string[]): Promise<number> {
  const prefix = args[0] ?? "";
  const client = await connect();
  try {
    const result = await client.call<Record<string, unknown>>("bus.getByPrefix", { prefix });
    const keys = Object.keys(result).sort();
    if (keys.length === 0) {
      process.stdout.write(`(no bus entries${prefix ? ` with prefix "${prefix}"` : ""})\n`);
      return 0;
    }
    for (const k of keys) {
      const v = result[k];
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      const truncated = s.length > 200 ? s.slice(0, 197) + "..." : s;
      process.stdout.write(`${k.padEnd(40)}  ${truncated}\n`);
    }
    return 0;
  } finally {
    client.close();
  }
}
