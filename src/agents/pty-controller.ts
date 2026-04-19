/**
 * PtyAgentController — v1's only AgentRuntime implementation, backed by node-pty.
 *
 * Lifecycle:
 *   1. constructor(driver, profile, opts) — creates PtyProcess but doesn't spawn yet
 *   2. start() — spawns the PTY, wires data → parser → state events
 *   3. submit/interrupt/approve/etc — driver.control methods translated to PTY I/O
 *   4. kill() — sends SIGTERM, waits for exit
 *
 * Bus integration: every state change and message is mirrored to the bus
 * (`agent.{id}.state`, `agent.{id}.transcript`, etc.) so plugins can react
 * without holding a direct reference to this controller.
 */

import { EventEmitter } from "node:events";
import { PtyProcess } from "../core/pty.js";
import type { Driver, DriverProfile } from "../drivers/api.js";
import type { ServiceBus } from "../core/bus.js";
import type { Logger } from "../core/logger.js";
import type {
  AgentInfo,
  AgentRuntime,
  AgentState,
  AssistantMessage,
  DriverMode,
  SubmitOptions,
  SubmitResult,
} from "./types.js";

const SCROLLBACK_MAX = 500;
const DEFAULT_SUBMIT_TIMEOUT_MS = 120_000;

export interface PtyAgentControllerOpts {
  id: string;
  driver: Driver;
  profile: DriverProfile;
  cwd: string;
  bus: ServiceBus;
  logger: Logger;
}

export class PtyAgentController extends EventEmitter implements AgentRuntime {
  readonly id: string;
  readonly driverId: string;
  readonly mode: DriverMode = "pty";
  readonly cwd: string;
  readonly createdAt: string;

  private _state: AgentState;
  private _transcript: AssistantMessage[] = [];
  private _scrollback: string[] = [];
  private _exited = false;
  private _exitCode?: number;

  private readonly driver: Driver;
  private readonly profile: DriverProfile;
  private readonly bus: ServiceBus;
  private readonly logger: Logger;
  private readonly pty: PtyProcess;
  private readonly _exitDeferred: { resolve: (n: number) => void; promise: Promise<number> };

  constructor(opts: PtyAgentControllerOpts) {
    super();
    this.id = opts.id;
    this.driver = opts.driver;
    this.driverId = opts.driver.id;
    this.profile = opts.profile;
    this.cwd = opts.cwd;
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.createdAt = new Date().toISOString();

    if (!opts.driver.buildPtySpawn) {
      throw new Error(`Driver ${opts.driver.id} does not implement buildPtySpawn`);
    }

    const spawnSpec = opts.driver.buildPtySpawn({ ...opts.profile, cwd: opts.cwd });
    this.pty = new PtyProcess({
      command: spawnSpec.command,
      args: spawnSpec.args,
      cwd: spawnSpec.cwd,
      env: spawnSpec.env,
      cleanEnv: spawnSpec.cleanEnv,
    });

    this._state = opts.driver.parser.initialState();

    let resolveExit!: (n: number) => void;
    const promise = new Promise<number>((resolve) => { resolveExit = resolve; });
    this._exitDeferred = { resolve: resolveExit, promise };

    this.publishState();
    this.bus.set(`agent.${this.id}.driver`, opts.driver.id);
    this.bus.set(`agent.${this.id}.cwd`, opts.cwd);
    this.bus.set(`agent.${this.id}.mode`, this.mode);
  }

  /** Spawn the PTY and start parsing. */
  start(): void {
    this.pty.on("data", (data) => this.onPtyData(data));
    this.pty.on("exit", ({ code, signal }) => this.onPtyExit(code, signal));
    this.pty.spawn();
    this.logger.info("agent", `spawned ${this.id} (driver=${this.driverId}, pid=${this.pty.pid})`);
  }

  // ── AgentRuntime interface ─────────────────────────────────────────────

  get state(): AgentState { return this._state; }
  get transcript(): AssistantMessage[] { return this._transcript; }
  get exited(): boolean { return this._exited; }
  get exitCode(): number | undefined { return this._exitCode; }
  get exitPromise(): Promise<number> { return this._exitDeferred.promise; }

  info(): AgentInfo {
    return {
      id: this.id,
      driverId: this.driverId,
      mode: this.mode,
      status: this._state.status,
      cwd: this.cwd,
      createdAt: this.createdAt,
      exitCode: this._exitCode,
    };
  }

  async submit(prompt: string, opts: SubmitOptions = {}): Promise<SubmitResult> {
    if (this._exited) throw new Error(`Agent ${this.id} has exited`);

    if (opts.interruptIfBusy && this._state.status === "busy") {
      await this.interrupt("submit-pre-interrupt");
    }

    const expectMessage = opts.expectMessage !== false;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;

    // Set up a wait for the next message BEFORE submitting (race-free)
    let messagePromise: Promise<AssistantMessage> | null = null;
    if (expectMessage) {
      messagePromise = this.waitForMessage(timeoutMs);
    }

    await this.driver.control.submit(this.controlContext(), prompt);

    if (!messagePromise) {
      return { accepted: true };
    }

    try {
      const message = await messagePromise;
      return { accepted: true, message };
    } catch (err) {
      // Timeout — still accepted, just no message captured
      this.logger.warn("agent", `submit on ${this.id} accepted but timed out: ${(err as Error).message}`);
      return { accepted: true };
    }
  }

  async interrupt(reason?: string): Promise<void> {
    if (this._exited) return;
    this.logger.info("agent", `interrupting ${this.id}${reason ? ` (${reason})` : ""}`);
    await this.driver.control.interrupt(this.controlContext());
  }

  async approve(): Promise<void> {
    if (this._exited) throw new Error(`Agent ${this.id} has exited`);
    await this.driver.control.approve(this.controlContext());
  }

  async reject(): Promise<void> {
    if (this._exited) throw new Error(`Agent ${this.id} has exited`);
    await this.driver.control.reject(this.controlContext());
  }

  async waitForIdle(timeoutMs = 30_000): Promise<AgentState> {
    if (this._state.status === "idle") return this._state;
    return this.bus.waitFor<AgentState>(
      `agent.${this.id}.state`,
      (data) => {
        const s = data as AgentState | undefined;
        return !!s && s.status === "idle";
      },
      timeoutMs,
    );
  }

  async waitForMessage(timeoutMs = 30_000): Promise<AssistantMessage> {
    return new Promise((resolve, reject) => {
      const onMsg = (msg: AssistantMessage) => {
        clearTimeout(timer);
        this.off("message", onMsg);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        this.off("message", onMsg);
        reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.on("message", onMsg);
    });
  }

  rawWrite(data: string): void {
    if (this._exited) throw new Error(`Agent ${this.id} has exited`);
    this.pty.write(data);
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this._exited) return;
    this.logger.info("agent", `killing ${this.id} (${signal})`);
    this.pty.kill(signal);
    await this._exitDeferred.promise;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private onPtyData(data: string): void {
    // Bounded scrollback
    this._scrollback.push(data);
    if (this._scrollback.length > SCROLLBACK_MAX) {
      this._scrollback.splice(0, this._scrollback.length - SCROLLBACK_MAX);
    }

    // Emit raw for high-volume observers (audit, capture)
    this.emit("output", data);
    this.bus.emit(`agent.${this.id}.output`, data);

    // Run through parser
    const result = this.driver.parser.feed(data, this._state);
    if (result.state !== this._state) {
      this._state = result.state;
      this.publishState();
    }

    // Forward parser events on the bus (e.g. mode.changed)
    for (const ev of result.events) {
      this.bus.emit(`agent.${this.id}.${ev.kind}`, ev.data);
    }

    // Append + emit complete messages
    for (const msg of result.messages) {
      this._transcript.push(msg);
      this.emit("message", msg);
      this.bus.emit(`agent.${this.id}.message`, msg);
      this.bus.set(`agent.${this.id}.transcript`, this._transcript);
    }

    // Emit blocked / idle as semantic events
    if (this._state.blocking) {
      this.emit("blocked", this._state.blocking);
      this.bus.emit(`agent.${this.id}.blocked`, this._state.blocking);
    }
    if (this._state.status === "idle") {
      this.emit("idle", this._state);
      this.bus.emit(`agent.${this.id}.idle`, this._state);
    }
  }

  private onPtyExit(code: number, signal: number): void {
    this._exited = true;
    this._exitCode = code;
    this._state = { ...this._state, status: "exited" };
    this.publishState();
    this.logger.info("agent", `${this.id} exited (code=${code}, signal=${signal})`);
    this.emit("exit", { code, signal });
    this.bus.emit(`agent.${this.id}.exited`, { code, signal });
    this._exitDeferred.resolve(code);
  }

  private publishState(): void {
    this.bus.set(`agent.${this.id}.state`, this._state);
    this.emit("state", this._state);
    this.bus.emit(`agent.${this.id}.state`, this._state);
  }

  private controlContext() {
    return {
      agentId: this.id,
      state: this._state,
      bus: this.bus,
      write: (data: string) => this.pty.write(data),
    };
  }
}
