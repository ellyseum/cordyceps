/**
 * PtyProcess — generic node-pty wrapper.
 *
 * No CLI-specific assumptions. Drivers configure the command, args, env,
 * and cwd; PtyProcess just spawns, reads, writes, resizes, kills.
 *
 * Events:
 *   - "data" (string): raw PTY output chunk
 *   - "exit" ({ code, signal }): PTY exited
 *   - "ready": PTY spawned successfully
 */

import * as pty from "node-pty";
import { EventEmitter } from "node:events";

export interface PtyProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** If true, don't inherit process.env — only use `env` as-is */
  cleanEnv?: boolean;
  /** Terminal dimensions (default: stdout size or 80x24) */
  cols?: number;
  rows?: number;
}

export interface PtyExitInfo {
  code: number;
  signal: number;
}

export interface PtyProcess {
  on(event: "data", listener: (data: string) => void): this;
  on(event: "exit", listener: (info: PtyExitInfo) => void): this;
  on(event: "ready", listener: () => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  emit(event: "data", data: string): boolean;
  emit(event: "exit", info: PtyExitInfo): boolean;
  emit(event: "ready"): boolean;
}

export class PtyProcess extends EventEmitter {
  private ptyProcess: pty.IPty | null = null;
  private _exited = false;
  private _exitCode?: number;
  private _exitSignal?: number;

  constructor(private options: PtyProcessOptions) {
    super();
  }

  /** Spawn the underlying process over a PTY. Emits "ready" on success. */
  spawn(): void {
    const cols = this.options.cols ?? process.stdout.columns ?? 80;
    const rows = this.options.rows ?? process.stdout.rows ?? 24;

    const env = this.options.cleanEnv
      ? { ...(this.options.env ?? {}) }
      : { ...process.env, ...this.options.env };

    this.ptyProcess = pty.spawn(this.options.command, this.options.args ?? [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.options.cwd ?? process.cwd(),
      env: env as Record<string, string>,
    });

    this.ptyProcess.onData((data: string) => {
      this.emit("data", data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this._exited = true;
      this._exitCode = exitCode;
      this._exitSignal = signal ?? 0;
      this.emit("exit", { code: exitCode ?? 0, signal: signal ?? 0 });
    });

    this.emit("ready");
  }

  /** Write to PTY stdin. No-op if process has exited. */
  write(data: string): void {
    if (this.ptyProcess && !this._exited) {
      this.ptyProcess.write(data);
    }
  }

  /** Resize the PTY. No-op if process has exited. */
  resize(cols: number, rows: number): void {
    if (this.ptyProcess && !this._exited) {
      this.ptyProcess.resize(cols, rows);
    }
  }

  /** Kill the PTY process. */
  kill(signal?: string): void {
    if (this.ptyProcess && !this._exited) {
      this.ptyProcess.kill(signal);
    }
  }

  get exited(): boolean {
    return this._exited;
  }

  get exitCode(): number | undefined {
    return this._exitCode;
  }

  get exitSignal(): number | undefined {
    return this._exitSignal;
  }

  get pid(): number | undefined {
    return this.ptyProcess?.pid;
  }
}
