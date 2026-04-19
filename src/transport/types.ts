/**
 * JSON-RPC 2.0 envelope types + cordyceps-specific error codes.
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: number | string;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  result: unknown;
  id: number | string;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: number | string | null;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ── Error codes ──────────────────────────────────────────────────────────

/** Standard JSON-RPC 2.0 error codes */
export const JsonRpcError = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** Cordyceps-specific error codes (range: -32000 to -32099 reserved by JSON-RPC for server use) */
export const CordycepsError = {
  AGENT_NOT_FOUND: -32001,
  /** Reserved for future mid-session token rotation/revocation. WS auth failure at upgrade is close 1008, not this. */
  UNAUTHENTICATED: -32002,
  AGENT_EXITED: -32003,
  TIMEOUT: -32004,
  DRIVER_UNAVAILABLE: -32005,
  DRIVER_PROBE_FAILED: -32006,
} as const;

export type ErrorCode = number;

export class JsonRpcMethodError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcMethodError";
  }
}

// ── Type guards ──────────────────────────────────────────────────────────

export function isRequest(msg: unknown): msg is JsonRpcRequest {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === "2.0" && typeof m.method === "string" && (typeof m.id === "number" || typeof m.id === "string");
}

export function isNotification(msg: unknown): msg is JsonRpcNotification {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === "2.0" && typeof m.method === "string" && m.id === undefined;
}
