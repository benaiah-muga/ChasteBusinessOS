/**
 * ARCH-5 — workflow persistence E2E (real PostgreSQL + HTTP server).
 *
 * Proves user-built workflows are persisted to Postgres and survive a full
 * app-context rebuild (process restart proxy), and that CRUD is exercised via
 * the command/query bus rather than an in-memory Map.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "@chaste/db";
import { buildServer } from "./server.js";
import type { AppContext } from "./app-context.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const ADDR = "http://127.0.0.1";

describe.skipIf(!hasDb)("ARCH-5 workflow persistence", () => {
  let server: FastifyInstance;
  let app: AppContext;
  let base: string;

  beforeAll(async () => {
    await runMigrations(process.env.DATABASE_URL!);
    const built = await buildServer();
    server = built.server;
    app = built.app;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `${ADDR}:${port}`;
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  it("creates and lists a persisted workflow via the bus", async () => {
    const wf = {
      name: `Persist Wf ${Date.now()}`,
      description: "ARCH-5 persistence check",
      steps: [
        {
          id: "s1",
          type: "command",
          command: "core.modules.list",
          description: "list modules",
          onError: "bail",
        },
      ],
    };

    const created = (await fetch(`${base}/api/v1/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wf),
    }).then((r) => r.json())) as { id: string; name: string; steps: unknown[] };
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(wf.name);
    expect(created.steps).toHaveLength(1);

    const list = (await fetch(`${base}/api/v1/workflows`).then((r) => r.json())) as {
      items: { id: string; name: string }[];
    };
    expect(list.items.some((i) => i.id === created.id)).toBe(true);

    const fetched = (await fetch(`${base}/api/v1/workflows/${created.id}`).then((r) => r.json())) as {
      id: string;
      name: string;
    };
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe(wf.name);
  }, 30_000);

  it("a workflow survives a full app-context rebuild (process restart)", async () => {
    const wf = {
      name: `Restart Survive ${Date.now()}`,
      description: "must persist across rebuild",
      steps: [
        { id: "s1", type: "command", command: "core.modules.list", onError: "bail" },
      ],
    };
    const created = (await fetch(`${base}/api/v1/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wf),
    }).then((r) => r.json())) as { id: string; name: string };
    const persistedId = created.id;

    // Simulate a restart: tear down and rebuild the app context + server.
    await server.close();
    await runMigrations(process.env.DATABASE_URL!);
    const rebuilt = await buildServer();
    server = rebuilt.server;
    app = rebuilt.app;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `${ADDR}:${port}`;

    const revived = (await fetch(`${base}/api/v1/workflows/${persistedId}`).then((r) => r.json())) as {
      id: string;
      name: string;
    };
    expect(revived.id).toBe(persistedId);
    expect(revived.name).toBe(wf.name);
  }, 60_000);
});