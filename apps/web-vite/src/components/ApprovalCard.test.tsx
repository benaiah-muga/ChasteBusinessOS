import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard";

const organizationId = "22222222-2222-4222-8222-222222222222";
const purchaseApprovalId = "11111111-1111-4111-8111-111111111111";
const customerApprovalId = "33333333-3333-4333-8333-333333333333";

const { submitApprovalDecision, fetchPurchaseOrder, fetchOrganizations } = vi.hoisted(() => ({
  submitApprovalDecision: vi.fn(async () => ({
    ok: true,
    status: "executed",
    result: { ok: true, data: { poNumber: 1 } },
  })),
  fetchPurchaseOrder: vi.fn(async () => ({
    poNumber: 1,
    vendorId: "33333333-3333-4333-8333-333333333333",
    vendorName: "Acme Supplies",
    status: "ordered",
    memo: "Restock cement",
    orderedAt: "2026-10-19T12:00:00.000Z",
    promisedAt: "2026-10-25T00:00:00.000Z",
    totalMinor: 12500,
    lines: [{
      lineNumber: 1,
      description: "Cement bag",
      quantity: 2000,
      unitPriceMinor: 5000,
      lineTotalMinor: 10000,
      acceptedThousandths: 0,
      rejectedThousandths: 0,
      returnedThousandths: 0,
      remainingThousandths: 2000,
    }],
    receipts: [],
    fullyReceived: false,
    backordered: false,
  })),
  fetchOrganizations: vi.fn(async () => ({
    activeOrgId: organizationId,
    orgs: [{ id: organizationId, name: "Test Co", baseCurrency: "USD" }],
  })),
}));

vi.mock("../api/approvals", () => ({
  fetchApprovals: vi.fn(async () => ({
    approvals: [
      {
        id: purchaseApprovalId,
        orgId: organizationId,
        capabilityId: "purchasing.createPurchaseOrder",
        riskClass: "money",
        status: "pending",
        rationale: "amount 5000 exceeds autonomous threshold 0",
        payload: {
          vendorId: "33333333-3333-4333-8333-333333333333",
          memo: "Restock cement",
          promisedAt: "2026-10-25T00:00:00Z",
          lines: [
            { description: "Cement bag", quantity: 2000, unitPriceMinor: 5000 },
            { description: "Delivery", quantity: 1000, unitPriceMinor: 2500 },
          ],
        },
      },
      {
        id: customerApprovalId,
        orgId: organizationId,
        capabilityId: "crm.createCustomer",
        riskClass: "write",
        status: "pending",
        rationale: "Org policy caps autonomy at read",
        payload: {
          name: "Browser Check Ltd",
          email: "browser@check.test",
          doNotContact: false,
          preferredContactMethod: "email",
        },
      },
    ],
    history: [],
  })),
  submitApprovalDecision,
}));

vi.mock("../api/purchasing", () => ({
  fetchPurchasingWorkspace: vi.fn(async () => ({
    baseCurrency: "USD",
    vendors: [{ id: "33333333-3333-4333-8333-333333333333", name: "Acme Supplies" }],
  })),
  fetchPurchaseOrder,
}));

vi.mock("../api/organizations", () => ({ fetchOrganizations }));

const purchaseProposal = {
  approvalId: purchaseApprovalId,
  capabilityId: "purchasing.createPurchaseOrder",
  rationale: "amount 5000 exceeds autonomous threshold 0",
};

const customerProposal = {
  approvalId: customerApprovalId,
  capabilityId: "crm.createCustomer",
  rationale: "Org policy caps autonomy at read",
};

afterEach(() => {
  cleanup();
  submitApprovalDecision.mockClear();
  fetchPurchaseOrder.mockClear();
  fetchOrganizations.mockClear();
});

describe("ApprovalCard", () => {
  it("renders the stored purchase approval lines rather than the model summary", async () => {
    render(<ApprovalCard proposal={purchaseProposal} organizationId={organizationId} />);
    expect(await screen.findByText("Acme Supplies")).toBeTruthy();
    expect(screen.getByText("Restock cement")).toBeTruthy();
    expect(screen.getByText("Cement bag")).toBeTruthy();
    expect(screen.getByText("Delivery")).toBeTruthy();
    expect(screen.getByText("$100.00")).toBeTruthy();
    expect(screen.getAllByText("$25.00").length).toBeGreaterThan(0);
    expect(screen.getByText("$125.00")).toBeTruthy();
  });

  it("approves the exact purchase approval and reports the executed result", async () => {
    render(<ApprovalCard proposal={purchaseProposal} organizationId={organizationId} />);
    const button = await screen.findByRole("button", { name: "Approve order" });
    fireEvent.click(button);
    await waitFor(() => expect(submitApprovalDecision).toHaveBeenCalledWith(purchaseApprovalId, "approve", organizationId));
    expect(await screen.findByText("Approved and executed. The purchase order is now on record.")).toBeTruthy();
    expect(fetchPurchaseOrder).toHaveBeenCalledWith(1, organizationId);
    expect(await screen.findByText(/Order #1/)).toBeTruthy();
    expect(await screen.findByText(/2 of 2 units still outstanding/)).toBeTruthy();
  });

  it("shows a non-purchase approval generically, with its stored fields", async () => {
    render(<ApprovalCard proposal={customerProposal} organizationId={organizationId} />);
    expect(await screen.findByText("Approval required")).toBeTruthy();
    expect(screen.queryByText("Purchase proposal")).toBeNull();
    expect(screen.getByText("Create Customer")).toBeTruthy();
    expect(screen.getByText("write risk")).toBeTruthy();
    expect(screen.getByText("Browser Check Ltd")).toBeTruthy();
    expect(screen.getByText("browser@check.test")).toBeTruthy();
    expect(screen.getByText("Do not contact")).toBeTruthy();
    expect(screen.getByText("Preferred contact method")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open approvals" }).getAttribute("href")).toBe("/approvals");
  });

  it("approves a generic approval without pretending a purchase order exists", async () => {
    render(<ApprovalCard proposal={customerProposal} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(submitApprovalDecision).toHaveBeenCalledWith(customerApprovalId, "approve", organizationId));
    expect(await screen.findByText("Approved and executed.")).toBeTruthy();
    expect(fetchPurchaseOrder).not.toHaveBeenCalled();
  });

  it("rejects a generic approval honestly", async () => {
    render(<ApprovalCard proposal={customerProposal} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(submitApprovalDecision).toHaveBeenCalledWith(customerApprovalId, "reject", organizationId));
    expect(await screen.findByText("Rejected. Nothing was changed.")).toBeTruthy();
  });
});
