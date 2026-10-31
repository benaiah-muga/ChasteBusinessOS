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

function routeRecorder(
  target: string,
  requests: Array<{ method: string | undefined; path: string | undefined; body: string }> = [],
  responseBody?: unknown,
): Server {
  return createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const recorded = {
        method: request.method,
        path: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody ?? { target, ...recorded }));
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
  const origin = `http://127.0.0.1:${address.port}`;
  const tracked = { close: () => server.close() };
  runningServers.push(tracked);
  return { server, origin, tracked };
}

describe("Manufacturing planning capability proxy", () => {
  it("forwards Manufacturing planning reads to Go", async () => {
    const go = routeRecorder("go");
    const goOrigin = await listen(go);
    runningServers.push({ close: () => new Promise<void>((resolveClose, reject) => go.close((error) => error ? reject(error) : resolveClose())) });
    const legacy = routeRecorder("legacy");
    const legacyOrigin = await listen(legacy);
    runningServers.push({ close: () => new Promise<void>((resolveClose, reject) => legacy.close((error) => error ? reject(error) : resolveClose())) });

    vi.stubEnv("CHASTE_GO_API_ORIGIN", goOrigin);
    vi.stubEnv("CHASTE_LEGACY_WEB_ORIGIN", legacyOrigin);
    vi.stubEnv("CHASTE_GO_SESSION_CAPABILITY_ROUTE", "1");
    const vite = await startViteProxy();
    const body = {
      capabilityId: "manufacturing.costPreview",
      input: { assemblySku: "DESK-1", quantityThousandths: 2000 },
      intentId: "manufacturing-preview-test-intent",
    };

    const response = await fetch(`${vite.origin}/api/capabilities/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(await response.json()).toEqual({
      target: "go",
      method: "POST",
      path: "/api/capabilities/execute",
      body: JSON.stringify(body),
    });
  });

});
