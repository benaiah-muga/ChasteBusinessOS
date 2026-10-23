import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxPage } from "./InboxPage";

const orgId = "62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12";

const signal = {
  id: "signal-1",
  severity: "orange",
  module: "inventory",
  subject: "Desk lamp is at or below its reorder point",
  detail: "5.000 on hand against a reorder point of 5.000.",
  evidence: { refType: "item", refId: "item-1" },
  suggestedAction: { capabilityId: "purchasing.createPurchaseOrder", inputDraft: {} },
};

const approval = {
  id: "30000000-0000-4000-8000-000000000001",
  orgId,
  sessionId: null,
  requestedByUserId: null,
  capabilityId: "accounting.recordPayment",
  riskClass: "destructive",
  payload: { amountMinor: 12500 },
  rationale: "Pay the outstanding supplier bill",
  createdAt: "2026-10-20T10:15:00.000Z",
  status: "pending",
  decidedByUserId: null,
  decisionComment: null,
  expiresAt: null,
  decidedAt: null,
  raisedBy: { name: "Ada Lovelace", kind: "human" },
  decidedBy: null,
  relatedDocuments: [],
};

function mockFetch(overrides: { signals?: () => Response; approvals?: () => Response; brief?: () => Response } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/signals") return overrides.signals ? overrides.signals() : Response.json({ signals: [signal] });
    if (url === "/api/approvals") return overrides.approvals ? overrides.approvals() : Response.json({ approvals: [approval], history: [] });
    if (url === "/api/my-work/summarize") return overrides.brief ? overrides.brief() : Response.json({ brief: "Focus on the reorder.", model: "test" });
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InboxPage", () => {
  it("ranks approvals and signals, links to the owning workspace, and asks Workmate", async () => {
    mockFetch();
    render(<InboxPage organizationId={orgId} />);

    expect(await screen.findByRole("heading", { name: "Inbox" })).not.toBeNull();
    expect(await screen.findByText("Desk lamp is at or below its reorder point")).not.toBeNull();
    expect(await screen.findByText("Pay the outstanding supplier bill")).not.toBeNull();
    expect(screen.getByRole("link", { name: /Review in Inventory/ }).getAttribute("href")).toBe("/inventory");
    expect(screen.getByRole("link", { name: /Review approval/ }).getAttribute("href")).toBe("/approvals");
    const ask = screen.getAllByRole("link", { name: /Ask Workmate/ })[0]!;
    expect(ask.getAttribute("href")).toContain("/chat?prompt=");
    expect(screen.getByText("Waiting on you").parentElement?.textContent).toContain("2");
  });

  it("filters to urgent work without losing the approval", async () => {
    mockFetch();
    render(<InboxPage organizationId={orgId} />);
    await screen.findByText("Desk lamp is at or below its reorder point");

    fireEvent.click(screen.getByRole("tab", { name: /Urgent/ }));
    expect(screen.queryByText("Desk lamp is at or below its reorder point")).toBeNull();
    expect(screen.getByText("Pay the outstanding supplier bill")).not.toBeNull();
  });

  it("builds a brief from the visible queue", async () => {
    mockFetch();
    render(<InboxPage organizationId={orgId} />);
    await screen.findByText("Desk lamp is at or below its reorder point");

    fireEvent.click(screen.getByRole("button", { name: /Brief me/ }));
    expect(await screen.findByText("Focus on the reorder.")).not.toBeNull();
  });

  it("shows a calm empty state when nothing needs a person", async () => {
    mockFetch({ signals: () => Response.json({ signals: [] }), approvals: () => Response.json({ approvals: [], history: [] }) });
    render(<InboxPage organizationId={orgId} />);
    expect(await screen.findByText("Inbox zero")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Ask the workmate what changed/ })).not.toBeNull();
  });

  it("shows a recoverable error when both feeds fail", async () => {
    mockFetch({
      signals: () => Response.json({ error: "unavailable" }, { status: 503 }),
      approvals: () => Response.json({ error: "unavailable" }, { status: 503 }),
    });
    render(<InboxPage organizationId={orgId} />);
    await waitFor(() => expect(screen.getByRole("alert")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
  });
});
