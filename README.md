# Cordyceps

**Local-first agent harness.** Spawns, drives, and coordinates PTY-based CLI coding agents through a JSON-RPC 2.0 control plane, a service bus, and a plugin architecture.

**Status:** v0.4.0 — pre-release.

## What it is

- **Daemon:** owns N live PTY agent sessions, exposes control over WebSocket JSON-RPC
- **Driver layer:** one adapter per CLI family. Mode-aware (`pty`, `exec`, `server-ws`, `server-http`)
- **Service bus:** in-process pub/sub + key/value state for inter-agent coordination
- **Plugin system:** plugins register JSON-RPC methods, subscribe to bus events, emit notifications
- **`cordy` CLI:** thin client; every subcommand is a JSON-RPC call to the daemon

## What it isn't

- Not a human-facing TUI or web UI — pure agentic infrastructure
- Not a provider SDK client (drives installed CLIs; no direct Anthropic/OpenAI/Google API calls)

## The manager-agent pattern

The agentic bit: a "manager" agent is just another client connected to the daemon's JSON-RPC API. Given a prompt, it spawns peer agents, drives them through work, responds to approvals, and tears them down. Gatekeeper, reviewer, orchestrator, human-in-the-loop escalator — these are all patterns that fall out of one LLM holding the steering wheel of a fleet.

v1 is the plumbing that makes that possible. Every primitive (spawn, submit, interrupt, approve, bus event) is reachable over the same API surface a human uses from the shell, so a manager-LLM operating cordy has the same capability as operator driving it manually — the agent becomes a peer, not a special case.

## Install

```bash
pnpm install
pnpm build
```

For convenience, link `bin/cordy` onto your PATH or use `./bin/cordy` directly.

## Quick start

```bash
# Start the daemon (detached background process)
./bin/cordy daemon start

# Inspect what's running
./bin/cordy daemon status
./bin/cordy doctor

# Spawn a Claude agent (uses your normal Claude auth — OAuth, memory, CLAUDE.md, hooks)
./bin/cordy spawn claude --name smoke

# Send it a prompt and get the response
./bin/cordy send smoke "respond with just: banana"

# Inspect state, transcript, bus
./bin/cordy state smoke
./bin/cordy transcript smoke
./bin/cordy bus agent.

# Clean up
./bin/cordy kill smoke
./bin/cordy daemon stop
```

### Deterministic profile (for automation)

```bash
# --profile deterministic uses --bare + plan mode + Edit/Write/MultiEdit blocked
./bin/cordy spawn claude --name reviewer --profile deterministic
```

`--bare` mode requires API-key style auth (skips OAuth/keychain). Default profile is for general use.

### Ephemeral mode (one-shot, no persistent daemon)

```bash
./bin/cordy --ephemeral doctor
./bin/cordy --ephemeral spawn claude --name once
```

### Manager agent — delegate tasks to a fleet

```bash
cordy manager "summarize the git log since last week"
cordy manager --driver claude --model haiku-4-5 "write a unit test for src/core/bus.ts"
```

Spawns a Claude session wired with cordy's MCP control plane and a manager system prompt. The manager is a peer agent — it can spawn other agents (Codex for exec tasks, Ollama for cheap reasoning, Gemini for search-heavy work), coordinate their output, and report back. Press Ctrl+C to interrupt; the spawned agent is killed.

### MCP bridge — expose cordy to another agent

A Claude Code, Codex, or any MCP client can treat cordy's control plane as a tool surface. Add `cordy mcp-stdio` to its MCP config:

```jsonc
// claude mcp-config entry
{
  "mcpServers": {
    "cordy": { "command": "cordy", "args": ["mcp-stdio"] }
  }
}
```

Now the spawned agent can call `cordy_agents_spawn`, `cordy_agents_submit`, `cordy_drivers_list`, etc. — i.e. it has delegated authority to spawn peer agents and drive them. This is the substrate for manager-agent patterns.

### Capturing PTY output (for fixture generation)

When a driver's parser drifts against a new CLI release, capture the raw PTY stream and feed it back as a regression fixture:

```bash
./bin/cordy spawn claude --name drift
./bin/cordy capture drift --duration 30 &
./bin/cordy send drift "small repro"
# → .cordyceps/captures/drift-<ts>.jsonl  (meta + output + state + message lines)
```

Each line is one event. The `meta` header records the driver id, driver version, CLI version, and the driver's tested range (`supportedVersions`). The file mode is `0600`; the directory self-ignores via `.cordyceps/.gitignore`.

### Fixture replay (parser regression guard)

Captures drop into `test/fixtures/<driver>/<version>/` and feed back through the parser in CI:

```ts
import { loadCapture, replay } from "../fixtures/replay.js";
import { ClaudeParser } from "../../src/drivers/claude/parser.js";

const cap = loadCapture("test/fixtures/claude/v2.1.114/basic-hello.jsonl");
const { finalState, messages } = replay(cap, new ClaudeParser());
// assert messages + finalState match recorded live values
```

When a CLI release shifts glyph spacing, mode-line shape, or spinner frames, the fixture breaks on the next `pnpm test` and the fix lives in the driver directory.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Daemon Process                          │
│  ┌────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Transport │◄──►│ Service Bus  │◄──►│   Plugins    │      │
│  │  WS /rpc   │    │ (events+kv)  │    │ (audit, …)   │      │
│  └─────┬──────┘    └──────┬───────┘    └──────────────┘      │
│        │                  │                   ▲              │
│        │                  ▼                   │              │
│        │         ┌────────────────┐           │              │
│        │         │ Agent Manager  ├───────────┘              │
│        │         │ + RuntimeReg   │                          │
│        │         └────────┬───────┘                          │
│        │                  │                                  │
│        ▼      ┌───────────┼───────────┐                      │
│  WS clients   ▼           ▼           ▼                      │
│       ┌───────────┐┌────────────┐┌────────────┐              │
│       │PtyAgent   ││PtyAgent    ││PtyAgent    │              │
│       │Controller ││Controller  ││Controller  │              │
│       └─────┬─────┘└─────┬──────┘└─────┬──────┘              │
│             ▼            ▼             ▼                     │
│       ┌─────────┐  ┌─────────┐   ┌─────────┐                 │
│       │  PTY    │  │  PTY    │   │  PTY    │                 │
│       │(agent)  │  │(agent)  │   │(agent)  │                 │
│       └─────────┘  └─────────┘   └─────────┘                 │
└──────────────────────────────────────────────────────────────┘

  HTTP /health        — liveness probe (no auth)
  WS   /rpc           — JSON-RPC 2.0 (bearer token via ?token=)
```

### The two keystone patterns

1. **Service Bus** (`src/core/bus.ts`) — pub/sub events + flat key-value state. `on()` returns an unsubscribe handle so plugins can clean up cleanly. Plugins coordinate through agreed-upon bus key prefixes; nothing imports across plugins.

2. **Plugin Architecture** (`src/plugins/api.ts`) — every extension is a `CordycepsPlugin` declaring `methods` (JSON-RPC handlers), `subcommands`, `flags`, and lifecycle hooks. Loaded in priority groups with topological sort within each group. The audit plugin (`src/plugins/builtin/audit/`) is the reference implementation.

### JSON-RPC over WebSocket

One bidirectional channel handles control + streaming. Methods are namespaced (`agents.*`, `drivers.*`, `bus.*`, `daemon.*`, plus plugin-specific). Notifications use the same namespace. Clients control their own subscription allowlist via `notifications.subscribe`/`unsubscribe`.

Default subscriptions on connect: `agent.created`, `agent.state`, `agent.message`, `agent.blocked`, `agent.idle`, `agent.exited`, `plugin.ready`, `daemon.stopping`. The high-volume `agent.output` stream is opt-in.

## Driver layer

Drivers declare modes (`pty`, `exec`, `server-ws`, `server-http`). The `AgentManager` has a runtime factory registry — runtimes for each mode are added by plugins via `manager.registerRuntime(mode, factory)` without touching core. Adding a new CLI family is a driver plus (if needed) a runtime plugin; nothing in the bus, plugin API, transport, or existing drivers has to change.

Drivers shipped in v0.3.0:

| Driver | Modes | Notes |
|--------|-------|-------|
| `claude-code` | `pty` | Interactive Claude Code TUI, full control (approve/reject/mode-switch) |
| `codex` | `exec` | `codex exec --json --skip-git-repo-check` |
| `gemini` | `exec` | `gemini -p … --output-format stream-json`; needs `GEMINI_API_KEY` in daemon env |
| `ollama` | `server-http` | Streams NDJSON from `/api/generate`; needs local daemon (`ollama serve`) |

The Claude driver at `src/drivers/claude/` is the exemplar for PTY-backed drivers:
- `driver.ts` — `claude --bare`, `--session-id <uuid>`, `--permission-mode <mode>`, etc.
- `parser.ts` — glyph-based state machine (`●` message, `⎿` result, spinner family, `⏵`/`⏸` mode)
- `control.ts` — `submit`/`interrupt`/`approve`/`reject`/`switchModel`/`switchMode`
- `session.ts` — fresh UUID per agent for `--session-id`; optional `CLAUDE_CONFIG_DIR` sandbox via `profile.isolateConfig`
- `tui.ts` — key sequences and patterns

When a CLI's output format changes, the fix lives in its driver directory (parser, control, or `tui.ts`). `cordy capture` + the fixture-replay harness (`test/fixtures/replay.ts`) catch drift in CI.

## Persistence + security

- `~/.cordyceps/` (mode `0700`) — daemon state, instance files, audit logs
- `~/.cordyceps/instances/{pid}.json` (mode `0600`, atomic writes) — discovery for the `cordy` client
- `<repo>/.cordyceps/` — per-repo artifacts. Cordyceps creates `.cordyceps/.gitignore` (containing `*`) on first write but never modifies the repo's own `.gitignore`. Use `cordy init --gitignore` to opt into that.
- Loopback-only transport (`127.0.0.1`)
- 192-bit bearer token, regenerated per daemon start
- WS auth failure → close code 1008 (no JSON-RPC session ever begins)

## Tests

```bash
pnpm test          # vitest, all green (~99 tests)
pnpm build         # tsc clean
```
