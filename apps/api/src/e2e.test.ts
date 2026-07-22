import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import type { AppContext } from "./app-context.js";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("postgres e2e", () => {
  let server: FastifyInstance;
  let app: AppContext;
  let base: string;

  beforeAll(async () => {
    const built = await buildServer();
    server = built.server;
    app = built.app;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  it("health and session with RBAC permissions", async () => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health).toMatchObject({ ok: true });
    const session = (await fetch(`${base}/api/v1/session`).then((r) => r.json())) as {
      permissions: string[];
    };
    expect(session.permissions.length).toBeGreaterThan(5);
  });

  it("manual CRM create persists", async () => {
    const name = `Vitest Co ${Date.now()}`;
    const created = (await fetch(`${base}/api/v1/crm/customers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, city: "Kampala" }),
    }).then((r) => r.json())) as { name: string };
    expect(created.name).toBe(name);
    const list = (await fetch(`${base}/api/v1/crm/customers`).then((r) => r.json())) as {
      items: { name: string }[];
    };
    expect(list.items.some((i) => i.name === name)).toBe(true);
  });

  it("AI confirm path uses same command bus", async () => {
    const chat = (await fetch(`${base}/api/v1/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: `Create customer Vitest AI ${Date.now()} in Nairobi` }),
    }).then((r) => r.json())) as { sessionId: string; pendingConfirmationId?: string };
    expect(chat.pendingConfirmationId).toBeTruthy();
    await fetch(`${base}/api/v1/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: chat.sessionId, confirmId: chat.pendingConfirmationId }),
    });
    expect(app.explanations.length).toBeGreaterThan(0);
  });

  it("marketplace and rbac endpoints work", async () => {
    const market = (await fetch(`${base}/api/v1/marketplace`).then((r) => r.json())) as {
      items: unknown[];
    };
    expect(market.items.length).toBeGreaterThanOrEqual(6);
    const rbac = (await fetch(`${base}/api/v1/rbac`).then((r) => r.json())) as {
      roles: unknown[];
    };
    expect(rbac.roles.length).toBeGreaterThanOrEqual(1);
  });
});
