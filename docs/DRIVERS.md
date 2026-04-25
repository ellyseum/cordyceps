# Drivers

A **driver** adapts one CLI family to cordyceps' agent model. It declares
which **modes** it supports, exposes a **parser** that walks raw output and
emits state transitions and messages, and a **control** surface that
implements `submit` / `interrupt` / `approve` / `reject` / `kill`.

## Modes

| Mode          | Transport                                | Use when                                       |
|---------------|------------------------------------------|------------------------------------------------|
| `pty`         | node-pty over a real terminal            | The CLI is interactive (TUI, prompts, ANSI)    |
| `exec`        | one-shot subprocess; stdin / stdout      | The CLI takes one prompt and prints (`--print`, `exec --json`) |
| `server-http` | HTTP streaming endpoint                  | Already-running daemon (Ollama, llama.cpp)     |
| `server-ws`   | WebSocket endpoint                       | Persistent socket (custom server, futures)     |

`pty` is the most expressive (full TUI control: approve, reject,
mode-switch). `exec` is faster and more reliable for one-shot prompts —
the council uses `exec` for all reviewers when available. `server-*` modes
keep cordy out of the lifecycle of the underlying server.

A single driver can declare multiple modes; `claude-code` ships both `pty`
and `exec`. `AgentManager` resolves a `mode` to a runtime factory at spawn
time.

## The `Driver` interface

```ts
interface Driver {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly label: string;
  readonly modes: readonly DriverMode[];
  readonly supportedVersions: string;     // semver range

  parser: DriverParser;
  control: DriverControl;

  /** Probe the local environment: is the binary present, what version, capabilities. */
  probe(): Promise<DriverProbe>;

  /** Build the spawn shape for `pty` mode. */
  buildPtySpawn?(opts: SpawnOpts): { binary: string; args: string[]; env?: Record<string, string> };

  /** Build the spawn shape for `exec` mode. */
  buildExec?(opts: SpawnOpts): { binary: string; args: string[]; env?: Record<string, string>; promptArg?: number };

  /** server-http / server-ws modes: connection details. */
  buildServerEndpoint?(opts: SpawnOpts): { url: string; method?: string; headers?: Record<string, string> };
}
```

`probe()` is the operator-facing diagnostic surface. Return:

```ts
{
  available: boolean;
  version?: string;
  path?: string;                         // optional — diagnostic only
  capabilities: Record<string, boolean>; // e.g. { mcpConfig: true, effort: false }
  warnings: string[];
  supportedModes: DriverMode[];
}
```

## DriverParser

A parser is a state machine. It receives chunks of output via `feed(chunk)`
and emits `{ state, events, messages }`:

```ts
interface DriverParser {
  feed(chunk: string | Buffer): {
    state: AgentState;                   // 'idle' | 'busy' | 'blocked' | 'exited' | …
    events: ParserEvent[];               // 'mode-switch', 'spinner-start', 'tool-request', …
    messages: AssistantMessage[];        // assembled, ready to publish
  };
  reset(): void;
}
```

For PTY drivers the input is *raw* — escape sequences, partial writes,
spinner frames repainted over the same cursor position. The parser walks
unicode glyphs as state transitions. The Claude parser at
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
  submit(input: { write(s: string): void; sendKey(seq: string): void }, prompt: string): Promise<void>;
  interrupt?(input: …): Promise<void>;
  approve?(input: …): Promise<void>;
  reject?(input: …): Promise<void>;
  switchModel?(input: …, model: string): Promise<void>;
  switchMode?(input: …, mode: string): Promise<void>;
}
```

Each method receives an opaque `input` whose `write` and `sendKey` operate
on the underlying transport (PTY for `pty`, stdin for `exec`, HTTP body
for `server-http`). The control implementation translates the high-level
operation into the right key sequence or message.

For exec / server modes, several of these are no-ops — there's no
interrupt for a one-shot subprocess that hasn't started, etc.

## Versions and probes

Every driver declares a `supportedVersions` semver range. `probe()` reads
the installed CLI version; `gradeCompat()` (in `src/core/semver.ts`) grades
the result as `tested` / `untested` / `unsupported`. `untested` adds a
warning to the probe output but doesn't block; `unsupported` blocks
spawn.

Wider ranges are more tolerant of CLI minor bumps but risk parser drift.
Narrower ranges catch drift early but break first-run for any user on a
fresh release. We default to the half-open range that covers the latest
major.

## Adding a driver

1. **Scaffold.** Copy `src/drivers/claude/` (full PTY example) or
   `src/drivers/codex/` (exec-only example) into `src/drivers/<name>/`.
2. **Trim.** Delete what doesn't apply — many drivers won't need a
   `tui.ts`, `session.ts`, or model/mode switching.
3. **Wire.** Register the driver in `src/drivers/index.ts`'s
   `createBuiltinDriverRegistry()`.
4. **Test.** Add a `test/drivers/<name>/parser.test.ts` and feed it raw
   output samples. For PTY drivers, capture real output via
   `cordy capture` and use it as a fixture under
   `test/fixtures/<driver>/<version>/<scenario>.jsonl`.
5. **Verify.** Spawn through `cordy doctor`, `cordy spawn <driver>`, and
   one round-trip prompt before declaring it shipped.

The goal is that everything CLI-specific lives in the driver directory
and nothing else has to change.

## Capturing PTY output for fixtures

When a CLI release shifts spacing, glyph choice, or message envelope, the
fastest path to a fix is replaying captured output:

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
