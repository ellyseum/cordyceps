import { connect } from "../client.js";

export async function runTranscript(args: string[]): Promise<number> {
  if (args.length < 1) {
    process.stderr.write("Usage: cordy transcript <agent-id> [--last N] [--json]\n");
    return 1;
  }
  const id = args[0];
  let last: number | undefined;
  let json = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--last" && args[i + 1]) last = parseInt(args[++i], 10);
    else if (args[i] === "--json") json = true;
  }

  const client = await connect();
  try {
    const transcript = await client.call<Array<{ text: string; ts: string }>>("agents.transcript", { id, last });
    if (json) {
      process.stdout.write(JSON.stringify(transcript, null, 2) + "\n");
      return 0;
    }
    for (const m of transcript) {
      process.stdout.write(`[${m.ts}]\n${m.text}\n\n`);
    }
    return 0;
  } finally {
    client.close();
  }
}
