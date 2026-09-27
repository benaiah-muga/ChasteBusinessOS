import type { DashboardData, SetupItem, WorkCard } from "../api/dashboard";

export const dashboardFixture: DashboardData = {
  signals: [{ id: "stock-warning", severity: "orange", module: "inventory", subject: "One item reached its reorder point", detail: "Reorder this item." }],
  money: {
    revenueMinor: 1_250_000,
    expenseMinor: 900_000,
    netIncomeMinor: 350_000,
    cashMinor: 500_000,
    balanced: true,
    assetsMinor: 1_200_000,
    liabilitiesMinor: 400_000,
    equityMinor: 800_000,
  },
  workingCapital: {
    arOutstandingMinor: 420_000,
    overdueCount: 2,
    overdueAmountMinor: 80_000,
    apOutstandingMinor: 310_000,
  },
  pipeline: {
    stages: [
      { stage: "lead", count: 1, valueMinor: 20_000 },
      { stage: "qualified", count: 2, valueMinor: 40_000 },
      { stage: "proposal", count: 1, valueMinor: 30_000 },
      { stage: "negotiation", count: 0, valueMinor: 0 },
      { stage: "won", count: 0, valueMinor: 0 },
      { stage: "lost", count: 0, valueMinor: 0 },
    ],
    openCount: 4,
    weightedForecastMinor: 50_000,
  },
  ops: {
    headcount: 5,
    pendingLeave: 1,
    posOpen: { register: "Front desk" },
    lowStock: [{ sku: "CHAIR-01", name: "Office chair" }],
    pendingApprovals: 3,
    docsParsed: 4,
    docsAwaitingCoding: 2,
  },
  trend: [
    { month: "2026-04", incomeMinor: 80_000, expenseMinor: 30_000 },
    { month: "2026-05", incomeMinor: 95_000, expenseMinor: 50_000 },
    { month: "2026-06", incomeMinor: 90_000, expenseMinor: 44_000 },
    { month: "2026-07", incomeMinor: 110_000, expenseMinor: 65_000 },
    { month: "2026-08", incomeMinor: 124_000, expenseMinor: 82_000 },
    { month: "2026-09", incomeMinor: 140_000, expenseMinor: 90_000 },
  ],
  activity: [{ seq: 12, kind: "capability.executed", capabilityId: "accounting.createInvoice", actorType: "agent", occurredAt: "2026-09-27T10:15:00.000Z" }],
};

export const setupFixture: SetupItem[] = [
  { id: "products", title: "Add what you sell", why: "Invoices and stock need products.", href: "/products", done: false },
  { id: "customers", title: "Add your first customer", why: "Sales and invoicing need customer records.", href: "/crm", done: false },
  { id: "vendors", title: "Add a vendor", why: "Bills need vendors.", href: "/purchasing", done: false },
  { id: "team", title: "Invite your team", why: "Approvals need a second pair of eyes.", href: "/team", done: true },
];

export const myWorkFixture: WorkCard[] = [
  {
    kind: "approval",
    id: "approval-1",
    title: "Approval needed: accounting.payBill",
    detail: "A vendor bill is waiting for review.",
    whyItMatters: "A human decision is required before this action runs.",
    actionLabel: "Review approval",
    actionHref: "/approvals",
    createdAt: "2026-09-27T09:20:00.000Z",
    rank: 0,
  },
  {
    kind: "receipt_remainder",
    id: "po-1",
    title: "PO 107: 3 units still outstanding",
    detail: "line 1 \"Office chairs\"",
    whyItMatters: "The supplier has not delivered everything ordered.",
    actionLabel: "Open receiving desk",
    actionHref: "/purchasing/receiving?poNumber=107",
    createdAt: null,
    rank: 1,
  },
];
