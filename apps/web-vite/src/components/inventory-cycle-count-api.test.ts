import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupInventoryBarcode, submitInventoryCycleCountAction } from "../api/inventory-cycle-count";

afterEach(() => vi.unstubAllGlobals());

describe("inventory cycle count API", () => {
  it("submits governed cycle count actions to the same-origin BFF", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { countId: "count-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitInventoryCycleCountAction({ action: "createCycleCount", note: "Monthly audit", skus: ["MUG-1"], locationId: "loc-1" })).resolves.toEqual({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
    }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "createCycleCount", note: "Monthly audit", skus: ["MUG-1"], locationId: "loc-1" });
    expect(body.intentId).toEqual(expect.any(String));
  });

  it("distinguishes approval-pending responses and rejects malformed approvals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, pendingApproval: true, reason: "Needs a manager" }, { status: 202 })));
    await expect(submitInventoryCycleCountAction({ action: "cancelCycleCount", countId: "count-1" })).resolves.toEqual({ kind: "pending" });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(submitInventoryCycleCountAction({ action: "cancelCycleCount", countId: "count-1" })).rejects.toThrow("unexpected approval response");
  });

  it("surfaces BFF errors and rejects unexpected 2xx responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "count is already posted" }), { status: 422 })));
    await expect(submitInventoryCycleCountAction({ action: "postCycleCount", countId: "count-1" })).rejects.toThrow("count is already posted");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    await expect(submitInventoryCycleCountAction({ action: "postCycleCount", countId: "count-1" })).rejects.toThrow("unexpected action response");
  });

  it("returns a matched barcode item or an explicit null", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { item: { sku: "MUG-1", name: "Ceramic mug", tags: [] } } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(lookupInventoryBarcode("MUG-CODE")).resolves.toEqual({ sku: "MUG-1", name: "Ceramic mug" });
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.objectContaining({ body: JSON.stringify({ action: "lookupByBarcode", barcode: "MUG-CODE" }) }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { item: null } })));
    await expect(lookupInventoryBarcode("UNKNOWN-CODE")).resolves.toBeNull();
  });

  it("reports mutation timeouts as unknown outcomes that must be reconciled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("Timed out", "TimeoutError"); }));
    await expect(submitInventoryCycleCountAction({ action: "postCycleCount", countId: "count-1" }))
      .rejects.toThrow("Check count history before retrying");
  });
});
