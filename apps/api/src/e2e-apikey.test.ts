/**
 * API keys E2E (real PostgreSQL + HTTP server).
 *
 * Verifies the full machine-credential lifecycle at the HTTP edge:
 *  - `core.apikey.create` mints a secret that is hashed at rest (never raw);
 *  - `X-Api-Key` authenticates as an org-scoped `api_key` principal whose
 *    permissions are exactly its declared scopes (least privilege);
 *  - an out-of-scope command is denied (403) while in-scope works;
 *  - revoked / expired / unknown keys are rejected with 401;
 *  - commands run with a key are audit-attributed to the key actor.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDb, hashApiKeySecret, runMigrations, schema } from "@chaste/db";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import type { AppContext } from "./app-context.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const ADDR = "http://127.0.0.1";

describe.skipIf(!hasDb)("API keys (org-scoped machine credentials)", () => {
  let server: FastifyInstance;
  let app: AppContext;
  let base: string;
  let db: ReturnType<typeof createDb>;
  let orgId: string;

  const createdKeyIds: string[] = [];
  const createdCustomerIds: string[] = [];

  async function adminCommand(
    name: string,
    input: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/v1/commands/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
    return { status: res.status, body: await res.json() };
  }

  async function createKey(scopes: string[], opts: { name?: string; expiresAt?: string } = {}) {
    const { status, body } = await adminCommand("core.apikey.create", {
      name: opts.name ?? `e2e-${Date.now()}`,
      scopes,
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    });
    expect(status).toBe(200);
    const data = body.data as { id: string; secret: string; prefix: string; scopes: string[] };
    createdKeyIds.push(data.id);
    return data;
  }

  async function call(path: string, init?: RequestInit & { apiKey?: string }) {
    const { apiKey, ...rest } = init ?? {};
    const headers: Record<string, string> = {
      ...(rest.headers as Record<string, string> | undefined),
      "content-type": "application/json",
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await fetch(`${base}${path}`, { ...rest, headers });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    process.env.CHASTE_ALLOW_ANON_ADMIN = "true";
    const built = await buildServer();
    server = built.server;
    app = built.app;
    db = createDb(process.env.DATABASE_URL!);
    await runMigrations(process.env.DATABASE_URL!);
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `${ADDR}:${port}`;
    orgId = app.sessionUser.organizationId;
  }, 60_000);

  it("core.apikey.create returns the secret once and stores only a digest", async () => {
    const key = await createKey(["crm.customer.read"], { name: "read-only-integration" });
    expect(key.secret).toMatch(/^chaste_[0-9a-f]{64}$/);
    expect(key.prefix).toMatch(/^chaste_[0-9a-f]{8}$/);
    expect(key.scopes).toEqual(["crm.customer.read"]);

    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, key.id));
    expect(row).toBeDefined();
    expect(row!.hashedSecret).not.toBe(key.secret); // never plaintext at rest
    expect(row!.hashedSecret).toBe(hashApiKeySecret(key.secret));
    expect(row!.organizationId).toBe(orgId);
  });

  it("rejects unknown scopes at creation", async () => {
    const { status } = await adminCommand("core.apikey.create", {
      name: "bad-scope",
      scopes: ["ghost.scope.not.in.catalog"],
    });
    expect(status).toBe(400);
  });

  it("a read-scoped key can call in-scope queries but not out-of-scope commands", async () => {
    const key = await createKey(["crm.customer.read"]);

    const list = await call("/api/v1/crm/customers", { apiKey: key.secret });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);

    const create = await call("/api/v1/crm/customers", {
      method: "POST",
      apiKey: key.secret,
      body: JSON.stringify({ name: "Should Not Exist" }),
    });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe("PERMISSION_DENIED");
  });

  it("a scoped create+read key can write, and audit attributes to the api_key actor", async () => {
    const key = await createKey(["crm.customer.read", "crm.customer.create"], {
      name: "full-crm-integration",
    });

    const create = await call("/api/v1/crm/customers", {
      method: "POST",
      apiKey: key.secret,
      body: JSON.stringify({ name: "API Key Customer", city: "Nairobi" }),
    });
    expect(create.status).toBe(200);
    const customerId = create.body.id ?? create.body.data?.id;
    createdCustomerIds.push(customerId);

    const audit = await call("/api/v1/audit");
    expect(audit.status).toBe(200);
    const entry = (audit.body.items as { action: string; actorKind: string }[]).find(
      (e) => e.action === "crm.customer.create" && e.actorKind === "api_key",
    );
    expect(entry).toBeDefined();
  });

  it("revoked keys are rejected with 401 and no longer resolve", async () => {
    const key = await createKey(["crm.customer.read"]);

    const before = await call("/api/v1/crm/customers", { apiKey: key.secret });
    expect(before.status).toBe(200);

    const revoke = await adminCommand("core.apikey.revoke", { apiKeyId: key.id });
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.status).toBe("revoked");

    const after = await call("/api/v1/crm/customers", { apiKey: key.secret });
    expect(after.status).toBe(401);
  });

  it("expired keys are rejected with 401", async () => {
    const key = await createKey(["crm.customer.read"], {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await call("/api/v1/crm/customers", { apiKey: key.secret });
    expect(res.status).toBe(401);
  });

  it("unknown/invalid keys are rejected with 401", async () => {
    const res = await call("/api/v1/crm/customers", { apiKey: "chaste_" + "0".repeat(64) });
    expect(res.status).toBe(401);
  });

  it("core.apikey.rotate invalidates the old secret and mints a new one", async () => {
    const key = await createKey(["crm.customer.read"], { name: "rotatable" });

    const rotated = await adminCommand("core.apikey.rotate", { apiKeyId: key.id });
    expect(rotated.status).toBe(200);
    const newSecret = rotated.body.data.secret as string;
    expect(newSecret).not.toBe(key.secret);

    const oldCall = await call("/api/v1/crm/customers", { apiKey: key.secret });
    expect(oldCall.status).toBe(401);
    const newCall = await call("/api/v1/crm/customers", { apiKey: newSecret });
    expect(newCall.status).toBe(200);
  });

  it("core.apikey.list never exposes secrets", async () => {
    const key = await createKey(["crm.customer.read"], { name: "listable" });
    // core.apikey.list is a query → goes through the queries endpoint.
    const res = await fetch(`${base}/api/v1/queries/core.apikey.list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data?.items as Array<Record<string, unknown>>;
    expect(items.some((k) => k.id === key.id)).toBe(true);
    for (const k of items) {
      expect(k).not.toHaveProperty("hashedSecret");
      expect(k).not.toHaveProperty("secret");
    }
  });

  afterAll(async () => {
    try {
      if (db) {
        if (createdKeyIds.length > 0) {
          await db.delete(schema.apiKeys).where(inArray(schema.apiKeys.id, createdKeyIds));
        }
        if (createdCustomerIds.length > 0) {
          await db
            .delete(schema.crmCustomers)
            .where(inArray(schema.crmCustomers.id, createdCustomerIds));
        }
      }
    } finally {
      await server.close();
      delete process.env.CHASTE_ALLOW_ANON_ADMIN;
    }
  });
});
