/**
 * ServerHttpAgentController — AgentRuntime backed by HTTP request/response
 * (or streaming NDJSON response) cycles against a driver's native endpoint.
 * Ollama's /api/generate is the canonical example.
 *
 * Unlike server-ws there is no persistent channel — each submit invokes
 * driver.control.submit which emits a request body via the control context;
 * the controller performs the POST, streams the response through driver.parser.
 *
 * Lifecycle:
 *   constructor   → state = idle (endpoint verified at buildServerHttp time)
 *   submit        → busy; POST; stream; idle
 *   interrupt     → AbortController.abort() on the active request
 *   kill          → mark exited; future submits throw
 */

import { EventEmitter } from "node:events";
import type { Driver, DriverProfile, ServerHttpSpec } from "../drivers/api.js";
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

export class ServerHttpModeError extends Error {
  constructor(op: string) {
    super(`server-http mode does not support ${op} — requests are one-shot`);
    this.name = "ServerHttpModeError";
  }
}

export interface ServerHttpAgentControllerOpts {
  id: string;
  driver: Driver;
  profile: DriverProfile;
  cwd: string;
  env: Record<string, string>;
  bus: ServiceBus;
  logger: Logger;
}

export class ServerHttpAgentController extends EventEmitter implements AgentRuntime {
  readonly id: string;
  readonly driverId: string;
  readonly mode: DriverMode = "server-http";
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
  private readonly spec: ServerHttpSpec;
  private readonly _exitDeferred: { resolve: (n: number) => void; promise: Promise<number> };

  private activeAbort: AbortController | undefined;
  /** Staging area for the next request body (set by driver.control.submit). */
  private pendingBody: string | undefined;

  constructor(opts: ServerHttpAgentControllerOpts) {
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

    if (!opts.driver.buildServerHttp) {
      throw new Error(`Driver ${opts.driver.id} does not implement buildServerHttp`);
    }
    this.spec = opts.driver.buildServerHttp({ ...opts.profile, cwd: opts.cwd });

    // HTTP runtimes start idle — endpoint is stateless.
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
    if (this.activeAbort) {
      if (opts.interruptIfBusy) {
        await this.interrupt("submit-pre-interrupt");
      } else {
        throw new Error(`Agent ${this.id} is already processing a submit (server-http runs one request at a time)`);
      }
    }

    const expectMessage = opts.expectMessage !== false;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;

    // The driver's control.submit writes a request body via ctx.write().
    this.pendingBody = undefined;
    await this.driver.control.submit(this.controlContext(), prompt);
    const body = this.pendingBody ?? JSON.stringify({ prompt });
    this.pendingBody = undefined;

    this.setStatus("busy");

    const messages: AssistantMessage[] = [];
    const onMessage = (m: AssistantMessage) => messages.push(m);
    this.on("message", onMessage);

    try {
      await this.performRequest(body, timeoutMs);
    } finally {
      this.off("message", onMessage);
      if (this._state.status === "busy") this.setStatus("idle");
    }

    if (!expectMessage) return { accepted: true };
    const last = messages[messages.length - 1];
    return last ? { accepted: true, message: last } : { accepted: true };
  }

  async interrupt(reason?: string): Promise<void> {
    if (this._exited) return;
    if (!this.activeAbort) return;
    this.logger.info("agent", `interrupting ${this.id}${reason ? ` (${reason})` : ""}`);
    this.activeAbort.abort();
  }

  async approve(): Promise<void> { throw new ServerHttpModeError("approve"); }
  async reject(): Promise<void> { throw new ServerHttpModeError("reject"); }

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
    // In server-http mode, the driver's control.submit writes the request body
    // here; the controller performs the actual fetch in `submit()` right after.
    this.pendingBody = data;
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this._exited) return;
    this.logger.info("agent", `killing ${this.id} (${signal})`);
    if (this.activeAbort) {
      try { this.activeAbort.abort(); } catch { /* ignore */ }
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

  private async performRequest(body: string, timeoutMs: number): Promise<void> {
    const url = `${this.spec.baseUrl.replace(/\/$/, "")}${this.spec.submitPath.startsWith("/") ? this.spec.submitPath : `/${this.spec.submitPath}`}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.spec.defaultHeaders ?? {}),
    };

    const abort = new AbortController();
    this.activeAbort = abort;
    const timer = setTimeout(() => abort.abort(new Error(`server-http timed out after ${timeoutMs}ms`)), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: abort.signal,
      });

      if (!res.ok) {
        throw new Error(`server-http HTTP ${res.status} ${res.statusText}`);
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!res.body) {
        // No body — nothing to stream
        this.feedChunk("");
        return;
      }

      // Always stream the response and split on newlines; parser decides
      // whether each line is a complete event (NDJSON) or part of text.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        this.emit("output", chunk);
        this.bus.emit(`agent.${this.id}.output`, chunk);

        if (contentType.includes("x-ndjson") || contentType.includes("stream")) {
          buffer += chunk;
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line) this.feedChunk(line);
            nl = buffer.indexOf("\n");
          }
        } else {
          buffer += chunk;
        }
      }
      // Flush residual (non-NDJSON body arrives as one chunk)
      if (buffer) this.feedChunk(buffer);
      // Empty-feed to let parser flush pending messages
      this.feedChunk("");
    } finally {
      clearTimeout(timer);
      this.activeAbort = undefined;
    }
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

  private controlContext() {
    return {
      agentId: this.id,
      state: this._state,
      profile: this.profile,
      bus: this.bus,
      write: (data: string) => this.rawWrite(data),
    };
  }
}
