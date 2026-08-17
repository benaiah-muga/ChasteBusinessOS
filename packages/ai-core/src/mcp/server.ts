import type {
  ApprovalGrantStore,
  CommandHelpers,
  CommandRegistry,
  InboxStore,
  QueryRegistry,
} from "@chaste/kernel";
import type { SessionLog } from "../trajectory/index.js";
import { buildToolsFromBus } from "../tools/index.js";
import { createMcpGateway } from "./gateway.js";
import type { McpGateway } from "./gateway.js";

/**
 * Convenience builder: expose the whole command/query bus as scoped MCP tools
 * behind the gateway. Every bus entry becomes a tool whose `exposeWhen` is the
 * command/query's own permission strings, so `tools/list` is automatically
 * scoped to the bound actor and every call is revalidated, reauthorized, and
 * audited through the same pipeline the native harness uses.
 */
export function createChasteMCPServer(
  commandRegistry: CommandRegistry,
  queryRegistry: QueryRegistry,
  opts: {
    helpers: CommandHelpers;
    grants?: ApprovalGrantStore;
    inbox?: InboxStore;
    approverUserId?: string;
    trajectory?: SessionLog;
    now?: () => Date;
    serverInfo?: { name: string; version: string };
  },
): McpGateway {
  const registry = buildToolsFromBus({ commands: commandRegistry, queries: queryRegistry });
  return createMcpGateway({ registry, commands: commandRegistry, queries: queryRegistry, ...opts });
}