/**
 * CodexControl — driver control methods.
 *
 * For exec mode the controller does not call `submit()` (it uses
 * `buildExec` to form the subprocess spec). Control methods are no-ops
 * except quit, which the manager uses on teardown.
 *
 * PTY and server-ws modes will supply real implementations in later
 * sub-phases (type-the-prompt for PTY, send-a-request-frame for WS).
 */

import type { DriverControl, ControlContext } from "../api.js";

export class CodexControl implements DriverControl {
  async waitForReady(_ctx: ControlContext, _timeoutMs: number): Promise<void> {
    // exec mode is stateless; runtime is immediately ready.
  }
  async submit(_ctx: ControlContext, _text: string): Promise<void> {
    // exec mode: ExecAgentController uses buildExec; this isn't called.
  }
  async interrupt(_ctx: ControlContext): Promise<void> {
    // exec mode: ExecAgentController.interrupt() SIGTERMs the child directly.
  }
  async approve(_ctx: ControlContext): Promise<void> { /* no-op for exec */ }
  async reject(_ctx: ControlContext): Promise<void> { /* no-op for exec */ }
  async quit(_ctx: ControlContext): Promise<void> { /* no-op for exec */ }
}
