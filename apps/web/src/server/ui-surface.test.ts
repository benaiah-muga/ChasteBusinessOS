import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("integrated operational UI surfaces", () => {
  it("sessions surface includes durable runs and canonical replay", () => {
    const page = source("src/app/(app)/sessions/page.tsx");
    const runsRoute = source("src/app/api/durable-runs/route.ts");
    const replayRoute = source("src/app/api/sessions/[id]/replay/route.ts");
    expect(page).toContain("/api/durable-runs");
    expect(page).toContain("Canonical replay");
    expect(page).toContain("Durable work");
    expect(runsRoute).toContain("resolved.orgId");
    expect(replayRoute).toContain("replaySession");
    console.log("UI-SESSIONS-SURFACE-OK");
  });

  it("Creator surface includes gaps, releases, and canary evidence", () => {
    const page = source("src/app/(app)/proposals/page.tsx");
    const proposalsRoute = source("src/app/api/proposals/route.ts");
    const gapsRoute = source("src/app/api/capability-gaps/route.ts");
    expect(page).toContain("Capability gaps");
    expect(page).toContain("Controlled release");
    expect(page).toContain("Record pass");
    expect(proposalsRoute).toContain("creatorEvolutionOutcomes");
    expect(gapsRoute).toContain('eq(tickets.origin, "capability_gap")');
    console.log("UI-CREATOR-SURFACE-OK");
  });

  it("harness surface exposes safe tenant-scoped inspection", () => {
    const page = source("src/app/(app)/settings/page.tsx");
    const route = source("src/app/api/harness/compositions/route.ts");
    expect(page).toContain("Runtime compositions");
    expect(page).toContain("Configuration patches");
    expect(route).toContain("inspectComposition");
    expect(route).toContain("harness.approve");
    console.log("UI-HARNESS-SURFACE-OK");
  });

  it("release controls route every mutation through the kernel approval result", () => {
    const page = source("src/app/(app)/proposals/page.tsx");
    const route = source("src/app/api/creator/evolution/route.ts");
    for (const action of ["stage", "promote", "rollback", "canary"]) {
      expect(page).toContain(`action: "${action}"`);
      expect(route).toContain(`z.literal("${action}")`);
    }
    expect(route).toContain("pendingApproval");
    expect(route).toContain("buildExecutor");
    console.log("UI-RELEASE-CONTROLS-OK");
  });

  it("AI settings expose workspace credentials and personal coding-plan connections", () => {
    const page = source("src/app/(app)/settings/page.tsx");
    const connections = source("src/app/(app)/settings/coding-plans.tsx");
    const route = source("src/app/api/ai-config/route.ts");
    const connectionRoute = source("src/app/api/ai-connections/route.ts");
    expect(page).toContain("Workspace model provider");
    expect(page).toContain("Custom OpenAI-compatible");
    expect(page).toContain("<CodingPlansCard />");
    expect(connections).toContain("Coding-plan connections");
    expect(connections).toContain("Connect Codex plan");
    expect(connections).toContain("Connect OpenCode");
    expect(connections).toContain("Scheduled and background work continues to use the workspace provider");
    expect(route).toContain('settings.configureAiProvider');
    expect(route).toContain("encryptedApiKey");
    expect(connectionRoute).toContain("connect_opencode");
    expect(connectionRoute).toContain("poll_codex_login");
    console.log("UI-AI-CONFIG-SURFACE-OK");
  });

  it("currency selection reaches the shared formatter", () => {
    const shell = source("src/app/(app)/app-shell.tsx");
    const format = source("src/lib/format.ts");
    expect(shell).toContain("setActiveCurrency");
    expect(shell).toContain("baseCurrency");
    expect(format).toContain('UGX: "USh "');
    console.log("UI-CURRENCY-SURFACE-OK");
  });

  it("receivable aging cards filter the invoice list and expose a reset", () => {
    const page = source("src/app/(app)/accounting/page.tsx");
    expect(page).toContain('showAgingRange("current")');
    expect(page).toContain('showAgingRange("d30")');
    expect(page).toContain('showAgingRange("d60")');
    expect(page).toContain('showAgingRange("d90plus")');
    expect(page).toContain('showAgingRange("outstanding")');
    expect(page).toContain("visibleInvoices.slice(0, 30)");
    expect(page).toContain("Show all invoices");
    expect(page).toContain("list?.focus({ preventScroll: true })");
    console.info("RECEIVABLE-AGING-FILTERS-OK");
  });

  it("POS quick add makes stock availability explicit", () => {
    const page = source("src/app/(app)/pos/page.tsx");
    expect(page).toContain('value={quickProduct.openingStock}');
    expect(page).toContain('action: "adjustStock"');
    expect(page).toContain("with zero stock. Add an opening balance in Inventory before selling it.");
    expect(page).toContain("waiting for approval before the item can be sold");
  });

  it("POS keeps scanning first and mobile cart actions clear of the sticky checkout", () => {
    const page = source("src/app/(app)/pos/page.tsx");
    expect(page.indexOf('id="pos-catalog-search"')).toBeLessThan(page.indexOf("Attach customer"));
    expect(page).toContain('grid-cols-[minmax(0,1fr)]');
    expect(page).toContain("input.scrollIntoView({");
    expect(page).toContain('id="pos-cart-lines"');
    expect(page).toContain("Review cart · {lines.length} line");
    expect(page).toContain("Complete sale for ${formatMoney(total)}");
    expect(page).toContain('event.key === "Enter" && catalogResults[0]');
    expect(page).toContain('event.key === "Backspace"');
    console.log("UI-POS-SCAN-FIRST-OK");
  });

  it("POS split tender rows remain readable on small screens and block an unpaid balance", () => {
    const page = source("src/app/(app)/pos/page.tsx");
    expect(page).toContain("grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(7rem,0.8fr)_auto]");
    expect(page).toContain('className="label col-span-2 sm:col-span-1">Payment method');
    expect(page).toContain("Remaining ${formatMoney(total - splitAllocatedMinor)}");
    expect(page).toContain("splitAllocatedMinor === total");
    expect(page).toContain('"Enter amounts"');
    expect(page).toContain("splitTenderRowsComplete");
    expect(page).toContain("Cash short ${formatMoney(splitCashAllocatedMinor - splitCashReceivedMinor)}");
    expect(page).toContain("splitCheckoutStatus");
    expect(page).toContain("!checkoutReady");
  });

  it("POS receipts preview before delivery and return review selects quantities with approval scope", () => {
    const page = source("src/app/(app)/pos/page.tsx");
    expect(page).toContain('title="Receipt preview"');
    expect(page).toContain("Email draft");
    expect(page).toContain("Receipt copied. Paste it into a message to share.");
    expect(page).toContain('aria-label="Items in original sale"');
    expect(page).toContain("Choose return quantities");
    expect(page).toContain("Quantity to return for ${saleLine.description}");
    expect(page).toContain("Request selected return");
    expect(page).toContain("Only the selected quantities will be refunded.");
    expect(page).toContain("Refunds by destination");
    expect(page).toContain("Every POS return needs approval before the refund posts or stock is restored.");
  });

  it("inventory overview explains value plainly and keeps ledger math expandable", () => {
    const page = source("src/app/(app)/inventory/page.tsx");
    expect(page).toContain('getElementById("inventory-create-item-name")?.focus()');
    expect(page).toContain(">Add item</Button>}");
    expect(page).toContain("Stock value estimates what the units on hand cost");
    expect(page).toContain("How stock value is calculated");
    expect(page).toContain("moving-average unit cost");
    expect(page).toContain("inventory ledger keeps the recorded stock movements");
  });
});
