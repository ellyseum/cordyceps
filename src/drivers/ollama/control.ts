/**
 * OllamaControl — builds HTTP request bodies for server-http mode.
 *
 * ServerHttpAgentController invokes `submit(ctx, prompt)` which must call
 * `ctx.write(body)` with the serialized JSON request. The controller then
 * POSTs it to the configured endpoint.
 *
 * Model + streaming flag are read from ctx.profile per submit so a single
 * Driver/Control pair can serve many agents with different models.
 */

import type { DriverControl, ControlContext } from "../api.js";
import type { OllamaProfile } from "./driver.js";

export interface OllamaSubmitPayload {
  model: string;
  prompt: string;
  stream: boolean;
  options?: Record<string, unknown>;
}

export class OllamaControl implements DriverControl {
  async waitForReady(_ctx: ControlContext): Promise<void> { /* stateless */ }

  async submit(ctx: ControlContext, text: string): Promise<void> {
    const profile = ctx.profile as OllamaProfile;
    const model = profile.model;
    if (!model) throw new Error("OllamaControl.submit: profile.model is required");
    const payload: OllamaSubmitPayload = {
      model,
      prompt: text,
      stream: profile.stream !== false,
    };
    ctx.write(JSON.stringify(payload));
  }

  async interrupt(_ctx: ControlContext): Promise<void> {
    // Controller aborts the fetch on interrupt; no driver-specific action.
  }

  async approve(_ctx: ControlContext): Promise<void> { /* not applicable */ }
  async reject(_ctx: ControlContext): Promise<void> { /* not applicable */ }
  async quit(_ctx: ControlContext): Promise<void> { /* no-op */ }
}
