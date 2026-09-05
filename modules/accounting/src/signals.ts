import { and, eq, isNull, lt } from "drizzle-orm";
import { expenseClaims, expensePolicies, invoices, payments, quotes } from "@chaste/db";
import type { Database } from "@chaste/db";
import type { BusinessSignal, SignalProducer } from "@chaste/kernel";
import { evaluateExpensePolicy, findDuplicateExpenseClaims, findDuplicatePayments } from "@chaste/erp-core";

/**
 * Receivables signals (ADR 0034): invoices that are out with money owed and
 * slipping past their age bands. 30+ days is orange; 60+ is red.
 *
 * M9 adds expired quotes: validity lapsed, money not yet committed — red,
 * suggesting the governed decline so the pipeline stays truthful.
 *
 * M10 adds suspected duplicate payments: same invoice, same amount, close
 * together — orange, evidence attached, human decides (ADR 0037).
 *
 * M11 adds expense hygiene: duplicate claims (same person, same amount,
 * days apart) and pending claims over their category's policy limit.
 */

export function createAccountingSignalProducer(db: Database["db"]): SignalProducer {
  return async (orgId, now) => {
    const rows = await db
      .select({
        id: invoices.id,
        number: invoices.number,
        issuedAt: invoices.issuedAt,
        totalMinor: invoices.totalMinor,
        paidMinor: invoices.paidMinor,
      })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), eq(invoices.status, "sent"), isNull(invoices.voidedAt)))
      .limit(200);

    const signals: BusinessSignal[] = [];
    for (const inv of rows) {
      const balance = inv.totalMinor - inv.paidMinor;
      if (balance <= 0 || !inv.issuedAt) continue;
      const ageDays = Math.floor((now.getTime() - inv.issuedAt.getTime()) / 86_400_000);
      if (ageDays < 30) continue;
      signals.push({
        id: `accounting.overdue:${inv.id}`,
        severity: ageDays >= 60 ? "red" : "orange",
        module: "accounting",
        subject: `Invoice #${inv.number} is ${ageDays} days overdue`,
        detail: `${(balance / 100).toFixed(2)} minor-major units outstanding of ${(inv.totalMinor / 100).toFixed(2)} — issued ${ageDays} days ago.`,
        evidence: { refType: "invoice", refId: inv.id },
        suggestedAction: {
          capabilityId: "accounting.recordPayment",
          inputDraft: { invoiceId: inv.id },
        },
      });
    }
    const lapsed = await db
      .select({ id: quotes.id, number: quotes.number, expiresAt: quotes.expiresAt, totalMinor: quotes.totalMinor })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.status, "sent"), lt(quotes.expiresAt, now)))
      .limit(100);
    for (const q of lapsed) {
      signals.push({
        id: `accounting.quoteExpired:${q.id}`,
        severity: "red",
        module: "accounting",
        subject: `Quote #${q.number} expired without a decision`,
        detail: `Validity lapsed ${q.expiresAt?.toISOString().slice(0, 10)}. Decline it to keep the pipeline truthful, or issue a fresh quote if the customer is still warm.`,
        evidence: { refType: "quote", refId: q.id },
        suggestedAction: {
          capabilityId: "accounting.declineQuote",
          inputDraft: { quoteId: q.id },
        },
      });
    }
    const payRows = await db
      .select({ id: payments.id, invoiceId: payments.invoiceId, amountMinor: payments.amountMinor, receivedAt: payments.receivedAt })
      .from(payments)
      .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
      .where(eq(invoices.orgId, orgId))
      .limit(500);
    for (const d of findDuplicatePayments(payRows)) {
      signals.push({
        id: `accounting.duplicatePayment:${d.paymentIdA}:${d.paymentIdB}`,
        severity: "orange",
        module: "accounting",
        subject: `Suspected duplicate payment on invoice (${(d.amountMinor / 100).toFixed(2)}, ${d.daysApart} day${d.daysApart === 1 ? "" : "s"} apart)`,
        detail: `Payments ${d.paymentIdA.slice(0, 8)} and ${d.paymentIdB.slice(0, 8)} hit the same invoice for the same amount ${d.daysApart} day${d.daysApart === 1 ? "" : "s"} apart. Could be a double click or an installment that matches by coincidence — verify and refund or reconcile.`,
        evidence: { refType: "invoice", refId: d.invoiceId },
        suggestedAction: null,
      });
    }
    const pendingClaims = await db
      .select({ id: expenseClaims.id, claimantUserId: expenseClaims.claimantUserId, amountMinor: expenseClaims.amountMinor, category: expenseClaims.category, createdAt: expenseClaims.createdAt })
      .from(expenseClaims)
      .where(and(eq(expenseClaims.orgId, orgId), eq(expenseClaims.status, "submitted")))
      .limit(300);
    const claimRecords = pendingClaims.map((c) => ({
      id: c.id,
      claimantUserId: c.claimantUserId,
      amountMinor: c.amountMinor,
      submittedAt: c.createdAt,
    }));
    for (const d of findDuplicateExpenseClaims(claimRecords)) {
      signals.push({
        id: `accounting.duplicateClaim:${d.claimIdA}:${d.claimIdB}`,
        severity: "orange",
        module: "accounting",
        subject: `Suspected duplicate expense claim (${(d.amountMinor / 100).toFixed(2)}, ${d.daysApart} day${d.daysApart === 1 ? "" : "s"} apart)`,
        detail: `Claims ${d.claimIdA.slice(0, 8)} and ${d.claimIdB.slice(0, 8)} are by the same person for the same amount ${d.daysApart} day${d.daysApart === 1 ? "" : "s"} apart. Reject one with a reason.`,
        evidence: { refType: "expense_claim", refId: d.claimIdA },
        suggestedAction: null,
      });
    }
    const policies = await db
      .select({ category: expensePolicies.category, limitMinor: expensePolicies.limitMinor })
      .from(expensePolicies)
      .where(eq(expensePolicies.orgId, orgId));
    for (const claim of pendingClaims) {
      const verdict = evaluateExpensePolicy(claim.category, claim.amountMinor, policies);
      if (!verdict.overLimit) continue;
      signals.push({
        id: `accounting.policyOverrun:${claim.id}`,
        severity: "orange",
        module: "accounting",
        subject: `Expense claim over policy: ${(claim.amountMinor / 100).toFixed(2)} in ${claim.category} (limit ${(verdict.limitMinor! / 100).toFixed(2)})`,
        detail: `The category ceiling is ${(verdict.limitMinor! / 100).toFixed(2)}; this pending claim exceeds it. Approve deliberately or send back with a reason.`,
        evidence: { refType: "expense_claim", refId: claim.id },
        suggestedAction: null,
      });
    }
    return signals;
  };
}
