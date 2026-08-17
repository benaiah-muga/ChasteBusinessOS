import { createInterface } from "node:readline";
import { stdin as stdinStream, stdout as stdoutStream } from "node:process";
import type { McpGatewaySession } from "./gateway.js";

/**
 * Stdio transport for the MCP gateway. The MCP stdio transport is
 * newline-delimited JSON-RPC: each message is a single line on stdin, each
 * response is a single line on stdout. Errors never leak to stdout — the
 * gateway renders them as JSON-RPC error responses; genuine transport failures
 * go to stderr.
 */

/** Feed one raw line into a session; returns the response line or null. */
export async function handleMcpLine(
  session: McpGatewaySession,
  line: string,
): Promise<string | null> {
  if (!line.trim()) return null;
  return session.handleMessage(line);
}

/** Run a blocking stdio MCP server over one bound session. */
export function createStdioMcpServer(session: McpGatewaySession): void {
  const rl = createInterface({ input: stdinStream, terminal: false });
  rl.on("line", (line: string) => {
    void handleMcpLine(session, line).then((response) => {
      if (response) stdoutStream.write(`${response}\n`);
    });
  });
}