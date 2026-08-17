import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { schema } from "@chaste/db";
import { buildServer } from "./server.js";
import type { AppContext } from "./app-context.js";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("postgres harness host e2e", () => {
  let server: FastifyInstance;
  let app: AppContext;
  let base: string;
  let sessionId: string | undefined;
  let inboxItemIds: string[] = [];

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
    // Test isolation — remove artifacts this suite wrote to the shared DB.
    if (app.db) {
      if (inboxItemIds.length > 0) {
        await app.db
          .delete(schema.pendingApprovals)
          .where(inArray(schema.pendingApprovals.id, inboxItemIds));
      }
      if (sessionId) {
        await app.db
          .delete(schema.agentSessionEvents)
          .where(eq(schema.agentSessionEvents.sessionId, sessionId));
      }
      await app.db
        .delete(schema.approvalGrants)
        .where(eq(schema.approvalGrants.policyBasis, "plan-approval"));
    }
    await server.close();
  });

  it("serves the inbox for the authenticated actor", async () => {
    const res = await fetch(`${base}/api/v1/inbox`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("executes a low-risk plan through the harness host", async () => {
    sessionId = crypto.randomUUID();
    const res = await fetch(`${base}/api/v1/ai/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        reason: "vitest harness e2e",
        plan: {
          id: "plan-e2e-low",
          objective: "List workflows",
          assumptions: [],
          steps: [{ id: "s1", title: "List workflows", command: "core.workflow.list", args: {} }],
          requiredApprovals: [],
          risks: [{ level: "low", description: "read-only" }],
          evidenceNeeded: [],
          stopConditions: [],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("executed");
    expect(body.result.ok).toBe(true);
    expect(Array.isArray(body.result.steps)).toBe(true);
  });

  it("rejects a malformed plan at the HTTP boundary", async () => {
    const res = await fetch(`${base}/api/v1/ai/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: crypto.randomUUID(),
        plan: { id: "plan-e2e-bad", objective: "Bad" },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("surfaces a plan for approval and executes it after a decision", async () => {
    const sid = crypto.randomUUID();
    const submit = await fetch(`${base}/api/v1/ai/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: sid,
        reason: "vitest harness e2e approval",
        plan: {
          id: "plan-e2e-gated",
          objective: "Review then list workflows",
          assumptions: [],
          steps: [{ id: "s1", title: "List workflows", command: "core.workflow.list", args: {} }],
          requiredApprovals: [
            { commandType: "core.workflow.list", riskClass: "exec", reason: "gated by policy" },
          ],
          risks: [{ level: "medium", description: "gated plan" }],
          evidenceNeeded: [],
          stopConditions: [],
        },
      }),
    });
    const submitted = await submit.json();
    expect(submitted.status).toBe("pending_approval");
    const itemId = submitted.itemId as string;
    expect(itemId).toBeTruthy();
    inboxItemIds.push(itemId);

    const inbox = await fetch(`${base}/api/v1/inbox`).then((r) => r.json());
    expect(inbox.items.some((i: { id: string }) => i.id === itemId)).toBe(true);

    const decide = await fetch(`${base}/api/v1/inbox/${itemId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: "approved" }),
    });
    expect(decide.status).toBe(200);
    const decided = await decide.json();
    expect(decided).toMatchObject({ resolved: true, kind: "plan" });
    expect(decided.result.ok).toBe(true);

    const grants = await app.db
      .select()
      .from(schema.approvalGrants)
      .where(eq(schema.approvalGrants.policyBasis, "plan-approval"));
    expect(grants.length).toBeGreaterThanOrEqual(1);
  });
});