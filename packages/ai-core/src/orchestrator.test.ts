import {
  createCommandRegistry,
  createRequestContext,
  defineCommand,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
} from "@chaste/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handleChatTurn, planFromText, planManyFromText, planDataQuestion } from "./orchestrator.js";

describe("planFromText", () => {
  it("parses customer and payroll intents", () => {
    expect(planFromText("Create customer Acme Ltd in Nairobi")).toMatchObject({
      command: "crm.customer.create",
    });
    expect(planFromText("Prepare payroll for March 2026")).toMatchObject({
      command: "hr.payroll.prepare",
    });
  });

  it("parses branch-open into a branch create with a derived code", () => {
    expect(planFromText("Open a new branch in Nairobi")).toMatchObject({
      command: "core.branch.create",
      input: { name: "Nairobi Branch", code: "NAIR" },
    });
  });
});

describe("planManyFromText — recurring / standing watch rules", () => {
  it("routes 'remind me every friday at 4pm to review stockouts' to a weekly watch rule", () => {
    const [plan] = planManyFromText("Remind me every friday at 4pm to review stockouts");
    expect(plan?.command).toBe("core.watchRule.create");
    expect(plan?.input).toMatchObject({
      trigger: {
        kind: "schedule",
        recurrence: { freq: "weekly", daysOfWeek: [5], at: "16:00" },
      },
      action: { mode: "notify", recipients: ["me"], intent: "review stockouts" },
    });
  });

  it("routes 'every morning, tell branch managers …' to a daily rule for the role group", () => {
    const [plan] = planManyFromText(
      "Every morning, tell branch managers which products are at risk of stockout",
    );
    expect(plan?.command).toBe("core.watchRule.create");
    expect(plan?.input).toMatchObject({
      trigger: { kind: "schedule", recurrence: { freq: "daily", at: "09:00" } },
      action: { mode: "notify", recipients: ["branch_manager"] },
    });
  });

  it("routes 'remind branch managers every Friday to review stockouts' (verb-first, no comma)", () => {
    const [plan] = planManyFromText("remind branch managers every Friday to review stockouts");
    expect(plan?.command).toBe("core.watchRule.create");
    expect(plan?.input).toMatchObject({
      trigger: { kind: "schedule", recurrence: { freq: "weekly", daysOfWeek: [5] } },
      action: { mode: "notify", recipients: ["branch_manager"], intent: "review stockouts" },
    });
  });

  it("maps 'if supplier bills over 5 million arrive, ask me before approval routing' to request_approval", () => {
    const [plan] = planManyFromText(
      "If supplier bills over 5 million arrive, ask me before approval routing",
    );
    expect(plan?.command).toBe("core.watchRule.create");
    expect(plan?.input).toMatchObject({
      condition: "po.total gt 5000000",
      action: { mode: "request_approval", recipients: ["me"], intent: "approval routing" },
    });
  });

  it("maps a follow-up+draft request to a draft watch rule with an overdue condition", () => {
    const [plan] = planManyFromText(
      "Follow up with customers whose invoices are overdue by >14 days, draft for approval",
    );
    expect(plan?.command).toBe("core.watchRule.create");
    expect(plan?.input).toMatchObject({
      condition: "invoice.overdue gt 14",
      action: { mode: "draft", recipients: ["me"] },
    });
  });

  it("parses deictic 'send this every monday' into a weekly rule for me", () => {
    const [plan] = planManyFromText("send this every Monday");
    expect(plan?.command).toBe("core.watchRule.create");
    expect(plan?.input).toMatchObject({
      trigger: { kind: "schedule", recurrence: { freq: "weekly", daysOfWeek: [1] } },
      action: { recipients: ["me"] },
    });
  });

  it("parses deictic 'make it monthly' into a monthly watch rule", () => {
    const [plan] = planManyFromText("make it monthly");
    expect(plan?.command).toBe("core.watchRule.create");
    expect(plan?.input).toMatchObject({
      trigger: { kind: "schedule", recurrence: { freq: "monthly" } },
      action: { recipients: ["me"] },
    });
  });

  it("parses 'schedule payroll approval for the 25th' into a monthly rule", () => {
    const [plan] = planManyFromText("schedule payroll approval for the 25th");
    expect(plan?.command).toBe("core.watchRule.create");
    expect(plan?.input).toMatchObject({
      trigger: { kind: "schedule", recurrence: { freq: "monthly" } },
      action: { intent: "payroll approval", recipients: ["me"] },
    });
  });

  it("extracts the ping recipient and approval condition on a day-of-month rule", () => {
    const [plan] = planManyFromText(
      "Schedule payroll approval for the 25th, and ping Finance if not approved by 3pm",
    );
    expect(plan?.command).toBe("core.watchRule.create");
    expect(plan?.input).toMatchObject({
      trigger: { kind: "schedule", recurrence: { freq: "monthly" } },
      action: { recipients: ["finance"] },
      condition: expect.stringMatching(/approved/),
    });
  });

  it("carries the org timezone into the watch-rule trigger", () => {
    const [plan] = planManyFromText(
      "Remind me every morning at 8am to review stockouts",
      "Africa/Kampala",
    );
    expect(plan?.input).toMatchObject({
      trigger: {
        kind: "schedule",
        recurrence: { freq: "daily", at: "08:00" },
        timezone: "Africa/Kampala",
      },
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

describe("planManyFromText — import / data-quality rules and dashboards", () => {
  it("maps 'treat blank tax IDs as unknown' to a blank_as_unknown import rule", () => {
    const [plan] = planManyFromText("treat blank tax IDs as unknown");
    expect(plan?.command).toBe("core.importRule.create");
    expect(plan?.input).toMatchObject({
      scope: "customer",
      ruleType: "blank_as_unknown",
      field: "tax IDs",
    });
  });

  it("maps 'split full name into first and last name' to a split_field import rule", () => {
    const [plan] = planManyFromText("split full name into first and last name");
    expect(plan?.command).toBe("core.importRule.create");
    expect(plan?.input).toMatchObject({
      scope: "customer",
      ruleType: "split_field",
      field: "full name",
      config: { into: ["first", "last name"] },
    });
  });

  it("maps 'these two supplier columns are the same supplier' to a dedupe_column import rule", () => {
    const [plan] = planManyFromText("these two supplier columns are the same supplier");
    expect(plan?.command).toBe("core.importRule.create");
    expect(plan?.input).toMatchObject({
      scope: "supplier",
      ruleType: "dedupe_column",
    });
  });

  it("maps 'turn this into a dashboard' to a deterministic dashboard create", () => {
    const [plan] = planManyFromText("turn this into a dashboard");
    expect(plan?.command).toBe("core.dashboard.create");
    expect(plan?.input).toMatchObject({
      name: "Monthly sales",
      widgets: [{ query: "core.analytics.salesSummary" }],
    });
  });

  it("maps 'create a dashboard for our stock levels at Ntinda' to a named dashboard with a stock widget", () => {
    const [plan] = planManyFromText("Create a dashboard for our stock levels at Ntinda");
    expect(plan?.command).toBe("core.dashboard.create");
    expect(plan?.input).toMatchObject({
      name: "Stock levels at Ntinda",
      widgets: [{ query: "inv.stock.list", title: "Stock levels at Ntinda" }],
    });
  });

  it("maps a purchase-order request to pur.po.create with resolvable name refs", () => {
    const [plan] = planManyFromText("Raise a purchase order for 60 bags of Wheat Flour from Kampala Flour Mills");
    expect(plan?.command).toBe("pur.po.create");
    expect(plan?.input).toMatchObject({
      vendorRef: "Kampala Flour Mills",
      productRef: "Wheat Flour",
      qty: 60,
      generateNumber: true,
    });
  });

  it("maps a goods-receive to a positive inv.stock.adjust with name refs", () => {
    const [plan] = planManyFromText("Receive 50 bags of Sugar at the Mbarara warehouse");
    expect(plan?.command).toBe("inv.stock.adjust");
    expect(plan?.input).toMatchObject({
      productRef: "Sugar",
      warehouseRef: "Mbarara",
      quantityDelta: 50,
    });
  });

  it("maps a spoilage adjustment to a negative inv.stock.adjust", () => {
    const [plan] = planManyFromText("Adjust stock of Fresh Yeast at Mukono down by 2 because of spoilage");
    expect(plan?.command).toBe("inv.stock.adjust");
    expect(plan?.input).toMatchObject({
      productRef: "Fresh Yeast",
      warehouseRef: "Mukono",
      quantityDelta: -2,
      reason: "spoilage",
    });
  });

  it("maps a balancing journal entry to acc.journal.post with account refs", () => {
    const [plan] = planManyFromText(
      "Post a journal entry JE-100 for rent: debit Expenses 800,000 and credit Cash 800,000",
    );
    expect(plan?.command).toBe("acc.journal.post");
    expect(plan?.input).toMatchObject({
      reference: "JE-100",
      memo: "rent",
      debitAccountRef: "Expenses",
      debitAmount: 800000,
      creditAccountRef: "Cash",
      creditAmount: 800000,
    });
  });

  it("maps an invoice with a customer and comma-separated amount to acc.invoice.create", () => {
    const [plan] = planManyFromText("Issue an invoice INV-1101 for 1,250,000 UGX to Ntinda Supermarket");
    expect(plan?.command).toBe("acc.invoice.create");
    expect(plan?.input).toMatchObject({
      number: "INV-1101",
      total: 1250000,
      currency: "UGX",
      customerRef: "Ntinda Supermarket",
    });
  });
});

describe("planDataQuestion — deterministic analytics / replenishment reads", () => {
  it("maps a margin drop question to the margin trend query", () => {
    const plan = planDataQuestion("why did margins fall this month?");
    expect(plan?.kind).toBe("margin");
  });

  it("maps 'compare to last quarter' to the margin trend query over 3 months", () => {
    const plan = planDataQuestion("compare to last quarter");
    expect(plan?.kind).toBe("margin");
    expect(plan?.input).toMatchObject({ months: 3 });
  });

  it("maps 'show this by branch' to sales grouped by location", () => {
    const plan = planDataQuestion("show this by branch");
    expect(plan?.kind).toBe("salesByLocation");
  });

  it("maps a low-inventory/replenishment request to the replenishment proposal query", () => {
    const plan = planDataQuestion("inventory is getting low; handle replenishment");
    expect(plan?.kind).toBe("replenishment");
  });

  it("answers a compound sales-by-branch + schedule via planManyFromText without a write plan for the read", () => {
    // The read part alone must not produce a write; the schedule part does.
    const read = planDataQuestion("show monthly sales by branch and schedule this every Monday");
    expect(read?.kind).toBe("salesByLocation");
    const writePlans = planManyFromText("show monthly sales by branch and schedule this every Monday");
    expect(writePlans).toHaveLength(1);
    expect(writePlans[0]?.command).toBe("core.watchRule.create");
  });
});

describe("planDataQuestion — operational reads (procurement / inventory / sales / finance)", () => {
  it("maps 'show our purchase orders' to the purchase-order list query", () => {
    const plan = planDataQuestion("Show our purchase orders");
    expect(plan?.kind).toBe("purchaseOrders");
  });

  it("does not shadow a purchase-order WRITE with a read", () => {
    expect(planDataQuestion("Raise a purchase order for 60 bags of Wheat Flour from Kampala Flour Mills")).toBeNull();
  });

  it("maps 'show current stock levels at Jinja' to stock levels scoped to Jinja", () => {
    const plan = planDataQuestion("Show current stock levels at Jinja");
    expect(plan?.kind).toBe("stockLevels");
    expect(plan?.input).toMatchObject({ warehouseRef: "jinja" });
  });

  it("does not read stock when the message is a dashboard create", () => {
    expect(planDataQuestion("Create a dashboard for our stock levels at Ntinda")).toBeNull();
  });

  it("maps 'list all our customers' to the customer list query", () => {
    const plan = planDataQuestion("List all our customers");
    expect(plan?.kind).toBe("customers");
  });

  it("maps an overdue-invoice question to the receivables read", () => {
    const plan = planDataQuestion("Which customers have overdue invoices?");
    expect(plan?.kind).toBe("receivables");
  });

  it("maps an expense question to the margin-trend (expenses) read", () => {
    const plan = planDataQuestion("How much did we spend on expenses this month?");
    expect(plan?.kind).toBe("expenses");
  });

  it("maps 'show sales for the Jinja branch' to sales filtered by location", () => {
    const plan = planDataQuestion("Show sales for the Jinja branch");
    expect(plan?.kind).toBe("salesByLocation");
    expect(plan?.input).toMatchObject({ location: "jinja" });
  });

  it("maps 'compare margins this month to last month' to a 2-month margin window", () => {
    const plan = planDataQuestion("Compare margins this month to last month");
    expect(plan?.kind).toBe("margin");
    expect(plan?.input).toMatchObject({ months: 2 });
  });
});
