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
    const rollbackProxy = await startViteProxy();
    expect(rollbackProxy.server.config.define?.__GO_MESSAGING_EDIT_SLICE__).toBe("false");
    expect(rollbackProxy.server.config.define?.__GO_MESSAGING_DELETE_SLICE__).toBe("false");
    expect(rollbackProxy.server.config.define?.__GO_MESSAGING_THREAD_READ__).toBe("false");
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
    const legacyResponse = await fetch(`${legacyProxy.origin}/api/capabilities/execute`, { method: "POST" });
    expect(await legacyResponse.json()).toEqual({ target: "legacy", path: "/api/capabilities/execute" });
  });
});
