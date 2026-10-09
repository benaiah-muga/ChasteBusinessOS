import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryItem, InventoryLocation } from "../api/inventory";
import {
  createInventoryLocation,
  InventoryLocationActionError,
  releaseInventoryReservation,
  reserveInventoryStock,
} from "../api/inventory-locations-reservations";
import type { InventoryReservation } from "./InventoryLocationsReservationsPanel";
import { InventoryLocationsReservationsPanel } from "./InventoryLocationsReservationsPanel";

const items: InventoryItem[] = [
  {
    sku: "BAG-50", name: "Cement 50kg", kind: "goods", unitLabel: "bag", onHandThousandths: 12000,
    reservedThousandths: 2000, availableThousandths: 10000, totalValueMinor: 28000, reorderPointThousandths: 0, reorderNeeded: false,
  },
  {
    sku: "LABOR", name: "Labor", kind: "service", unitLabel: "hour", onHandThousandths: 0,
    reservedThousandths: 0, availableThousandths: 0, totalValueMinor: 0, reorderPointThousandths: 0, reorderNeeded: false,
  },
];
const locations: InventoryLocation[] = [{ id: "loc-main", code: "MAIN", name: "Main warehouse" }];
const reservations: InventoryReservation[] = [{
  id: "reservation-1", sku: "BAG-50", quantityThousandths: 2500, reason: "SO-1042", status: "open", createdAt: "2026-10-01T00:00:00Z",
}];

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("inventory location and reservation API", () => {
  it("posts location creation with a fresh intent ID and validates the capability response", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { locationId: "loc-new" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createInventoryLocation({ code: "WH-A", name: "Warehouse A" })).resolves.toEqual({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal) }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "createLocation", code: "WH-A", name: "Warehouse A", intentId: expect.any(String) });
  });

  it("posts reservation in integer thousandths and reports approval pending", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: false, pendingApproval: true, reason: "owner approval required" }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reserveInventoryStock({ sku: "BAG-50", quantityThousandths: 1250, reason: "SO-1042" })).resolves.toEqual({ kind: "pending", reason: "owner approval required" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: "reserveStock", sku: "BAG-50", quantityThousandths: 1250, reason: "SO-1042", intentId: expect.any(String),
    });
  });

  it("releases by reservation ID and rejects malformed success bodies", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { released: true } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(releaseInventoryReservation({ reservationId: "reservation-1" })).resolves.toEqual({ kind: "completed" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ action: "releaseReservation", reservationId: "reservation-1", intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, data: { released: "yes" } })));
    await expect(releaseInventoryReservation({ reservationId: "reservation-1" })).rejects.toBeInstanceOf(InventoryLocationActionError);
  });

  it("explains that network failures have an unknown outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(createInventoryLocation({ code: "WH-A", name: "Warehouse A" })).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("outcome is unknown"),
    });
  });
});

describe("InventoryLocationsReservationsPanel", () => {
  it("creates a location and shows a pending approval without refreshing prematurely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, pendingApproval: true, reason: "manager approval required" }, 202)));
    const onChanged = vi.fn();
    render(<InventoryLocationsReservationsPanel items={items} locations={locations} reservations={reservations} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("Location code"), { target: { value: "wh-b" } });
    fireEvent.change(screen.getByLabelText("Location name"), { target: { value: "Back store" } });
    fireEvent.click(screen.getByRole("button", { name: "Create location" }));
    expect((await screen.findByRole("status")).textContent).toContain("waiting for approval");
    expect(screen.getByRole("status").textContent).toContain("manager approval required");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("ignores a Go write response after the active organization changes", async () => {
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    let resolveWrite: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveWrite = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const props = {
      items,
      locations,
      reservations,
      onChanged,
      retryScope: { actorId: "actor-1", organizationId: "org-1" },
    };
    const { rerender } = render(<InventoryLocationsReservationsPanel {...props} />);
    fireEvent.change(screen.getByLabelText("Location code"), { target: { value: "wh-b" } });
    fireEvent.change(screen.getByLabelText("Location name"), { target: { value: "Back store" } });
    fireEvent.click(screen.getByRole("button", { name: "Create location" }));
    await waitFor(() => expect(resolveWrite).toBeDefined());

    rerender(<InventoryLocationsReservationsPanel {...props} retryScope={{ actorId: "actor-1", organizationId: "org-2" }} />);
    await act(async () => {
      resolveWrite?.(jsonResponse({ ok: true, data: { locationId: "loc-new" } }));
    });

    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("Stock location created.")).toBeNull();
    expect((screen.getByLabelText("Location code") as HTMLInputElement).value).toBe("wh-b");
    expect((screen.getByRole("button", { name: "Create location" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reserves stock with exact thousandths and releases open reservations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { reservationId: "reservation-new", availableAfterThousandths: 8750 } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { released: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<InventoryLocationsReservationsPanel items={items} locations={locations} reservations={reservations} onChanged={onChanged} />);

    fireEvent.change(screen.getByLabelText("Stock item"), { target: { value: "BAG-50" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText("Reason or order reference"), { target: { value: "SO-1043" } });
    fireEvent.click(screen.getByRole("button", { name: "Reserve stock" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ action: "reserveStock", quantityThousandths: 1250, sku: "BAG-50" });

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ action: "releaseReservation", reservationId: "reservation-1" });
  });

  it("rejects fractional precision beyond thousandths before posting", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryLocationsReservationsPanel items={items} locations={locations} reservations={[]} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Stock item"), { target: { value: "BAG-50" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1.0001" } });
    fireEvent.change(screen.getByLabelText("Reason or order reference"), { target: { value: "SO-1043" } });
    expect((screen.getByRole("button", { name: "Reserve stock" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
