/**
 * Fixture-replay harness for driver parsers.
 *
 * Loads a capture JSONL written by `cordy capture` and feeds the recorded
 * output chunks back through a `DriverParser` in sequence. Tests assert that
 * the resulting messages + final state match what was observed live.
 *
 * This protects against parser drift: when a CLI release shifts glyph spacing,
 * mode-line shape, or spinner frames, the same fixture fails instantly.
 */

import { readFileSync } from "node:fs";
import type { DriverParser, AgentState } from "../../src/drivers/api.js";
import type { AssistantMessage } from "../../src/agents/types.js";

export interface CaptureMeta {
  kind: "meta";
  agentId: string;
  driver: string;
  driverMode: string;
  driverVersion?: string;
  cliVersion?: string;
  supportedVersions?: string | null;
  cwd: string;
  capturedAt: string;
}

export interface OutputLine {
  kind: "output";
  t: number;
  len: number;
  hex: string;
  printable?: string;
}

export interface StateLine {
  kind: "state";
  t: number;
  state: AgentState;
}

export interface MessageLine {
  kind: "message";
  t: number;
  message: AssistantMessage;
}

export type CaptureLine = CaptureMeta | OutputLine | StateLine | MessageLine;

export interface ParsedCapture {
  meta: CaptureMeta;
  outputs: OutputLine[];
  states: StateLine[];
  messages: MessageLine[];
}

export function loadCapture(path: string): ParsedCapture {
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n").filter(Boolean);
  let meta: CaptureMeta | undefined;
  const outputs: OutputLine[] = [];
  const states: StateLine[] = [];
  const messages: MessageLine[] = [];

  for (const line of lines) {
    const parsed = JSON.parse(line) as CaptureLine;
    if (parsed.kind === "meta") meta = parsed;
    else if (parsed.kind === "output") outputs.push(parsed);
    else if (parsed.kind === "state") states.push(parsed);
    else if (parsed.kind === "message") messages.push(parsed);
  }

  if (!meta) throw new Error(`Capture ${path} has no meta header`);
  return { meta, outputs, states, messages };
}

export interface ReplayResult {
  finalState: AgentState;
  messages: AssistantMessage[];
  /** Sequence of states observed after every output chunk (throttled copies) */
  stateTrace: AgentState[];
}

/**
 * Feed every recorded output chunk through the parser in order, returning
 * all accumulated messages + the final state.
 */
export function replay(capture: ParsedCapture, parser: DriverParser): ReplayResult {
  let state = parser.initialState();
  const messages: AssistantMessage[] = [];
  const stateTrace: AgentState[] = [];

  for (const out of capture.outputs) {
    const chunk = Buffer.from(out.hex, "hex").toString("utf-8");
    const result = parser.feed(chunk, state);
    state = result.state;
    for (const m of result.messages) messages.push(m);
    stateTrace.push(structuredClone(state));
  }

  return { finalState: state, messages, stateTrace };
}
