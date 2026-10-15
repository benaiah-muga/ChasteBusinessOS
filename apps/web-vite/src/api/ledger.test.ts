import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLedgerEvents, LedgerApiError } from "./ledger";

const event = {
  seq: 24,
  kind: "invoice.created",
  capabilityId: "accounting.createInvoice",
  actorType: "agent",
  actorId: "user-1",
  sessionId: "session-1",
  payload: { amountMinor: 12500 },
  hash: "1234567890abcdef1234567890abcdef",
  prevHash: "fedcba0987654321fedcba0987654321",
  occurredAt: "2026-09-27T10:15:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("ledger API client", () => {
  it("requests the latest page plus a lookahead event through the same-origin session and validates chain fields", async () => {
    const fetchMock = vi.fn(async () => Response.json({ events: [event] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLedgerEvents()).resolves.toEqual([event]);
    expect(fetchMock).toHaveBeenCalledWith("/api/ledger?limit=101", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("requests an older page before a validated sequence cursor", async () => {
    const fetchMock = vi.fn(async () => Response.json({ events: [event] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchLedgerEvents(undefined, 100)).resolves.toEqual([event]);
    expect(fetchMock).toHaveBeenCalledWith("/api/ledger?limit=101&before=100", expect.any(Object));
    await expect(fetchLedgerEvents(undefined, 0)).rejects.toMatchObject({ status: 0 });
  });

  it("preserves forbidden and expired-session states as explicit API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden: missing accounting.read" }, { status: 403 })));
    await expect(fetchLedgerEvents()).rejects.toMatchObject({
      name: "LedgerApiError",
      status: 403,
      message: "You do not have permission to view the event ledger.",
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })));
    await expect(fetchLedgerEvents()).rejects.toMatchObject({
      name: "LedgerApiError",
      status: 401,
      message: "Your session has ended. Sign in again to continue.",
    });
  });

  it("rejects data that omits a required hash-chain field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [{ ...event, hash: null }] })));

    await expect(fetchLedgerEvents()).rejects.toEqual(expect.objectContaining({
      status: 200,
      message: "The ledger service returned data in an unexpected format.",
    }));
  });

  it("maps an unavailable ledger service to a recoverable error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "ledger service unavailable" }, { status: 503 })));

    const request = fetchLedgerEvents();
    await expect(request).rejects.toBeInstanceOf(LedgerApiError);
    await expect(request).rejects.toMatchObject({
      status: 503,
      message: "The ledger service is unavailable. Try again.",
    });
  });
});
