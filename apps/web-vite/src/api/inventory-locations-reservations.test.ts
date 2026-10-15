import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInventoryLocation,
  InventoryLocationActionError,
  releaseInventoryReservation,
  reserveInventoryStock,
} from "./inventory-locations-reservations";

const reservationId = "40000000-0000-4000-8000-000000000004";
let retryScope = { actorId: "", organizationId: "" };

beforeEach(() => {
  const suffix = crypto.randomUUID();
  retryScope = { actorId: `actor-${suffix}`, organizationId: `org-${suffix}` };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

    await expect(createInventoryLocation({ code: "MAIN", name: "Main warehouse" }, retryScope)).resolves.toEqual({ kind: "completed" });
    await expect(reserveInventoryStock({ sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" }, retryScope)).resolves.toEqual({ kind: "completed" });
    await expect(releaseInventoryReservation({ reservationId }, retryScope)).resolves.toEqual({ kind: "completed" });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string },
      headers: init?.headers as Record<string, string>,
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
    expect(requests.map((request) => request.headers["X-Organization-ID"])).toEqual([retryScope.organizationId, retryScope.organizationId, retryScope.organizationId]);
    expect(new Set(requests.map(({ body }) => body.intentId)).size).toBe(3);
  });

  it("does not try legacy writes when the Go endpoint is unavailable", async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(Response.json({ error: "route unavailable" }, { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createInventoryLocation({ code: "MAIN", name: "Main warehouse" }, retryScope))
      .rejects.toMatchObject({ status: 404 });
    await expect(reserveInventoryStock({ sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" }, { ...retryScope, organizationId: `${retryScope.organizationId}-reserve` }))
      .rejects.toMatchObject({ status: 404 });
    await expect(releaseInventoryReservation({ reservationId }, { ...retryScope, organizationId: `${retryScope.organizationId}-release` }))
      .rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(3).fill("/api/capabilities/execute"));
  });

  it("keeps a create-location intent after malformed success and retries the identical request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { locationId: reservationId, unexpected: true } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { locationId: reservationId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createInventoryLocation({ code: "MAIN", name: "Main warehouse" }, retryScope))
      .rejects.toThrow("unexpected result");
    await expect(createInventoryLocation({ code: "MAIN", name: "Main warehouse" }, retryScope))
      .resolves.toEqual({ kind: "completed" });

    const attempts = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { capabilityId: string; input: unknown; intentId: string });
    expect(attempts[1]).toMatchObject({ capabilityId: attempts[0]?.capabilityId, input: attempts[0]?.input, intentId: attempts[0]?.intentId });
  });

  it("blocks a different action while a Go result is unresolved in the same scope", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reserveInventoryStock({ sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" }, retryScope))
      .rejects.toBeInstanceOf(InventoryLocationActionError);
    const saved = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "");
    expect(saved.some((key) => key.includes(":scope:"))).toBe(true);

    await expect(createInventoryLocation({ code: "MAIN", name: "Main warehouse" }, retryScope))
      .rejects.toThrow("A Go inventory action is unresolved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved.every((key) => localStorage.getItem(key) !== null)).toBe(true);
  });

  it("requires the scope marker to persist before saving an action marker", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.includes(":scope:")) throw new DOMException("storage unavailable", "QuotaExceededError");
      originalSetItem.call(this, key, value);
    });

    await expect(reserveInventoryStock({ sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" }, retryScope))
      .rejects.toThrow("Inventory retry markers could not be saved");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    setItemSpy.mockRestore();
  });

  it("blocks changed-action rollback when a later scope-marker write fails after an uncertain attempt", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    const input = { sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" };
    await expect(reserveInventoryStock(input, retryScope)).rejects.toBeInstanceOf(InventoryLocationActionError);

    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.includes(":scope:")) throw new DOMException("storage unavailable", "QuotaExceededError");
      originalSetItem.call(this, key, value);
    });
    await expect(reserveInventoryStock(input, retryScope)).rejects.toThrow("Inventory retry markers could not be saved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setItemSpy.mockRestore();

    await expect(createInventoryLocation({ code: "MAIN", name: "Main warehouse" }, retryScope))
      .rejects.toThrow("A Go inventory action is unresolved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks scope-less writes after a scoped Go marker is saved", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reserveInventoryStock({ sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" }, retryScope))
      .rejects.toBeInstanceOf(InventoryLocationActionError);
    expect(localStorage.length).toBeGreaterThan(0);

    vi.resetModules();
    const reloaded = await import("./inventory-locations-reservations");
    await expect(reloaded.createInventoryLocation({ code: "MAIN", name: "Main warehouse" }))
      .rejects.toThrow("Wait for your account and organization");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an invalid saved intent UUID without replacing the marker", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    const input = { sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" };
    await expect(reserveInventoryStock(input, retryScope)).rejects.toBeInstanceOf(InventoryLocationActionError);
    const actionKey = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "")
      .find((key) => key.startsWith("chaste.inventory-location-reservation.intent.v1:") && !key.includes(":scope:"));
    expect(actionKey).toBeDefined();
    localStorage.setItem(actionKey!, "not-a-uuid");
    const activeKey = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "")
      .find((key) => key.includes(":scope:"));
    const activeBefore = localStorage.getItem(activeKey!);

    await expect(reserveInventoryStock(input, retryScope)).rejects.toThrow("retry marker is malformed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(actionKey!)).toBe("not-a-uuid");
    expect(localStorage.getItem(activeKey!)).toBe(activeBefore);
  });

  it("fails closed on rollback when a scoped marker has an invalid stored UUID", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    const input = { sku: "ITEM-1", quantityThousandths: 500, reason: "Order allocation" };
    await expect(reserveInventoryStock(input, retryScope)).rejects.toBeInstanceOf(InventoryLocationActionError);
    const actionKey = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "")
      .find((key) => key.startsWith("chaste.inventory-location-reservation.intent.v1:") && !key.includes(":scope:"));
    expect(actionKey).toBeDefined();
    localStorage.setItem(actionKey!, "not-a-uuid");
    await expect(reserveInventoryStock(input, retryScope)).rejects.toThrow("retry marker is malformed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(actionKey!)).toBe("not-a-uuid");
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
    expect(keys).toHaveLength(6);
    expect(keys.every((key) => key.startsWith("chaste.inventory-location-reservation.intent.v1:"))).toBe(true);
    expect(keys.join(" ")).not.toContain(retryScope.actorId);
    expect(keys.join(" ")).not.toContain(retryScope.organizationId);
    expect(keys.join(" ")).not.toContain("Private allocation note");
  });

  it("fails before Go writes when actor or organization retry scope is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    const input = { sku: "ITEM-2", quantityThousandths: 1000, reason: "Retry requires scope" };

    await expect(reserveInventoryStock(input)).rejects.toThrow("Wait for your account and organization");
    await expect(reserveInventoryStock(input, { actorId: retryScope.actorId, organizationId: " " }))
      .rejects.toThrow("Wait for your account and organization");
    await expect(reserveInventoryStock(input, { actorId: " ", organizationId: retryScope.organizationId }))
      .rejects.toThrow("Wait for your account and organization");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
});
