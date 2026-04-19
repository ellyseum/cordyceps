/**
 * Auth — bearer token verification for WS upgrade.
 *
 * Token comes via query param: `ws://host:port/rpc?token=<bearer>`.
 * Failure → WS close 1008 (Policy Violation). No JSON-RPC session ever begins.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Generate a 192-bit base64url token (48 chars). */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Verify the bearer token on a WS upgrade request.
 * Reads `?token=<bearer>` from the request URL.
 * Constant-time compare to prevent timing leaks.
 */
export function verifyUpgradeToken(req: IncomingMessage, expected: string): boolean {
  if (!expected) return false;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const token = url.searchParams.get("token");
  if (!token) return false;
  if (token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}
