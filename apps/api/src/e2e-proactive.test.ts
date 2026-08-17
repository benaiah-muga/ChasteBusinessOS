/**
 * ADR 0014 — proactive coordinator HTTP surface E2E (real PostgreSQL + server).
 *
 * Proves the watch-rule CRUD, preferences, dry-run suggestions, and the
 * deliver tick are all reachable over HTTP, org-scoped, and persist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "@chaste/db";
import { buildServer } from "./server.js";
import type { AppContext } from "./app-context.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const ADDR = "http://127.0.0.1";

describe.skipIf(!hasDb)("Proactive coordinator HTTP surface", () => {
  let server: FastifyInstance;
  let app: AppContext;
  let base: string;
  let ruleId: string;
  const hour = String(new Date().getUTCHours()).padStart(2, "0");

  function futureNow(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(Number(hour), 5, 0, 0);
    return d.toISOString();
  }

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

  it("creates, lists, pauses, re-enables, and deletes a watch rule", async () => {
    const created = (await fetch(`${base}/api/v1/proactive/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Low-stock alert",
        trigger: { kind: "schedule", recurrence: { freq: "daily", at: `${hour}:00` }, timezone: "UTC" },
        action: { mode: "notify", intent: "Notify the buyer about low stock", recipients: ["buyer-1"] },
      }),
    }).then((r) => r.json())) as { id: string; name: string; enabled: boolean };
    expect(created.id).toBeTruthy();
    expect(created.enabled).toBe(true);
    ruleId = created.id;

    const listed = (await fetch(`${base}/api/v1/proactive/rules`).then((r) => r.json())) as {
      items: { id: string }[];
    };
    expect(listed.items.some((i) => i.id === ruleId)).toBe(true);

    const paused = (await fetch(`${base}/api/v1/proactive/rules/${ruleId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }).then((r) => r.json())) as { enabled: boolean };
    expect(paused.enabled).toBe(false);

    const resumed = (await fetch(`${base}/api/v1/proactive/rules/${ruleId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }).then((r) => r.json())) as { enabled: boolean };
    expect(resumed.enabled).toBe(true);

    const deleted = (await fetch(`${base}/api/v1/proactive/rules/${ruleId}`, {
      method: "DELETE",
    }).then((r) => r.json())) as { removed: boolean };
    expect(deleted.removed).toBe(true);

    const after = (await fetch(`${base}/api/v1/proactive/rules`).then((r) => r.json())) as {
      items: { id: string }[];
    };
    expect(after.items.some((i) => i.id === ruleId)).toBe(false);
  }, 30_000);

  it("reports due suggestions (dry-run) and records deliveries on a tick", async () => {
    const created = (await fetch(`${base}/api/v1/proactive/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Weekly review",
        trigger: { kind: "schedule", recurrence: { freq: "daily", at: `${hour}:00` }, timezone: "UTC" },
        action: { mode: "request_approval", intent: "Draft the weekly review", recipients: ["buyer-1"] },
      }),
    }).then((r) => r.json())) as { id: string };
    ruleId = created.id;

    const suggestions = (await fetch(
      `${base}/api/v1/proactive/suggestions?now=${encodeURIComponent(futureNow())}`,
    ).then((r) => r.json())) as { suggestions: { requiredApproval: boolean }[] };
    expect(suggestions.suggestions).toHaveLength(1);
    expect(suggestions.suggestions[0]!.requiredApproval).toBe(true);

    const tick = (await fetch(`${base}/api/v1/proactive/tick`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ now: futureNow() }),
    }).then((r) => r.json())) as { deliveries: { suppressed: boolean; requiredApproval: boolean }[] };
    expect(tick.deliveries).toHaveLength(1);
    expect(tick.deliveries[0]?.suppressed).toBe(false);
    expect(tick.deliveries[0]?.requiredApproval).toBe(true);
  }, 30_000);

  it("reads and edits org proactive preferences", async () => {
    const defaults = (await fetch(`${base}/api/v1/proactive/preferences`).then((r) => r.json())) as {
      maxSuggestionsPerDay: number;
    };
    expect(defaults.maxSuggestionsPerDay).toBe(10);

    const updated = (await fetch(`${base}/api/v1/proactive/preferences`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        maxSuggestionsPerDay: 3,
        quietHours: { start: "22:00", end: "07:00", timezone: "UTC" },
      }),
    }).then((r) => r.json())) as { maxSuggestionsPerDay: number; quietHours: { start: string } };
    expect(updated.maxSuggestionsPerDay).toBe(3);
    expect(updated.quietHours?.start).toBe("22:00");

    const fetched = (await fetch(`${base}/api/v1/proactive/preferences`).then((r) => r.json())) as {
      maxSuggestionsPerDay: number;
    };
    expect(fetched.maxSuggestionsPerDay).toBe(3);
    void app;
  }, 30_000);
});