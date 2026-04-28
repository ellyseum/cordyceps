# Protocol reference

Cordyceps speaks JSON-RPC 2.0 over a single WebSocket. This document covers
the wire details a client author needs: discovery, auth, the namespaces of
methods, and the notification stream.

For a runnable Node example see
[`../examples/basic-agent/`](../examples/basic-agent/).

## Discovery

The daemon writes an instance file on start:

```
~/.cordyceps/instances/<pid>.json    (mode 0600)
{
  "pid": 12345,
  "url": "ws://127.0.0.1:3247/rpc",
  "token": "<base64url-32char>",
  "port": 3247,
  "startedAt": "2026-04-28T...",
  "version": "0.5.0"   // example — actual value comes from package.json
}
```

A client picks the most recently started instance whose PID is still alive.
The directory is `0700`; the file is `0600`. Stale entries (dead PIDs) are
cleaned up on the next read.

## Auth

Token presented on the WS upgrade request:

```
Authorization: Bearer <token>      (preferred)
```

Or, for backward compat with older clients:

```
ws://127.0.0.1:<port>/rpc?token=<token>   (legacy)
```

Auth failure → HTTP 401 on the upgrade socket. No JSON-RPC session opens.
The compare is constant-time.

The transport also rejects (with 403) any upgrade whose `Host` or `Origin`
header isn't a loopback address, before checking the token at all. This is
defense in depth alongside the loopback bind.

## Liveness

```
GET http://127.0.0.1:<port>/health
```

Returns `{ ok, version, pid, uptime, methods }` with no auth. `methods` is
the count of registered JSON-RPC methods (a quick liveness signal that
plugins finished loading). Useful for process supervisors. No other
unauthenticated endpoints exist.

## Frame format

Standard JSON-RPC 2.0 over text frames:

```jsonc
// Request (client → server)
{ "jsonrpc": "2.0", "id": 1, "method": "agents.spawn", "params": { "driverId": "claude-code" } }

// Response
{ "jsonrpc": "2.0", "id": 1, "result": { "id": "...", "state": "idle", … } }

// Error response
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32602, "message": "...", "data": "..." } }

// Notification (server → client; no id)
{ "jsonrpc": "2.0", "method": "agent.message", "params": { "agentId": "foo", "message": { … } } }
```

## Method reference

This table is hand-maintained; the source of truth is
`src/transport/methods.ts` (core) and the `methods` map of each plugin
under `src/plugins/builtin/`. If something here disagrees with the code,
the code wins — open an issue.

### Core (`src/transport/methods.ts`)

| Method                       | Purpose                                                       |
|------------------------------|---------------------------------------------------------------|
| `daemon.health`              | Liveness + version + currently registered drivers + methods. |
| `daemons.list`               | Enumerate alive daemon instances on this machine.            |
| `agents.list`                | Snapshot of every registered agent.                          |
| `agents.spawn`               | Create a new agent. Params: `driverId`, `id?`, `cwd?`, `profile?`, `env?`. |
| `agents.get`                 | Look up one agent by id.                                     |
| `agents.kill`                | Send terminate to one agent.                                 |
| `agents.state`               | Current state (`idle` / `busy` / `blocked` / `exited` / …).  |
| `agents.transcript`          | Full transcript or last N entries.                           |
| `agents.submit`              | Send a prompt; resolves on idle. Params: `id`, `prompt`, `timeoutMs?`, `expectMessage?`, `interruptIfBusy?`. |
| `agents.interrupt`           | Cancel current work.                                         |
| `agents.approve`             | Approve a pending tool / permission request.                 |
| `agents.reject`              | Reject a pending tool / permission request.                  |
| `agents.raw`                 | Write raw bytes into the agent's input (driver-specific).    |
| `drivers.list`               | Every registered driver with its probe result.               |
| `drivers.get`                | One driver's probe result by id.                             |
| `bus.get`                    | Read one bus key.                                            |
| `bus.getByPrefix`            | Read all bus keys under a prefix.                            |
| `notifications.subscribe`    | Add events to this client's notification allowlist.          |
| `notifications.unsubscribe`  | Remove events from this client's allowlist.                  |

The bus is read-only over the wire — there's no `bus.set` exposed. Plugins
mutate the bus from inside the daemon process.

### Built-in plugins

| Method                       | Plugin    | Purpose                                                  |
|------------------------------|-----------|----------------------------------------------------------|
| `audit.tail`                 | audit     | Last N audit entries, optionally filtered by kind. Returns `[]` when audit is disabled. |
| `council.review`             | council   | Multi-family code review with chair synthesis.           |
| `manager.spawn`              | manager   | Spawn a manager agent wired with the cordy MCP bridge.   |
| `peer.ask`                   | peer      | Ask a one-shot prompt of another running agent.          |
| `peer.tell`                  | peer      | Forward a fire-and-forget message to another agent.      |

## Default subscriptions

A new client is subscribed to:

```
agent.created    plugin.ready    daemon.stopping
agent.state      agent.message   agent.blocked    agent.idle    agent.exited
```

The high-volume `agent.output` stream is opt-in via `notifications.subscribe`.
A client tunes its allowlist with:

```jsonc
{ "method": "notifications.subscribe",   "params": { "events": ["agent.output"] } }
{ "method": "notifications.unsubscribe", "params": { "events": ["agent.message"] } }
```

## Notifications by event

| Event              | Payload                                                  |
|--------------------|----------------------------------------------------------|
| `agent.created`    | `{ id, driverId, mode, cwd, status, profile? }`          |
| `agent.state`      | `{ agentId, state }` — state machine transition          |
| `agent.message`    | `{ agentId, message: { text, ts, tokens?, toolsUsed? } }` — assistant message complete |
| `agent.output`     | `{ agentId, data }` — raw chunk (opt-in)                 |
| `agent.blocked`    | `{ agentId, blocking }` — awaiting approval / tool use   |
| `agent.idle`       | `{ agentId, state }` — agent transitioned to idle        |
| `agent.exited`     | `{ agentId, exitCode, signal? }`                         |
| `plugin.ready`     | `{ name }` — plugin init complete                        |
| `daemon.stopping`  | `{ reason }` — shutdown imminent                         |

## End-to-end example

```
client → server   { "jsonrpc": "2.0", "id": 1, "method": "agents.spawn", "params": { "driverId": "claude-code", "id": "demo", "cwd": "/path/to/repo" } }
server → client   { "jsonrpc": "2.0", "id": 1, "result": { "id": "demo", "driverId": "claude-code", "mode": "exec", "cwd": "/path/to/repo", "status": "idle" } }
server → client   { "jsonrpc": "2.0", "method": "agent.created", "params": { "id": "demo", … } }

client → server   { "jsonrpc": "2.0", "id": 2, "method": "agents.submit", "params": { "id": "demo", "prompt": "what's 2+2?" } }
server → client   { "jsonrpc": "2.0", "method": "agent.state",   "params": { "agentId": "demo", "state": "busy" } }
server → client   { "jsonrpc": "2.0", "method": "agent.message", "params": { "agentId": "demo", "message": { "text": "4", "ts": "2026-04-25T13:11:48.501Z" } } }
server → client   { "jsonrpc": "2.0", "method": "agent.idle",    "params": { "agentId": "demo", "state": "idle" } }
server → client   { "jsonrpc": "2.0", "id": 2, "result": { "accepted": true, "message": { "text": "4", "ts": "2026-04-25T13:11:48.501Z" } } }

client → server   { "jsonrpc": "2.0", "id": 3, "method": "agents.kill", "params": { "id": "demo" } }
server → client   { "jsonrpc": "2.0", "method": "agent.exited", "params": { "agentId": "demo", "exitCode": 0 } }
server → client   { "jsonrpc": "2.0", "id": 3, "result": { "ok": true } }
```

## Error codes

Standard JSON-RPC 2.0 codes (`-32700` parse error, `-32600` invalid request,
etc.) plus cordyceps-specific:

| Code     | Meaning                                                  |
|----------|----------------------------------------------------------|
| `-32001` | Driver not available (probe failed).                     |
| `-32002` | Agent not found.                                         |
| `-32003` | Agent in wrong state for this operation.                 |
| `-32004` | Plugin error (specifics in `error.data`).                |

`error.data` carries a free-form message in development; production
deployments may want to scrub it.

## Stability

Pre-1.0. The shape of `agent.message` and the per-driver `profile` block
are the most likely places to evolve before 1.0. Subscribe early,
re-validate at every minor.
