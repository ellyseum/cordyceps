/**
 * ExecAgentController — AgentRuntime backed by one-shot subprocesses.
 *
 * Unlike PtyAgentController, no persistent process is held. Each `submit()`
 * spawns a fresh child (via `driver.buildExec(profile, task)`), pipes the
 * prompt in (if `ExecSpec.stdin` is set), streams stdout through the driver's
 * parser, and resolves with the final assistant message when the child exits.
 *
 * Lifecycle:
 *   constructor      → state = idle (no child exists)
 *   submit(prompt)   → state = busy; spawn, stream, collect, resolve
 *   interrupt()      → SIGTERM the currently running child (if any)
 *   kill()           → kill + mark exited; future submits throw
 *
 * approve/reject/rawWrite/switchModel/switchMode don't make sense in exec mode
 * (runs to completion) — they throw `ExecModeUnsupported`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Driver, DriverProfile, ExecSpec } from "../drivers/api.js";
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

const DEFAULT_SUBMIT_TIMEOUT_MS = 300_000; // exec is higher-latency; give it 5min default

export class ExecModeUnsupported extends Error {
  constructor(op: string) {
    super(`exec mode does not support ${op} (child runs to completion)`);
    this.name = "ExecModeUnsupported";
  }
}

export interface ExecAgentControllerOpts {
  id: string;
  driver: Driver;
  profile: DriverProfile;
  cwd: string;
  env: Record<string, string>;
  bus: ServiceBus;
  logger: Logger;
}

export class ExecAgentController extends EventEmitter implements AgentRuntime {
  readonly id: string;
  readonly driverId: string;
  readonly mode: DriverMode = "exec";
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
  private readonly _exitDeferred: { resolve: (n: number) => void; promise: Promise<number> };

  /** The currently-running child, if any. One at a time. */
  private activeChild: ChildProcess | undefined;

  constructor(opts: ExecAgentControllerOpts) {
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

    if (!opts.driver.buildExec) {
      throw new Error(`Driver ${opts.driver.id} does not implement buildExec (exec mode)`);
    }

    // Exec runtimes start idle — no persistent session to boot.
    this._state = { ...opts.driver.parser.initialState(), status: "idle" };

    let resolveExit!: (n: number) => void;
    const promise = new Promise<number>((resolve) => { resolveExit = resolve; });
    this._exitDeferred = { resolve: resolveExit, promise };

    this.publishState();
    this.bus.set(`agent.${this.id}.driver`, opts.driver.id);
    this.bus.set(`agent.${this.id}.cwd`, opts.cwd);
    this.bus.set(`agent.${this.id}.mode`, this.mode);
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
    if (this.activeChild) {
      if (opts.interruptIfBusy) {
        await this.interrupt("submit-pre-interrupt");
      } else {
        throw new Error(`Agent ${this.id} is already processing a submit (exec mode runs one child at a time)`);
      }
    }

    const expectMessage = opts.expectMessage !== false;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;

    const spec = this.driver.buildExec!(
      { ...this.profile, cwd: this.cwd },
      { prompt, timeoutMs },
    );

    this.setStatus("busy");

    const messages: AssistantMessage[] = [];
    const onMessage = (m: AssistantMessage) => messages.push(m);
    this.on("message", onMessage);

    try {
      await this.runChild(spec, timeoutMs);
    } finally {
      this.off("message", onMessage);
      // After child exits, drop to idle unless a parser set us blocked
      if (this._state.status === "busy") this.setStatus("idle");
    }

    if (!expectMessage) return { accepted: true };
    const last = messages[messages.length - 1];
    return last ? { accepted: true, message: last } : { accepted: true };
  }

  async interrupt(reason?: string): Promise<void> {
    if (this._exited) return;
    if (!this.activeChild) return;
    this.logger.info("agent", `interrupting ${this.id}${reason ? ` (${reason})` : ""}`);
    this.activeChild.kill("SIGTERM");
  }

  async approve(): Promise<void> { throw new ExecModeUnsupported("approve"); }
  async reject(): Promise<void> { throw new ExecModeUnsupported("reject"); }
  rawWrite(_data: string): void { throw new ExecModeUnsupported("rawWrite"); }

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

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this._exited) return;
    this.logger.info("agent", `killing ${this.id} (${signal})`);
    if (this.activeChild) {
      this.activeChild.kill(signal);
      // Let the child's own 'exit' trigger onChildExit, which finalizes
    }
    this._exited = true;
    this._exitCode = 0;
    this._state = { ...this._state, status: "exited" };
    this.publishState();
    this.emit("exit", { code: 0, signal });
    this.bus.emit(`agent.${this.id}.exited`, { code: 0, signal });
    this._exitDeferred.resolve(0);
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private runChild(spec: ExecSpec, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...spec.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.activeChild = child;

      let stdoutBuf = "";
      let stderrBuf = "";
      const flushStderr = () => {
        if (stderrBuf) {
          this.logger.debug("agent", `${this.id} stderr: ${stderrBuf.slice(0, 4096)}`);
          stderrBuf = "";
        }
      };

      const timer = setTimeout(() => {
        reject(new Error(`exec child timed out after ${timeoutMs}ms`));
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, timeoutMs);

      child.stdout?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        this.emit("output", chunk);
        this.bus.emit(`agent.${this.id}.output`, chunk);

        if (spec.parseOutput === "jsonl") {
          // Buffer + split on newlines; feed each complete line to the parser.
          stdoutBuf += chunk;
          let nl = stdoutBuf.indexOf("\n");
          while (nl >= 0) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (line) this.feedChunk(line);
            nl = stdoutBuf.indexOf("\n");
          }
        } else {
          // text or json — accumulate, parse at exit
          stdoutBuf += chunk;
        }
      });

      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => {
        stderrBuf += chunk;
      });

      child.once("error", (err) => {
        clearTimeout(timer);
        this.activeChild = undefined;
        flushStderr();
        reject(err);
      });

      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        this.activeChild = undefined;
        flushStderr();

        // Flush any residual stdout
        if (stdoutBuf) {
          if (spec.parseOutput === "jsonl") {
            this.feedChunk(stdoutBuf);
          } else {
            this.feedChunk(stdoutBuf);
          }
          stdoutBuf = "";
        }
        // Final empty-feed to let the parser flush pending messages
        this.feedChunk("");

        if (code === 0 || signal === "SIGTERM") {
          resolve();
        } else {
          reject(new Error(`exec child exited with code ${code} signal ${signal}`));
        }
      });

      // Pipe stdin if the driver supplied a payload
      if (spec.stdin !== undefined) {
        child.stdin?.write(spec.stdin);
      }
      child.stdin?.end();
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
}
