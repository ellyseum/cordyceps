/**
 * Auth — bearer token verification for WS upgrade.
 *
 * Preferred transport: `Authorization: Bearer <token>` header on the upgrade
 * request. Falls back to `?token=<bearer>` query string for backward compat
 * with clients (or instance-file URLs) that pre-date the header path.
 *
 * Failure → HTTP 401 on the upgrade socket. No JSON-RPC session ever begins.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Generate a 192-bit base64url token (32 chars). */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Constant-time string compare. Pads both buffers to the max length so
 * timingSafeEqual can run for every call — no early-return on length
 * mismatch, no length-leakage signal in the auth path.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  const len = Math.max(aBuf.length, bBuf.length);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  aBuf.copy(padA);
  bBuf.copy(padB);
  // Run the constant-time compare regardless of length match. The final
  // length-equality check happens after, so an attacker who somehow guessed
  // the right prefix still can't distinguish "wrong-length" from "wrong-byte"
  // by timing.
  const eq = timingSafeEqual(padA, padB);
  return eq && aBuf.length === bBuf.length;
}

/**
 * Verify the bearer token on a WS upgrade request.
 *
 * Reads the token from (in order of preference):
 *   1. `Authorization: Bearer <token>` header (preferred — header doesn't
 *      land in HTTP access logs the way URLs do).
 *   2. `?token=<bearer>` query string (legacy compat).
 *
 * Returns true only if the presented token matches `expected`. Empty
 * `expected` always returns false.
 */
export function verifyUpgradeToken(req: IncomingMessage, expected: string): boolean {
  if (!expected) return false;

  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string") {
    const match = /^[Bb]earer\s+(.+)$/.exec(authHeader);
    if (match && constantTimeStringEqual(match[1].trim(), expected)) {
      return true;
    }
  }

  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const queryToken = url.searchParams.get("token");
    if (queryToken && constantTimeStringEqual(queryToken, expected)) {
      return true;
    }
  } catch {
    // Malformed URL — fall through to false.
  }

  return false;
}

/**
 * Reject WS upgrade requests whose Host or Origin header isn't a loopback
 * address. The server already binds to 127.0.0.1, but this is defense in
 * depth — a future broadening of the bind shouldn't open a DNS-rebinding
 * gap. CLIs and Node WS clients don't set Origin; only browsers do, and no
 * trusted browser context should ever talk to the daemon.
 */
export function isLoopbackUpgrade(req: IncomingMessage): boolean {
  const host = (req.headers["host"] ?? "").toString().toLowerCase();
  // Host header is "<hostname>" or "<hostname>:<port>". Strip port to compare.
  const hostname = host.replace(/:\d+$/, "").replace(/^\[(.+)\]$/, "$1");
  const okHost =
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1";
  if (!okHost) return false;

  const origin = req.headers["origin"];
  if (origin == null) return true;
  if (typeof origin !== "string") return false;
  if (origin === "null") return true;
  try {
    const u = new URL(origin);
    const ohost = u.hostname.toLowerCase();
    return ohost === "127.0.0.1" || ohost === "localhost" || ohost === "::1";
  } catch {
    return false;
  }
}
