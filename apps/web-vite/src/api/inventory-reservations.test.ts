import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchInventoryReservations, InventoryReservationsApiError } from "./inventory-reservations";

afterEach(() => vi.unstubAllGlobals());

const organizationId = "0569aacb-58c3-4a30-8afe-3554e38eb2ce";
const reservation = {
  id: "07363742-7f2b-4b18-8f65-6874f17e88e4",
  orgId: organizationId,
  itemId: "39b78356-54ed-4cc0-8d87-30a628740df7",
  sku: "MUG-1",
  quantityThousandths: 1250,
  reason: "SO-1042",
  refType: "sales_order",
  refId: "2e4b0474-d13f-4cc6-af1b-8b548d26b218",
  status: "open",
  createdByActorType: "human",
  createdByActorId: "d574e26a-6c64-419f-921b-909be248f40c",
  releasedAt: null,
  createdAt: "2026-10-14T10:30:00.000Z",
};

describe("Go inventory reservations reader", () => {
  it("loads scoped open reservations through the governed Go capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { reservations: [reservation] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInventoryReservations(organizationId)).resolves.toEqual([{
      id: reservation.id,
      sku: "MUG-1",
      quantityThousandths: 1250,
      reason: "SO-1042",
      status: "open",
      createdAt: reservation.createdAt,
    }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: expect.objectContaining({ "X-Organization-ID": organizationId }),
      body: expect.stringMatching(/"capabilityId":"inventory\.listReservations","input":\{"openOnly":true\}/),
    }));
  });

  it("rejects malformed reads and missing organization scope without fallback", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { reservations: [{ ...reservation, status: "unknown" }] } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { reservations: [{ ...reservation, unexpected: true }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInventoryReservations(organizationId)).rejects.toMatchObject({
      name: "InventoryReservationsApiError",
      status: 200,
      message: "The Go inventory service returned reservations in an unexpected format.",
    });
    await expect(fetchInventoryReservations(organizationId)).rejects.toMatchObject({ status: 200, message: expect.stringContaining("unexpected format") });
    await expect(fetchInventoryReservations(null)).rejects.toBeInstanceOf(InventoryReservationsApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
