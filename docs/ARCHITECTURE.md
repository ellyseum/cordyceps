# Architecture

This is a five-minute orientation. For the JSON-RPC method reference see
[`PROTOCOL.md`](PROTOCOL.md); for the driver authoring guide,
[`DRIVERS.md`](DRIVERS.md); for plugins, [`PLUGINS.md`](PLUGINS.md).

## System topology

```mermaid
flowchart LR
  subgraph clients [Clients]
    cli[cordy CLI]
    mcp[MCP-bridged LLM]
    mgr[Manager LLM]
    sdk[Custom Node client]
  end

  subgraph daemon [Cordyceps daemon]
    direction LR
    transport[Transport<br/>HTTP /health · WS /rpc]
    bus[Service Bus<br/>events + KV state]
    plugins[Plugins<br/>audit · council · manager · …]
    manager_[Agent Manager<br/>+ Runtime Registry]

    transport --> bus
    bus <--> plugins
    plugins --> manager_
    manager_ --> bus
  end

  subgraph controllers [Per-agent controllers]
    pty[PtyController]
    exec[ExecController]
    swh[ServerHttpController]
    sws[ServerWsController]
  end

  subgraph cli_agents [Backend CLIs]
    claude[claude]
    codex[codex]
    gemini[gemini]
    ollama[ollama daemon]
  end

  cli  --> transport
  mcp  --> transport
  mgr  --> transport
  sdk  --> transport

  manager_ --> pty
  manager_ --> exec
  manager_ --> swh
  manager_ --> sws

  pty  --> claude
  exec --> codex
  exec --> gemini
  swh  --> ollama
```

The daemon is the only process that owns PTY state. Clients are stateless.

## Spawn → send → response

The most interesting flow in the system is what happens between
`cordy send foo "hello"` and the response landing on stdout. Sequence:

```mermaid
sequenceDiagram
  autonumber
  participant U as User shell
  participant C as cordy CLI
  participant T as Transport (WS /rpc)
  participant M as AgentManager
  participant Ctl as Controller (Pty/Exec/…)
  participant CLI as Agent CLI process

  U->>C: cordy send foo "hello"
  C->>T: agents.submit { id:"foo", prompt:"hello" }
  T->>M: dispatch
  M->>Ctl: ctl.submit("hello")
  Ctl->>CLI: write to PTY / spawn exec
  CLI-->>Ctl: tokens / events
  Ctl-->>M: emit agent.foo.message
  M-->>T: bus event → JSON-RPC notification
  T-->>C: subscribed clients receive notification
  Ctl-->>M: agent.foo.idle
  M-->>T: idle notification
  T-->>C: agents.submit returns final transcript
  C-->>U: print response on stdout
```

`agents.submit` blocks until the agent is idle; subscribed clients see
intermediate `agent.message` and `agent.output` events along the way.

## Manager-agent pattern

The differentiator. A manager LLM is a regular WS client with the same
methods as the human-driven CLI:

```mermaid
sequenceDiagram
  autonumber
  participant H as Human
  participant M as Manager LLM
  participant T as Daemon transport
  participant P as Peer agent (Codex)

  H->>M: cordy manager "review this branch"
  M->>T: agents.spawn { driverId: "codex" }
  T-->>M: { id: "peer-1", state: "idle" }
  M->>T: notifications.subscribe ["agent.message"]
  M->>T: agents.submit { id: "peer-1", prompt: "review …" }
  T->>P: spawn codex exec
  P-->>T: tokens
  T-->>M: agent.message notifications
  P-->>T: idle
  T-->>M: agents.submit returns transcript
  M->>T: agents.kill { id: "peer-1" }
  M-->>H: synthesized review on stdout
```

Capability parity is the whole point — the manager has every tool an
operator has, no more.

## Agent state machine

```mermaid
stateDiagram-v2
  [*] --> Spawning
  Spawning --> Idle: ready
  Idle --> Busy: submit
  Busy --> Blocked: tool / approval needed
  Blocked --> Busy: approve / reject
  Busy --> Idle: response complete
  Idle --> Exited: kill / EOF
  Busy --> Exited: kill
  Blocked --> Exited: kill
  Exited --> [*]
```

`agent.{id}.state` events fire on every transition. Subscribers can build
their own UIs or coordination logic on top.

## Bus key conventions

The bus is a flat keyspace. Static prefixes (used by core):

| Prefix              | Meaning                                                      |
|---------------------|--------------------------------------------------------------|
| `agent.created`     | New agent registered (event)                                 |
| `agent.<id>.state`  | Per-agent state transitions (event)                          |
| `agent.<id>.message`| Per-agent assistant message complete (event)                 |
| `agent.<id>.output` | Per-agent raw output chunk (event, opt-in subscription)      |
| `agent.<id>.blocked`| Per-agent waiting for tool approval (event)                  |
| `agent.<id>.idle`   | Per-agent idle transition (event)                            |
| `agent.<id>.exited` | Per-agent exit (event)                                       |
| `plugin.ready`      | Plugin completed init (event)                                |
| `daemon.stopping`   | Shutdown signal (event)                                      |
| `transport.url`     | Daemon WS URL (KV; non-secret)                               |
| `transport.port`    | Daemon listen port (KV; non-secret)                          |

Plugins coordinate by agreeing on namespaces — the council plugin uses
`council.<id>.…`, audit uses `audit.entry.written`, etc. Nothing imports
across plugins.

## Plugin lifecycle

Loaded in two phases:

1. **Discover** — `discoverBuiltins()` walks an explicit list of in-tree
   plugins. There is no dynamic file-system import; third-party plugins
   are not yet a stable surface.
2. **Sort + load** — `sortPlugins()` groups by `order.priority` (lower
   first), then topologically sorts within each group by `order.after` /
   `order.before`. `loadPlugin()` registers RPC methods, fires `init(ctx)`,
   and tracks unsubscribes / destroyers for clean teardown.

`init` receives a `PluginContext` with `bus`, `agents`, `drivers`, `rpc`,
`config`, `logger`, `cwd`, `subscribe()` (auto-cleaned), `onDestroy()`, and
helpers `emit` / `notify`. On daemon shutdown, `destroyPlugin()` runs in
reverse load order: methods unregister, subscriptions tear down, custom
disposables run.

## Why JSON-RPC over WebSocket

Two requirements drove the choice:

- **Bidirectional in one channel.** The same socket carries client → server
  RPC and server → client notifications. HTTP+SSE would have meant two
  connections to keep in sync; gRPC would have added a code-gen step that
  doesn't pay back at this scale.
- **MCP compatibility.** MCP itself is JSON-RPC over stdio; cordy speaks
  the same wire format on a different transport. The bridge from one to
  the other is mostly framing logic, not protocol translation.

The trade-off: WebSocket frame size limits and head-of-line blocking. Both
are acceptable for a control plane that almost never moves more than a few
KB per call.

## Why driver modes are first-class

A `pty`-only abstraction would have forced exec-only CLIs (Codex, Gemini)
through a fake terminal. Worse: HTTP-streaming services (Ollama) don't fit
PTY semantics at all. Modes (`pty`, `exec`, `server-ws`, `server-http`) let
each driver pick the right transport, and the runtime registry resolves
modes to controllers without touching core. Adding a new family is a
driver plus (sometimes) a runtime plugin; nothing in the bus, transport,
or other drivers has to change.

## Security posture (high-level)

- Transport binds to `127.0.0.1`. Upgrade rejects non-loopback Host /
  Origin as defense in depth.
- 192-bit bearer token, regenerated per daemon start, presented via
  `Authorization: Bearer <token>` (preferred) or `?token=` query string
  (legacy). Compare is constant-time.
- Instance file (`~/.cordyceps/instances/<pid>.json`) is mode `0600`,
  written via tmp + atomic rename so external readers never see partial
  tokens.
- Subprocess spawning everywhere uses array args (`execFileSync`,
  `spawn`); no `shell: true`, no string concatenation.
- Plugin loader uses static imports only — no path traversal surface.

The bearer token is shell-execution-equivalent. Treat it like an SSH key.

## Where to read next

- Add a new CLI family → [`DRIVERS.md`](DRIVERS.md).
- Add a plugin (RPC methods, bus subscriptions) → [`PLUGINS.md`](PLUGINS.md).
- Build a Node client against the daemon → [`PROTOCOL.md`](PROTOCOL.md) and
  [`../examples/basic-agent/`](../examples/basic-agent/).
