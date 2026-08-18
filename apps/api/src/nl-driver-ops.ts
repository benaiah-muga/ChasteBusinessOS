/**
 * Dynamic natural-language driver — bakery company operations. A second set of
 * ~15 NL requests covering procurement, inventory, sales, invoicing,
 * accounting, finance, and reporting, driven over the live HTTP API exactly
 * like a real user (`POST /api/v1/ai/chat` + approving parked `confirm_action`s).
 *
 * Distinct from `nl-driver.ts` (scheduling / data-quality / analytics reads):
 * these exercise operational WRITES that resolve org entities by name
 * (vendor/product/warehouse/customer/account → id) through the read-query bus,
 * plus operational READS from the query bus. Where a write has a verifiable
 * effect, the driver re-queries the bus (`POST /api/v1/queries/:name`) and
 * asserts the actual data changed — not just that a card appeared.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3001 AUTH_TOKEN=<bearer> \
 *     tsx --env-file=../../.env src/nl-driver-ops.ts
 *
 * Output: per-request pass/fail + a JSON summary on stdout. Exit code is the
 * number of failing requests (0 = all green).
 */

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3001";
const AUTH = process.env.AUTH_TOKEN ?? "";

interface UiPart {
  type: string;
  text?: string;
  title?: string;
  id?: string;
  command?: string;
  input?: Record<string, unknown>;
  summary?: string;
  plannedCommand?: string;
  [key: string]: unknown;
}

interface ChatMessage {
  role: string;
  parts: UiPart[];
}

interface ChatResponse {
  sessionId: string;
  messages: ChatMessage[];
  pendingConfirmationId?: string;
}

interface DriveResult {
  message: string;
  parts: UiPart[];
  confirmed: {
    ok: boolean;
    parts: UiPart[];
  };
}

async function chat(body: Record<string, unknown>): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/api/v1/ai/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`chat HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as ChatResponse;
}

/** Read through the same query bus a human uses. */
async function query(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/api/v1/queries/${name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`query ${name} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
  return json.data ?? {};
}

/** Post a message, then confirm any parked write action (fresh session per test). */
async function drive(message: string): Promise<DriveResult> {
  const sessionId = crypto.randomUUID();
  const r1 = await chat({ sessionId, message });
  const parts = (r1.messages ?? []).flatMap((m) => m.parts ?? []);

  let confirmed: DriveResult["confirmed"] = { ok: false, parts: [] };
  if (r1.pendingConfirmationId) {
    const r2 = await chat({ sessionId, confirmId: r1.pendingConfirmationId });
    confirmed = {
      ok: true,
      parts: (r2.messages ?? []).flatMap((m) => m.parts ?? []),
    };
  }

  return { message, parts, confirmed };
}

interface NlOpsTestCase {
  id: string;
  message: string;
  /** Expected command(s) carried by a parked confirm_action (writes). */
  expectCommand?: string | string[];
  /** Expected read-query name(s) answered (explanation.plannedCommand). */
  expectRead?: string | string[];
  /** Optional post-verify through the query bus — returns failure reasons. */
  verify?: () => Promise<string[]>;
}

function evaluate(t: NlOpsTestCase, res: DriveResult): { ok: boolean; reason: string[] } {
  const reasons: string[] = [];
  const allParts = [...res.parts, ...res.confirmed.parts];

  const confirmAction = allParts.find((p) => p.type === "confirm_action");
  const explanations = allParts.filter((p) => p.type === "explanation");
  const plannedCommands = explanations.map((p) => String(p.plannedCommand ?? "")).filter(Boolean);

  const readFailed = allParts.some(
    (p) => p.type === "error" || (p.text ?? "").includes("couldn't read that"),
  );
  if (readFailed) reasons.push("a read query failed (error part / 'couldn't read that')");

  const wantCommands = t.expectCommand
    ? Array.isArray(t.expectCommand)
      ? t.expectCommand
      : [t.expectCommand]
    : [];
  for (const c of wantCommands) {
    if (confirmAction?.command !== c) {
      reasons.push(`expected confirm_action.command=${c} got ${confirmAction?.command ?? "none"}`);
    }
  }

  const wantReads = t.expectRead ? (Array.isArray(t.expectRead) ? t.expectRead : [t.expectRead]) : [];
  for (const q of wantReads) {
    if (!plannedCommands.includes(q)) {
      reasons.push(`expected read query ${q} answered, planned=[${plannedCommands.join(", ")}]`);
    }
  }

  if (wantCommands.length > 0 && !res.confirmed.ok) {
    reasons.push("write action was not confirmed");
  }
  if (wantReads.length > 0 && wantCommands.length === 0 && confirmAction) {
    reasons.push("read intent unexpectedly parked a confirm_action");
  }

  return { ok: reasons.length === 0, reason: reasons };
}

interface InvStockShape {
  warehouses: { id: string; code: string; name: string }[];
  products: { id: string; sku: string; name: string }[];
  levels: { warehouseId: string; productId: string; quantity: number }[];
}

/** Look up on-hand quantity of a product at a warehouse from the query bus. */
async function stockAt(productName: string, warehouseName: string): Promise<number | null> {
  const data = (await query("inv.stock.list")) as unknown as InvStockShape;
  const wh = data.warehouses.find((w) => w.name.toLowerCase().includes(warehouseName.toLowerCase()));
  const prod = data.products.find((p) => p.name.toLowerCase().includes(productName.toLowerCase()));
  if (!wh || !prod) return null;
  const lvl = data.levels.find((l) => l.warehouseId === wh.id && l.productId === prod.id);
  return lvl?.quantity ?? 0;
}

const TESTS: NlOpsTestCase[] = [
  // ── Procurement ───────────────────────────────────────────────────────────
  {
    id: "p1",
    message: "Create a new vendor Kampala Sugar Wholesalers",
    expectCommand: "pur.vendor.create",
  },
  {
    id: "p2",
    message: "Raise a purchase order for 60 bags of Wheat Flour from Kampala Flour Mills",
    expectCommand: "pur.po.create",
    verify: async () => {
      const reasons: string[] = [];
      const data = (await query("pur.po.list")) as {
        vendors: { id: string; name: string }[];
        orders: { number: string; vendorId: string; status: string; total: string }[];
      };
      if (data.orders.length < 7) reasons.push(`expected ≥7 POs after create, got ${data.orders.length}`);
      const v = data.vendors.find((x) => x.name === "Kampala Flour Mills");
      if (!v) reasons.push("vendor Kampala Flour Mills not found in pur.po.list");
      const last = data.orders[data.orders.length - 1];
      if (!last || last.vendorId !== v?.id) reasons.push("new PO not linked to Kampala Flour Mills");
      if (last && !/^PO-\d{4}-\d{4}$/.test(last.number)) reasons.push(`PO number not generated: ${last.number}`);
      return reasons;
    },
  },
  {
    id: "p3",
    message: "Show our purchase orders",
    expectRead: "pur.po.list",
  },

  // ── Inventory ─────────────────────────────────────────────────────────────
  {
    id: "i1",
    message: "Receive 50 bags of Sugar at the Mbarara warehouse",
    expectCommand: "inv.stock.adjust",
    verify: async () => {
      const reasons: string[] = [];
      const qty = await stockAt("Sugar 50kg", "Mbarara");
      if (qty !== 57) reasons.push(`expected Sugar@Mbarara = 57 after +50 receive, got ${qty}`);
      return reasons;
    },
  },
  {
    id: "i2",
    message: "Adjust stock of Fresh Yeast at Mukono down by 2 because of spoilage",
    expectCommand: "inv.stock.adjust",
    verify: async () => {
      const reasons: string[] = [];
      const qty = await stockAt("Fresh Yeast", "Mukono");
      if (qty !== 1) reasons.push(`expected Fresh Yeast@Mukono = 1 after −2, got ${qty}`);
      return reasons;
    },
  },
  {
    id: "i3",
    message: "Show current stock levels at Jinja",
    expectRead: "inv.stock.list",
  },

  // ── Sales & invoicing ─────────────────────────────────────────────────────
  {
    id: "s1",
    message: "Create a customer Kampala Coffee House in Kampala",
    expectCommand: "crm.customer.create",
  },
  {
    id: "s2",
    message: "Issue an invoice INV-1101 for 1,250,000 UGX to Ntinda Supermarket",
    expectCommand: "acc.invoice.create",
    verify: async () => {
      const reasons: string[] = [];
      const data = (await query("acc.invoice.list")) as { items: { number: string; customerId: string | null; total: string; currency: string }[] };
      const inv = data.items.find((i) => i.number === "INV-1101");
      if (!inv) reasons.push("INV-1101 not found in acc.invoice.list");
      if (inv && !inv.customerId) reasons.push("INV-1101 customerId not resolved to Ntinda Supermarket");
      if (inv && inv.currency !== "UGX") reasons.push(`INV-1101 currency expected UGX got ${inv.currency}`);
      return reasons;
    },
  },
  {
    id: "s3",
    message: "List all our customers",
    expectRead: "crm.customer.list",
  },

  // ── Accounting & finance ──────────────────────────────────────────────────
  {
    id: "a1",
    message: "Post a journal entry JE-100 for rent: debit Expenses 800,000 and credit Cash 800,000",
    expectCommand: "acc.journal.post",
    verify: async () => {
      const reasons: string[] = [];
      const data = (await query("core.analytics.marginTrend")) as { monthly: { month: string; expenses: number }[] };
      const last = data.monthly[data.monthly.length - 1];
      if (!last) reasons.push("marginTrend returned no monthly rows");
      if (last && last.expenses !== 1_400_000) {
        reasons.push(`expected this month expenses = 1,400,000 after JE-100 (600k seed + 800k), got ${last.expenses}`);
      }
      return reasons;
    },
  },
  {
    id: "a2",
    message: "Which customers have overdue invoices?",
    expectRead: "acc.invoice.list",
  },
  {
    id: "a3",
    message: "How much did we spend on expenses this month?",
    expectRead: "core.analytics.marginTrend",
  },

  // ── Reporting ─────────────────────────────────────────────────────────────
  {
    id: "r1",
    message: "Show sales for the Jinja branch",
    expectRead: "core.analytics.salesByLocation",
  },
  {
    id: "r2",
    message: "Compare margins this month to last month",
    expectRead: "core.analytics.marginTrend",
  },
  {
    id: "r3",
    message: "Create a dashboard for our stock levels at Ntinda",
    expectCommand: "core.dashboard.create",
    verify: async () => {
      const reasons: string[] = [];
      const data = (await query("core.dashboard.list")) as { dashboards: { name: string }[] };
      if (!data.dashboards.some((d) => d.name === "Stock levels at Ntinda")) {
        reasons.push("dashboard 'Stock levels at Ntinda' not found in core.dashboard.list");
      }
      return reasons;
    },
  },
];

async function main(): Promise<void> {
  const results: Record<string, unknown> = {};
  let failures = 0;
  console.log(`NL ops driver — ${BASE} (token ${AUTH ? "set" : "MISSING"})\n`);
  for (const t of TESTS) {
    const label = `${t.id.padStart(2, " ")}. ${t.message}`;
    try {
      const res = await drive(t.message);
      const verdict = evaluate(t, res);
      const verifyReasons = t.verify ? await t.verify() : [];
      const ok = verdict.ok && verifyReasons.length === 0;
      if (!ok) failures += 1;
      const ca = res.parts.concat(res.confirmed.parts).find((p) => p.type === "confirm_action");
      const exp = res.parts.concat(res.confirmed.parts).find((p) => p.type === "explanation");
      results[t.id] = {
        message: t.message,
        ok,
        reasons: [...verdict.reason, ...verifyReasons],
        confirmAction: ca ? { command: ca.command, input: ca.input } : null,
        read: exp ? exp.plannedCommand : null,
      };
      console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
      if (!ok) {
        for (const r of [...verdict.reason, ...verifyReasons]) console.log(`      - ${r}`);
      }
    } catch (err) {
      failures += 1;
      results[t.id] = { message: t.message, ok: false, reasons: [(err as Error).message] };
      console.log(`FAIL  ${label}`);
      console.log(`      - ${(err as Error).message}`);
    }
  }
  console.log(`\n${TESTS.length - failures}/${TESTS.length} passing`);
  console.log(JSON.stringify(results, null, 2));
  process.exit(failures);
}

await main();