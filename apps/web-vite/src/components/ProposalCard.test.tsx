import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalCard } from "./ProposalCard";

const { submitApprovalDecision, fetchPurchaseOrder } = vi.hoisted(() => ({
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
}));

vi.mock("../api/approvals", () => ({
  fetchApprovals: vi.fn(async () => ({
    approvals: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        orgId: "22222222-2222-4222-8222-222222222222",
        capabilityId: "purchasing.createPurchaseOrder",
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

const proposal = {
  approvalId: "11111111-1111-4111-8111-111111111111",
  capabilityId: "purchasing.createPurchaseOrder",
  rationale: "amount 5000 exceeds autonomous threshold 0",
};

afterEach(() => {
  cleanup();
  submitApprovalDecision.mockClear();
  fetchPurchaseOrder.mockClear();
});

describe("ProposalCard", () => {
  it("renders the stored approval lines rather than the model summary", async () => {
    render(<ProposalCard proposal={proposal} organizationId="22222222-2222-4222-8222-222222222222" />);
    expect(await screen.findByText("Acme Supplies")).toBeTruthy();
    expect(screen.getByText("Restock cement")).toBeTruthy();
    expect(screen.getByText("Cement bag")).toBeTruthy();
    expect(screen.getByText("Delivery")).toBeTruthy();
    expect(screen.getByText("$100.00")).toBeTruthy();
    expect(screen.getAllByText("$25.00").length).toBeGreaterThan(0);
    expect(screen.getByText("$125.00")).toBeTruthy();
  });

  it("approves the exact approval and reports the executed result", async () => {
    render(<ProposalCard proposal={proposal} organizationId="22222222-2222-4222-8222-222222222222" />);
    const button = await screen.findByRole("button", { name: "Approve order" });
    fireEvent.click(button);
    await waitFor(() => expect(submitApprovalDecision).toHaveBeenCalledWith(proposal.approvalId, "approve", "22222222-2222-4222-8222-222222222222"));
    expect(await screen.findByText("Approved and executed. The purchase order is now on record.")).toBeTruthy();
    expect(fetchPurchaseOrder).toHaveBeenCalledWith(1, "22222222-2222-4222-8222-222222222222");
    expect(await screen.findByText(/Order #1/)).toBeTruthy();
    expect(await screen.findByText(/2 of 2 units still outstanding/)).toBeTruthy();
  });
});
