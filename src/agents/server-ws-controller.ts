/**
 * ServerWsAgentController — AgentRuntime backed by a persistent WebSocket
 * connection to a driver-native server (e.g. `codex app-server`).
 *
 * Unlike exec mode (one-shot child) and PTY mode (raw byte stream), this
 * runtime keeps a long-lived WS channel. The driver's parser processes each
 * incoming text frame; the driver's control methods invoke the runtime's
 * `rawWrite()` to send frames back.
 *
 * Lifecycle:
 *   constructor   → optionally spawns a server subprocess (ServerWsSpec.spawnServer)
 *   start()       → connects to spec.url, wires messages → parser
 *   submit        → driver.control.submit (typically JSON-encoded request frame)
 *   interrupt     → driver.control.interrupt (driver-defined cancel message)
 *   kill          → close WS, kill spawned server if any
 */

import { EventEmitter } from "node:events";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import type { Driver, DriverProfile, ServerWsSpec } from "../drivers/api.js";
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

const DEFAULT_SUBMIT_TIMEOUT_MS = 180_000;
const CONNECT_TIMEOUT_MS = 15_000;

export interface ServerWsAgentControllerOpts {
  id: string;
  driver: Driver;
  profile: DriverProfile;
  cwd: string;
  env: Record<string, string>;
  bus: ServiceBus;
  logger: Logger;
}

export class ServerWsAgentController extends EventEmitter implements AgentRuntime {
  readonly id: string;
  readonly driverId: string;
  readonly mode: DriverMode = "server-ws";
  readonly cwd: string;
  readonly createdAt: string;

  private _state: AgentState;
  private _transcript: AssistantMessage[] = [];
  private _exited = false;
  private _exitCode?: number;

  private readonly driver: Driver;
  private readonly profile: DriverProfile;
  private readonly env: Record<string, string>;
  private readonly bus: ServiceBus;
  private readonly logger: Logger;
  private readonly spec: ServerWsSpec;
  private readonly _exitDeferred: { resolve: (n: number) => void; promise: Promise<number> };

  private ws: WebSocket | undefined;
  private serverChild: ChildProcess | undefined;
  private _ready = false;

  constructor(opts: ServerWsAgentControllerOpts) {
    super();
    this.id = opts.id;
    this.driver = opts.driver;
    this.driverId = opts.driver.id;
    this.profile = opts.profile;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.createdAt = new Date().toISOString();

    if (!opts.driver.buildServerWs) {
      throw new Error(`Driver ${opts.driver.id} does not implement buildServerWs`);
    }
    this.spec = opts.driver.buildServerWs({ ...opts.profile, cwd: opts.cwd });

    this._state = opts.driver.parser.initialState();

    let resolveExit!: (n: number) => void;
    const promise = new Promise<number>((resolve) => { resolveExit = resolve; });
    this._exitDeferred = { resolve: resolveExit, promise };

    this.publishState();
    this.bus.set(`agent.${this.id}.driver`, opts.driver.id);
    this.bus.set(`agent.${this.id}.cwd`, opts.cwd);
    this.bus.set(`agent.${this.id}.mode`, this.mode);
  }

  /** Spawn server subprocess (if spec requires it), then open the WS connection. */
  async start(): Promise<void> {
    if (this.spec.spawnServer) {
      const s = this.spec.spawnServer;
      this.serverChild = spawnProcess(s.command, s.args, {
        cwd: s.cwd,
        env: { ...s.env, ...this.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.serverChild.stdout?.setEncoding("utf-8");
      this.serverChild.stderr?.setEncoding("utf-8");
      this.serverChild.stdout?.on("data", (d: string) => {
        this.logger.debug("agent", `${this.id} server stdout: ${d.trim().slice(0, 500)}`);
      });
      this.serverChild.stderr?.on("data", (d: string) => {
        this.logger.debug("agent", `${this.id} server stderr: ${d.trim().slice(0, 500)}`);
      });
      this.serverChild.on("exit", (code, signal) => {
        if (!this._exited) {
          this.logger.warn("agent", `${this.id} server subprocess exited unexpectedly (code=${code}, signal=${signal})`);
          this.onConnectionClosed(code ?? 0);
        }
      });
      // Small delay to let the server bind its port
      await new Promise((r) => setTimeout(r, 200));
    }

    await this.connectWs();
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
    if (!this._ready) throw new Error(`Agent ${this.id} WS not ready`);

    if (opts.interruptIfBusy && this._state.status === "busy") {
      await this.interrupt("submit-pre-interrupt");
    }

    const expectMessage = opts.expectMessage !== false;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;

    let messagePromise: Promise<AssistantMessage> | null = null;
    if (expectMessage) {
      messagePromise = this.waitForMessage(timeoutMs);
    }

    await this.driver.control.submit(this.controlContext(), prompt);

    if (!messagePromise) return { accepted: true };

    try {
      const message = await messagePromise;
      return { accepted: true, message };
    } catch (err) {
      this.logger.warn("agent", `submit on ${this.id} accepted but timed out: ${(err as Error).message}`);
      return { accepted: true };
    }
  }

  async interrupt(reason?: string): Promise<void> {
    if (this._exited || !this._ready) return;
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Agent ${this.id} WS not open`);
    }
    this.ws.send(data);
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this._exited) return;
    this.logger.info("agent", `killing ${this.id} (${signal})`);
    try { this.ws?.close(1000, "killed"); } catch { /* ignore */ }
    if (this.serverChild) {
      try { this.serverChild.kill(signal); } catch { /* ignore */ }
    }
    // Give the close handshake ~500ms, then force-finalize
    await new Promise((r) => setTimeout(r, 500));
    if (!this._exited) this.onConnectionClosed(0);
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private connectWs(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.spec.authHeader) headers["Authorization"] = this.spec.authHeader;

      const ws = new WebSocket(this.spec.url, { headers });
      this.ws = ws;

      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`WS connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);

      ws.once("open", () => {
        clearTimeout(timer);
        this._ready = true;
        if (this._state.status === "starting") this.setStatus("idle");
        this.logger.info("agent", `${this.id} WS connected to ${this.spec.url}`);
        resolve();
      });

      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.on("message", (raw) => {
        const text = raw.toString();
        this.emit("output", text);
        this.bus.emit(`agent.${this.id}.output`, text);
        this.feedChunk(text);
      });

      ws.once("close", (code) => {
        if (!this._exited) this.onConnectionClosed(code);
      });
    });
  }

  private feedChunk(chunk: string): void {
    const result = this.driver.parser.feed(chunk, this._state);
    if (result.state !== this._state) {
      this._state = result.state;
      this.publishState();
    }
    for (const ev of result.events) {
      this.bus.emit(`agent.${this.id}.${ev.kind}`, ev.data);
    }
    for (const msg of result.messages) {
      this._transcript.push(msg);
      this.emit("message", msg);
      this.bus.emit(`agent.${this.id}.message`, msg);
      this.bus.set(`agent.${this.id}.transcript`, this._transcript);
    }
    if (this._state.blocking) {
      this.emit("blocked", this._state.blocking);
      this.bus.emit(`agent.${this.id}.blocked`, this._state.blocking);
    }
    if (this._state.status === "idle") {
      this.emit("idle", this._state);
      this.bus.emit(`agent.${this.id}.idle`, this._state);
    }
  }

  private onConnectionClosed(code: number): void {
    if (this._exited) return;
    this._exited = true;
    this._exitCode = code;
    this._state = { ...this._state, status: "exited" };
    this.publishState();
    this.emit("exit", { code, signal: null });
    this.bus.emit(`agent.${this.id}.exited`, { code });
    this._exitDeferred.resolve(code);
  }

  private setStatus(status: AgentState["status"]): void {
    if (this._state.status === status) return;
    this._state = { ...this._state, status };
    this.publishState();
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
      write: (data: string) => this.rawWrite(data),
    };
  }
}
