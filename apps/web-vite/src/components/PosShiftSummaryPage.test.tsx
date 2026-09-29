import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PosShiftSummaryPage } from "./PosShiftSummaryPage";

const sessions = [
  { id: "10000000-0000-4000-8000-000000000001", register: "Front register", status: "closed", openingFloatMinor: 10000, openedAt: "2026-09-27T10:15:00.000Z", closedAt: "2026-09-27T18:30:00.000Z" },
  { id: "10000000-0000-4000-8000-000000000002", register: "Front register", status: "open", openingFloatMinor: 5000, openedAt: "2026-09-28T09:00:00.000Z", closedAt: null },
];
const summary = (register: string, takingsMinor = 129900) => ({
  register,
  status: "closed",
  salesCount: 3,
  takingsMinor,
  tenderTotals: [{ method: "cash", amountMinor: 89900 }, { method: "card", amountMinor: takingsMinor - 89900 }],
  refundTotals: [{ method: "cash", amountMinor: 1000 }],
  expectedCashMinor: 88900,
  countedCashMinor: 88000,
  varianceMinor: -900,
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Vite POS shift summary page", () => {
  it("loads the newest session summary and allows switching shifts", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return Response.json({ sessions });
      const payload = JSON.parse(String(init.body)) as { sessionId: string };
      return Response.json({ ok: true, data: summary(payload.sessionId.endsWith("2") ? "Front register" : "Front register") });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PosShiftSummaryPage baseCurrency="USD" />);

    expect(await screen.findByRole("heading", { name: "POS shift summary" })).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Shift totals" })).not.toBeNull();
    expect(screen.getByText("$1,299.00")).not.toBeNull();
    expect(screen.getByText("−$9.00")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open full POS workspace" })).not.toBeNull();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/pos", expect.objectContaining({ cache: "no-store" }));

    fireEvent.change(screen.getByRole("combobox", { name: "Register session" }), { target: { value: sessions[1]!.id } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual(expect.objectContaining({ action: "shiftSummary", sessionId: sessions[1]!.id }));
  });

  it("keeps the selected shift when its initial summary request resolves late", async () => {
    let resolveInitialSummary!: (response: Response) => void;
    const initialSummary = new Promise<Response>((resolve) => { resolveInitialSummary = resolve; });
    let summaryRequests = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return Response.json({ sessions });
      summaryRequests += 1;
      return summaryRequests === 1
        ? initialSummary
        : Response.json({ ok: true, data: summary("Front register", 219900) });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PosShiftSummaryPage baseCurrency="USD" />);

    const picker = await screen.findByRole("combobox", { name: "Register session" }) as HTMLSelectElement;
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const nextSessionId = sessions.find((session) => session.id !== picker.value)!.id;
    fireEvent.change(picker, { target: { value: nextSessionId } });
    expect(await screen.findByText("$2,199.00")).not.toBeNull();

    await act(async () => {
      resolveInitialSummary(Response.json({ ok: true, data: summary("Front register", 129900) }));
      await initialSummary;
    });

    expect(picker.value).toBe(nextSessionId);
    expect(screen.getByText("$2,199.00")).not.toBeNull();
  });

  it("offers a login link after the session expires", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })));
    render(<PosShiftSummaryPage />);
    const loginLink = await screen.findByRole("link", { name: "Sign in again" });
    expect(loginLink.getAttribute("href")).toBe("/login");
  });

  it("shows accessible empty and recoverable error states", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sessions: [] })));
    const { unmount } = render(<PosShiftSummaryPage />);
    expect(await screen.findByRole("heading", { name: "No register sessions yet" })).not.toBeNull();
    unmount();

    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json({ sessions: [] });
    }));
    render(<PosShiftSummaryPage />);
    expect(await screen.findByRole("heading", { name: "Could not load POS sessions" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "No register sessions yet" })).not.toBeNull();
  });

  it("formats money using the configured zero-decimal currency minor units", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method
      ? Response.json({ ok: true, data: summary("Front register") })
      : Response.json({ sessions: [sessions[0]] })));
    localStorage.setItem("chaste-prefs", JSON.stringify({ currency: "UGX" }));
    render(<PosShiftSummaryPage baseCurrency="USD" />);
    expect(await screen.findByText((value) => value.includes("129,900"))).not.toBeNull();
  });
});
