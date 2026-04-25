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
  "version": "0.5.0"
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

Returns `{ ok, version, pid, uptime, drivers }` with no auth. Useful for
process supervisors. No other unauthenticated endpoints exist.

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

## Method namespaces

| Namespace        | Examples                                      | Purpose                                      |
|------------------|-----------------------------------------------|----------------------------------------------|
| `daemon.*`       | `daemon.health`, `daemon.stop`                | Daemon-level control.                        |
| `drivers.*`      | `drivers.list`, `drivers.probe`               | Driver introspection.                        |
| `agents.*`       | `agents.list`, `agents.spawn`, `agents.submit`, `agents.interrupt`, `agents.approve`, `agents.kill` | Lifecycle and I/O for individual agents.     |
| `bus.*`          | `bus.get`, `bus.set`, `bus.keys`              | Read / write the in-process KV state.        |
| `notifications.*`| `notifications.subscribe`, `notifications.unsubscribe` | Per-client subscription allowlist.           |
| `audit.*`        | `audit.tail`                                  | Optional plugin (opt-in via `--audit`).      |
| `council.*`      | `council.review`                              | Code review council plugin.                  |
| `manager.*`      | `manager.spawn`, `manager.tasks`              | Manager plugin (Claude-only at present).     |
| `peer.*`         | `peer.list`                                   | Peer-coordination plugin.                    |

For exact parameter shapes, the source of truth is `src/transport/methods.ts`
(core methods) and the `methods` map of each plugin in `src/plugins/builtin/`.

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
| `agent.message`    | `{ agentId, message }` — assistant message complete      |
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
server → client   { "jsonrpc": "2.0", "method": "agent.message", "params": { "agentId": "demo", "message": { "role": "assistant", "text": "4" } } }
server → client   { "jsonrpc": "2.0", "method": "agent.idle",    "params": { "agentId": "demo", "state": "idle" } }
server → client   { "jsonrpc": "2.0", "id": 2, "result": { "agentId": "demo", "messages": [...], "state": "idle" } }

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
