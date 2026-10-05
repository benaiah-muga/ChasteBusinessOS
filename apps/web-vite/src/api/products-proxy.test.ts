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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
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
  const origin = `http://127.0.0.1:${address.port}`;
  const tracked = { close: () => server.close() };
  runningServers.push(tracked);
  return { server, origin, tracked };
}

describe("Products capability route proxy", () => {
  it("sends the governed endpoint to Go only when its session route flag is on, otherwise falls back to legacy", async () => {
    const go = routeRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => go.close((error) => error ? reject(error) : resolve())) });
    const legacy = routeRecorder("legacy");
    const legacyOrigin = await listen(legacy);
    runningServers.push({ close: () => new Promise<void>((resolve, reject) => legacy.close((error) => error ? reject(error) : resolve())) });

    vi.stubEnv("CHASTE_GO_API_ORIGIN", goOrigin);
    vi.stubEnv("CHASTE_LEGACY_WEB_ORIGIN", legacyOrigin);
    vi.stubEnv("CHASTE_GO_SESSION_CAPABILITY_ROUTE", "1");
    vi.stubEnv("CHASTE_GO_INVENTORY_IMPORT_SLICE", "1");
    vi.stubEnv("CHASTE_GO_INVENTORY_TRANSFER_WRITES", "1");
    const goProxy = await startViteProxy();
    expect(goProxy.server.config.define?.__GO_INVENTORY_IMPORT_SLICE__).toBe("true");
    expect(goProxy.server.config.define?.__GO_INVENTORY_TRANSFER_WRITES__).toBe("true");
    const goResponse = await fetch(`${goProxy.origin}/api/capabilities/execute`, { method: "POST" });
    expect(await goResponse.json()).toEqual({ target: "go", path: "/api/capabilities/execute" });
    await goProxy.server.close();
    runningServers.splice(runningServers.indexOf(goProxy.tracked), 1);

    vi.stubEnv("CHASTE_GO_SESSION_CAPABILITY_ROUTE", "0");
    const legacyProxy = await startViteProxy();
    expect(legacyProxy.server.config.define?.__GO_INVENTORY_IMPORT_SLICE__).toBe("false");
    expect(legacyProxy.server.config.define?.__GO_INVENTORY_TRANSFER_WRITES__).toBe("false");
    const legacyResponse = await fetch(`${legacyProxy.origin}/api/capabilities/execute`, { method: "POST" });
    expect(await legacyResponse.json()).toEqual({ target: "legacy", path: "/api/capabilities/execute" });
  });
});
