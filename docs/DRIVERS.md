# Drivers

A **driver** adapts one CLI family to cordyceps' agent model. It declares
which **modes** it supports, exposes a **parser** that walks raw output and
emits state transitions and messages, and a **control** surface that
translates high-level operations (`submit` / `interrupt` / `approve` /
`reject` / `quit`) into transport-appropriate I/O.

The source of truth for the interface is `src/drivers/api.ts`. This page
is a guided tour; if it disagrees with the file, the file wins — open an
issue.

## Modes

| Mode          | Transport                                | Use when                                       |
|---------------|------------------------------------------|------------------------------------------------|
| `pty`         | node-pty over a real terminal            | The CLI is interactive (TUI, prompts, ANSI)    |
| `exec`        | one-shot subprocess; stdin / stdout      | The CLI takes one prompt and prints (`--print`, `exec --json`) |
| `server-http` | HTTP request / streaming response        | Already-running daemon (Ollama, llama.cpp)     |
| `server-ws`   | WebSocket endpoint                       | Persistent socket (custom server, futures)     |

`pty` is the most expressive — full TUI control: approve, reject,
mode-switch. `exec` is faster and more reliable for one-shot prompts; the
council uses `exec` for all reviewers when available. `server-*` modes
keep cordy out of the lifecycle of the underlying server.

A single driver can declare multiple modes; `claude-code` ships both
`pty` and `exec`. The runtime registry resolves a mode to a controller
factory at spawn time.

## The `Driver` interface

```ts
interface Driver {
  readonly id: string;             // canonical id, e.g. "claude-code"
  readonly label: string;          // human label
  readonly version: string;        // driver version, not CLI version
  readonly aliases?: string[];     // CLI aliases, e.g. ["claude"]
  readonly modes: DriverMode[];    // in order of preference
  readonly supportedVersions?: string;  // semver range against the CLI

  parser: DriverParser;
  control: DriverControl;

  probe(): Promise<DriverProbe>;

  // Implement the build*() that matches each declared mode:
  buildPtySpawn?(profile: DriverProfile): SpawnSpec;
  buildExec?(profile: DriverProfile, task: ExecTask): ExecSpec;
  buildServerWs?(profile: DriverProfile): ServerWsSpec;
  buildServerHttp?(profile: DriverProfile): ServerHttpSpec;
}
```

`probe()` is the operator-facing diagnostic surface. Return:

```ts
{
  available: boolean;
  version?: string;
  capabilities: Record<string, boolean>;  // driver-defined feature flags
  warnings: string[];
  supportedModes: DriverMode[];           // narrower than Driver.modes if some can't run here
  compat?: "supported" | "untested" | "unsupported" | "any";
}
```

`compat` is graded against `supportedVersions` by the registry; the
driver doesn't compute it.

## Spawn / exec / server specs

Every `build*` returns a spec the runtime feeds into the right transport:

```ts
interface SpawnSpec {        // pty
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cleanEnv?: boolean;
}

interface ExecSpec {         // exec
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;            // optional payload piped into stdin
  parseOutput: "text" | "json" | "jsonl";  // how the runtime should chunk stdout
}

interface ServerHttpSpec {   // server-http
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  submitPath: string;        // path the runtime POSTs prompts to
}

interface ServerWsSpec {     // server-ws
  url: string;
  authHeader?: string;
  spawnServer?: SpawnSpec;   // if cordy needs to start the server itself
}
```

## DriverParser

A parser is a state machine. It returns `{ state, events, messages }`
each time it's fed a chunk:

```ts
interface DriverParser {
  initialState(): AgentState;
  feed(chunk: string, state: AgentState): ParseResult;
}

interface ParseResult {
  state: AgentState;
  events: ParserEvent[];      // driver-defined ("tool.call", "mode.changed", …)
  messages: AssistantMessage[];
}

interface AssistantMessage {
  text: string;
  ts: string;                 // ISO timestamp
  tokens?: number;
  toolsUsed?: string[];
}
```

For PTY drivers the input is *raw* — escape sequences, partial writes,
spinner frames repainted over the same cursor position. The parser walks
unicode glyphs as state-machine transitions. The Claude parser at
`src/drivers/claude/parser.ts` is the worked example:

| Glyph        | Meaning                                |
|--------------|----------------------------------------|
| `●`          | Assistant message turn complete        |
| `⎿`          | Tool / function result block           |
| Spinner glyphs (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) | Busy indicator                |
| `⏵` / `⏸`    | Mode-line render (auto-accept on/off)  |

Why glyphs and not regex: PTY output ships as bytes, with the cursor
moving in the middle of a render. A regex needs to handle every
render-time race. A state machine fed by the actual stream doesn't.

For exec drivers the input is JSON-per-line (`codex exec --json`,
`gemini --output-format stream-json`). The parser still walks events but
the surface is much smaller.

## DriverControl

```ts
interface DriverControl {
  waitForReady(ctx: ControlContext, timeoutMs: number): Promise<void>;
  submit(ctx: ControlContext, text: string): Promise<void>;
  interrupt(ctx: ControlContext): Promise<void>;
  approve(ctx: ControlContext): Promise<void>;
  reject(ctx: ControlContext): Promise<void>;
  switchModel?(ctx: ControlContext, model: string): Promise<void>;
  switchMode?(ctx: ControlContext, mode: string): Promise<void>;
  quit(ctx: ControlContext): Promise<void>;
}

interface ControlContext {
  agentId: string;
  state: AgentState;
  profile: DriverProfile;
  bus: ServiceBus;
  write(data: string): void;   // raw write — for PTY drivers, raw keystrokes
}
```

For exec / server modes, several of these reduce to small no-ops or
HTTP-call equivalents — there's no interrupt for a one-shot subprocess
that hasn't started, etc.

## Versions and probes

Every driver declares an optional `supportedVersions` semver range.
`probe()` reads the installed CLI version; `gradeCompat()` (in
`src/core/semver.ts`) grades it as `supported` / `untested` /
`unsupported` / `any`. `untested` adds a warning to the probe output but
doesn't block; `unsupported` blocks spawn.

Wider ranges tolerate CLI minor bumps but risk parser drift. Narrower
ranges catch drift early but break first-run for any user on a fresh
release. Default to a half-open range that covers the latest major.

## Adding a driver

1. **Scaffold.** Copy `src/drivers/claude/` (full PTY example) or
   `src/drivers/codex/` (exec-only example) into `src/drivers/<name>/`.
2. **Trim.** Delete what doesn't apply — many drivers won't need a
   `tui.ts`, `session.ts`, or model/mode switching.
3. **Wire.** Register the driver in `src/drivers/index.ts`'s
   `createBuiltinDriverRegistry()`.
4. **Test.** Add `test/drivers/<name>/parser.test.ts` and feed it raw
   output samples. For PTY drivers, capture real output via
   `cordy capture` and use it as a fixture under
   `test/fixtures/<driver>/<version>/<scenario>.jsonl`.
5. **Verify.** Spawn through `cordy doctor`, `cordy spawn <driver>`, and
   one round-trip prompt before declaring it shipped.

The goal is that everything CLI-specific lives in the driver directory
and nothing else has to change.

## Capturing PTY output for fixtures

When a CLI release shifts spacing, glyph choice, or message envelope,
the fastest path to a fix is replaying captured output:

```bash
cordy spawn claude --name drift
cordy capture drift --duration 30 &
cordy send drift "small repro of the new behavior"
# → .cordyceps/captures/drift-<ts>.jsonl
```

Each line is one event. The `meta` header records the driver id, driver
version, CLI version, and the driver's tested range — so the fixture
captures the full context for a future regression check.

Captures drop into `test/fixtures/<driver>/<version>/` and feed back
through the parser via `loadCapture` + `replay` from
`test/fixtures/replay.ts`. When a CLI release breaks the parser, the
fixture fails on the next `pnpm test` and the fix lives in the driver's
parser file.
