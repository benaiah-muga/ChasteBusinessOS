import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";

const runningServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function routeRecorder(target: string): Server {
  return createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ target, path: request.url }));
  });
}

function bodyRecorder(target: string, requests: Array<{ path: string | undefined; body: unknown }>): Server {
  return createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as unknown : null;
      requests.push({ path: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ target, path: request.url, body }));
    });
  });
}

async function startViteProxy(): Promise<{ server: ViteDevServer; origin: string; tracked: { close: () => Promise<void> } }> {
  const server = await createViteServer({
    configFile: resolve(process.cwd(), "vite.config.ts"),
    mode: "test",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo;
  const tracked = { close: () => server.close() };
  const started = { server, origin: `http://127.0.0.1:${address.port}`, tracked };
  runningServers.push(tracked);
  return started;
}

describe("Messaging capability proxy", () => {
  it("sends around-message capability reads to Go with the selected message id", async () => {
    const goRequests: Array<{ path: string | undefined; body: unknown }> = [];
    const go = bodyRecorder("go", goRequests);
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolveClose, reject) => go.close((error) => error ? reject(error) : resolveClose())) });
    const legacyRequests: Array<{ path: string | undefined; body: unknown }> = [];
    const legacy = bodyRecorder("legacy", legacyRequests);
    const legacyOrigin = await listen(legacy);
    runningServers.push({ close: () => new Promise<void>((resolveClose, reject) => legacy.close((error) => error ? reject(error) : resolveClose())) });

    vi.stubEnv("CHASTE_GO_API_ORIGIN", goOrigin);
    vi.stubEnv("CHASTE_LEGACY_WEB_ORIGIN", legacyOrigin);
    vi.stubEnv("CHASTE_GO_SESSION_CAPABILITY_ROUTE", "1");
    const proxy = await startViteProxy();
    const around = "72b99920-8c21-463a-9c5b-479216017501";
    const response = await fetch(`${proxy.origin}/api/capabilities/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capabilityId: "messaging.readMessages",
        input: { conversationId: "conversation-1", limit: 60, around },
        intentId: "11111111-1111-4111-8111-111111111111",
      }),
    });

    expect(await response.json()).toMatchObject({ target: "go", path: "/api/capabilities/execute", body: { input: { around } } });
    expect(goRequests).toHaveLength(1);
    expect(goRequests[0]?.body).toMatchObject({ capabilityId: "messaging.readMessages", input: { around } });

    const readAt = "2026-10-01T09:00:00.000Z";
    const cursorResponse = await fetch(`${proxy.origin}/api/capabilities/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capabilityId: "messaging.advanceReadCursor",
        input: { conversationId: "conversation-1", readAt },
        intentId: "22222222-2222-4222-8222-222222222222",
      }),
    });
    expect(await cursorResponse.json()).toMatchObject({ target: "go", path: "/api/capabilities/execute" });
    expect(goRequests).toHaveLength(2);
    expect(goRequests[1]?.body).toMatchObject({
      capabilityId: "messaging.advanceReadCursor",
      input: { conversationId: "conversation-1", readAt },
      intentId: "22222222-2222-4222-8222-222222222222",
    });
    for (const [capabilityId, input] of [
      ["messaging.setMessageReaction", { messageId: around, emoji: "👍", active: true }],
      ["messaging.setMessagePin", { messageId: around, pinned: true }],
    ] as const) {
      const response = await fetch(`${proxy.origin}/api/capabilities/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilityId, input, intentId: crypto.randomUUID() }),
      });
      expect(await response.json()).toMatchObject({ target: "go", path: "/api/capabilities/execute" });
    }
    expect(goRequests).toHaveLength(4);
    expect(goRequests[2]?.body).toMatchObject({ capabilityId: "messaging.setMessageReaction", input: { messageId: around, emoji: "👍", active: true } });
    expect(goRequests[3]?.body).toMatchObject({ capabilityId: "messaging.setMessagePin", input: { messageId: around, pinned: true } });
    expect(legacyRequests).toEqual([]);
  });

  it("defaults messaging thread reads including older-page capability requests, edits, and deletions to Go with session routing and preserves independent selector rollbacks", async () => {
    const go = routeRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolveClose, reject) => go.close((error) => error ? reject(error) : resolveClose())) });
    const legacy = routeRecorder("legacy");
    const legacyOrigin = await listen(legacy);
    runningServers.push({ close: () => new Promise<void>((resolveClose, reject) => legacy.close((error) => error ? reject(error) : resolveClose())) });

    vi.stubEnv("CHASTE_GO_API_ORIGIN", goOrigin);
    vi.stubEnv("CHASTE_LEGACY_WEB_ORIGIN", legacyOrigin);
    vi.stubEnv("CHASTE_GO_SESSION_CAPABILITY_ROUTE", "1");
    const goProxy = await startViteProxy();
    expect(goProxy.server.config.define?.__GO_MESSAGING_EDIT_SLICE__).toBe("true");
    expect(goProxy.server.config.define?.__GO_MESSAGING_DELETE_SLICE__).toBe("true");
    expect(goProxy.server.config.define?.__GO_MESSAGING_THREAD_READ__).toBe("true");
    expect(goProxy.server.config.define?.__GO_MESSAGING_READ_CURSOR__).toBe("true");
    expect(goProxy.server.config.define?.__GO_MESSAGING_REACTIONS__).toBe("true");
    expect(goProxy.server.config.define?.__GO_MESSAGING_PINS__).toBe("true");
    const goResponse = await fetch(`${goProxy.origin}/api/capabilities/execute`, { method: "POST" });
    expect(await goResponse.json()).toEqual({ target: "go", path: "/api/capabilities/execute" });
    const olderPageResponse = await fetch(`${goProxy.origin}/api/capabilities/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilityId: "messaging.readMessages", input: { conversationId: "conversation-1", before: "message-1" } }),
    });
    expect(await olderPageResponse.json()).toEqual({ target: "go", path: "/api/capabilities/execute" });
    await goProxy.server.close();
    runningServers.splice(runningServers.indexOf(goProxy.tracked), 1);

    vi.stubEnv("CHASTE_GO_MESSAGING_EDIT_SLICE", "0");
    vi.stubEnv("CHASTE_GO_MESSAGING_DELETE_SLICE", "0");
    vi.stubEnv("CHASTE_GO_MESSAGING_THREAD_READ", "0");
    vi.stubEnv("CHASTE_GO_MESSAGING_READ_CURSOR", "0");
    vi.stubEnv("CHASTE_GO_MESSAGING_REACTIONS", "0");
    vi.stubEnv("CHASTE_GO_MESSAGING_PINS", "0");
    const rollbackProxy = await startViteProxy();
    expect(rollbackProxy.server.config.define?.__GO_MESSAGING_EDIT_SLICE__).toBe("false");
    expect(rollbackProxy.server.config.define?.__GO_MESSAGING_DELETE_SLICE__).toBe("false");
    expect(rollbackProxy.server.config.define?.__GO_MESSAGING_THREAD_READ__).toBe("false");
    expect(rollbackProxy.server.config.define?.__GO_MESSAGING_READ_CURSOR__).toBe("false");
    expect(rollbackProxy.server.config.define?.__GO_MESSAGING_REACTIONS__).toBe("false");
    expect(rollbackProxy.server.config.define?.__GO_MESSAGING_PINS__).toBe("false");
    const rollbackResponse = await fetch(`${rollbackProxy.origin}/api/capabilities/execute`, { method: "POST" });
    expect(await rollbackResponse.json()).toEqual({ target: "go", path: "/api/capabilities/execute" });
    const legacyEditResponse = await fetch(`${rollbackProxy.origin}/api/messages/m1`, { method: "PATCH" });
    expect(await legacyEditResponse.json()).toEqual({ target: "legacy", path: "/api/messages/m1" });
    const legacyDeleteResponse = await fetch(`${rollbackProxy.origin}/api/messages/m1?intentId=11111111-1111-4111-8111-111111111111`, { method: "DELETE" });
    expect(await legacyDeleteResponse.json()).toEqual({ target: "legacy", path: "/api/messages/m1?intentId=11111111-1111-4111-8111-111111111111" });
    await rollbackProxy.server.close();
    runningServers.splice(runningServers.indexOf(rollbackProxy.tracked), 1);

    vi.stubEnv("CHASTE_GO_MESSAGING_EDIT_SLICE", "1");
    vi.stubEnv("CHASTE_GO_MESSAGING_DELETE_SLICE", "1");
    vi.stubEnv("CHASTE_GO_SESSION_CAPABILITY_ROUTE", "0");
    const legacyProxy = await startViteProxy();
    expect(legacyProxy.server.config.define?.__GO_MESSAGING_EDIT_SLICE__).toBe("false");
    expect(legacyProxy.server.config.define?.__GO_MESSAGING_DELETE_SLICE__).toBe("false");
    expect(legacyProxy.server.config.define?.__GO_MESSAGING_THREAD_READ__).toBe("false");
    expect(legacyProxy.server.config.define?.__GO_MESSAGING_REACTIONS__).toBe("false");
    expect(legacyProxy.server.config.define?.__GO_MESSAGING_PINS__).toBe("false");
    const legacyResponse = await fetch(`${legacyProxy.origin}/api/capabilities/execute`, { method: "POST" });
    expect(await legacyResponse.json()).toEqual({ target: "legacy", path: "/api/capabilities/execute" });
  });
});
