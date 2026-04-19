import { connect } from "../client.js";

export async function runSend(args: string[]): Promise<number> {
  if (args.length < 1) {
    process.stderr.write('Usage: cordy send <agent-id> "<prompt>" [--timeout N] [--no-wait]\n');
    return 1;
  }

  const id = args[0];
  let timeoutMs: number | undefined;
  let noWait = false;
  let stdin = false;
  const promptParts: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--timeout" && args[i + 1]) {
      timeoutMs = parseInt(args[++i], 10) * 1000;
    } else if (arg === "--no-wait") {
      noWait = true;
    } else if (arg === "--stdin") {
      stdin = true;
    } else {
      promptParts.push(arg);
    }
  }

  let prompt = promptParts.join(" ");
  if (stdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    prompt = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!prompt) {
    process.stderr.write("No prompt provided.\n");
    return 1;
  }

  const client = await connect();
  try {
    const result = await client.call<{ accepted: boolean; message?: { text: string } }>(
      "agents.submit",
      { id, prompt, timeoutMs, expectMessage: !noWait },
      timeoutMs ? timeoutMs + 5000 : undefined,
    );
    if (result.message) {
      process.stdout.write(result.message.text + "\n");
    } else if (noWait) {
      process.stderr.write("Submitted (fire-and-forget).\n");
    } else {
      process.stderr.write("Submitted; no message arrived before timeout.\n");
      return 2;
    }
    return 0;
  } finally {
    client.close();
  }
}
