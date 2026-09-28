import { describe, expect, it } from "vitest";
import { goCapabilityRouteResponse } from "./go-route-response";

const unavailableMessage = "service unavailable; check status before retrying";

describe("Go capability route response", () => {
  it("preserves success, approval, and validation responses without cache", async () => {
    const success = await goCapabilityRouteResponse({ kind: "response", response: Response.json({ ok: true, data: { saved: true } }) }, unavailableMessage);
    expect(success.status).toBe(200);
    expect(success.headers.get("cache-control")).toBe("no-store");
    expect(await success.json()).toEqual({ ok: true, data: { saved: true } });

    const pending = await goCapabilityRouteResponse({ kind: "response", response: Response.json({ ok: false, pendingApproval: true, reason: "Owner approval required" }, { status: 202 }) }, unavailableMessage);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ ok: false, pendingApproval: true, reason: "Owner approval required" });

    const invalid = await goCapabilityRouteResponse({ kind: "response", response: Response.json({ ok: false, error: "not eligible" }, { status: 422 }) }, unavailableMessage);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ ok: false, error: "not eligible" });
  });

  it.each([
    { kind: "not-dispatched" as const },
    { kind: "outcome-unknown" as const },
    { kind: "response" as const, response: Response.json({ ok: true }, { status: 200 }) },
  ])("fails closed for invalid Go result $kind", async (result) => {
    const response = await goCapabilityRouteResponse(result, unavailableMessage);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: unavailableMessage });
  });
});
