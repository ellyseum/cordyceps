# Example: basic agent client

Self-contained Node.js script that connects to a running cordyceps daemon
over its JSON-RPC WebSocket, spawns a Claude agent, submits one prompt,
and tears down.

This is the simplest possible client — no framework, no bundler, no
abstractions. The point is to show the JSON-RPC client interface as it
actually is.

## Prerequisites

- [`@ellyseum/cordyceps`](https://www.npmjs.com/package/@ellyseum/cordyceps)
  installed (`npm i -g @ellyseum/cordyceps`).
- The `claude` CLI installed and authenticated.
- A running cordy daemon: `cordy daemon start`.

## Run

```bash
node examples/basic-agent/index.mjs
```

You should see, roughly:

```
→ daemon ws://127.0.0.1:3247/rpc (pid 12345, version 0.5.0)
→ spawned demo (claude-code exec)
← pong
→ assistant message: pong
→ killed
```

## What it demonstrates

- **Discovery**: read the latest instance file from `~/.cordyceps/instances/`
  to find the daemon URL and bearer token.
- **Auth**: present the token in the `Authorization` header on the WS
  upgrade.
- **JSON-RPC**: a tiny `call()` helper threads `id` ↔ `Promise` mapping;
  every RPC is one line.
- **Live notifications**: `agent.message` events stream in alongside the
  `agents.submit` request → response cycle.
- **Cleanup**: kill the agent, close the socket, exit.

For the full method reference see [`../../docs/PROTOCOL.md`](../../docs/PROTOCOL.md).
For architecture context, [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
