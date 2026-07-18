import {
  createCommandRegistry,
  createRequestContext,
  defineCommand,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
} from "@chaste/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handleChatTurn, planFromText } from "./orchestrator.js";

describe("planFromText", () => {
  it("parses customer and payroll intents", () => {
    expect(planFromText("Create customer Acme Ltd in Nairobi")).toMatchObject({
      command: "crm.customer.create",
    });
    expect(planFromText("Prepare payroll for March 2026")).toMatchObject({
      command: "hr.payroll.prepare",
    });
  });
});

describe("handleChatTurn", () => {
  it("creates customer through command bus after confirm", async () => {
    const commands = createCommandRegistry();
    commands.register(
      defineCommand({
        name: "crm.customer.create",
        permissions: ["crm.customer.create"],
        tags: ["crm"],
        input: z.object({
          name: z.string(),
          city: z.string().optional(),
        }),
        output: z.object({ id: z.string(), name: z.string(), city: z.string().optional() }),
        handler: async (input) => ({ id: "c1", name: input.name, city: input.city }),
      }),
    );
    const audit = new InMemoryAuditWriter();
    const outbox = new InMemoryOutboxWriter();
    const ctx = createRequestContext({
      actor: {
        kind: "user",
        userId: "u1",
        organizationId: "o1",
        permissions: new Set(["crm.customer.create"]),
      },
      autonomy: "confirm",
    });

    const emptyQueries = {
      register() {},
      get() {
        return undefined;
      },
      list: () => [],
    };

    const plan = await handleChatTurn(
      {
        commands,
        queries: emptyQueries,
        helpers: { audit, outbox },
        autonomy: "confirm",
      },
      {
        session: { id: "s1", messages: [] },
        userText: "Create customer Acme Ltd in Nairobi",
        ctx,
      },
    );

    expect(plan.session.pending?.command).toBe("crm.customer.create");

    const confirmed = await handleChatTurn(
      {
        commands,
        queries: emptyQueries,
        helpers: { audit, outbox },
        autonomy: "confirm",
      },
      {
        session: plan.session,
        confirmId: plan.session.pending!.id,
        ctx,
      },
    );

    expect(confirmed.session.pending).toBeUndefined();
    expect(audit.entries.some((e) => e.success && e.action === "crm.customer.create")).toBe(true);
  });
});
