import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { internalApiUrl, proxyGoOnboardingCreate } from "./onboarding-go-proxy";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://business.example.test/api/onboarding", {
    method: "POST",
    headers: {
      host: "business.example.test",
      origin: "http://business.example.test",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  orgName: "Northwind Books",
  businessDescription: "A wholesale business importing and selling household goods.",
  baseCurrency: "USD",
  path: "fresh",
  deferredSteps: ["import_data"],
  intentId: "onboarding-intent-1",
};

describe("onboarding Go endpoint validation", () => {
  it.each([
    "http://api.example.test:8080",
    "ftp://127.0.0.1:8080",
    "https://user:secret@api.example.test",
    "https://api.example.test/private-path",
    "https://api.example.test?token=secret",
    "https://api.example.test#fragment",
    "not a URL",
  ])("rejects unsupported Go API endpoint %s", (endpoint) => {
    expect(internalApiUrl(endpoint)).toBeNull();
  });

  it.each([
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
  ])("allows cleartext loopback endpoint %s", (endpoint) => {
    expect(internalApiUrl(endpoint)?.origin).toBe(endpoint);
  });

  it("allows operator-controlled remote or private HTTPS service origins", () => {
    expect(internalApiUrl("https://go-api.service.internal:8443")?.origin)
      .toBe("https://go-api.service.internal:8443");
  });
});

describe("legacy onboarding Go transport", () => {
  it("relays the exact payload and verified-session credentials without deriving identity from the body", async () => {
    let seen: { method?: string; url?: string; host?: string; origin?: string; cookie?: string; authorization?: string; body?: string } = {};
    const server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        seen = {
          method: incoming.method,
          url: incoming.url,
          host: incoming.headers.host,
          origin: incoming.headers.origin,
          cookie: incoming.headers.cookie,
          authorization: incoming.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ orgId: "d4d0f18b-d20c-421e-a7fc-78281a97cab4", replayed: false }));
      });
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const body = JSON.stringify(validBody);
    const response = await proxyGoOnboardingCreate(new Request("http://business.example.test/api/onboarding", {
      method: "POST",
      headers: {
        host: "business.example.test",
        origin: "http://business.example.test",
        cookie: "better-auth.session_token=session-token",
        authorization: "Bearer browser-token",
        "content-type": "application/json",
      },
      body,
    }), { baseUrl });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ orgId: "d4d0f18b-d20c-421e-a7fc-78281a97cab4", replayed: false });
    expect(seen).toEqual({
      method: "POST",
      url: "/api/onboarding",
      host: "business.example.test",
      origin: "http://business.example.test",
      cookie: "better-auth.session_token=session-token",
      authorization: "Bearer browser-token",
      body,
    });
  });

  it("rejects body-supplied actor identity instead of forwarding it", async () => {
    const response = await proxyGoOnboardingCreate(request({ ...validBody, userId: "attacker" }), {
      baseUrl: "http://127.0.0.1:8080",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid" });
  });

  it("preserves safe Go conflict status and code while discarding malformed upstream errors", async () => {
    const conflict = createServer((_incoming, response) => {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "This setup was already started with different details.", code: "intent_conflict" }));
    });
    servers.push(conflict);
    const conflictResponse = await proxyGoOnboardingCreate(request(validBody), { baseUrl: await listen(conflict) });
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toEqual({
      error: "This setup was already started with different details.",
      code: "intent_conflict",
    });

    const broken = createServer((_incoming, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "database password details", code: "server_error" }));
    });
    servers.push(broken);
    const brokenResponse = await proxyGoOnboardingCreate(request(validBody), { baseUrl: await listen(broken) });
    expect(brokenResponse.status).toBe(503);
    expect(await brokenResponse.json()).toEqual({
      error: "Workspace setup is unavailable. Try again in a moment.",
      code: "server_error",
    });
  });

  it("fails closed on timeout without retrying against the TypeScript writer", async () => {
    const slow = createServer((_incoming, response) => {
      setTimeout(() => {
        if (!response.destroyed) response.end(JSON.stringify({ orgId: "d4d0f18b-d20c-421e-a7fc-78281a97cab4", replayed: false }));
      }, 100);
    });
    servers.push(slow);
    const response = await proxyGoOnboardingCreate(request(validBody), { baseUrl: await listen(slow), timeoutMs: 10 });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "server_error" });
  });
});
