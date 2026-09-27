import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalsPage } from "./ApprovalsPage";

const pending = {
  id: "approval-1",
  capabilityId: "accounting.recordPayment",
  riskClass: "money",
  payload: {
    customerName: "Ada Lovelace",
    amountMinor: 125000,
    password: "never-render-this-value",
    apiKey: "never-render-this-api-key",
    privateKey: "never-render-this-private-key",
    authorization: "never-render-this-authorization-value",
    bearer: "never-render-this-bearer-value",
    nested: { apiToken: "also-secret" },
  },
  rationale: "A payment needs a human review.",
  createdAt: "2026-09-27T10:15:00.000Z",
  status: "pending",
  raisedBy: { name: "Ada Lovelace", kind: "agent" as const },
  relatedDocuments: [{ id: "doc-1", title: "Invoice 104" }],
};

const recent = {
  id: "approval-0",
  capabilityId: "crm.createCustomer",
  riskClass: "write",
  payload: { name: "Grace Hopper" },
  rationale: "Customer setup.",
  createdAt: "2026-09-26T09:00:00.000Z",
  status: "rejected",
  decidedAt: "2026-09-26T09:05:00.000Z",
  decisionComment: "Please confirm the billing address first.",
  decidedBy: "Ada Lovelace",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "chaste_display_currency=; Max-Age=0; path=/";
  localStorage.clear();
});

function approvalsResponse(approvals: unknown[] = [pending], history: unknown[] = [recent]) {
  return Response.json({ approvals, history });
}

describe("Vite approvals page", () => {
  it("shows pending decisions and history while redacting sensitive payload values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => approvalsResponse()));
    render(<ApprovalsPage baseCurrency="USD" />);

    expect(await screen.findByRole("heading", { name: "Approvals" })).not.toBeNull();
    expect(await screen.findByText(/A payment needs a human review\./)).not.toBeNull();
    expect(screen.getByText("Ada Lovelace", { selector: "dd" })).not.toBeNull();
    expect(screen.getByText("$1,250.00")).not.toBeNull();
    expect(screen.getByText("agent · for Ada Lovelace")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Invoice 104" }).getAttribute("href")).toContain("/documents?documentId=doc-1");
    expect(screen.getByRole("heading", { name: "Recent decisions" })).not.toBeNull();
    expect(screen.getByText("Please confirm the billing address first.")).not.toBeNull();
    expect(screen.queryByText("never-render-this-value")).toBeNull();
    expect(screen.queryByText("also-secret")).toBeNull();
    const preview = screen.getByRole("region", { name: "Affected record preview" });
    expect(preview.textContent).not.toContain("apiKey");
    expect(preview.textContent).not.toContain("privateKey");
    expect(preview.textContent).not.toContain("authorization");
    expect(preview.textContent).not.toContain("bearer");

    fireEvent.click(screen.getByText("Technical details"));
    const details = screen.getByText(/\[hidden\]/).closest("pre");
    expect(details?.textContent).toContain('"password": "[hidden]"');
    expect(details?.textContent).toContain('"apiKey": "[hidden]"');
    expect(details?.textContent).toContain('"privateKey": "[hidden]"');
    expect(details?.textContent).toContain('"authorization": "[hidden]"');
    expect(details?.textContent).toContain('"bearer": "[hidden]"');
    expect(details?.textContent).toContain('"apiToken": "[hidden]"');
    expect(details?.textContent).not.toContain("never-render-this-value");
    expect(details?.textContent).not.toContain("never-render-this-api-key");
    expect(details?.textContent).not.toContain("never-render-this-private-key");
    expect(details?.textContent).not.toContain("never-render-this-authorization-value");
    expect(details?.textContent).not.toContain("never-render-this-bearer-value");
    expect(details?.textContent).not.toContain("also-secret");
  });

  it("approves through the legacy endpoint and reloads the decision history", async () => {
    let listReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/approvals?") && listReads > 0) return Response.json({ ok: true, status: "executed" });
      if (path.startsWith("/api/approvals?") && path.includes("approval-1")) return Response.json({ ok: true, status: "executed" });
      if (path === "/api/approvals") {
        listReads += 1;
        return listReads === 1
          ? approvalsResponse()
          : approvalsResponse([], [{ ...pending, status: "executed", decidedAt: "2026-09-27T10:20:00.000Z" }]);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApprovalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Approve & execute/ }));

    expect(await screen.findByRole("status")).not.toBeNull();
    expect(await screen.findByText("Approved and executed, the result is in the ledger.")).not.toBeNull();
    expect(await screen.findByText("executed", { selector: ".approval-status" })).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Pending approvals" })).toBeNull();
    const post = fetchMock.mock.calls.find(([input]) => String(input).startsWith("/api/approvals?"));
    expect(post?.[0]).toBe("/api/approvals?id=approval-1");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toMatchObject({ decision: "approve" });
  });

  it("does not claim an action executed after a 422 response and keeps it pending", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/approvals") {
        return approvalsResponse();
      }
      if (init?.method === "POST") return Response.json({ ok: false, error: "The period is closed" }, { status: 422 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApprovalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Approve & execute/ }));

    expect((await screen.findByRole("alert")).textContent).toContain("Approval execution failed. The action did not run. The accounting period is closed.");
    expect(screen.queryByText("Approved and executed, the result is in the ledger.")).toBeNull();
    expect(screen.getByRole("region", { name: "Pending approvals" })).not.toBeNull();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/approvals?id=approval-1");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ decision: "approve" });
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/approvals")).toHaveLength(2);
  });

  it("records a successful rejection in the decision history", async () => {
    let listReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/approvals") {
        listReads += 1;
        return listReads === 1 ? approvalsResponse() : approvalsResponse([], [recent]);
      }
      if (init?.method === "POST") return Response.json({ ok: true, status: "rejected" });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApprovalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

    expect(await screen.findByText("Rejected. The action was not executed and the decision is on record.")).not.toBeNull();
    expect(await screen.findByText("rejected", { selector: ".approval-status" })).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Pending approvals" })).toBeNull();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ decision: "reject" });
    await waitFor(() => expect(listReads).toBe(2));
  });

  it("shows a recoverable load error and retries the legacy read endpoint", async () => {
    let reads = 0;
    const fetchMock = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? new Response(null, { status: 503 }) : approvalsResponse([], []);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApprovalsPage />);

    expect(await screen.findByText("The approvals service is unavailable. Try again.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Inbox zero" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
