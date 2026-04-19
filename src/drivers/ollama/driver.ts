/**
 * OllamaDriver — local Ollama daemon via /api/generate.
 *
 * Mode: server-http. No subprocess to spawn; the daemon is assumed to be
 * running at baseUrl (default http://127.0.0.1:11434). The driver's control
 * serializes each submit into an Ollama generate payload and the runtime
 * streams NDJSON back through the parser.
 */

import type { Driver, DriverMode, DriverProbe, DriverProfile, ServerHttpSpec } from "../api.js";
import { OllamaParser } from "./parser.js";
import { OllamaControl } from "./control.js";

export interface OllamaProfile extends DriverProfile {
  /** Base URL of the Ollama server (default: http://127.0.0.1:11434) */
  baseUrl?: string;
  /** Model name, e.g. "qwen2.5:7b" — required */
  model?: string;
  /** Stream NDJSON (true) or single JSON (false). Default true. */
  stream?: boolean;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

export class OllamaDriver implements Driver {
  id = "ollama";
  label = "Ollama (local)";
  version = "1.0.0";
  aliases = ["ol"];
  modes: DriverMode[] = ["server-http"];
  // Ollama HTTP API shape has been stable across 0.x releases.
  supportedVersions = ">=0.1.0 <1.0.0";

  parser = new OllamaParser();
  control = new OllamaControl();

  async probe(): Promise<DriverProbe> {
    const warnings: string[] = [];
    let available = false;
    let version: string | undefined;

    try {
      const res = await fetch(`${DEFAULT_BASE_URL}/api/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        const body = await res.json() as { version: string };
        version = body.version;
        available = true;
      }
    } catch (err) {
      warnings.push(`Ollama daemon not reachable at ${DEFAULT_BASE_URL}: ${(err as Error).message}. Run \`ollama serve\`.`);
    }

    return {
      available,
      version,
      capabilities: {
        generate: available,
        chat: available,
      },
      warnings,
      supportedModes: available ? ["server-http"] : [],
      compat: available ? "supported" : "untested",
    };
  }

  buildServerHttp(profile: OllamaProfile): ServerHttpSpec {
    if (!profile.model) {
      throw new Error("OllamaDriver requires profile.model (e.g. qwen2.5:7b)");
    }
    return {
      baseUrl: profile.baseUrl ?? DEFAULT_BASE_URL,
      submitPath: "/api/generate",
    };
  }
}
