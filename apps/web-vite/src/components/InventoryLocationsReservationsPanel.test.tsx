import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const locations: InventoryLocation[] = [{ id: "07363742-7f2b-4b18-8f65-6874f17e88e4", code: "MAIN", name: "Main warehouse" }];
const reservations: InventoryReservation[] = [{
  id: "07363742-7f2b-4b18-8f65-6874f17e88e4", sku: "BAG-50", quantityThousandths: 2500, reason: "SO-1042", status: "open", createdAt: "2026-10-01T00:00:00Z",
}];
let retryScope = { actorId: crypto.randomUUID(), organizationId: crypto.randomUUID() };

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

beforeEach(() => {
  retryScope = { actorId: crypto.randomUUID(), organizationId: crypto.randomUUID() };
  vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
});

describe("inventory location and reservation API", () => {
  it("posts location creation with a fresh intent ID and validates the capability response", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { locationId: "f7d59a13-6a75-4e16-a38f-2c6067fdca83" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createInventoryLocation({ code: "WH-A", name: "Warehouse A" }, retryScope)).resolves.toEqual({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal) }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ capabilityId: "inventory.createLocation", input: { code: "WH-A", name: "Warehouse A" }, intentId: expect.any(String) });
  });

  it("posts reservation in integer thousandths and reports approval pending", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: false, pendingApproval: true, reason: "owner approval required" }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reserveInventoryStock({ sku: "BAG-50", quantityThousandths: 1250, reason: "SO-1042" }, retryScope)).resolves.toEqual({ kind: "pending", reason: "owner approval required" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "inventory.reserveStock", input: { sku: "BAG-50", quantityThousandths: 1250, reason: "SO-1042" }, intentId: expect.any(String),
    });
  });

  it("releases by reservation ID and rejects malformed success bodies", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { released: true } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(releaseInventoryReservation({ reservationId: "reservation-1" }, retryScope)).resolves.toEqual({ kind: "completed" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "inventory.releaseReservation", input: { reservationId: "reservation-1" }, intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, data: { released: "yes" } })));
    await expect(releaseInventoryReservation({ reservationId: "reservation-1" }, retryScope)).rejects.toBeInstanceOf(InventoryLocationActionError);
  });

  it("explains that network failures have an unknown outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(createInventoryLocation({ code: "WH-A", name: "Warehouse A" }, retryScope)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("outcome is unknown"),
    });
  });
});

describe("InventoryLocationsReservationsPanel", () => {
  it("creates a location and shows a pending approval without refreshing prematurely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, pendingApproval: true, reason: "manager approval required" }, 202)));
    const onChanged = vi.fn();
    render(<InventoryLocationsReservationsPanel items={items} locations={locations} reservations={reservations} onChanged={onChanged} retryScope={retryScope} />);
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
      retryScope,
    };
    const { rerender } = render(<InventoryLocationsReservationsPanel {...props} />);
    fireEvent.change(screen.getByLabelText("Location code"), { target: { value: "wh-b" } });
    fireEvent.change(screen.getByLabelText("Location name"), { target: { value: "Back store" } });
    fireEvent.click(screen.getByRole("button", { name: "Create location" }));
    await waitFor(() => expect(resolveWrite).toBeDefined());

    rerender(<InventoryLocationsReservationsPanel {...props} retryScope={{ actorId: retryScope.actorId, organizationId: crypto.randomUUID() }} />);
    await act(async () => {
      resolveWrite?.(jsonResponse({ ok: true, data: { locationId: "f7d59a13-6a75-4e16-a38f-2c6067fdca83" } }));
    });

    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("Stock location created.")).toBeNull();
    expect((screen.getByLabelText("Location code") as HTMLInputElement).value).toBe("wh-b");
    expect((screen.getByRole("button", { name: "Create location" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides cached reservations and ignores a late read when the actor changes within the same organization", async () => {
    const organizationId = "0569aacb-58c3-4a30-8afe-3554e38eb2ce";
    const firstActor = "d574e26a-6c64-419f-921b-909be248f40c";
    const secondActor = "f418d421-cd7d-4fd5-8c3c-2d2f63702943";
    const makeRow = (reason: string) => ({
      id: "07363742-7f2b-4b18-8f65-6874f17e88e4",
      orgId: organizationId,
      itemId: "39b78356-54ed-4cc0-8d87-30a628740df7",
      sku: "BAG-50",
      quantityThousandths: 1250,
      reason,
      refType: null,
      refId: null,
      status: "open",
      createdByActorType: "human",
      createdByActorId: firstActor,
      releasedAt: null,
      createdAt: "2026-10-14T10:30:00.000Z",
    });
    let reservationReads = 0;
    const pendingReads: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { capabilityId: string };
      if (payload.capabilityId === "inventory.listReservations") {
        reservationReads += 1;
        if (reservationReads === 1) return jsonResponse({ ok: true, data: { reservations: [makeRow("Prior actor hold")] } });
        return new Promise<Response>((resolve) => { pendingReads.push(resolve); });
      }
      if (payload.capabilityId === "inventory.reserveStock") {
        return jsonResponse({ ok: true, data: { reservationId: "f7d59a13-6a75-4e16-a38f-2c6067fdca83", availableAfterThousandths: 8750 } });
      }
      throw new Error(`Unexpected capability: ${payload.capabilityId}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const props = {
      items,
      locations,
      reservations: [],
      organizationId,
      onChanged,
      retryScope: { actorId: firstActor, organizationId },
    };
    const { rerender } = render(<InventoryLocationsReservationsPanel {...props} />);
    expect(await screen.findByText(/Prior actor hold/)).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Stock item"), { target: { value: "BAG-50" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText("Reason or order reference"), { target: { value: "SO-1044" } });
    fireEvent.click(screen.getByRole("button", { name: "Reserve stock" }));
    await waitFor(() => expect(reservationReads).toBe(2));

    rerender(<InventoryLocationsReservationsPanel {...props} retryScope={{ actorId: secondActor, organizationId }} />);
    expect(screen.queryByText(/Prior actor hold/)).toBeNull();
    await waitFor(() => expect(reservationReads).toBe(3));

    await act(async () => {
      pendingReads[0]?.(jsonResponse({ ok: true, data: { reservations: [makeRow("Late prior actor hold")] } }));
    });
    expect(screen.queryByText(/Prior actor hold|Late prior actor hold/)).toBeNull();

    await act(async () => {
      pendingReads[1]?.(jsonResponse({ ok: true, data: { reservations: [makeRow("Current actor hold")] } }));
    });
    expect(await screen.findByText(/Current actor hold/)).not.toBeNull();
    expect(screen.queryByText(/Prior actor hold|Late prior actor hold/)).toBeNull();
  });

  it("reserves stock with exact thousandths and releases open reservations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { reservationId: "f7d59a13-6a75-4e16-a38f-2c6067fdca83", availableAfterThousandths: 8750 } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { released: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<InventoryLocationsReservationsPanel
      items={items}
      locations={locations}
      reservations={reservations}
      onChanged={onChanged}
      retryScope={retryScope}
    />);

    fireEvent.change(screen.getByLabelText("Stock item"), { target: { value: "BAG-50" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText("Reason or order reference"), { target: { value: "SO-1043" } });
    fireEvent.click(screen.getByRole("button", { name: "Reserve stock" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "inventory.reserveStock", input: { quantityThousandths: 1250, sku: "BAG-50" } });

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ capabilityId: "inventory.releaseReservation", input: { reservationId: reservations[0]!.id } });
  });

  it("rejects fractional precision beyond thousandths before posting", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryLocationsReservationsPanel items={items} locations={locations} reservations={[]} onChanged={vi.fn()} retryScope={retryScope} />);
    fireEvent.change(screen.getByLabelText("Stock item"), { target: { value: "BAG-50" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1.0001" } });
    fireEvent.change(screen.getByLabelText("Reason or order reference"), { target: { value: "SO-1043" } });
    expect((screen.getByRole("button", { name: "Reserve stock" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
