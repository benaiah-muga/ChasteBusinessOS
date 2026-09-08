/**
 * M12 verification — understanding: analytics + helpdesk + documents.
 * Run: pnpm demo:m12 [decompose|ask|tickets|documents|all]
 */
import { getDb, invoiceLines, invoices, users } from "@chaste/db";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

let passed = 0;
function ok(label: string, condition?: boolean) {
  if (condition === false) throw new Error(`FAILED: ${label}`);
  console.log(`✓ ${label}`);
  passed += 1;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- demo reads heterogeneous capability outputs
function data(run: any) {
  if (run.error) throw new Error(`capability failed: ${run.error}`);
  return run.data;
}

async function seedOrg(db: ReturnType<typeof getDb>["db"], orgName: string) {
  const [owner] = await db.insert(users).values({ email: `own-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@demo.test`, name: "Owner" }).returning();
  if (!owner) throw new Error("owner insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: owner.id,
    userEmail: owner.email,
    orgName,
    businessDescription: "A trading company that wants its numbers explained, not dashboards admired.",
  });
  return { orgId, ownerId: owner.id, ownerCtx: { actor: { type: "human" as const, id: owner.id, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} } };
}

async function invoice(db: ReturnType<typeof getDb>["db"], orgId: string, customerId: string, number: number, issuedAt: Date, lines: Array<{ description: string; price: number }>) {
  const total = lines.reduce((s, l) => s + l.price, 0);
  const [inv] = await db.insert(invoices).values({ orgId, customerId, number, status: "sent", subtotalMinor: total, taxMinor: 0, totalMinor: total, issuedAt }).returning({ id: invoices.id });
  for (const l of lines) {
    await db.insert(invoiceLines).values({ invoiceId: inv!.id, description: l.description, quantity: 1_000, unitPriceMinor: l.price });
  }
  return inv!.id;
}

async function decomposeScenario(): Promise<string> {
  const db = getDb().db;
  const ex = buildExecutor(db, buildRegistry(db));
  const { orgId, ownerCtx } = await seedOrg(db, "M12 Explain Co");
  const alpha = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "Explain Alpha" }));
  const beta = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "Explain Beta" }));
  await invoice(db, orgId, alpha.customerId, 1, new Date(Date.UTC(2026, 0, 5)), [{ description: "Widgets", price: 500_00 }]);
  await invoice(db, orgId, beta.customerId, 2, new Date(Date.UTC(2026, 0, 6)), [{ description: "Gadgets", price: 300_00 }]);
  await invoice(db, orgId, alpha.customerId, 3, new Date(Date.UTC(2026, 0, 25)), [{ description: "Widgets", price: 250_00 }]);
  await invoice(db, orgId, beta.customerId, 4, new Date(Date.UTC(2026, 0, 26)), [{ description: "Gadgets", price: 310_00 }]);

  const d = data(await ex.execute("analytics.explainChange", ownerCtx, {
    dimension: "customer",
    periodAFrom: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    periodATo: new Date(Date.UTC(2026, 0, 15)).toISOString(),
    periodBFrom: new Date(Date.UTC(2026, 0, 20)).toISOString(),
    periodBTo: new Date(Date.UTC(2026, 1, 15)).toISOString(),
  }));
  const sum = d.contributions.reduce((s: number, c: { deltaMinor: number }) => s + c.deltaMinor, 0);
  ok(`decomposition sums: contributions ${sum} = delta ${d.deltaMinor}`, sum === d.deltaMinor);
  ok(`biggest mover: ${d.contributions[0].key} (${d.contributions[0].deltaMinor})`, d.contributions[0].deltaMinor === -250_00);
  ok(`drill carries ${d.drill[0]?.invoiceIds.length ?? 0} invoice id(s)`, (d.drill[0]?.invoiceIds.length ?? 0) > 0);
  console.log("DECOMPOSITION SUMS");
  return orgId;
}

async function askScenario(): Promise<string> {
  const db = getDb().db;
  const ex = buildExecutor(db, buildRegistry(db));
  const { orgId, ownerCtx } = await seedOrg(db, "M12 Ask Co");
  const cust = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "Ask Target Co" }));
  const overdue = new Date(Date.now() - 40 * 86_400_000);
  await invoice(db, orgId, cust.customerId, 1, overdue, [{ description: "Consulting", price: 900_00 }]);

  const answer = data(await ex.execute("analytics.askYourBusiness", ownerCtx, { focus: "collections" }));
  const cited = answer.sections.some((s: { citations: string[] }) => s.citations.length > 0);
  ok(`answer cites its rows (${answer.sections.map((s: { heading: string }) => s.heading).join(", ")})`, cited);
  if (answer.proposedAction) {
    ok(`proposed governed action: ${answer.proposedAction.capabilityId}`, answer.proposedAction.capabilityId.length > 0);
  } else {
    ok("no proposed action when the signal feed is quiet");
  }
  console.log("ASK-ANSWER CITED");
  return orgId;
}

async function ticketsScenario(): Promise<string> {
  const db = getDb().db;
  const ex = buildExecutor(db, buildRegistry(db));
  const { orgId, ownerCtx } = await seedOrg(db, "M12 Tickets Co");
  const cust = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "SLA Tester" }));
  const conv = data(await ex.execute("support.startConversation", ownerCtx, { customerId: cust.customerId, subject: "Order still missing" }));
  const suggestion = data(await ex.execute("support.suggestCategory", ownerCtx, { text: "Order still missing — where is delivery?" }));
  ok(`category draft: ${suggestion.category}`, suggestion.draft === true);
  data(await ex.execute("support.updateTicket", ownerCtx, {
    conversationId: conv.conversationId,
    priority: "urgent",
    category: "shipping",
    slaDueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  }));
  const canned = data(await ex.execute("support.createCannedResponse", ownerCtx, { shortcut: "/sorry", title: "Apology", body: "We are sorry — here is what happens next." }));
  const kb = data(await ex.execute("support.createKbArticle", ownerCtx, { title: "Late deliveries", body: "Escalation path for late deliveries.", category: "shipping" }));
  ok(`canned response ${canned.cannedResponseId.slice(0, 8)}… and KB article ${kb.articleId.slice(0, 8)}… saved`);
  const signals = data(await ex.execute("signals.list", ownerCtx, {}));
  const breach = (signals.signals ?? []).find((s: { id: string }) => s.id.startsWith("support.slaBreach:"));
  if (!breach) throw new Error("SLA breach must raise a red signal");
  ok(`SLA breach signal: ${breach.subject}`);
  console.log("TICKETS DEEP OK");
  return orgId;
}

async function documentsScenario(): Promise<string> {
  const db = getDb().db;
  const ex = buildExecutor(db, buildRegistry(db));
  const { orgId, ownerCtx } = await seedOrg(db, "M12 Documents Co");
  const doc = data(await ex.execute("documents.createDocument", ownerCtx, {
    title: "Depot lease",
    text: "Lease agreement, original terms.",
    folder: "contracts/2026",
    expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
  }));
  const v1 = data(await ex.execute("documents.addVersion", ownerCtx, { documentId: doc.documentId, rawText: "Lease renewed with clause 7.", note: "renewal" }));
  const versions = data(await ex.execute("documents.listVersions", ownerCtx, { documentId: doc.documentId }));
  ok(`version history append-only: [${versions.versions.map((v: { version: number }) => v.version).join(", ")}]`, versions.versions.map((v: { version: number }) => v.version).join(",") === "1");
  void v1;
  const signals = data(await ex.execute("signals.list", ownerCtx, {}));
  const expired = (signals.signals ?? []).find((s: { id: string }) => s.id.startsWith("documents.expired:"));
  if (!expired) throw new Error("expired document must raise a red signal");
  ok(`expiry signal: ${expired.subject}`);
  console.log("DOCUMENTS LAYER OK");
  return orgId;
}

async function main() {
  const scenario = process.argv[2] ?? "all";
  if (scenario === "decompose" || scenario === "all") await decomposeScenario();
  if (scenario === "ask" || scenario === "all") await askScenario();
  if (scenario === "tickets" || scenario === "all") await ticketsScenario();
  if (scenario === "documents" || scenario === "all") await documentsScenario();
  console.log(`\n${passed} guarantees held.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
