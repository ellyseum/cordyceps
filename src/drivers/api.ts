/**
 * Driver interface — one adapter per CLI family.
 *
 * A driver is **mode-aware** from v1: it declares which transport modes it
 * supports (`"pty"`, `"exec"`, `"server-ws"`, `"server-http"`), and the
 * runtime factory registry (AgentManager) dispatches to the right factory.
 *
 * In v1 only `"pty"` mode is actually implemented in the runtime. The other
 * `build*` slots exist so driver authors can add them in phase 2+ without
 * changing core or the Claude driver.
 */

import type { AgentState, AssistantMessage, DriverMode } from "../agents/types.js";
import type { ServiceBus } from "../core/bus.js";

export type { DriverMode } from "../agents/types.js";

export interface Driver {
  /** Canonical id (e.g. "claude-code") */
  id: string;
  /** Human label */
  label: string;
  /** Driver version (informational; not tied to CLI version) */
  version: string;
  /** Accepted CLI aliases — `cordy spawn claude` resolves to this driver */
  aliases?: string[];
  /** Modes this driver can build, in order of preference */
  modes: DriverMode[];
  /**
   * Supported CLI version range — npm-style semver expression evaluated by the
   * probe. Values inside this range are `supported`; outside it are `untested`
   * (the driver will still try to work; users get a warning). Omit to accept any.
   * Example: ">=2.1.100 <2.2.0"
   */
  supportedVersions?: string;

  /** Is this CLI installed + usable here? */
  probe(): Promise<DriverProbe>;

  /** Required if `modes` includes "pty" */
  buildPtySpawn?(profile: DriverProfile): SpawnSpec;

  /** Required if `modes` includes "exec" */
  buildExec?(profile: DriverProfile, task: ExecTask): ExecSpec;

  /** Required if `modes` includes "server-ws" */
  buildServerWs?(profile: DriverProfile): ServerWsSpec;

  /** Required if `modes` includes "server-http" */
  buildServerHttp?(profile: DriverProfile): ServerHttpSpec;

  /** Parse backend output into AgentState + messages */
  parser: DriverParser;

  /** Translate high-level operations into backend-appropriate I/O */
  control: DriverControl;
}

export interface DriverProbe {
  available: boolean;
  version?: string;
  /** Driver-defined capability flags (e.g. `bareMode`, `mcpConfig`, `appServer`) */
  capabilities: Record<string, boolean>;
  warnings: string[];
  /** Modes actually usable on this machine (may be narrower than Driver.modes) */
  supportedModes: DriverMode[];
  /**
   * Compatibility of the detected version against `Driver.supportedVersions`:
   *   - "supported"   — in range, exercised in CI
   *   - "untested"    — out of range (or no version detected), may work but unverified
   *   - "unsupported" — known-broken range (set by driver when it needs to harden)
   *   - "any"         — driver doesn't declare a range
   */
  compat?: "supported" | "untested" | "unsupported" | "any";
}

export interface DriverProfile {
  cwd?: string;
  env?: Record<string, string>;
  /** Mode preference override (manager picks first from Driver.modes ∩ supportedModes ∩ registered factories if omitted) */
  mode?: DriverMode;
  /** Driver-specific config passed through */
  [key: string]: unknown;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** If true, only use provided env (not process.env) */
  cleanEnv?: boolean;
}

export interface ExecTask {
  prompt: string;
  /** Path to a JSON schema file for structured output (driver-dependent support) */
  outputSchema?: string;
  timeoutMs?: number;
}

export interface ExecSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Optional stdin payload piped into the process */
  stdin?: string;
  /** How to interpret stdout: "text" (single string), "json" (single object), or "jsonl" (line-delimited events) */
  parseOutput: "text" | "json" | "jsonl";
}

export interface ServerWsSpec {
  /** ws:// or wss:// URL to connect to */
  url: string;
  /** Optional bearer/auth header */
  authHeader?: string;
  /** Optional: driver may need to spawn the server subprocess itself */
  spawnServer?: SpawnSpec;
}

export interface ServerHttpSpec {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  /** Path used for `submit` operations (rest are driver-internal) */
  submitPath: string;
}

// ── Parser ────────────────────────────────────────────────────────────────

export interface DriverParser {
  /** Initial state for a new session */
  initialState(): AgentState;

  /** Feed one output chunk; returns updated state plus emitted events/messages */
  feed(chunk: string, state: AgentState): ParseResult;
}

export interface ParseResult {
  state: AgentState;
  events: ParserEvent[];
  messages: AssistantMessage[];
}

export interface ParserEvent {
  kind: string;             // driver-defined (e.g. "tool.call", "mode.changed")
  data: unknown;
}

// ── Control ───────────────────────────────────────────────────────────────

export interface ControlContext {
  agentId: string;
  state: AgentState;
  /** The profile this agent was spawned with — drivers read per-agent config here (model, temperature, etc.) */
  profile: DriverProfile;
  bus: ServiceBus;
  /** Low-level write — for PTY drivers this is raw bytes/keystrokes */
  write(data: string): void;
}

export interface DriverControl {
  /** Wait until the agent is idle/ready to accept input */
  waitForReady(ctx: ControlContext, timeoutMs: number): Promise<void>;

  /** Submit a prompt: clear input, type, enter, wait for busy/spinner */
  submit(ctx: ControlContext, text: string): Promise<void>;

  /** Interrupt (driver-specific: Escape for Claude, Ctrl+C for shells, etc.) */
  interrupt(ctx: ControlContext): Promise<void>;

  /** Approve a blocking prompt (y/n or equivalent) */
  approve(ctx: ControlContext): Promise<void>;

  /** Reject a blocking prompt */
  reject(ctx: ControlContext): Promise<void>;

  /** Optional: switch the active model mid-session */
  switchModel?(ctx: ControlContext, model: string): Promise<void>;

  /** Optional: switch permission/mode mid-session */
  switchMode?(ctx: ControlContext, mode: string): Promise<void>;

  /** Clean exit */
  quit(ctx: ControlContext): Promise<void>;
}
