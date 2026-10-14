import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelInventoryTransfer, confirmInventoryTransfer, createInventoryTransfer } from "./inventory-transfers";

const transferId = "40000000-0000-4000-8000-000000000004";
const lineId = "50000000-0000-4000-8000-000000000005";
const retryScope = { actorId: "actor-1", organizationId: "org-1" };

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("inventory transfer API client", () => {
  it("sends create and confirm through Go with declared inputs and separate resolved intents", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { transferId, number: 12, status: "pending" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { transferId, status: "confirmed", confirmedNowThousandths: 1000 } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);

    await expect(createInventoryTransfer({
      fromLocationCode: "MAIN", toLocationCode: "SHOP", sku: "ITEM-1", quantityThousandths: 2500, note: "Move to shop floor",
    }, retryScope)).resolves.toEqual({ kind: "completed" });
    await expect(confirmInventoryTransfer(transferId, retryScope, [{ lineId, quantityThousandths: 1000 }]))
      .resolves.toEqual({ kind: "completed" });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string },
      headers: init?.headers as Record<string, string>,
    }));
    expect(requests.map((request) => request.url)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(requests.map((request) => request.body.capabilityId)).toEqual(["inventory.createTransfer", "inventory.confirmTransfer"]);
    expect(requests[0]?.body.input).toEqual({
      fromLocationCode: "MAIN", toLocationCode: "SHOP", lines: [{ sku: "ITEM-1", quantityThousandths: 2500 }], note: "Move to shop floor",
    });
    expect(requests[1]?.body.input).toEqual({ transferId, lines: [{ lineId, quantityThousandths: 1000 }] });
    expect(requests[0]?.body.intentId).not.toBe(requests[1]?.body.intentId);
    expect(requests.map((request) => request.headers["X-Organization-ID"])).toEqual([retryScope.organizationId, retryScope.organizationId]);
  });

  it("cancels a transfer draft through the governed Go capability and validates its result", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true, data: { cancelled: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cancelInventoryTransfer(transferId, retryScope)).resolves.toEqual({ kind: "completed" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      capabilityId: "inventory.cancelTransfer",
      input: { transferId },
      intentId: expect.any(String),
    });

    const badResponse = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true, data: { cancelled: true, transferId } }));
    vi.stubGlobal("fetch", badResponse);
    await expect(cancelInventoryTransfer(transferId, { ...retryScope, organizationId: "org-2" }))
      .rejects.toThrow("unexpected transfer response");
  });

  it("fails closed when the Go endpoint is unavailable without trying a legacy route", async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(jsonResponse({ error: "route unavailable" }, 404)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createInventoryTransfer({ fromLocationCode: "MAIN", toLocationCode: "SHOP", sku: "ITEM-1", quantityThousandths: 2500 }, retryScope))
      .rejects.toMatchObject({ status: 404 });
    await expect(confirmInventoryTransfer(transferId, { ...retryScope, organizationId: `${retryScope.organizationId}-confirm` }))
      .rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(2).fill("/api/capabilities/execute"));
  });

  it("fails closed for Go when actor or organization scope is unresolved", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);
    await expect(confirmInventoryTransfer(transferId, { actorId: null, organizationId: retryScope.organizationId }))
      .rejects.toThrow("Wait for your account and organization to finish loading");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses a scoped intent through pending approval and clears it after success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, pendingApproval: true, reason: "owner review" }, 202))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { transferId, number: 12, status: "pending" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);
    const input = { fromLocationCode: "MAIN", toLocationCode: "SHOP", sku: "ITEM-1", quantityThousandths: 2500 };

    await expect(createInventoryTransfer(input, retryScope)).resolves.toEqual({ kind: "pending", reason: "owner review" });
    await expect(createInventoryTransfer(input, retryScope)).resolves.toEqual({ kind: "completed" });
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string });
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { transferId, number: 12, status: "pending" } }));
    await expect(createInventoryTransfer(input, retryScope)).resolves.toEqual({ kind: "completed" });
    const resolvedRetry = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { intentId: string };
    expect(resolvedRetry.intentId).not.toBe(bodies[0]?.intentId);
  });

  it("reuses the same intent after an uncertain network result", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { transferId, number: 12, status: "pending" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);
    const input = { fromLocationCode: "MAIN", toLocationCode: "SHOP", sku: "ITEM-1", quantityThousandths: 2500 };

    await expect(createInventoryTransfer(input, retryScope)).rejects.toBeInstanceOf(Error);
    await expect(createInventoryTransfer(input, retryScope)).resolves.toEqual({ kind: "completed" });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const retry = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(retry.intentId).toBe(first.intentId);
  });

  it("preserves malformed nonempty retry markers and refuses to mint another intent", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);
    const invalidMarkers = [
      "{broken",
      JSON.stringify({ fingerprint: "not-a-fingerprint", intentId: transferId }),
      JSON.stringify({ fingerprint: "a".repeat(64), intentId: "not-a-uuid" }),
      JSON.stringify({ fingerprint: "a".repeat(64), intentId: transferId, extra: true }),
    ];

    for (const [index, invalidMarker] of invalidMarkers.entries()) {
      const scope = { actorId: `actor-${index}`, organizationId: `org-${index}` };
      const input = { fromLocationCode: "MAIN", toLocationCode: "SHOP", sku: "ITEM-1", quantityThousandths: 2500 };
      await expect(createInventoryTransfer(input, scope)).rejects.toBeInstanceOf(Error);
      const key = Array.from({ length: localStorage.length }, (_, keyIndex) => localStorage.key(keyIndex))
        .filter((candidate) => candidate?.startsWith("chaste:inventory-transfer-attempt:")).at(-1);
      expect(key).toBeDefined();
      localStorage.setItem(key!, invalidMarker);
      const requestCount = fetchMock.mock.calls.length;

      await expect(createInventoryTransfer(input, scope)).rejects.toThrow("retry marker is malformed");
      expect(fetchMock).toHaveBeenCalledTimes(requestCount);
      expect(localStorage.getItem(key!)).toBe(invalidMarker);
    }
  });

  it("fails closed for a valid pre-route marker even when Go is currently selected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);
    const input = { fromLocationCode: "MAIN", toLocationCode: "SHOP", sku: "ITEM-1", quantityThousandths: 2500 };
    const payload = {
      action: "createTransfer",
      fromLocationCode: input.fromLocationCode,
      toLocationCode: input.toLocationCode,
      lines: [{ sku: input.sku, quantityThousandths: input.quantityThousandths }],
    };
    const digest = async (value: string) => {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const scope = { actorId: retryScope.actorId, organizationId: retryScope.organizationId };
    const storageKey = `chaste:inventory-transfer-attempt:${await digest(JSON.stringify(scope))}`;
    const fingerprint = await digest(JSON.stringify({ ...scope, payload }));
    const oldMarker = JSON.stringify({ fingerprint, intentId: transferId });
    localStorage.setItem(storageKey, oldMarker);

    await expect(createInventoryTransfer(input, retryScope)).rejects.toThrow("has no recorded route");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKey)).toBe(oldMarker);
  });

  it("keeps pending reasons and terminal errors, and rejects malformed success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, pendingApproval: true, reason: "Manager approval required." }, 202))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: "Source location has insufficient stock." }, 422))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);

    const input = { fromLocationCode: "MAIN", toLocationCode: "SHOP", sku: "ITEM-1", quantityThousandths: 2500 };
    await expect(createInventoryTransfer(input, retryScope))
      .resolves.toEqual({ kind: "pending", reason: "Manager approval required." });
    await expect(createInventoryTransfer(input, retryScope)).rejects.toMatchObject({ status: 422, message: "Source location has insufficient stock." });
    await expect(createInventoryTransfer(input, retryScope)).rejects.toThrow("unexpected transfer response");
  });

  it("never falls back from a missing Go route and preserves exact retries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "route missing" }, 404))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { transferId, number: 12, status: "pending" } }))
      .mockResolvedValueOnce(jsonResponse({ error: "route missing" }, 404))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { transferId, status: "confirmed", confirmedNowThousandths: 1000 } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { fromLocationCode: "MAIN", toLocationCode: "SHOP", sku: "ITEM-1", quantityThousandths: 2500 };

    await expect(createInventoryTransfer(input, retryScope)).rejects.toMatchObject({ status: 404, message: "route missing" });
    await expect(createInventoryTransfer(input, retryScope)).resolves.toEqual({ kind: "completed" });

    await expect(confirmInventoryTransfer(transferId, retryScope, [{ lineId, quantityThousandths: 1000 }]))
      .rejects.toMatchObject({ status: 404, message: "route missing" });
    await expect(confirmInventoryTransfer(transferId, retryScope, [{ lineId, quantityThousandths: 1000 }]))
      .resolves.toEqual({ kind: "completed" });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string },
    }));
    expect(requests.map(({ url }) => url)).toEqual(Array(4).fill("/api/capabilities/execute"));
    expect(requests.map(({ body }) => body.capabilityId)).toEqual([
      "inventory.createTransfer", "inventory.createTransfer", "inventory.confirmTransfer", "inventory.confirmTransfer",
    ]);
    expect(requests[1]?.body.intentId).toBe(requests[0]?.body.intentId);
    expect(requests[3]?.body.intentId).toBe(requests[2]?.body.intentId);
    expect(requests[2]?.body.intentId).not.toBe(requests[0]?.body.intentId);
  });

  it("warns about unknown outcomes when a transfer request times out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("Timed out", "TimeoutError"); }));
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);
    await expect(confirmInventoryTransfer(transferId, retryScope)).rejects.toThrow("Check transfer history before retrying");
  });
});
