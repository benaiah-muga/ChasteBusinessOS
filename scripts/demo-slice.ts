/**
 * M1 vertical slice, driven through the Go capability pipeline:
 * onboarding → createCustomer → createInvoice → recordPayment approval
 * → human decision → execution → trial balance proves the books balance.
 *
 * Run: pnpm demo:slice (Postgres and the Go API must be running).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentSessions,
  approvals,
  authSession,
  authUser,
  getDb,
  invoices,
  payments,
  users,
} from "@chaste/db";
import { formatMinor } from "@chaste/erp-core";
import {
  decideGoApproval,
  executeGoCapability,
  type GoApprovalDecisionAssertionInput,
  type GoCapabilityExecutionAssertionInput,
} from "../apps/web/src/server/go-bridge";
import { runOnboarding } from "../apps/web/src/server/onboarding";

type GoActionContext = GoCapabilityExecutionAssertionInput["actionContext"];
type GoSession = GoCapabilityExecutionAssertionInput["session"];
type PaymentInput = {
  invoiceNumber: number;
  amountMinor: number;
  method: "cash" | "bank_transfer" | "card";
};
type PaymentOutput = { paymentId: string; entryId: string; fullyPaid: boolean };
type PendingApproval = { reason: string; approvalId: string };
type InvoiceOutput = {
  invoiceId: string;
  invoiceNumber: number;
  totalMinor: number;
  entryId: string;
  currency: string;
};
type CustomerOutput = { customerId: string };
type TrialBalanceLine = {
  code: string;
  name: string;
  currency: string;
  debitMinor: number;
  creditMinor: number;
};
type TrialBalanceOutput = { lines: TrialBalanceLine[]; balanced: boolean };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isUUID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseCustomerOutput(value: unknown): CustomerOutput | null {
  const result = asRecord(value);
  return result && isUUID(result.customerId)
    ? { customerId: result.customerId }
    : null;
}

function parseInvoiceOutput(value: unknown): InvoiceOutput | null {
  const result = asRecord(value);
  if (
    !result ||
    !isUUID(result.invoiceId) ||
    !isUUID(result.entryId) ||
    !safeInteger(result.invoiceNumber) ||
    result.invoiceNumber < 1 ||
    !safeInteger(result.totalMinor) ||
    typeof result.currency !== "string"
  )
    return null;
  return {
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber,
    totalMinor: result.totalMinor,
    entryId: result.entryId,
    currency: result.currency,
  };
}

function parsePaymentInput(value: unknown): PaymentInput | null {
  const result = asRecord(value);
  if (
    !result ||
    !safeInteger(result.invoiceNumber) ||
    result.invoiceNumber < 1 ||
    !safeInteger(result.amountMinor) ||
    result.amountMinor < 1 ||
    (result.method !== "cash" &&
      result.method !== "bank_transfer" &&
      result.method !== "card")
  )
    return null;
  return {
    invoiceNumber: result.invoiceNumber,
    amountMinor: result.amountMinor,
    method: result.method,
  };
}

function parsePaymentOutput(value: unknown): PaymentOutput | null {
  const result = asRecord(value);
  return result &&
    isUUID(result.paymentId) &&
    isUUID(result.entryId) &&
    typeof result.fullyPaid === "boolean"
    ? {
        paymentId: result.paymentId,
        entryId: result.entryId,
        fullyPaid: result.fullyPaid,
      }
    : null;
}

function parsePendingApproval(value: unknown): PendingApproval | null {
  const result = asRecord(value);
  return result &&
    result.ok === false &&
    result.pendingApproval === true &&
    typeof result.reason === "string" &&
    isUUID(result.approvalId)
    ? { reason: result.reason, approvalId: result.approvalId }
    : null;
}

function parseTrialBalanceOutput(value: unknown): TrialBalanceOutput | null {
  const result = asRecord(value);
  if (
    !result ||
    typeof result.balanced !== "boolean" ||
    !Array.isArray(result.lines)
  )
    return null;
  const lines: TrialBalanceLine[] = [];
  for (const value of result.lines) {
    const line = asRecord(value);
    if (
      !line ||
      typeof line.code !== "string" ||
      typeof line.name !== "string" ||
      typeof line.currency !== "string" ||
      !safeInteger(line.debitMinor) ||
      !safeInteger(line.creditMinor)
    )
      return null;
    lines.push({
      code: line.code,
      name: line.name,
      currency: line.currency,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
    });
  }
  return { lines, balanced: result.balanced };
}

async function callGoCapability(
  actionContext: GoActionContext,
  session: GoSession,
  capabilityId: string,
  input: unknown,
): Promise<{ status: number; body: unknown }> {
  const dispatched = await executeGoCapability({
    actionContext,
    session,
    capabilityId,
    input,
  });
  if (dispatched.kind === "not-dispatched") {
    throw new Error(
      "Go capability was not dispatched; check GO_INTERNAL_AUTH_SECRET and GO_API_INTERNAL_URL.",
    );
  }
  if (dispatched.kind === "outcome-unknown") {
    throw new Error(
      "Go capability outcome is unknown; check the Go API and reconcile the database before retrying.",
    );
  }
  return {
    status: dispatched.response.status,
    body: await dispatched.response.json().catch((): unknown => null),
  };
}

async function executeGoCapabilityData<T>(
  actionContext: GoActionContext,
  session: GoSession,
  capabilityId: string,
  input: unknown,
  parseData: (value: unknown) => T | null,
): Promise<T> {
  const result = await callGoCapability(
    actionContext,
    session,
    capabilityId,
    input,
  );
  if (result.status !== 200) {
    const error = asRecord(result.body)?.error;
    throw new Error(
      typeof error === "string"
        ? error
        : `${capabilityId} failed with HTTP ${result.status}`,
    );
  }
  const envelope = asRecord(result.body);
  if (!envelope || envelope.ok !== true || !("data" in envelope))
    throw new Error(`${capabilityId} returned an invalid Go response`);
  const data = parseData(envelope.data);
  if (data === null)
    throw new Error(
      `${capabilityId} returned data outside its expected contract`,
    );
  return data;
}

async function main() {
  if (
    !process.env.GO_INTERNAL_AUTH_SECRET ||
    Buffer.byteLength(process.env.GO_INTERNAL_AUTH_SECRET, "utf8") < 32
  ) {
    throw new Error(
      "Set GO_INTERNAL_AUTH_SECRET to at least 32 bytes before running pnpm demo:slice.",
    );
  }

  const db = getDb().db;
  const runId = randomUUID();
  const email = `slice-${runId}@demo.test`;

  // A fresh domain user and organization are still provisioned by the existing setup flow.
  const [domainUser] = await db
    .insert(users)
    .values({ email, name: "Demo Founder" })
    .returning();
  if (!domainUser) throw new Error("user insert failed");

  const { orgId } = await runOnboarding(db, {
    userId: domainUser.id,
    userEmail: email,
    orgName: `Glow Works Demo ${runId.slice(0, 8)}`,
    businessDescription:
      "We design and sell handmade lighting fixtures online and to interior designers. Most orders are 10-50 units. Returning wholesale buyers get a 2% discount.",
  });
  console.info("✓ org onboarded:", orgId);

  // Go verifies Better Auth session state and a persisted, open agent session for every assertion.
  const authUserId = `slice-auth-user-${runId}`;
  const authSessionId = `slice-auth-session-${runId}`;
  await db.insert(authUser).values({
    id: authUserId,
    name: "Demo Founder",
    email,
    emailVerified: true,
  });
  await db.insert(authSession).values({
    id: authSessionId,
    token: `slice-auth-token-${runId}`,
    userId: authUserId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const [agentSession] = await db
    .insert(agentSessions)
    .values({
      orgId,
      userId: domainUser.id,
      title: "Go migration demo",
      mode: "assist",
      status: "open",
    })
    .returning({ id: agentSessions.id });
  if (!agentSession) throw new Error("agent session insert failed");

  const session: GoSession = { userId: domainUser.id, orgId, authSessionId };
  const humanContext: GoActionContext = {
    actor: {
      type: "human",
      id: domainUser.id,
      orgId,
      permissions: new Set(["*"]),
    },
    now: new Date(),
    services: {},
  };
  const agentContext = (intentId: string): GoActionContext => ({
    actor: { ...humanContext.actor, type: "agent" },
    sessionId: agentSession.id,
    intentId: `demo-slice:${runId}:${intentId}`,
    now: new Date(),
    services: {},
  });

  // 1. Agent creates a customer through Go.
  const customer = await executeGoCapabilityData(
    agentContext("customer"),
    session,
    "crm.createCustomer",
    { name: "Acme Interiors", email: "ap@acme.test" },
    parseCustomerOutput,
  );
  console.info("✓ agent created customer:", customer.customerId);

  // 2. Agent issues an invoice: 20 lamps @ $120 + $60 tax.
  const invoice = await executeGoCapabilityData(
    agentContext("invoice"),
    session,
    "accounting.createInvoice",
    {
      customerId: customer.customerId,
      memo: "Order #1042, pendant lamps",
      lines: [
        {
          description: "Pendant lamp",
          quantity: 20000,
          unitPriceMinor: 12_000,
          taxMinor: 6_000,
        },
      ],
    },
    parseInvoiceOutput,
  );
  console.info(
    `✓ invoice #${invoice.invoiceNumber} posted: ${formatMinor(invoice.totalMinor)} → entry ${invoice.entryId.slice(0, 8)}`,
  );
  if (invoice.totalMinor !== 246_000)
    throw new Error(`invoice total was ${invoice.totalMinor}, expected 246000`);

  // 3. The Go policy gate holds the large agent payment before it changes the books.
  const paymentInput = {
    invoiceNumber: invoice.invoiceNumber,
    amountMinor: 246_000,
    method: "bank_transfer" as const,
  };
  const pendingResult = await callGoCapability(
    agentContext("payment"),
    session,
    "accounting.recordPayment",
    paymentInput,
  );
  if (pendingResult.status !== 202) {
    const error = asRecord(pendingResult.body)?.error;
    throw new Error(
      typeof error === "string"
        ? error
        : "large payment was not held for approval",
    );
  }
  const pending = parsePendingApproval(pendingResult.body);
  if (!pending)
    throw new Error("Go returned an invalid pending-approval response");
  console.info("✓ policy gate held:", pending.reason);
  console.info("  → waiting in Approvals inbox");

  const [approval] = await db
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.id, pending.approvalId), eq(approvals.orgId, orgId)),
    )
    .limit(1);
  if (
    !approval ||
    approval.status !== "pending" ||
    approval.capabilityId !== "accounting.recordPayment" ||
    approval.riskClass !== "money"
  ) {
    throw new Error(
      "Go payment approval row is missing or does not match the money approval contract",
    );
  }
  const storedPaymentInput = parsePaymentInput(approval.payload);
  if (
    !storedPaymentInput ||
    storedPaymentInput.invoiceNumber !== invoice.invoiceNumber ||
    storedPaymentInput.amountMinor !== paymentInput.amountMinor
  ) {
    throw new Error("Go approval payload does not match the requested payment");
  }

  // 4. The owner decides through the signed Go approval bridge as a human.
  const decisionInput: GoApprovalDecisionAssertionInput = {
    actionContext: humanContext,
    session,
    approvalId: approval.id,
    capabilityId: approval.capabilityId,
    input: storedPaymentInput,
    decision: "approve",
    comment: "M1 demo owner approval",
  };
  const decision = await decideGoApproval(decisionInput);
  if (decision.kind === "not-dispatched") {
    throw new Error(
      "Go approval decision was not dispatched; check GO_INTERNAL_AUTH_SECRET and GO_API_INTERNAL_URL.",
    );
  }
  if (decision.kind === "outcome-unknown") {
    throw new Error(
      "Go approval outcome is unknown; check the Go API and reconcile the database before retrying.",
    );
  }
  const decisionBody: unknown = await decision.response
    .json()
    .catch((): unknown => null);
  const decisionRecord = asRecord(decisionBody);
  if (decision.response.status !== 200) {
    const error = decisionRecord?.error;
    throw new Error(
      typeof error === "string"
        ? error
        : `Go approval decision failed with HTTP ${decision.response.status}`,
    );
  }
  const decisionResult = asRecord(decisionRecord?.result);
  const approvedPayment =
    decisionRecord?.ok === true &&
    decisionRecord.status === "executed" &&
    decisionResult?.ok === true
      ? parsePaymentOutput(decisionResult.data)
      : null;
  if (!approvedPayment)
    throw new Error(
      "Go approval decision returned an invalid execution result",
    );
  console.info(
    "✓ human approved → payment posted, fullyPaid:",
    approvedPayment.fullyPaid,
  );
  if (!approvedPayment.fullyPaid)
    throw new Error("approved payment did not fully pay the invoice");

  const [paidInvoice] = await db
    .select({ status: invoices.status, paidMinor: invoices.paidMinor })
    .from(invoices)
    .where(and(eq(invoices.id, invoice.invoiceId), eq(invoices.orgId, orgId)))
    .limit(1);
  if (
    paidInvoice?.status !== "paid" ||
    paidInvoice.paidMinor !== paymentInput.amountMinor
  ) {
    throw new Error(
      `approved payment left invoice status=${paidInvoice?.status ?? "missing"} paidMinor=${paidInvoice?.paidMinor ?? "missing"}`,
    );
  }

  const postedPayments = await db
    .select({ id: payments.id, amountMinor: payments.amountMinor })
    .from(payments)
    .where(
      and(eq(payments.orgId, orgId), eq(payments.invoiceId, invoice.invoiceId)),
    )
    .limit(2);
  if (
    postedPayments.length !== 1 ||
    postedPayments[0]?.id !== approvedPayment.paymentId ||
    postedPayments[0]?.amountMinor !== paymentInput.amountMinor
  ) {
    throw new Error(
      "approved payment did not persist as exactly one matching payment row",
    );
  }

  const [completedApproval] = await db
    .select({
      status: approvals.status,
      decidedByUserId: approvals.decidedByUserId,
    })
    .from(approvals)
    .where(and(eq(approvals.id, approval.id), eq(approvals.orgId, orgId)))
    .limit(1);
  if (
    completedApproval?.status !== "executed" ||
    completedApproval.decidedByUserId !== domainUser.id
  ) {
    throw new Error(
      "Go approval history does not show the signed human decision",
    );
  }

  // 5. The Go trial balance proves the books balance.
  const trialBalance = await executeGoCapabilityData(
    agentContext("trial-balance"),
    session,
    "accounting.trialBalance",
    {},
    parseTrialBalanceOutput,
  );
  console.info("✓ trial balance:");
  for (const line of trialBalance.lines) {
    if (line.debitMinor || line.creditMinor) {
      console.info(
        `    ${line.code} ${line.name.padEnd(25)} DR ${formatMinor(line.debitMinor)}  CR ${formatMinor(line.creditMinor)}`,
      );
    }
  }
  console.info("  balanced:", trialBalance.balanced);
  if (!trialBalance.balanced)
    throw new Error("Go trial balance is not balanced");
  console.info("GO DEMO SLICE PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
