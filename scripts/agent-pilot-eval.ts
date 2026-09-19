/**
 * W0.5 pilot: drive natural-language multi-step operations through the real
 * agent loop over the full capability registry and the real database - the
 * same runAgentLoop, registry composition and executor the app's chat route
 * uses, so what this script surfaces is what a pilot user would hit.
 *
 * Scenarios:
 *   A. the full procurement chain in one breath: create vendor, order,
 *      receive with a rejection, then answer what is outstanding.
 *   B. an overreceipt refused without authority, then accepted with the
 *      paired tolerance + authority fields.
 *
 * NL operations run on openrouter/stealth/union-alpha (OPENROUTER_API_KEY).
 * Run: pnpm exec tsx --tsconfig apps/web/tsconfig.json scripts/agent-pilot-eval.ts
 */
import { and, eq } from "drizzle-orm";
import {
  createDb,
  goodsReceiptLines,
  items,
  organizations,
  purchaseOrders,
  purgeTenantFinancials,
  vendors,
} from "@chaste/db";
import { OpenAiCompatAdapter, resolveClient, stripProviderPrefix } from "@chaste/ai";
import { CapabilityRegistry, runAgentLoop } from "@chaste/kernel";
import { buildExecutor, buildRegistry } from "@/server/kernel";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const db = createDb(url);
const orgId = crypto.randomUUID();
const fullRegistry = buildRegistry(db.db).scopedToModules(new Set(["purchasing", "inventory", "signals"]));
// The recommended pilot chain needs six capabilities; a focused tool list
// keeps the request inside a small OpenRouter budget while using the real,
// registered capabilities and executor.
const PILOT_TOOLS = [
  "purchasing.createVendor",
  "purchasing.createPurchaseOrder",
  "purchasing.receiveGoods",
  "purchasing.listReceipts",
  "purchasing.returnGoods",
  "purchasing.listPurchaseWorkflow",
];
const focused = new CapabilityRegistry();
for (const id of PILOT_TOOLS) {
  const cap = fullRegistry.get(id);
  if (!cap) throw new Error(`pilot capability missing: ${id}`);
  focused.register(cap);
}
const executor = buildExecutor(db.db, focused);

// Mirrors the app: the acting principal carries a real uuid (the ledger's
// actor_id is a uuid column), and the tool list is scoped to the pilot's
// modules exactly as the chat route scopes it for an org.
const actor = {
  actor: {
    type: "agent" as const,
    id: crypto.randomUUID(),
    orgId,
    permissions: new Set([
      "purchasing.read",
      "purchasing.write",
      "purchasing.post",
      "inventory.read",
      "inventory.write",
      "signals.read",
    ]),
  },
  now: new Date(),
  services: {},
};

const NL_MODEL = process.env.EVAL_MODEL ?? process.env.MODEL_NL ?? "openrouter/stealth/union-alpha";
const useOpenRouter = NL_MODEL.startsWith("openrouter/");
// The account is free-tier: the stealth slug was retired (successor
// unbiased/pareto serves only small requests), so the turn falls through to
// a free tool-capable model. The adapter walks the chain on 404/402/429.
const NL_FALLBACK_MODEL = process.env.MODEL_NL_FALLBACK ?? "openrouter/deepseek/deepseek-v4-flash-0731:free";

function makeModel(): OpenAiCompatAdapter {
  return new OpenAiCompatAdapter({
    client: resolveClient(NL_MODEL),
    model: stripProviderPrefix(NL_MODEL),
    temperature: 0,
    fallback: useOpenRouter
      ? { client: resolveClient(NL_FALLBACK_MODEL), model: stripProviderPrefix(NL_FALLBACK_MODEL) }
      : undefined,
  });
}

const model = makeModel();

const SYSTEM = `You operate a purchasing ERP through the listed capabilities. Rules:
- Prefer tools over prose; confirm results with numbers and ids.
- Amounts are minor units. Quantities are thousandths of a unit.
- If a tool errors, adjust the call per the error and try once; never repeat an identical failing call.
- Never invent capabilities or numbers.

Playbook for the receiving workflow (follow in order, adapting where needed):
1. purchasing.createVendor {name}
2. purchasing.createPurchaseOrder {vendorId, lines:[{description, quantity(thousandths), unitPriceMinor, sku?}]}
3. purchasing.receiveGoods {poNumber, lines:[{lineNumber, quantity(accepted, thousandths), rejected(thousandths), rejectionNote?}]}; a pure rejection line may set quantity 0
4. purchasing.listReceipts {poNumber} shows accepted/rejected/returned/remaining per line and the order state.`;

async function runScenario(name: string, goal: string, maxSteps = Number(process.env.EVAL_MAX_STEPS ?? 12)) {
  const tools: string[] = [];
  console.log(`\n▶ scenario ${name}`);
  const result = await runAgentLoop(
    model,
    registry,
    executor,
    actor,
    {
      sessionId: `eval-${name}`,
      systemPrompt: SYSTEM,
      userGoal: goal,
      maxSteps,
      onEvent: (event) => {
        if (event.role === "tool_call") {
          const c = event.content as { name: string; args?: unknown };
          tools.push(c.name);
          console.log(`  → ${c.name} ${JSON.stringify(c.args ?? {}).slice(0, 300)}`);
        }
        if (event.role === "tool_result") {
          const c = event.content as { name: string; ok: boolean; error?: string };
          if (!c.ok) console.log(`  ✗ ${c.name}: ${(c.error ?? "").slice(0, 240)}`);
        }
      },
    },
    {
      file: async (_org, title) => {
        console.log(`  → TICKET: ${title}`);
        return { id: null, error: "the eval does not file tickets" };
      },
    },
  );
  console.log(`  steps: ${result.steps}`);
  console.log(`  final: ${result.finalMessage}`);
  return { tools, result };
}

async function cleanup() {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Agent Pilot Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id).catch(() => {});
    await db.db.delete(organizations).where(eq(organizations.id, o.id)).catch(() => {});
  }
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required for the agent eval");
  await cleanup();
  await db.db.insert(organizations).values({ id: orgId, name: "Agent Pilot Probe", slug: `ap-${orgId.slice(0, 8)}` });
  await db.db.insert(items).values({ orgId, sku: "PAPER-A4", name: "Copy paper ream", salePriceMinor: 500 });

  const _a = await runScenario(
    "chain",
    "Create a vendor named 'Union Paper Co'. Then create a purchase order with that vendor for one line: 10 reams of copy paper, 450 cents per ream, sku PAPER-A4. " +
      "Then receive the delivery against that order: 8 reams accepted, 2 reams rejected because the packaging was wet. " +
      "Then tell me what is still outstanding on that order and what state the order is in.",
  );

  const b = await runScenario(
    "authority",
    "One more delivery arrived late: 3 additional reams for that same order. Receive them. " +
      "If that is refused: we have permission now, the site manager approved the overdelivery in writing, so receive the 3 reams using a 10 percent overreceipt tolerance with that authority.",
  );

  console.log("\n── database truth ──");
  const [vendor] = await db.db.select({ name: vendors.name }).from(vendors).where(and(eq(vendors.orgId, orgId), eq(vendors.name, "Union Paper Co")));
  const [po] = await db.db.select({ number: purchaseOrders.number, status: purchaseOrders.status }).from(purchaseOrders).where(eq(purchaseOrders.orgId, orgId));
  const receipts = await db.db
    .select({ accepted: goodsReceiptLines.acceptedThousandths, rejected: goodsReceiptLines.rejectedThousandths, note: goodsReceiptLines.rejectionNote })
    .from(goodsReceiptLines)
    .where(eq(goodsReceiptLines.orgId, orgId));
  console.log(JSON.stringify({ vendor: vendor?.name ?? null, po: po ?? null, receipts }, null, 2));

  const refusedWithoutAuthority = b.tools.length > 0 && /refus|authoriz|tolerance|permission/i.test(b.result.finalMessage);
  const ok =
    vendor?.name === "Union Paper Co" &&
    receipts.some((r) => r.accepted === 8_000 && r.rejected === 2_000 && r.note) &&
    receipts.some((r) => r.accepted === 3_000) &&
    po?.status === "received" &&
    refusedWithoutAuthority;
  console.log(`\nAGENT-PILOT-${ok ? "OK" : "BROKEN"}`);

  await cleanup();
  if (!ok) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
