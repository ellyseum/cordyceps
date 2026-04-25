import { connect } from "../client.js";

export async function runSpawn(args: string[]): Promise<number> {
  if (args.length === 0) {
    process.stderr.write("Usage: cordy spawn <driver> [--name N] [--cwd .] [--profile NAME] [--bare] [--key=val ...]\n");
    return 1;
  }

  const driverId = args[0];
  let id: string | undefined;
  let cwd: string | undefined;
  const profile: Record<string, unknown> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--name" && args[i + 1]) {
      id = args[++i];
    } else if (arg === "--cwd" && args[i + 1]) {
      cwd = args[++i];
    } else if (arg === "--profile" && args[i + 1]) {
      profile.preset = args[++i];
    } else if (arg === "--bare") {
      profile.bare = true;
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const [k, v] = arg.slice(2).split("=", 2);
      profile[k] = v;
    } else if (arg.startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--")) {
      profile[arg.slice(2)] = args[++i];
    }
  }

  // Default cwd to the caller's working directory so spawn behavior doesn't
  // depend on where `cordy daemon start` was run.
  const effectiveCwd = cwd ?? process.cwd();

  const client = await connect();
  try {
    const info = await client.call<{ id: string; driverId: string; mode: string; cwd: string; status: string }>(
      "agents.spawn",
      { driverId, id, cwd: effectiveCwd, profile },
    );
    process.stdout.write(`Spawned: ${info.id} (driver=${info.driverId}, mode=${info.mode}, cwd=${info.cwd})\n`);
    return 0;
  } finally {
    client.close();
  }
}
