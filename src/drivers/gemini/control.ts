/**
 * GeminiControl — no-op in exec mode. ExecAgentController uses buildExec
 * to form the subprocess; control methods are not invoked for submit.
 */

import type { DriverControl, ControlContext } from "../api.js";

export class GeminiControl implements DriverControl {
  async waitForReady(_ctx: ControlContext): Promise<void> { /* no-op */ }
  async submit(_ctx: ControlContext, _text: string): Promise<void> { /* no-op */ }
  async interrupt(_ctx: ControlContext): Promise<void> { /* no-op — child SIGTERM */ }
  async approve(_ctx: ControlContext): Promise<void> { /* no-op */ }
  async reject(_ctx: ControlContext): Promise<void> { /* no-op */ }
  async quit(_ctx: ControlContext): Promise<void> { /* no-op */ }
}
