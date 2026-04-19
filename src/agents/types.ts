/**
 * Agent types — shared between drivers, runtimes, and the manager.
 */

import type { EventEmitter } from "node:events";

/** The transport mode backing an agent session. */
export type DriverMode = "pty" | "exec" | "server-ws" | "server-http";

/** What kind of thing is blocking an agent's progress, from its own perspective. */
export type BlockKind =
  | "tool-approval"
  | "plan-approval"
  | "confirmation"
  | "picker"
  | "auth"
  | "unknown";

/** Current state of an agent. Drivers parse this from their backend output. */
export interface AgentState {
  status: "starting" | "idle" | "busy" | "blocked" | "exited" | "unknown";
  model?: string;
  /** Permission mode or equivalent — driver-specific vocabulary */
  mode?: string;
  /** Most recent complete assistant message */
  lastMessage?: string;
  /** Current activity if busy (spinner label, elapsed time, tokens-so-far) */
  activity?: {
    label: string;
    duration?: string;
    tokens?: string;
  };
  /** Set when status === "blocked" */
  blocking?: {
    kind: BlockKind;
    prompt?: string;
  };
  tokens?: {
    used: number;
    contextRemaining?: number;
  };
  lastTool?: {
    name: string;
    args?: unknown;
  };
  /** Driver-specific extension bag */
  extra?: Record<string, unknown>;
}

export interface AssistantMessage {
  text: string;
  /** ISO timestamp */
  ts: string;
  tokens?: number;
  toolsUsed?: string[];
}

export interface AgentInfo {
  id: string;
  /** Canonical driver id (not alias) */
  driverId: string;
  mode: DriverMode;
  status: AgentState["status"];
  cwd: string;
  /** ISO timestamp */
  createdAt: string;
  exitCode?: number;
}

export interface SubmitOptions {
  /** Max ms to wait for the assistant message (default 120_000). Only used when expectMessage !== false. */
  timeoutMs?: number;
  /** If false, fire-and-forget — resolve immediately after submit without waiting for a message. Default true. */
  expectMessage?: boolean;
  /** If true and agent is busy, send an interrupt first. Default false. */
  interruptIfBusy?: boolean;
}

export interface SubmitResult {
  accepted: true;
  /** Present iff `expectMessage !== false` AND a message arrived before timeout. */
  message?: AssistantMessage;
}

/**
 * Events emitted on an AgentRuntime (and mirrored on the service bus):
 *
 *   output     — raw backend chunk (high-volume; prefer `state`/`message` for consumers)
 *   state      — (AgentState) — on every state transition
 *   message    — (AssistantMessage) — complete assistant turn
 *   blocked    — ({ kind, prompt }) — hit a prompt needing approval
 *   idle       — (AgentState) — transitioned to idle
 *   exit       — ({ code, signal }) — backend process exited
 */
export interface AgentRuntime extends EventEmitter {
  readonly id: string;
  readonly driverId: string;
  readonly mode: DriverMode;
  readonly state: AgentState;
  readonly transcript: AssistantMessage[];
  readonly cwd: string;
  /** ISO timestamp */
  readonly createdAt: string;
  readonly exited: boolean;
  readonly exitCode?: number;

  /** Resolves with the last emitted message (if any) when the backend exits. */
  readonly exitPromise: Promise<number>;

  // High-level operations — implementations translate to their backend
  submit(prompt: string, opts?: SubmitOptions): Promise<SubmitResult>;
  interrupt(reason?: string): Promise<void>;
  approve(): Promise<void>;
  reject(): Promise<void>;
  waitForIdle(timeoutMs?: number): Promise<AgentState>;
  waitForMessage(timeoutMs?: number): Promise<AssistantMessage>;

  /** Escape hatch for driver-specific flows (raw keystrokes, protocol messages). */
  rawWrite(data: string): void;

  kill(signal?: NodeJS.Signals): Promise<void>;

  /** Returns the current AgentInfo snapshot */
  info(): AgentInfo;
}
