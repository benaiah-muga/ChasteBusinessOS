import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerPage } from "./LedgerPage";

const events = [
  {
    seq: 24,
    kind: "invoice.created",
    capabilityId: "accounting.createInvoice",
    actorType: "agent",
    actorId: "user-1",
    sessionId: "session-abcdefgh",
    payload: { privateNote: "not displayed in the ledger" },
    hash: "1234567890abcdef1234567890abcdef",
    prevHash: "fedcba0987654321fedcba0987654321",
    occurredAt: "2026-09-27T10:15:00.000Z",
  },
  {
    seq: 23,
    kind: "approval.decided",
    capabilityId: "policy.respond",
    actorType: "human",
    actorId: "user-2",
    sessionId: null,
    payload: {},
    hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prevHash: null,
    occurredAt: "2026-09-27T09:15:00.000Z",
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Vite ledger page", () => {
  it("shows the latest events, agent context, and accessible full hash-chain details", async () => {
    const fetchMock = vi.fn(async () => Response.json({ events }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LedgerPage />);

    expect(await screen.findByRole("heading", { name: "Event Ledger" })).not.toBeNull();
    expect(await screen.findByText("invoice.created")).not.toBeNull();
    expect(screen.getByText("approval.decided")).not.toBeNull();
    expect(screen.getByText("s·sessio").getAttribute("title")).toBe("Agent session session-abcdefgh acting for user user-1");
    expect(screen.queryByText("not displayed in the ledger")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/ledger?limit=100", expect.any(Object));

    fireEvent.click(screen.getByLabelText("Show hash chain details for event 24"));
    const firstEvent = events.at(0);
    expect(firstEvent).toBeDefined();
    if (!firstEvent) return;
    expect(screen.getByText(firstEvent.hash)).not.toBeNull();
    if (firstEvent.prevHash) expect(screen.getByText(firstEvent.prevHash)).not.toBeNull();
  });

  it("filters the current 100 event page by kind, capability, or actor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events })));
    render(<LedgerPage />);

    const filter = await screen.findByRole("searchbox", { name: "Filter ledger events" });
    fireEvent.change(filter, { target: { value: "  POLICY.RESPOND  " } });
    expect(screen.getByText("approval.decided")).not.toBeNull();
    expect(screen.queryByText("invoice.created")).toBeNull();

    fireEvent.change(filter, { target: { value: "human" } });
    expect(screen.getByText("approval.decided")).not.toBeNull();
    expect(screen.queryByText("invoice.created")).toBeNull();
  });

  it("shows loading and an empty ledger as status updates", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; })));
    render(<LedgerPage />);

    expect(screen.getByRole("status").textContent).toContain("Loading the event ledger");
    resolveResponse?.(Response.json({ events: [] }));
    expect(await screen.findByRole("heading", { name: "Nothing in the ledger yet" })).not.toBeNull();
  });

  it("preserves permission failures and retries the same read", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempt += 1;
      return attempt === 1
        ? Response.json({ error: "forbidden: missing accounting.read" }, { status: 403 })
        : Response.json({ events: [] });
    }));
    render(<LedgerPage />);

    expect(await screen.findByRole("heading", { name: "Access denied" })).not.toBeNull();
    expect(screen.getByText("You do not have permission to view the event ledger.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Nothing in the ledger yet" })).not.toBeNull();
    expect(attempt).toBe(2);
  });

  it("shows an empty result when no event matches the filter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events })));
    render(<LedgerPage />);

    fireEvent.change(await screen.findByRole("searchbox", { name: "Filter ledger events" }), { target: { value: "missing-event" } });
    expect(await screen.findByRole("heading", { name: "No events match" })).not.toBeNull();
  });
});
