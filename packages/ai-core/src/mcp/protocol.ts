import { z } from "zod";

/**
 * Model Context Protocol transport (build item 15 — MCP/integration plane).
 *
 * A minimal, dependency-free JSON-RPC 2.0 implementation of the three MCP
 * methods the integration plane needs (`initialize`, `tools/list`,
 * `tools/call`, plus `ping`), with the protocol error codes the spec defines.
 * Messages are validated with zod at the wire boundary; everything else in the
 * gateway is plain functions.
 */

export const JSON_RPC_VERSION = "2.0";
/** The MCP protocol version this server advertises. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const McpErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP-specific: the named tool does not exist (or is not exposed). */
  ToolNotFound: -32002,
  /** MCP-specific: the tool call failed during execution. */
  ToolExecutionError: -32003,
} as const;

/** A JSON-RPC request carrying an id (expects a response). */
export const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: z.union([z.number(), z.string(), z.null()]),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();

/** A JSON-RPC notification (no id → no response). */
export const jsonRpcNotificationSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();

export type JsonRpcId = number | string | null;

export interface JsonRpcRequest {
  type: "request";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  type: "notification";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Protocol error with an MCP/JSON-RPC code. */
export class McpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** Parse a raw line into a request or notification; throws McpError on any
 * protocol violation (parse error / invalid request). */
export function parseJsonRpc(raw: string): JsonRpcRequest | JsonRpcNotification {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new McpError(McpErrorCode.ParseError, "Invalid JSON");
  }
  const request = jsonRpcRequestSchema.safeParse(value);
  if (request.success) {
    return { type: "request", id: request.data.id, method: request.data.method, params: request.data.params };
  }
  const notification = jsonRpcNotificationSchema.safeParse(value);
  if (notification.success) {
    return {
      type: "notification",
      method: notification.data.method,
      params: notification.data.params,
    };
  }
  throw new McpError(McpErrorCode.InvalidRequest, "Message is not a valid JSON-RPC request or notification");
}

/** A successful JSON-RPC response. */
export function jsonRpcResponse(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, result });
}

/** A JSON-RPC error response. */
export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

/** An outbound notification (e.g. `notifications/initialized`). */
export function jsonRpcNotification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: JSON_RPC_VERSION, method, ...(params !== undefined ? { params } : {}) });
}

/** MCP tool descriptor returned by `tools/list` (inputSchema is JSON Schema). */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: { tools: Record<string, never> };
  serverInfo: { name: string; version: string };
}

export interface McpServerInfo {
  name: string;
  version: string;
}