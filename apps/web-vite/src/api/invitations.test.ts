import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("Go invitation API", () => {
  it("loads a validated public preview without sending credentials", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      email: "ada@example.test",
      orgName: "Analytical Engines",
      roleName: "Bookkeeper",
      expiresAt: "2026-10-13T10:00:00Z",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { invitationsApi } = await import("./invitations");

    await expect(invitationsApi.preview("invite token")).resolves.toMatchObject({ email: "ada@example.test" });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/invitations/invite%20token", expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    }));
  });

  it("posts acceptance and preserves Go's status and error message", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "Invitation email does not match the signed-in account" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const { invitationsApi } = await import("./invitations");

    await expect(invitationsApi.accept("invite-token")).rejects.toMatchObject({
      name: "InvitationApiError",
      status: 403,
      message: "Invitation email does not match the signed-in account",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/invitations/invite-token", expect.objectContaining({ method: "POST", body: "{}" }));
  });
});
