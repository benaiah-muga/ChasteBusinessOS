import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInventoryLocation,
  InventoryLocationActionError,
  releaseInventoryReservation,
  reserveInventoryStock,
} from "./inventory-locations-reservations";

const reservationId = "40000000-0000-4000-8000-000000000004";
const retryScope = {
  actorId: "10000000-0000-4000-8000-000000000001",
  organizationId: "20000000-0000-4000-8000-000000000002",
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("inventory location and reservation API client", () => {
  it("sends all three actions through their Go capabilities with declared inputs", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      ok: true,
      data: { locationId: reservationId },
    }));
    fetchMock
      .mockResolvedValueOnce(Response.json({ ok: true, data: { locationId: reservationId } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { reservationId, availableAfterThousandths: 2500 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { released: true } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);

    await expect(createInventoryLocation({ code: "MAIN", name: "Main warehouse" })).resolves.toEqual({ kind: "completed" });
    await expect(reserveInventoryStock({ sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" })).resolves.toEqual({ kind: "completed" });
    await expect(releaseInventoryReservation({ reservationId })).resolves.toEqual({ kind: "completed" });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string },
    }));
    expect(requests.map(({ url }) => url)).toEqual(Array(3).fill("/api/capabilities/execute"));
    expect(requests.map(({ body }) => body.capabilityId)).toEqual([
      "inventory.createLocation",
      "inventory.reserveStock",
      "inventory.releaseReservation",
    ]);
    expect(requests.map(({ body }) => body.input)).toEqual([
      { code: "MAIN", name: "Main warehouse" },
      { sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" },
      { reservationId },
    ]);
    expect(new Set(requests.map(({ body }) => body.intentId)).size).toBe(3);
  });

  it("keeps the legacy inventory action route when disabled and creates a fresh intent per action", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, data: { locationId: reservationId } }));
    fetchMock
      .mockResolvedValueOnce(Response.json({ ok: true, data: { locationId: reservationId } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { reservationId, availableAfterThousandths: 2500 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { released: true } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", false);

    await createInventoryLocation({ code: "MAIN", name: "Main warehouse" });
    await reserveInventoryStock({ sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" });
    await releaseInventoryReservation({ reservationId });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));
    expect(requests.map(({ url }) => url)).toEqual(Array(3).fill("/api/inventory"));
    expect(requests.map(({ body }) => body.action)).toEqual(["createLocation", "reserveStock", "releaseReservation"]);
    expect(new Set(requests.map(({ body }) => body.intentId)).size).toBe(3);
  });

  it("reuses an unresolved Go intent for identical payloads and clears it after success", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { reservationId, availableAfterThousandths: 2500 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { reservationId, availableAfterThousandths: 2500 } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    const input = { sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" };

    await expect(reserveInventoryStock(input, retryScope)).rejects.toBeInstanceOf(InventoryLocationActionError);
    await reserveInventoryStock(input, retryScope);
    await reserveInventoryStock(input, retryScope);

    const intentIds = fetchMock.mock.calls.map(([, init]) =>
      (JSON.parse(String(init?.body)) as { intentId: string }).intentId,
    );
    expect(intentIds[0]).toBe(intentIds[1]);
    expect(intentIds[2]).not.toBe(intentIds[1]);
  });

  it("keeps an approval intent through pending retries and preserves approval reasons and errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        pendingApproval: true,
        reason: "Manager approval required.",
        approvalId: reservationId,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        pendingApproval: true,
        reason: "Manager approval required.",
        approvalId: reservationId,
      }), { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { reservationId, availableAfterThousandths: 2500 } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "Reservation is already closed." }), { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);

    const input = { sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" };
    await expect(reserveInventoryStock(input, retryScope))
      .resolves.toEqual({ kind: "pending", reason: "Manager approval required." });
    await expect(reserveInventoryStock(input, retryScope))
      .resolves.toEqual({ kind: "pending", reason: "Manager approval required." });
    await reserveInventoryStock(input, retryScope);
    await expect(releaseInventoryReservation({ reservationId }, retryScope)).rejects.toMatchObject({
      name: "InventoryLocationActionError",
      status: 422,
      message: "Reservation is already closed.",
    });
    const intentIds = fetchMock.mock.calls.slice(0, 3).map(([, init]) =>
      (JSON.parse(String(init?.body)) as { intentId: string }).intentId,
    );
    expect(new Set(intentIds).size).toBe(1);
  });

  it("isolates persisted retries by actor and organization without exposing scope or payload in the storage key", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockRejectedValueOnce(new TypeError("connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    const input = { sku: "ITEM-1", quantityThousandths: 500, reason: "Private allocation note" };

    await expect(reserveInventoryStock(input, retryScope)).rejects.toBeInstanceOf(InventoryLocationActionError);
    await expect(reserveInventoryStock(input, { ...retryScope, actorId: "30000000-0000-4000-8000-000000000003" }))
      .rejects.toBeInstanceOf(InventoryLocationActionError);
    await expect(reserveInventoryStock(input, { ...retryScope, organizationId: "30000000-0000-4000-8000-000000000003" }))
      .rejects.toBeInstanceOf(InventoryLocationActionError);

    const intentIds = fetchMock.mock.calls.map(([, init]) =>
      (JSON.parse(String(init?.body)) as { intentId: string }).intentId,
    );
    expect(intentIds[0]).not.toBe(intentIds[1]);
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "");
    expect(keys).toHaveLength(3);
    expect(keys.every((key) => key.startsWith("chaste.inventory-location-reservation.intent.v1:"))).toBe(true);
    expect(keys.join(" ")).not.toContain(retryScope.actorId);
    expect(keys.join(" ")).not.toContain(retryScope.organizationId);
    expect(keys.join(" ")).not.toContain("Private allocation note");
  });

  it("keeps retry identity in memory only when actor or organization scope is unavailable", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockRejectedValueOnce(new TypeError("connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    const input = { sku: "ITEM-2", quantityThousandths: 1000, reason: "Retry without scope" };

    await expect(reserveInventoryStock(input)).rejects.toBeInstanceOf(InventoryLocationActionError);
    await expect(reserveInventoryStock(input)).rejects.toBeInstanceOf(InventoryLocationActionError);

    const intentIds = fetchMock.mock.calls.map(([, init]) =>
      (JSON.parse(String(init?.body)) as { intentId: string }).intentId,
    );
    expect(intentIds[0]).toBe(intentIds[1]);
    expect(localStorage.length).toBe(0);
  });
});
