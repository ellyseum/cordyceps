import { connect } from "../client.js";

export async function runDriversCmd(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const client = await connect();
  try {
    const drivers = await client.call<Array<{
      id: string;
      label: string;
      version: string;
      aliases: string[];
      modes: string[];
      probe: { available: boolean; version?: string; capabilities: Record<string, boolean>; warnings: string[]; supportedModes: string[] };
    }>>("drivers.list");

    if (json) {
      process.stdout.write(JSON.stringify(drivers, null, 2) + "\n");
      return 0;
    }

    if (drivers.length === 0) {
      process.stdout.write("(no drivers registered)\n");
      return 0;
    }

    for (const d of drivers) {
      const aliasList = d.aliases.length ? ` (aliases: ${d.aliases.join(", ")})` : "";
      process.stdout.write(`${d.id}${aliasList}\n`);
      process.stdout.write(`  label:    ${d.label}\n`);
      process.stdout.write(`  modes:    ${d.modes.join(", ")}\n`);
      if (d.probe) {
        process.stdout.write(`  probe:    ${d.probe.available ? "✓" : "✗"} ${d.probe.version ?? "(no version)"}\n`);
        if (Object.keys(d.probe.capabilities).length) {
          const caps = Object.entries(d.probe.capabilities).filter(([, v]) => v).map(([k]) => k);
          if (caps.length) process.stdout.write(`  caps:     ${caps.join(", ")}\n`);
        }
        if (d.probe.warnings.length) {
          process.stdout.write(`  warnings: ${d.probe.warnings.join("; ")}\n`);
        }
      }
      process.stdout.write("\n");
    }
    return 0;
  } finally {
    client.close();
  }
}
