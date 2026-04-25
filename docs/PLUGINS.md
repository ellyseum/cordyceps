# Plugins

A **plugin** extends the daemon by registering JSON-RPC methods,
subscribing to bus events, emitting notifications, or adding new agent
runtimes. The reference implementation is the `audit` plugin at
`src/plugins/builtin/audit/index.ts` — read it alongside this doc.

External plugin packaging is not yet a stable surface. The current loader
walks an explicit list of in-tree built-ins. Treat anything outside that
list as experimental.

## The `CordycepsPlugin` interface

```ts
interface CordycepsPlugin {
  name: string;                              // unique
  description?: string;
  version?: string;

  /** Loaded in priority groups (lower first); topo-sorted within. */
  order?: { priority?: number; after?: string[]; before?: string[] };

  /** CLI flags this plugin accepts. Wired by the engine when present. */
  flags?: PluginFlag[];

  /** Subcommands surfaced under `cordy <name> ...` (advisory; not yet wired). */
  subcommands?: PluginSubcommand[];

  /** JSON-RPC method handlers registered on the dispatcher. */
  methods?: Record<string, (params: unknown, ctx: RpcContext) => Promise<unknown>>;

  /** Lifecycle. */
  init?(ctx: PluginContext): Promise<void>;
  destroy?(ctx: PluginContext): Promise<void>;
}
```

Plugins are loaded once at daemon startup. Hot reload is not currently
supported.

## `PluginContext`

`init` receives a fully wired context:

```ts
interface PluginContext {
  bus: ServiceBus;                          // pub/sub events + KV state
  agents: AgentManager;                     // spawn / kill / list
  drivers: DriverRegistry;                  // probe / list / add runtime
  rpc: RpcContext;                          // notify / register / unregister
  config: PluginConfig;                     // settings + flag overrides
  logger: Logger;
  cwd: string;                              // daemon's startup cwd

  emit(event: string, data: unknown): void;            // bus.emit
  notify(method: string, params: unknown): void;       // broadcast JSON-RPC notification

  /** Auto-cleaned on destroy. */
  subscribe(event: string, cb: (data?: unknown) => void): () => void;

  /** Register a custom disposer to run on destroy. */
  onDestroy(fn: () => void | Promise<void>): void;
}
```

Anything registered via `subscribe` or `onDestroy` is automatically torn
down when the plugin destroys; you don't have to track unsubscribes
manually.

## Topological order

Plugins declare `order.after` (must load after named plugins) and
`order.before` (must load before). The loader groups by `order.priority`
(default 0; lower numbers load first), then runs a topological sort within
each group. Cycles throw at startup with a clear message.

Built-in priorities:

| Priority | Group                                            |
|----------|--------------------------------------------------|
| 5        | Runtime registrants (`runtime-exec`, `runtime-server-*`) — must register before anything spawns. |
| 10       | Audit (so it can see everything that follows).   |
| 20       | Council (consumer of agents; depends on runtimes).|
| 20       | Manager / peer (same).                           |

User plugins default to priority `0` (loaded first); set higher to load
later.

## Method registration

```ts
const plugin: CordycepsPlugin = {
  name: "myplugin",
  methods: {
    "myplugin.echo": async (params) => {
      return { you_sent: params };
    },
  },
};
```

Methods land on the dispatcher under their declared names. Namespacing is
a convention, not enforcement — pick a unique prefix and stick to it.
`destroy` automatically unregisters everything in `methods`.

## Bus subscriptions

```ts
init(ctx) {
  ctx.subscribe("agent.created", (info) => {
    const id = (info as { id?: string })?.id;
    if (!id) return;

    // Per-agent dynamic event names. Subscribe inside the static one.
    const unsub = ctx.bus.on(`agent.${id}.message`, (m) => {
      // ... do something with the message
    });
    ctx.onDestroy(unsub);
  });
}
```

Events come from cordy core, from agent runtimes, and from other plugins
that emit. The bus key namespace is documented in
[`ARCHITECTURE.md`](ARCHITECTURE.md#bus-key-conventions); plugins should
pick a prefix and stick to it.

## Emitting notifications

`ctx.notify(method, params)` broadcasts a JSON-RPC notification to every
WS client subscribed to that method name. Use it for live-tailing UIs.
For internal coordination (other plugins, in-process consumers), prefer
`ctx.emit(event, data)` (bus event) — same data, no round-trip through
the transport.

## Runtime plugins

A **runtime plugin** registers an `AgentRuntime` factory for a mode the
core doesn't know about. The built-in `runtime-exec`, `runtime-server-ws`,
and `runtime-server-http` plugins all do this. They make the agent
manager mode-pluggable without core changes:

```ts
init(ctx) {
  ctx.agents.registerRuntime("exec", (driver, opts) => new ExecAgentRuntime(driver, opts));
}
```

If you're adding a new transport (gRPC, ZeroMQ, named pipe), add a
runtime plugin alongside your driver and let the registry connect them.

## Audit plugin walk-through

Read `src/plugins/builtin/audit/index.ts` end to end. It demonstrates:

- **Opt-in via flags.** `flags: [{ name: "--audit", … }]`; `init` checks
  `ctx.config.flags["--audit"] === true || ctx.config.settings.enabled`.
  Default-off; explicit opt-in.
- **Method registration.** `audit.tail` returns recent entries from the
  on-disk JSONL.
- **Bus subscription with auto-cleanup.** `ctx.subscribe(...)` for static
  events; nested `ctx.bus.on()` + `ctx.onDestroy()` for per-agent dynamic
  event names.
- **Notification emission.** Every write fires `audit.entry.written` for
  any subscribed dashboard.
- **Lazy filesystem path.** Default audit dir is computed via `homedir()`
  at `init` time (not module load) so test redirection of `process.env.HOME`
  works.

Total file: ~120 lines. Anything beyond that complexity probably wants
splitting into multiple files — at which point the plugin becomes a small
package whose entry exports the `CordycepsPlugin` shape.
