import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxPage } from "./InboxPage";

const orgId = "62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12";
const userId = "50000000-0000-4000-8000-000000000001";

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

function mockFetch(overrides: { signals?: () => Response; approvals?: () => Response; exceptions?: () => Response; brief?: () => Response } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/signals") return overrides.signals ? overrides.signals() : Response.json({ signals: [signal] });
    if (url === "/api/approvals") return overrides.approvals ? overrides.approvals() : Response.json({ approvals: [approval], history: [] });
    if (url === "/api/my-work/summarize") return overrides.brief ? overrides.brief() : Response.json({ brief: "Focus on the reorder.", model: "test" });
    if (url === "/api/capabilities/execute") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string; input?: Record<string, unknown> };
      if (body.capabilityId === "operations.listRecords") {
        return overrides.exceptions ? overrides.exceptions() : Response.json({ ok: true, data: { records: [] } });
      }
      if (body.capabilityId === "operations.upsertRecord" && body.input) {
        return Response.json({ ok: true, data: {
          id: "40000000-0000-4000-8000-000000000002",
          kind: "exception",
          stableKey: body.input.stableKey,
          status: body.input.status,
          title: body.input.title,
          summary: body.input.summary ?? null,
          details: body.input.details ?? {},
          revision: 1,
          authorityRef: null,
          approvalId: null,
          ownerUserId: body.input.ownerUserId ?? null,
          createdAt: "2026-10-24T10:00:00.000Z",
          updatedAt: "2026-10-24T10:00:00.000Z",
          resolvedAt: body.input.status === "resolved" ? "2026-10-24T10:00:00.000Z" : null,
        } });
      }
    }
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

  it("acknowledges, owns, and resolves a live exception through the governed record path", async () => {
    const fetchMock = mockFetch();
    render(<InboxPage organizationId={orgId} actorId={userId} />);
    await screen.findByText("Desk lamp is at or below its reorder point");

    fireEvent.click(screen.getByRole("button", { name: "Take it" }));
    expect(await screen.findByText("Acknowledged")).not.toBeNull();
    expect(await screen.findByText("Assigned to you")).not.toBeNull();

    const acknowledgment = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string; input?: Record<string, unknown> })
      .find((body) => body.capabilityId === "operations.upsertRecord");
    expect(acknowledgment?.input).toMatchObject({
      kind: "exception",
      stableKey: "signal:signal-1",
      status: "acknowledged",
      ownerUserId: userId,
    });

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByText("Resolved")).not.toBeNull();
    const resolution = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string; input?: Record<string, unknown> })
      .find((body) => body.capabilityId === "operations.upsertRecord" && body.input?.status === "resolved");
    expect(resolution?.input?.stableKey).toBe("signal:signal-1");
  });

  it("keeps a saved exception visible after its live signal disappears", async () => {
    const fetchMock = mockFetch({
      signals: () => Response.json({ signals: [] }),
      approvals: () => Response.json({ approvals: [], history: [] }),
      exceptions: () => Response.json({ ok: true, data: { records: [{
        id: "40000000-0000-4000-8000-000000000002",
        kind: "exception",
        stableKey: "signal:purchasing.orderDelayed:old",
        status: "acknowledged",
        title: "Purchase order #41 is 10 days past its promised date",
        summary: "CopperWire GmbH promised delivery on 2026-09-08; the order is still partial.",
        details: { severity: "red", module: "purchasing", href: "/purchasing" },
        revision: 2,
        authorityRef: null,
        approvalId: null,
        ownerUserId: userId,
        createdAt: "2026-10-20T10:00:00.000Z",
        updatedAt: "2026-10-23T10:00:00.000Z",
        resolvedAt: null,
      }] } }),
    });
    render(<InboxPage organizationId={orgId} actorId={userId} />);

    expect(await screen.findByText("Purchase order #41 is 10 days past its promised date")).not.toBeNull();
    expect(screen.getByText("No longer detected")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(screen.queryByText("Purchase order #41 is 10 days past its promised date")).toBeNull());
    const resolution = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string; input?: Record<string, unknown> })
      .find((body) => body.capabilityId === "operations.upsertRecord" && body.input?.status === "resolved");
    expect(resolution?.input?.stableKey).toBe("signal:purchasing.orderDelayed:old");
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
      exceptions: () => Response.json({ error: "unavailable" }, { status: 503 }),
    });
    render(<InboxPage organizationId={orgId} />);
    await waitFor(() => expect(screen.getByRole("alert")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
  });
});
