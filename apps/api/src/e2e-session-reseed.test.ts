/**
 * Session self-healing E2E (real PostgreSQL + HTTP server).
 *
 * Regression test for the stale-session bug: the API's anonymous (dev-only)
 * fallback session was a boot-time snapshot of the bootstrap admin. If the
 * database is truncated/reseeded while the process is alive (test runs, manual
 * resets, seed scripts), that cached org/user uuid points at deleted rows and
 * every org-scoped query silently returns empty until the process restarts.
 *
 * This test reproduces the exact sequence: build a server, read the session,
 * wipe the core tables, re-seed, and read the session again — the second read
 * must resolve to the NEW bootstrap admin's org (self-healing), not the stale
 * cached one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapPlatform, cleanupTestData, createDb, runMigrations, schema } from "@chaste/db";
import { eq } from "drizzle-orm";
import { buildServer } from "./server.js";
import type { AppContext } from "./app-context.js";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("anonymous session self-heals after a DB reseed", () => {
  let server: FastifyInstance;
  let app: AppContext;
  let base: string;
  let db: ReturnType<typeof createDb>;

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
    base = `http://127.0.0.1:${port}`;
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  it("session resolves to a live org before the wipe", async () => {
    const session = (await fetch(`${base}/api/v1/session`).then((r) => r.json())) as {
      organizationId: string;
      userId: string;
    };
    expect(session.organizationId).toBeTruthy();
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, session.organizationId));
    expect(org).toBeDefined();
  });

  it("wipes the core tables while the server is alive", async () => {
    await cleanupTestData(db);
    const [org] = await db.select().from(schema.organizations).limit(1);
    expect(org).toBeUndefined();
  });

  it("re-seeds a fresh bootstrap admin", async () => {
    const result = await bootstrapPlatform(db, app.config);
    expect(result.organizationId).toBeTruthy();
    expect(result.adminUserId).toBeTruthy();
  });

  it("session self-heals to the NEW org instead of the stale cached one", async () => {
    // Before the wipe the session pointed at the old org; after truncate +
    // re-seed the bootstrap admin has a brand-new org uuid. A stale cached
    // session would still return the deleted org id.
    const session = (await fetch(`${base}/api/v1/session`).then((r) => r.json())) as {
      organizationId: string;
      userId: string;
      permissions: string[];
    };
    expect(session.organizationId).toBeTruthy();
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, session.organizationId));
    expect(org).toBeDefined();
    // The org-scoped query path must be live again against the fresh org.
    const rbac = (await fetch(`${base}/api/v1/rbac`).then((r) => r.json())) as {
      roles: unknown[];
    };
    expect(Array.isArray(rbac.roles)).toBe(true);
    expect(rbac.roles.length).toBeGreaterThan(0);
    expect(session.permissions.length).toBeGreaterThan(5);
  });
});
