import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTeam, submitTeamAction, TeamApiError } from "./team";

const teamData = {
  members: [{ userId: "user-1", name: "Ada Lovelace", email: "ada@example.com", roleKeys: ["owner"] }],
  roles: [{ id: "role-1", key: "bookkeeper", name: "Bookkeeper", isSystem: false, permissions: ["accounting.read"] }],
  catalog: ["accounting.read", "accounting.write"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Vite team API", () => {
  it("validates the existing team response and uses the authenticated same-origin session", async () => {
    const fetchMock = vi.fn(async () => Response.json(teamData));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTeam()).resolves.toEqual(teamData);
    expect(fetchMock).toHaveBeenCalledWith("/api/team", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("rejects malformed team data and maps authentication failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ members: [], roles: [] })));
    await expect(fetchTeam()).rejects.toMatchObject({
      name: "TeamApiError",
      message: "The team service returned data in an unexpected format.",
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })));
    await expect(fetchTeam()).rejects.toMatchObject({
      status: 401,
      message: "Your session has ended. Sign in again to continue.",
    });
  });

  it("submits the existing invite action with an intent id and preserves the returned token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { token: "invite-token" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitTeamAction({ action: "invite", email: "new@example.com", roleId: "role-1" }, "intent-1"))
      .resolves.toEqual({ kind: "completed", data: { token: "invite-token" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/team", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ action: "invite", email: "new@example.com", roleId: "role-1", intentId: "intent-1" }),
    }));
  });

  it("keeps approval-required identity actions pending without treating them as errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, pendingApproval: true, reason: "approval required" }, { status: 202 })));

    await expect(submitTeamAction({ action: "assignRole", userId: "user-1", roleId: "role-1" }, "intent-2"))
      .resolves.toEqual({ kind: "pending", reason: "approval required" });
  });

  it("rejects invalid actions, malformed approval responses, and server refusals", async () => {
    await expect(submitTeamAction({ action: "createRole", key: "Bad Key", name: "Bad" } as never, "intent-3"))
      .rejects.toBeInstanceOf(TeamApiError);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(submitTeamAction({ action: "setPermissions", roleId: "role-1", permissions: ["accounting.read"] }, "intent-4"))
      .rejects.toMatchObject({ status: 202, message: "The team service returned an unexpected approval response." });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "Role is protected" }, { status: 422 })));
    await expect(submitTeamAction({ action: "setPermissions", roleId: "role-1", permissions: ["accounting.read"] }, "intent-5"))
      .rejects.toMatchObject({ status: 422, message: "Role is protected" });
  });
});
