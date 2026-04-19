# Probe report — `claude mcp serve`

**Status:** Exploratory — **not** consumed by v1 code. Findings inform later phases.
**Probed against:** Claude Code `2.1.114` (claude/tengu), `claude mcp serve` subcommand.
**Date:** 2026-04-19.

## What it is

`claude mcp serve` is Claude Code's **MCP server mode** — it speaks MCP
protocol (`2024-11-05`) over stdio. It is not a way to drive Claude-the-agent;
it exposes Claude Code's **tool executors** (`Read`, `Write`, `Bash`, `Agent`, …)
for other MCP clients to call.

```
claude mcp serve
  -d, --debug
  --verbose
```

No ports, no listen address — strictly stdio.

## What it advertises

- `protocolVersion: "2024-11-05"`
- `serverInfo: { name: "claude/tengu", version: "2.1.114" }`
- `capabilities: { tools: {} }`

**17 tools listed on `tools/list`:**

```
Agent          TaskOutput        Bash           Glob           Grep
ExitPlanMode   Read              Edit           Write          NotebookEdit
WebFetch       TodoWrite         WebSearch      TaskStop       AskUserQuestion
Skill          EnterPlanMode
```

The full schema for each (arguments, description, maxResultSizeChars) is returned.

## What it does on `tools/call`

A `tools/call` with `name: "Read"` and `arguments: { file_path }` **actually
executes** the tool in the server process and returns `{ content: [{ type: "text", text }] }`.
The returned text is JSON-in-JSON (Claude's internal content-item format), one layer down:

```json
{
  "type": "text",
  "file": {
    "filePath": "…",
    "content": "…",
    "numLines": 59,
    "startLine": 1,
    "totalLines": 59
  }
}
```

The implication: the Claude Code process running `mcp serve` has the same
tool runtime (including sandboxing, permission prompts, hooks) as the TUI,
just exposed over a different front-end.

## What it is *not*

- **Not** an exec mode for Claude-the-agent. There is no `prompt` input.
  The `Agent` tool is listed but I did not verify whether calling it spawns
  a live agent or just returns a task handle. This is a follow-up question.
- **Not** a replacement for the PTY driver for council-style use cases:
  we need an actual LLM turn, not tool execution.
- **Not** documented as stable transport. It's what Claude Code ships today;
  the shape of `content[].text` or the tool list could shift across
  versions — the same parser-drift risk as the TUI.

## Relevance to cordyceps

### Phase 2+ — potential new driver mode

If we want Claude tool execution without a full PTY session — e.g. a
"secondary agent" that only does file reads + web fetches on demand for a
main agent — this is a direct fit.

It would slot in as a new `DriverMode`, something like `"server-stdio-mcp"`,
with:

```
modes: ["pty", "server-stdio-mcp"]
buildServerStdioMcp(profile) → SpawnSpec  // spawn `claude mcp serve`
```

And a new `AgentRuntime` implementation (`StdioMcpAgentRuntime`) that:
- Spawns the subprocess
- Speaks MCP over stdio
- Exposes `submit(prompt)` by translating prompts into `tools/call` against
  the `Agent` tool (pending verification that `Agent` runs a full turn)
- Maps `tools/list` to the runtime's capability list

Per the v1 runtime factory registry (§4.5 of the plan), this lands as a
plugin. Zero core changes.

### Phase 3a — cordy as MCP server

More interesting: cordy itself could expose an MCP server that fronts its
agent fleet, so a Claude Code session managed by cordy sees a unified tool
surface that includes peer-agent communication (`cordy.spawn`,
`cordy.send`, `cordy.state`, etc.) as first-class MCP tools.

This is phase 3a territory. The probe confirms the protocol ergonomics
are fine — simple initialize + tools/call over stdio, no handshake gymnastics.

## Open questions (for whenever this goes live)

1. Does `tools/call` with `name: "Agent"` spawn a real Claude turn (LLM + tool use),
   or is `Agent` also just a tool-delegating executor?
2. Does MCP serve respect the same `CLAUDE_CONFIG_DIR` / `--permission-mode`
   flags the interactive mode uses? (Probably yes — it's the same binary.)
3. What happens when the server is asked for a tool that requires an approval
   prompt (`Bash` with a dangerous command)? Does it return `blocked`, pause,
   or reject?
4. Token accounting — are MCP-served tool calls billed the same as interactive
   Claude turns?
5. Does each spawn cost an MCP handshake round-trip? If cordyceps starts many
   short-lived MCP servers per agent lifetime, the overhead matters.

## Recommendation

**Not** build a Claude-over-MCP runtime in 1.x. The PTY driver is the
right primitive for live agent sessions. Re-visit when:

- Phase 3a lands (cordy-as-MCP, where this is a peer protocol anyway), **or**
- A concrete "tool-only secondary" use case shows up (audit agent, scanner,
  file-reader worker), **or**
- A future Claude Code release adds a real exec-with-prompt MCP method
  that replaces the TUI parse path.

Meanwhile the probe findings are captured here so the next person working
on drivers doesn't need to re-discover them.
