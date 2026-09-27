import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchOrganizations,
  OrganizationApiError,
  switchActiveOrganization,
} from "./organizations";

const firstOrgId = "62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12";
const secondOrgId = "21e89f2b-996f-4b18-9078-c0f2f743a5ab";

afterEach(() => vi.unstubAllGlobals());

describe("organization API client", () => {
  it("validates the organization list and sends the same-origin session cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      activeOrgId: firstOrgId,
      orgs: [
        { id: firstOrgId, name: "First workspace" },
        { id: secondOrgId, name: "Second workspace" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchOrganizations();

    expect(result).toEqual({
      activeOrgId: firstOrgId,
      orgs: [
        { id: firstOrgId, name: "First workspace" },
        { id: secondOrgId, name: "Second workspace" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/org", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: expect.any(AbortSignal),
    }));
  });

  it("rejects malformed organization data before rendering it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      activeOrgId: "not-a-uuid",
      orgs: [{ id: firstOrgId, name: "First workspace" }],
    })));

    await expect(fetchOrganizations()).rejects.toMatchObject({
      name: "OrganizationApiError",
      message: "The organization service returned an invalid response.",
    });
  });

  it("posts the requested organization and accepts only the legacy success shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(switchActiveOrganization(secondOrgId)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith("/api/org", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ orgId: secondOrgId }),
      signal: expect.any(AbortSignal),
    }));
  });

  it("validates each member workspace currency so the dashboard can format the selected org", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      activeOrgId: secondOrgId,
      orgs: [
        { id: firstOrgId, name: "First workspace", baseCurrency: "USD" },
        { id: secondOrgId, name: "Second workspace", baseCurrency: "UGX" },
      ],
    })));

    await expect(fetchOrganizations()).resolves.toMatchObject({
      activeOrgId: secondOrgId,
      orgs: [
        { id: firstOrgId, baseCurrency: "USD" },
        { id: secondOrgId, baseCurrency: "UGX" },
      ],
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      activeOrgId: secondOrgId,
      orgs: [{ id: secondOrgId, name: "Second workspace", baseCurrency: "US" }],
    })));
    await expect(fetchOrganizations()).rejects.toMatchObject({
      name: "OrganizationApiError",
      message: "The organization service returned an invalid response.",
    });
  });

  it("surfaces membership rejection without claiming the organization switched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

    await expect(switchActiveOrganization(secondOrgId)).rejects.toEqual(
      new OrganizationApiError(403, "Your account or organization access needs attention."),
    );
  });
});
