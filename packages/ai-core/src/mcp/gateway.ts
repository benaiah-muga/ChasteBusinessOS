import type {
  Actor,
  ActorOrigin,
  ApprovalGrantStore,
  CommandHelpers,
  CommandRegistry,
  InboxStore,
  QueryRegistry,
} from "@chaste/kernel";
import { z } from "zod";
import type { SessionLog } from "../trajectory/index.js";
import { createToolContextFactory } from "../harness/index.js";
import { executeBusinessTool } from "../tools/index.js";
import type { ToolRegistry } from "../tools/index.js";
import {
  jsonRpcError,
  jsonRpcResponse,
  McpError,
  McpErrorCode,
  MCP_PROTOCOL_VERSION,
  parseJsonRpc,
} from "./protocol.js";
import type { JsonRpcId, McpInitializeResult, McpTool, McpToolCallResult } from "./protocol.js";
import { zodToJsonSchema } from "./zod-json-schema.js";

/**
 * MCP/integration gateway (research doc §Integration Plane, build item 15).
 *
 * Exposes Chaste business capabilities to external harnesses (Codex, Claude
 * Code, opencode, DeepSeek Harness, MCP clients) as *scoped MCP tools
 * mediated by Chaste*. The doc's security rules are the design:
 *
 * - External harnesses receive scoped MCP/business tools mediated by Chaste.
 * - Any proposed command is revalidated, reauthorized, and audited in Chaste.
 * - External traces attach as artifacts but the Chaste trajectory remains the
 *   audit spine (every tool call lands on the session log).
 *
 * A session binds an actor once; every `tools/list` returns only the tools the
 * actor may see (`exposeWhen`), and every `tools/call` runs through the exact
 * execution pipeline the native harness uses — permission-filtered bus
 * dispatch, durable-grant auto-allow, inbox-backed approval for risky actions,
 * trajectory events, and audit. The gateway never touches the database
 * directly and never elevates authority.
 */

const callToolParamsSchema = z
  .object({
    name: z.string(),
    arguments: z.unknown().optional(),
  })
  .strict();

export interface McpGatewayOptions {
  registry: ToolRegistry;
  commands: CommandRegistry;
  queries: QueryRegistry;
  helpers: CommandHelpers;
  grants?: ApprovalGrantStore;
  inbox?: InboxStore;
  approverUserId?: string;
  /** The append-only session log; every MCP tool call is recorded here. */
  trajectory?: SessionLog;
  now?: () => Date;
  serverInfo?: { name: string; version: string };
  /** Where the call originated, e.g. `integration`. */
  origin?: ActorOrigin;
}

export interface McpSessionInput {
  sessionId: string;
  organizationId: string;
  actor: Actor;
}

export interface McpGatewaySession extends McpSessionInput {
  initialize(): McpInitializeResult;
  listTools(): McpTool[];
  callTool(name: string, args: unknown): Promise<McpToolCallResult>;
  ping(): Record<string, never>;
  /** Dispatch one JSON-RPC method → result, or throw McpError. */
  handleRequest(method: string, params: unknown): Promise<unknown>;
  /** Transport-agnostic entry: parse one raw line, return the response (null
   * for notifications). */
  handleMessage(raw: string): Promise<string | null>;
}

export interface McpGateway {
  readonly serverInfo: { name: string; version: string };
  /** Bind a session (actor + org + session id) to a transport. */
  createSession(input: McpSessionInput): McpGatewaySession;
}

export function createMcpGateway(opts: McpGatewayOptions): McpGateway {
  const serverInfo = opts.serverInfo ?? { name: "chaste-business-os", version: "1.0.0" };
  const buildToolContext = createToolContextFactory({
    commands: opts.commands,
    queries: opts.queries,
    helpers: opts.helpers,
    grants: opts.grants,
    inbox: opts.inbox,
    approverUserId: opts.approverUserId,
    trajectory: opts.trajectory,
    now: opts.now,
  });

  function createSession(input: McpSessionInput): McpGatewaySession {
    const { sessionId, organizationId, actor } = input;
    let seq = 0;

    function listTools(): McpTool[] {
      // Scoped: only tools the actor may see and use. A hidden tool is
      // indistinguishable from a nonexistent one to the external harness.
      return opts.registry.listForActor(actor).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.input),
      }));
    }

    async function callTool(name: string, args: unknown): Promise<McpToolCallResult> {
      const tool = opts.registry.get(name);
      const exposed = opts.registry
        .listForActor(actor)
        .some((t) => t.name === name);
      if (!tool || !exposed) {
        throw new McpError(McpErrorCode.ToolNotFound, `Tool not found: ${name}`, { name });
      }

      const ctx = buildToolContext({
        actor,
        sessionId,
        organizationId,
        tool: name,
        args: args ?? {},
        origin: opts.origin ?? "integration",
        correlationId: `mcp:${sessionId}:${(seq += 1)}`,
      });

      const outcome = await executeBusinessTool(tool, args ?? {}, ctx);
      if (outcome.ok) {
        const text = `${outcome.result.summary}\n${JSON.stringify(outcome.result.structured)}`;
        return { content: [{ type: "text", text }] };
      }
      // A denied, validation-failed, approval-required, or errored call is a
      // failed tool call with an explainable payload — never a silent success.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              kind: outcome.kind,
              reason: "reason" in outcome ? outcome.reason : undefined,
              message: "message" in outcome ? outcome.message : undefined,
              issues: "issues" in outcome ? outcome.issues : undefined,
              policyDecisions: outcome.policyDecisions,
              ...("approvalRequest" in outcome && outcome.approvalRequest
                ? {
                    approval: {
                      tool: outcome.approvalRequest.tool,
                      commandType: outcome.approvalRequest.commandType,
                      riskClass: outcome.approvalRequest.riskClass,
                      reason: outcome.approvalRequest.reason,
                      policyBasis: outcome.approvalRequest.policyBasis,
                    },
                  }
                : {}),
            }),
          },
        ],
        isError: true,
      };
    }

    async function handleRequest(method: string, params: unknown): Promise<unknown> {
      switch (method) {
        case "initialize":
          return initialize();
        case "tools/list":
          return { tools: listTools() };
        case "tools/call": {
          const parsed = callToolParamsSchema.safeParse(params ?? {});
          if (!parsed.success) {
            throw new McpError(
              McpErrorCode.InvalidParams,
              "tools/call requires { name, arguments? }",
              parsed.error.issues,
            );
          }
          return callTool(parsed.data.name, parsed.data.arguments);
        }
        case "ping":
          return {};
        default:
          throw new McpError(McpErrorCode.MethodNotFound, `Method not found: ${method}`);
      }
    }

    async function handleMessage(raw: string): Promise<string | null> {
      let id: JsonRpcId = null;
      try {
        const message = parseJsonRpc(raw);
        if (message.type === "notification") return null;
        id = message.id;
        const result = await handleRequest(message.method, message.params);
        return jsonRpcResponse(id, result);
      } catch (err) {
        const code = err instanceof McpError ? err.code : McpErrorCode.InternalError;
        const message = err instanceof Error ? err.message : String(err);
        const data = err instanceof McpError ? err.data : undefined;
        return jsonRpcError(id, code, message, data);
      }
    }

    function initialize(): McpInitializeResult {
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo,
      };
    }

    return { ...input, initialize, listTools, callTool, ping: () => ({}), handleRequest, handleMessage };
  }

  return { serverInfo, createSession };
}