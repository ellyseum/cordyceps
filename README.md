# Cordyceps

[![npm version](https://img.shields.io/npm/v/@ellyseum/cordyceps.svg?style=flat-square)](https://www.npmjs.com/package/@ellyseum/cordyceps)
[![CI](https://img.shields.io/github/actions/workflow/status/ellyseum/cordyceps/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/ellyseum/cordyceps/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node ^20 || ^22 || ^24](https://img.shields.io/badge/node-%5E20%20%7C%7C%20%5E22%20%7C%7C%20%5E24-brightgreen.svg?style=flat-square)](package.json)

**Local-first agent harness.** A daemon that spawns and drives PTY-based CLI coding agents — Claude Code, Codex, Gemini, Ollama — through a single JSON-RPC 2.0 control plane. Every primitive a human invokes from the shell (spawn, submit, interrupt, approve, kill) is reachable over the same API a manager LLM uses to drive a fleet of peers.

## Why this exists

Most agent frameworks assume one model, one task, one process. Real agentic
work is a fleet — a manager LLM driving peers, with humans escalated only
when needed. The design insight that unlocked it: a manager LLM should be a
peer client on the same control plane as a human operator, not a privileged
special case. Once `spawn` / `submit` / `interrupt` / `approve` are reachable
over a stable API, the manager gets everything the operator has — and a code
review council, an MCP bridge, an autonomous repo grinder, and a deterministic
test runner all fall out of the same plumbing.

Cordyceps is that plumbing. The PTY work is a backend detail; the control
plane is the product.

## Quick start

```bash
# Install
npm install -g @ellyseum/cordyceps

# Start the daemon (loopback-only, bearer-auth WebSocket)
cordy daemon start

# Spawn a Claude agent (uses your normal Claude auth — OAuth, memory, hooks)
cordy spawn claude --name smoke

# Send a prompt; print the response
cordy send smoke "respond with just: banana"

# Inspect; clean up
cordy state smoke
cordy kill smoke
cordy daemon stop
```

For one-shots without a persistent daemon: `cordy --ephemeral spawn claude --name once`.

### Prerequisites

- Node `^20 || ^22 || ^24`.
- `node-pty` is a native module. The npm registry ships prebuilt binaries
  for common Node ABIs; on a system without a matching prebuild, install
  needs Python 3 and a C++ toolchain (`build-essential` on Debian/Ubuntu,
  Xcode CLT on macOS).
- The CLI agents you want to drive (`claude`, `codex`, `gemini`, `ollama`)
  must already be installed on `PATH`. Cordyceps is a harness — it doesn't
  ship its own model access.

### Install from source

```bash
git clone https://github.com/ellyseum/cordyceps
cd cordyceps
pnpm install
pnpm build
./bin/cordy daemon start
```

## The manager-agent pattern

The agentic bit: a "manager" agent is just another client connected to the
daemon's JSON-RPC API. Given a prompt, it spawns peer agents, drives them
through work, responds to approvals, and tears them down. Gatekeeper,
reviewer, orchestrator, human-in-the-loop escalator — these all fall out of
one LLM holding the steering wheel of a fleet.

Every primitive is reachable over the same API surface a human uses from the
shell, so a manager LLM operating cordy has the same capability as an
operator driving it manually. The agent becomes a peer, not a special case.

```bash
cordy manager "summarize the git log since last week"
```

This spawns a Claude session wired with cordy's MCP bridge and a manager
system prompt. The manager can spawn other agents (Codex for exec tasks,
Gemini for search-heavy work, Ollama for cheap reasoning), coordinate their
output, and report back. Press Ctrl+C to interrupt.

## Code review council

```bash
cordy council review src/core/bus.ts
cordy council review src/core/bus.ts --panel claude,codex,gemini --chair codex --json
cordy council review src/core/bus.ts --no-chair --json   # synthesize yourself
cordy council diff                              # uncommitted changes vs HEAD
cordy council diff --staged                     # only staged changes
cordy council diff main..feature --scope src/   # branch comparison, scoped
```

N reviewers from different driver families run in parallel, each in a silo
(no reviewer sees another's output), then a chair agent synthesizes their
findings into a prioritized markdown verdict. The whole point is
heterogeneous training lineages — intra-family ensembles correlate their
blind spots; inter-family councils don't.

`--no-chair` (0.5.2+) skips the chair-spawn step and returns
per-reviewer findings only. Useful when an LLM caller (e.g. a Claude
Code session driving cordy) wants to synthesize the panel's output
itself using full conversation context, instead of paying for a
separate chair model.

`review` operates on a whole file; `diff` reviews the changes shown by `git
diff` (with `--no-ext-diff --no-textconv --end-of-options` for hostile-repo
safety). Tool-capable drivers (Claude PTY, Codex exec, Gemini exec) get a
path-only prompt and read the file themselves; tool-less drivers fall back
to inline mode with auto-chunking at ~30KB.

## Use from Claude Code

The recommended way to drive cordy from a Claude Code session is the
[`claude-cordyceps`](https://github.com/ellyseum/claude-cordyceps)
plugin. It teaches Claude how to map natural-language asks
("consult peers on src/foo.ts", "spawn council", "brainstorm with
multiple LLMs", "ask Codex about this design") to the right `cordy`
invocation, and ships a SessionStart hook that detects which drivers
are reachable on the current machine.

After installing cordy globally as above:

```text
/plugin marketplace add ellyseum/claude-cordyceps
/plugin install claude-cordyceps
```

Then trigger via natural language or the `/cordy <ask>` slash command.
See the plugin's README for the full setup and trigger phrase list.

## MCP bridge — expose cordy to another agent

> **Experimental.** The bridge currently speaks line-delimited JSON-RPC,
> which is what Claude Code's MCP loader accepts. Stricter MCP clients may
> reject the framing; full MCP stdio framing is tracked for a future release.

For lower-level integration (no plugin), add `cordy mcp-stdio` to a
Claude Code MCP config — the agent gains delegated authority to spawn
peers and drive them via tool calls (`cordy_agents_spawn`,
`cordy_agents_submit`, `cordy_drivers_list`, …):

```jsonc
{
  "mcpServers": {
    "cordy": { "command": "cordy", "args": ["mcp-stdio"] }
  }
}
```

This is the substrate the `claude-cordyceps` plugin builds on, and is
the path to take if you want raw tool calls instead of the plugin's
opinionated skill body.

## Drivers

| Driver | Family | Modes | Notes |
|--------|--------|-------|-------|
| `claude-code` | Anthropic | `pty`, `exec` | Interactive TUI (`pty`) or one-shot via `claude --print` (`exec`). PTY supports approve / reject / mode-switch; exec is cleaner for one-shot prompts and council reviewers. |
| `codex` | OpenAI | `exec` | `codex exec --json --skip-git-repo-check` |
| `gemini` | Google | `exec` | `gemini -p … --output-format stream-json`; needs `GEMINI_API_KEY` in the daemon env |
| `ollama` | local | `server-http` | Streams NDJSON from `/api/generate`; needs a local Ollama daemon (`ollama serve`). Free for local models. |

Drivers declare their modes; the `AgentManager` runtime registry maps each
mode to a controller plugin without core changes. Adding a new CLI family
is a driver (plus a runtime plugin if it speaks an unsupported protocol);
nothing in the bus, transport, or existing drivers needs to change.

See [`docs/DRIVERS.md`](docs/DRIVERS.md) for the parser/control protocol and
how to add one.

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
│       │  Pty      ││   Exec     ││ ServerHttp │              │
│       │Controller ││ Controller ││ Controller │              │
│       └─────┬─────┘└─────┬──────┘└─────┬──────┘              │
│             ▼            ▼             ▼                     │
│       ┌─────────┐  ┌─────────┐   ┌─────────┐                 │
│       │  PTY    │  │  exec   │   │  HTTP   │                 │
│       │(agent)  │  │(agent)  │   │(server) │                 │
│       └─────────┘  └─────────┘   └─────────┘                 │
└──────────────────────────────────────────────────────────────┘

  HTTP /health        — liveness probe (no auth)
  WS   /rpc           — JSON-RPC 2.0 (Authorization: Bearer <token>)
```

Two keystone patterns:

- **Service Bus** (`src/core/bus.ts`) — pub/sub events + flat key-value
  state. `on()` returns an unsubscribe handle so plugins clean up cleanly.
  Plugins coordinate through agreed bus-key prefixes; nothing imports
  across plugins.
- **Plugin architecture** (`src/plugins/api.ts`) — every extension is a
  `CordycepsPlugin` declaring `methods`, lifecycle hooks, and bus
  subscriptions. Loaded in priority groups with topological sort. The
  `audit` plugin is the reference implementation.

For Mermaid diagrams of the spawn / send / response flow and the
manager-agent sequence, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
JSON-RPC method reference: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Notable design decisions

**Manager as peer, not special case.** The same JSON-RPC surface that powers
the `cordy` CLI also powers manager LLMs talking through `cordy mcp-stdio`.
A manager has zero capabilities beyond what an operator has — which means
every shell workflow tested manually maps directly to an agent's behavior.

**Glyph-based state machine over regex scraping.** PTY output is messy:
escape sequences, partial writes, spinner frames over the same cursor
position. The Claude parser walks Unicode glyphs (`●` message, `⎿` result,
`⏵`/`⏸` mode) as state-machine transitions and ships a fixture-replay
harness as a regression net. Regex would have to handle every render-time
race; a state machine fed by the actual TTY stream doesn't.

**Bus-coordinated plugins.** Plugins talk through `bus.on()` / `bus.emit()`
rather than importing each other's types. That keeps the plugin set
loosely coupled, lets the loader topo-sort by declared `order`, and makes
hot-load / unload practical without a registry refactor.

## What it isn't

- Not a human-facing TUI or web UI — pure agentic infrastructure.
- Not a provider SDK client (drives installed CLIs; no direct
  Anthropic / OpenAI / Google API calls). The trade-off is that you bring
  your own auth and pay for whatever the underlying CLI bills you for.
- Not a multi-machine orchestrator — the daemon is loopback-only by design.

## Persistence and security

- `~/.cordyceps/` (mode `0700`) — daemon state, instance files, optional
  audit logs (opt-in via `--audit`).
- `~/.cordyceps/instances/{pid}.json` (mode `0600`, atomic writes) — the
  client uses these to discover the running daemon and read its bearer
  token. The token is regenerated on every daemon start.
- `~/.cordyceps/env` (mode `0600`) — optional env file auto-loaded at
  daemon start. Shell env wins over file values. Useful for driver API
  keys like `GEMINI_API_KEY`. Override the path via `CORDY_ENV_FILE`;
  per-repo override is `<repo>/.cordyceps/env`.
- Loopback-only transport (`127.0.0.1`); upgrade rejects non-loopback
  Host / Origin headers as defense in depth.
- 192-bit bearer token (`base64url` of 24 random bytes), regenerated per
  daemon start, presented via `Authorization: Bearer <token>` on the
  upgrade request.
- The bearer token is shell-execution-equivalent — anyone who reads it can
  spawn arbitrary subprocess via cordy's spawn API. Treat it like an SSH
  key.

## Tests

```bash
pnpm test          # vitest, full suite green
pnpm build         # tsc clean
```

The repo uses pnpm; `npm test` and `npm run build` work too if you don't
have pnpm installed.

When a CLI release shifts glyph spacing, mode-line shape, or spinner
frames, the fixture-replay harness in `test/fixtures/` catches the drift
on the next test run and the fix lives in the relevant driver's directory.

## Status

Pre-1.0. Ships a working daemon, four built-in drivers, the council and
manager plugins, an MCP stdio bridge (experimental framing), and the
plugin / runtime registries. See [`STATUS.md`](STATUS.md) for what's in
progress and what's sketched.

## Contributing

Issues and PRs welcome. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
first if you're touching anything beyond a typo; touching a driver,
[`docs/DRIVERS.md`](docs/DRIVERS.md); touching a plugin,
[`docs/PLUGINS.md`](docs/PLUGINS.md).

## License

MIT — see [`LICENSE`](LICENSE).

Built by [Jocelyn Ellyse](https://github.com/ellyseum).
