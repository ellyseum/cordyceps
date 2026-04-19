/**
 * `cordy mcp-stdio` — MCP (Model Context Protocol) bridge over stdio.
 *
 * A Claude Code (or any MCP client) spawns this subcommand as an MCP server.
 * We speak MCP on stdin/stdout, translate tool calls into JSON-RPC calls
 * against a running cordy daemon, and return the results as MCP content.
 *
 * This is how an in-Claude agent gets first-class access to cordy's control
 * plane — spawn peers, submit prompts, read transcripts — without any
 * cordy-specific wiring inside Claude.
 *
 * Discovery: the bridge connects to the latest-running cordy daemon via the
 * standard instance file under ~/.cordyceps/instances/. If no daemon is
 * running, it errors on the initialize response so the client sees a
 * meaningful message.
 */

import { createInterface } from "node:readline";
import { connect, type RpcClient } from "../client.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_VERSION = "0.4.0";

interface McpRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string; items?: unknown }>;
    required?: string[];
  };
  /** Internal: which cordy JSON-RPC method this tool calls */
  _rpc: string;
}

const TOOLS: McpTool[] = [
  {
    name: "agents_list",
    description: "List all agents currently alive in the cordy daemon.",
    inputSchema: { type: "object", properties: {} },
    _rpc: "agents.list",
  },
  {
    name: "agents_spawn",
    description: "Spawn a new agent. Returns AgentInfo with the assigned id.",
    inputSchema: {
      type: "object",
      properties: {
        driverId: { type: "string", description: "Driver id or alias (e.g. 'claude', 'codex', 'gemini', 'ollama')" },
        id: { type: "string", description: "Optional agent id — auto-generated if omitted" },
        cwd: { type: "string", description: "Working directory for the agent (default: daemon cwd)" },
        profile: { type: "object", description: "Driver-specific profile (model, preset, etc.)" },
      },
      required: ["driverId"],
    },
    _rpc: "agents.spawn",
  },
  {
    name: "agents_submit",
    description: "Submit a prompt to an agent and wait for its reply.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Agent id" },
        prompt: { type: "string", description: "Prompt text" },
        timeoutMs: { type: "number", description: "Max wait (default 120_000)" },
        expectMessage: { type: "boolean", description: "Wait for message (default true). Set false for fire-and-forget." },
      },
      required: ["id", "prompt"],
    },
    _rpc: "agents.submit",
  },
  {
    name: "agents_state",
    description: "Get the current AgentState snapshot for an agent.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Agent id" } },
      required: ["id"],
    },
    _rpc: "agents.state",
  },
  {
    name: "agents_transcript",
    description: "Return an agent's assistant-message transcript.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Agent id" },
        last: { type: "number", description: "Limit to the last N messages" },
      },
      required: ["id"],
    },
    _rpc: "agents.transcript",
  },
  {
    name: "agents_interrupt",
    description: "Interrupt an agent that's busy (Escape / SIGTERM depending on driver).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    _rpc: "agents.interrupt",
  },
  {
    name: "agents_kill",
    description: "Kill an agent. The runtime is torn down.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        signal: { type: "string", description: "Signal (default SIGTERM)" },
      },
      required: ["id"],
    },
    _rpc: "agents.kill",
  },
  {
    name: "drivers_list",
    description: "List all drivers known to the daemon, with probe results.",
    inputSchema: { type: "object", properties: {} },
    _rpc: "drivers.list",
  },
  {
    name: "bus_get",
    description: "Read a value from the service bus key/value store.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    _rpc: "bus.get",
  },
  {
    name: "bus_get_by_prefix",
    description: "Return all bus entries whose key starts with `prefix`.",
    inputSchema: {
      type: "object",
      properties: { prefix: { type: "string" } },
      required: ["prefix"],
    },
    _rpc: "bus.getByPrefix",
  },
  {
    name: "peer_ask",
    description: "Agent `from` asks agent `to` a question and returns the reply. Blocks up to timeoutMs (default 120s).",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Sender agent id" },
        to: { type: "string", description: "Recipient agent id" },
        text: { type: "string", description: "Question text" },
        timeoutMs: { type: "number", description: "Max wait (default 120_000)" },
      },
      required: ["from", "to", "text"],
    },
    _rpc: "peer.ask",
  },
  {
    name: "peer_tell",
    description: "Agent `from` notifies agent `to` — fire-and-forget, no reply expected.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        text: { type: "string" },
      },
      required: ["from", "to", "text"],
    },
    _rpc: "peer.tell",
  },
  {
    name: "daemons_list",
    description: "List all cordy daemons running on this host (for cross-daemon coordination). Tokens are NOT returned.",
    inputSchema: { type: "object", properties: {} },
    _rpc: "daemons.list",
  },
];

function writeMsg(msg: McpRequest): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function errResponse(id: number | string | null | undefined, code: number, message: string, data?: unknown): void {
  writeMsg({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } as unknown });
}

function okResponse(id: number | string | null | undefined, result: unknown): void {
  writeMsg({ jsonrpc: "2.0", id: id ?? null, result });
}

export async function runMcpStdio(_args: string[]): Promise<number> {
  let client: RpcClient | undefined;
  try {
    client = await connect();
  } catch (err) {
    // Don't hard-fail on startup — initialize response will report the problem
    // so the client sees a readable error. Still log to stderr for the user.
    process.stderr.write(`cordy mcp-stdio: cannot reach daemon: ${(err as Error).message}\n`);
  }

  const rl = createInterface({ input: process.stdin, terminal: false });

  // Track in-flight handlers so we don't exit before async responses land.
  let pending = 0;
  let closed = false;
  let resolveWait!: () => void;
  const allDone = new Promise<void>((resolve) => { resolveWait = resolve; });
  const maybeFinish = () => { if (closed && pending === 0) resolveWait(); };

  rl.on("line", (line) => {
    pending++;
    void (async () => {
      try {
        await handleLine(line);
      } finally {
        pending--;
        maybeFinish();
      }
    })();
  });

  async function handleLine(line: string): Promise<void> {
    let req: McpRequest;
    try {
      req = JSON.parse(line) as McpRequest;
    } catch {
      errResponse(null, -32700, "Parse error");
      return;
    }

    try {
      switch (req.method) {
        case "initialize": {
          okResponse(req.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "cordy", version: SERVER_VERSION },
          });
          break;
        }
        case "notifications/initialized": {
          // No-op; no response required for notifications
          break;
        }
        case "tools/list": {
          okResponse(req.id, {
            tools: TOOLS.map(({ _rpc: _unused, ...pub }) => pub),
          });
          break;
        }
        case "tools/call": {
          const p = req.params as { name?: string; arguments?: unknown } | undefined;
          const toolName = p?.name;
          const args = p?.arguments ?? {};
          const tool = TOOLS.find((t) => t.name === toolName);
          if (!tool) { errResponse(req.id, -32601, `Unknown tool: ${toolName}`); break; }
          if (!client) { errResponse(req.id, -32000, "cordy daemon not reachable (is `cordy daemon start` running?)"); break; }

          try {
            const result = await client.call(tool._rpc, args);
            okResponse(req.id, {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            });
          } catch (err) {
            const e = err as { code?: number; message?: string };
            okResponse(req.id, {
              isError: true,
              content: [{ type: "text", text: `cordy error: ${e.message ?? String(err)}` }],
            });
          }
          break;
        }
        case "ping": {
          okResponse(req.id, {});
          break;
        }
        default: {
          if (req.id !== undefined) errResponse(req.id, -32601, `Method not found: ${req.method}`);
        }
      }
    } catch (err) {
      errResponse(req.id, -32603, `Internal error: ${(err as Error).message}`);
    }
  }

  rl.on("close", () => { closed = true; maybeFinish(); });
  process.stdin.on("end", () => { closed = true; maybeFinish(); });

  await allDone;

  try { client?.close(); } catch { /* ignore */ }
  return 0;
}
