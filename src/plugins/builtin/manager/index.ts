/**
 * manager plugin — spawns a "cordy manager" Claude session wired with the
 * cordy MCP bridge so it can drive peer agents autonomously.
 *
 * Exposes two things:
 *
 *   Method `manager.spawn`
 *     params: { driverId?, task, model?, name? }
 *     Spawns the manager agent (Claude by default), injects the MCP config
 *     pointing at `cordy mcp-stdio`, appends a system prompt explaining the
 *     role, and submits the user's task. Returns { id } of the manager.
 *
 *   Subcommand `cordy manager <task...>`
 *     Ergonomic wrapper — same thing from the shell.
 *
 * The manager, once running, uses MCP tools (agents_spawn, agents_submit,
 * drivers_list, etc.) to delegate. This is the foundation of the
 * manager-agent pattern — the LLM is a peer, not a special case.
 */

import type { CordycepsPlugin, PluginContext } from "../../api.js";

const MANAGER_PROMPT = `You are a **cordy manager**. Your job is to accomplish user tasks by coordinating peer agents via the cordy control plane.

You have the following MCP tools (prefixed \`cordy_\` in your tool list):

  cordy_agents_spawn      — spawn a new agent (claude, codex, gemini, ollama)
  cordy_agents_submit     — send a prompt to an agent, await its reply
  cordy_agents_state      — read an agent's current state
  cordy_agents_transcript — read an agent's message history
  cordy_agents_interrupt  — interrupt a busy agent
  cordy_agents_kill       — terminate an agent
  cordy_drivers_list      — list available drivers + their probe status
  cordy_bus_get           — read a cordy service-bus key
  cordy_bus_get_by_prefix — list bus entries under a prefix

Approach:
1. Break the user's task into subtasks that can be delegated.
2. Pick appropriate drivers for each subtask (Claude for code work, Codex for
   quick exec tasks, Ollama for cheap local reasoning).
3. Spawn peer agents, submit prompts, collect replies.
4. Compose their results into a final answer for the user.
5. Kill agents when you're done (unused agents consume memory).

Stay focused on the user's task. Don't spawn more agents than necessary.
`;

const plugin: CordycepsPlugin = {
  name: "manager",
  description: "Spawn a cordy-manager Claude session wired with MCP for peer delegation",
  version: "1.0.0",
  order: { priority: 20 }, // load after runtime plugins

  subcommands: {
    manager: {
      description: "Spawn a cordy manager and give it a task",
      usage: "cordy manager [--driver claude|codex|gemini] [--model M] [--name N] <task...>",
      async handler(args, ctx): Promise<string[] | void> {
        if (args.length === 0) {
          ctx.logger.warn("manager", "Usage: cordy manager [--driver X] [--model Y] [--name Z] <task>");
          process.stderr.write("Usage: cordy manager [--driver X] [--model Y] [--name Z] <task>\n");
          process.exit(1);
        }

        let driverId = "claude";
        let model: string | undefined;
        let name: string | undefined;
        const taskParts: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === "--driver" && args[i + 1]) { driverId = args[++i]; }
          else if (a === "--model" && args[i + 1]) { model = args[++i]; }
          else if (a === "--name" && args[i + 1]) { name = args[++i]; }
          else taskParts.push(a);
        }
        const task = taskParts.join(" ");
        if (!task) { process.stderr.write("cordy manager: task required\n"); process.exit(1); }

        const result = await ctx.agents.spawn(driverId, {
          id: name,
          profile: buildManagerProfile(driverId, model),
        });
        const spawnedId = result.id;
        process.stdout.write(`Manager spawned: ${spawnedId} (driver=${driverId})\n`);

        // Submit the task; stream output to the console via on("message")
        const agent = ctx.agents.get(spawnedId);
        if (!agent) { process.stderr.write("cordy manager: agent lookup failed\n"); process.exit(1); }

        agent.on("message", (msg) => {
          const m = msg as { text: string };
          process.stdout.write(`\n--- ${spawnedId} ---\n${m.text}\n`);
        });

        const submit = await agent.submit(task, { timeoutMs: 300_000 });
        if (!submit.accepted) {
          process.stderr.write("cordy manager: submit rejected\n");
          process.exit(1);
        }
        // Final message (if any) already printed via on("message"). Print a
        // trailing newline to separate from the prompt redraw.
        process.stdout.write("\n");
      },
    },
  },

  // Note: manager.spawn is registered at init time (closure-captured manager access)
  async init(ctx: PluginContext) {
    ctx.rpc.register("manager.spawn", async (params) => {
      const p = (params ?? {}) as { driverId?: string; task?: string; model?: string; name?: string };
      const driverId = p.driverId ?? "claude";
      if (!p.task) throw new Error("manager.spawn: task is required");

      const agent = await ctx.agents.spawn(driverId, {
        id: p.name,
        profile: buildManagerProfile(driverId, p.model),
      });
      const runtime = ctx.agents.get(agent.id);
      if (!runtime) throw new Error("manager spawned but runtime lookup failed");

      // Fire-and-forget — the caller subscribes to the agent's bus events
      // for streaming output.
      void runtime.submit(p.task, { timeoutMs: 300_000, expectMessage: false });
      return { id: agent.id };
    });
    ctx.onDestroy(() => { ctx.rpc.unregister("manager.spawn"); });
    ctx.logger.info("manager", "manager plugin ready — `cordy manager <task>`");
  },
};

function buildManagerProfile(driverId: string, model?: string): Record<string, unknown> {
  const profile: Record<string, unknown> = {};

  // MCP wiring — all drivers that take --mcp-config can see cordy as a tool
  // surface. For Claude, we inject via profile.mcpConfig. For Codex/Gemini,
  // this is a future extension (their MCP config formats differ).
  if (driverId === "claude" || driverId === "claude-code") {
    profile.mcpConfig = {
      mcpServers: { cordy: { command: "cordy", args: ["mcp-stdio"] } },
    };
    profile.appendSystemPrompt = MANAGER_PROMPT;
    if (model) profile.model = model;
  } else if (model) {
    profile.model = model;
  }

  return profile;
}

export default plugin;
