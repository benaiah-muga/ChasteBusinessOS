import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeOpenCodeEndpoint, requestOpenCode, signToolAccessToken, verifyToolAccessToken } from "./coding-agent-connections";
import { codexExecArguments, consumeCodexEvent, type CodexEventState } from "./coding-agent-adapter";

afterEach(() => vi.unstubAllEnvs());

describe("personal coding-plan connections", () => {
  it("signs short-lived tool grants with a narrow allowlist and rejects tampering or expiry", () => {
    vi.stubEnv("AI_CONFIG_ENCRYPTION_KEY", "test-only-coding-plan-key");
    const token = signToolAccessToken({
      orgId: "org-1",
      userId: "user-1",
      connectionId: "connection-1",
      sessionId: "session-1",
      allowedTools: ["crm_list_customers"],
    }, 1_000_000);
    expect(verifyToolAccessToken(token, 1_001_000)).toMatchObject({
      orgId: "org-1",
      userId: "user-1",
      connectionId: "connection-1",
      sessionId: "session-1",
      allowedTools: ["crm_list_customers"],
    });
    expect(verifyToolAccessToken(`${token}x`, 1_001_000)).toBeNull();
    expect(verifyToolAccessToken(token, 200_000_000)).toBeNull();
  });

  it("accepts HTTPS server origins and blocks credential-bearing or private production endpoints", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(normalizeOpenCodeEndpoint("https://opencode.example.com")).toBe("https://opencode.example.com");
    expect(() => normalizeOpenCodeEndpoint("https://user:pass@opencode.example.com")).toThrow("public HTTPS");
    expect(() => normalizeOpenCodeEndpoint("https://opencode.example.com?token=secret")).toThrow("public HTTPS");
    expect(() => normalizeOpenCodeEndpoint("http://opencode.example.com")).toThrow("public HTTPS");
    expect(() => normalizeOpenCodeEndpoint("https://127.0.0.1:4096")).toThrow("public HTTPS");
  });

  it("uses authenticated OpenCode HTTP requests without following redirects", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/global/health" && request.headers.authorization === `Basic ${Buffer.from("opencode:secret").toString("base64")}`) {
        response.end(JSON.stringify({ healthy: true, version: "test" }));
      } else {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "unauthorized" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a port");
    try {
      const response = await requestOpenCode(
        `http://127.0.0.1:${address.port}`,
        { username: "opencode", password: "secret" },
        "/global/health",
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ healthy: true, version: "test" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("runs Codex in an ephemeral read-only tool-limited mode and omits the bridge for text-only tasks", () => {
    const businessArgs = codexExecArguments({ appUrl: "https://app.example.com/", token: "signed-token", cwd: "/tmp/empty", modelId: null });
    expect(businessArgs).toContain("--ephemeral");
    expect(businessArgs).toContain("read-only");
    expect(businessArgs).toContain("features.shell_tool=false");
    expect(businessArgs).toContain('mcp_servers.chaste.bearer_token_env_var="CHASTE_MCP_TOKEN"');

    const textOnlyArgs = codexExecArguments({ appUrl: "https://app.example.com", cwd: "/tmp/empty", modelId: "gpt-default" });
    expect(textOnlyArgs).not.toContain("mcp_servers.chaste.url=\"https://app.example.com/api/ai-tools/mcp\"");
  });

  it("consumes a final Codex event even when the JSON stream has no trailing newline", () => {
    const state: CodexEventState = {
      text: "",
      lastDeltaLength: 0,
      usage: { input: 0, output: 0, cachedInput: 0 },
      terminal: null,
      failure: null,
    };
    const deltas: string[] = [];
    consumeCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "The answer" } }, state, (delta) => deltas.push(delta));
    consumeCodexEvent({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 7, cached_input_tokens: 4 } }, state);
    expect(state).toMatchObject({
      text: "The answer",
      terminal: "completed",
      usage: { input: 12, output: 7, cachedInput: 4 },
    });
    expect(deltas).toEqual(["The answer"]);
  });
});
