import { afterEach, describe, expect, it, vi } from "vitest";
import { connectOpenCode, disconnectAgent, fetchAgentConnections, setDefaultAgentConnection } from "./ai-connections";

const connection = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  provider: "opencode",
  endpoint: "http://127.0.0.1:4096",
  modelId: "openai/gpt-5",
  status: "connected",
  isDefault: true,
  runCount: 3,
  inputTokens: 1200,
  outputTokens: 340,
  lastUsedAt: null,
  connectedAt: "2026-10-20T10:00:00Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("coding agent connections API", () => {
  it("reads the connection list", async () => {
    const fetchMock = vi.fn(async () => Response.json({ connections: [connection], codexRuntime: { available: false, version: null } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAgentConnections()).resolves.toMatchObject({ connections: [connection] });
    expect(fetchMock).toHaveBeenCalledWith("/api/ai-connections", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("sends the exact opencode connect body", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, connection }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(connectOpenCode({ endpoint: "http://127.0.0.1:4096", password: "secret", makeDefault: true }))
      .resolves.toEqual(connection);
    expect(fetchMock).toHaveBeenCalledWith("/api/ai-connections", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "connect_opencode", endpoint: "http://127.0.0.1:4096", password: "secret", makeDefault: true }),
    }));
  });

  it("uses the documented actions for default and disconnect", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, connections: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await setDefaultAgentConnection(connection.id);
    await setDefaultAgentConnection(null);
    await disconnectAgent("opencode");
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { action: "set_default", connectionId: connection.id },
      { action: "set_default", connectionId: null },
      { action: "disconnect", provider: "opencode" },
    ]);
  });

  it("surfaces a server refusal in product language", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "OpenCode rejected the server password." }, { status: 422 })));
    await expect(connectOpenCode({ endpoint: "http://127.0.0.1:4096", password: "wrong" }))
      .rejects.toMatchObject({ status: 422, message: "OpenCode rejected the server password." });
  });
});
