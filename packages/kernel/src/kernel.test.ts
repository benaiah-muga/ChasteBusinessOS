import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability, type ActionContext } from "./capability";
import { KernelExecutor } from "./executor";
import { InMemoryLedger } from "./ledger";
import { CapabilityRegistry } from "./registry";

function makeCtx(permissions: string[], type: "human" | "agent" = "agent"): ActionContext {
  return {
    actor: { type, id: "u1", orgId: "org1", permissions: new Set(permissions) },
    now: new Date("2026-08-21T00:00:00Z"),
    services: {},
  };
}

const createCustomer = defineCapability({
  id: "crm.createCustomer",
  title: "Create customer",
  intent: "Create a new customer record",
  module: "crm",
  risk: "write",
  permission: "crm.write",
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ id: z.string() }),
  execute: async (_ctx, input) => ({ id: `cus_${input.name.toLowerCase()}` }),
});

const postEntry = defineCapability({
  id: "accounting.postJournalEntry",
  title: "Post journal entry",
  intent: "Post an immutable journal entry to the ledger",
  module: "accounting",
  risk: "money",
  permission: "accounting.post",
  moneyThresholdMinor: 50_000,
  moneyAmount: (input) => input.amountMinor,
  input: z.object({ amountMinor: z.number().int() }),
  output: z.object({ posted: z.boolean() }),
  execute: async () => ({ posted: true }),
});

// Money-risk with an unknowable up-front amount (like a reversal): policy
// must gate it unconditionally instead of letting it slip through.
const reverseEntry = defineCapability({
  id: "accounting.reverseEntry",
  title: "Reverse journal entry",
  intent: "Reverse a posted journal entry with an exact mirror entry",
  module: "accounting",
  risk: "money",
  permission: "accounting.post",
  moneyAmount: () => null,
  input: z.object({ entryId: z.string() }),
  output: z.object({ reversed: z.boolean() }),
  execute: async () => ({ reversed: true }),
});

const grantRole = defineCapability({
  id: "iam.grantRole",
  title: "Grant role to user",
  intent: "Assign a role to a user (identity-sensitive)",
  module: "iam",
  risk: "identity",
  permission: "iam.admin",
  input: z.object({ userId: z.string() }),
  output: z.object({ granted: z.boolean() }),
  execute: async () => ({ granted: true }),
});

function buildKernel(approvals?: { proceed: boolean; verify?: (id: string) => boolean }) {
  const registry = new CapabilityRegistry();
  registry.register(createCustomer);
  registry.register(postEntry);
  registry.register(reverseEntry);
  registry.register(grantRole);
  const ledger = new InMemoryLedger();
  let approvalRequested = false;
  const executor = new KernelExecutor({
    registry,
    ledger,
    approvals: approvals
      ? {
          submit: async () => {
            approvalRequested = true;
            return approvals.proceed;
          },
          ...(approvals.verify ? { verify: async (id: string) => approvals.verify!(id) } : {}),
        }
      : undefined,
  });
  return { executor, ledger, registry, wasApprovalRequested: () => approvalRequested };
}

describe("governance pipeline", () => {
  it("executes permitted low-risk actions and audits them", async () => {
    const k = buildKernel();
    const res = await k.executor.execute(
      "crm.createCustomer",
      makeCtx(["crm.write"]),
      { name: "Acme" },
    );
    expect(res.ok).toBe(true);
    expect(k.ledger.entries).toHaveLength(1);
    expect(k.ledger.entries[0]?.kind).toBe("capability.executed");
    expect(k.ledger.entries[0]?.hash).toHaveLength(64);
  });

  it("rejects actions the actor lacks permission for", async () => {
    const k = buildKernel();
    const res = await k.executor.execute("crm.createCustomer", makeCtx([]), { name: "Acme" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("missing permission");
    expect(k.ledger.entries).toHaveLength(0);
  });

  it("rejects invalid input without executing", async () => {
    const k = buildKernel();
    const res = await k.executor.execute("crm.createCustomer", makeCtx(["crm.write"]), {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid input");
  });

  it("forces human authority for identity actions even with permission", async () => {
    const k = buildKernel({ proceed: false });
    const res = await k.executor.execute(
      "iam.grantRole",
      makeCtx(["iam.admin"]),
      { userId: "u2" },
    );
    expect(res.ok).toBe(false);
    expect(res.pendingApproval).toBeDefined();
    expect(res.pendingApproval?.riskClass).toBe("identity");
    expect(k.wasApprovalRequested()).toBe(true);
  });

  it("requires approval when agent money action exceeds threshold", async () => {
    const k = buildKernel({ proceed: false });
    const res = await k.executor.execute(
      "accounting.postJournalEntry",
      makeCtx(["accounting.post"]),
      { amountMinor: 900_000 },
    );
    expect(res.pendingApproval?.rationale).toContain("exceeds autonomous threshold");
  });

  it("lets small money actions through autonomously", async () => {
    const k = buildKernel();
    const res = await k.executor.execute(
      "accounting.postJournalEntry",
      makeCtx(["accounting.post"]),
      { amountMinor: 10_000 },
    );
    expect(res.ok).toBe(true);
  });

  it("chains ledger hashes tamper-evidently", async () => {
    const k = buildKernel();
    await k.executor.execute("crm.createCustomer", makeCtx(["crm.write"]), { name: "A" });
    await k.executor.execute("crm.createCustomer", makeCtx(["crm.write"]), { name: "B" });
    const [first, second] = k.ledger.entries;
    expect(second?.prevHash).toBe(first?.hash);
  });

  it("returns honest error for unknown capabilities", async () => {
    const k = buildKernel();
    const res = await k.executor.execute("time.travel", makeCtx(["*"]), {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown capability");
  });

  it("gates money actions with unknowable amounts even for small inputs (fail closed)", async () => {
    const k = buildKernel({ proceed: false });
    const res = await k.executor.execute(
      "accounting.reverseEntry",
      makeCtx(["accounting.post"]),
      { entryId: "e1" },
    );
    expect(res.ok).toBe(false);
    expect(res.pendingApproval).toBeDefined();
    expect(res.pendingApproval?.rationale).toContain("not knowable before execution");
  });

  it("refuses an approvedApprovalId that fails verification", async () => {
    const k = buildKernel({ proceed: false, verify: () => false });
    const res = await k.executor.execute(
      "accounting.reverseEntry",
      makeCtx(["accounting.post"]),
      { entryId: "e1" },
      { approvedApprovalId: "fake-approval" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("approval verification failed");
  });

  it("executes under a verified approval id without re-submitting the gate", async () => {
    const k = buildKernel({ proceed: false, verify: (id) => id === "real-approval" });
    const res = await k.executor.execute(
      "accounting.reverseEntry",
      makeCtx(["accounting.post"]),
      { entryId: "e1" },
      { approvedApprovalId: "real-approval" },
    );
    expect(res.ok).toBe(true);
    // The bypass path audits approval.granted + capability.executed.
    expect(k.ledger.entries.map((e) => e.kind)).toEqual(["approval.granted", "capability.executed"]);
  });

  it("fails closed when no verify() is implemented and an id is claimed", async () => {
    const k = buildKernel({ proceed: false });
    const res = await k.executor.execute(
      "accounting.reverseEntry",
      makeCtx(["accounting.post"]),
      { entryId: "e1" },
      { approvedApprovalId: "whatever" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("approval verification failed");
  });
});
