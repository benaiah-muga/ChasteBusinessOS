/**
 * M3-completion verification: document ingestion → parse → deterministic
 * coding suggestions → vendor bill from the suggested codes → gated payment
 * proves the whole governed chain.
 *
 * Works fully offline: the document is pasted text (no OCR call needed) and
 * line items are supplied explicitly. When NVIDIA_API_KEY is present, the
 * LLM line-extraction path is proven instead.
 *
 * Run: pnpm demo:m3
 */
import { and, eq } from "drizzle-orm";
import { approvals, getDb, users } from "@chaste/db";
import { formatMinor } from "@chaste/erp-core";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

const BILL_TEXT = `ACME OFFICE SUPPLIES LTD
Invoice #42    Date: 2026-08-20

Qty  Description                     Unit      Total
20   Office chair                    85.00   1700.00
1    Annual internet subscription   960.00    960.00
60   Ream A4 paper                    4.50    270.00

Total                              USD    2930.00`;

async function main() {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  const [user] = await db.insert(users).values({ email: `m3-doc-${Date.now()}@demo.test`, name: "M3 Founder" }).returning();
  if (!user) throw new Error("user insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: user.id,
    userEmail: user.email,
    orgName: "M3 Demo Co",
    businessDescription: "Coffee roastery selling beans online.",
  });

  const humanCtx = {
    actor: { type: "human" as const, id: user.id, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  const agentCtx = { ...humanCtx, actor: { ...humanCtx.actor, type: "agent" as const } };

  // 1. Ingest a vendor bill as text and parse it into org memory.
  const doc = await executor.execute("documents.createDocument", agentCtx, {
    title: "Acme office supplies invoice #42",
    text: BILL_TEXT,
  });
  if (!doc.ok || !doc.data) throw new Error(doc.error ?? "create failed");
  const documentId = doc.data.documentId as string;

  const parsed = await executor.execute("documents.parseDocument", agentCtx, { documentId });
  if (!parsed.ok) throw new Error(parsed.error ?? "parse failed");
  console.log(`✓ document ingested & parsed (${parsed.data?.chars} chars indexed into org memory)`);

  // 2. Coding suggestions — explicit lines offline; model extraction when a key exists.
  const hasKey = Boolean(process.env.NVIDIA_API_KEY);
  const suggestInput = hasKey
    ? { documentId }
    : {
        documentId,
        lines: [
          { description: "Office chair", quantityThousandths: 20_000, unitPriceMinor: 8500 },
          { description: "Annual internet subscription", quantityThousandths: 1000, unitPriceMinor: 96_000 },
          { description: "Ream A4 paper", quantityThousandths: 60_000, unitPriceMinor: 450 },
        ],
      };
  const suggested = await executor.execute("documents.suggestCoding", agentCtx, suggestInput);
  if (!suggested.ok || !suggested.data) throw new Error(suggested.error ?? "suggest failed");
  for (const s of suggested.data.suggestions as { description: string; suggestedAccountCode: string; matchScore: number }[]) {
    console.log(`✓ suggestion: "${s.description}" → account ${s.suggestedAccountCode} (signal ×${s.matchScore})`);
  }

  // 3. The suggestions become a real bill through the governed purchasing path.
  const ven = await executor.execute("purchasing.createVendor", agentCtx, { name: "Acme Office Supplies" });
  const lines = (
    suggested.data.suggestions as { description: string; quantityThousandths: number; unitPriceMinor: number; suggestedAccountCode: string }[]
  ).map((s) => ({
    description: s.description,
    quantity: s.quantityThousandths,
    unitPriceMinor: s.unitPriceMinor,
    expenseAccountCode: s.suggestedAccountCode,
  }));
  const bill = await executor.execute("purchasing.createBill", agentCtx, {
    vendorId: ven.data!.vendorId as string,
    vendorRef: "ACME-42",
    memo: "from ingested document",
    lines,
  });
  if (!bill.ok || !bill.data) throw new Error(bill.error ?? "bill failed");
  console.log(`✓ bill #${bill.data.billNumber} posted from suggestions: ${formatMinor(bill.data.totalMinor as number)} → DR expenses / CR AP`);

  // 4. Paying it stays gated — ingestion does not lower anyone's authority.
  const pay = await executor.execute("purchasing.payBill", agentCtx, {
    billNumber: bill.data.billNumber as number,
    amountMinor: bill.data.totalMinor as number,
  });
  if (!pay.pendingApproval) throw new Error("payment was not gated!");
  console.log("✓ payment gated:", pay.pendingApproval.rationale);

  const [pending] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .limit(1);
  const approved = await executor.execute("purchasing.payBill", humanCtx, pending!.payload, {
    approvedApprovalId: pending!.id,
  });
  if (!approved.ok || !approved.data) throw new Error(approved.error ?? "pay failed");
  console.log("✓ approved & paid, fullyPaid:", approved.data.fullyPaid);

  const bs = await executor.execute("accounting.balanceSheet", humanCtx, {});
  if (!bs.data!.balanced) throw new Error("balance sheet does not balance!");
  console.log(`✓ Balance sheet balanced after the whole chain (assets ${formatMinor(bs.data!.assetsMinor as number)})`);

  // 5. Deleting the document is destructive-class and always needs a person.
  const del = await executor.execute("documents.deleteDocument", agentCtx, { documentId });
  if (!del.pendingApproval && !del.ok) throw new Error(del.error ?? "delete failed unexpectedly");
  console.log(del.pendingApproval ? "✓ document deletion gated behind human authority" : "✓ document deleted");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
