import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamPage } from "./TeamPage";

const fixture = {
  members: [
    { userId: "owner-1", name: "Ada Lovelace", email: "ada@example.com", roleKeys: ["owner"] },
    { userId: "member-1", name: "Grace Hopper", email: "grace@example.com", roleKeys: ["bookkeeper"] },
  ],
  roles: [
    { id: "role-owner", key: "owner", name: "Owner", isSystem: true, permissions: ["*"] },
    { id: "role-bookkeeper", key: "bookkeeper", name: "Bookkeeper", isSystem: false, permissions: ["accounting.read"] },
  ],
  catalog: ["accounting.read", "accounting.write", "iam.read"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Vite team page", () => {
  it("loads members and roles, and protects system roles from permission editing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(fixture));
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamPage />);

    expect(screen.getByRole("status").textContent).toContain("Loading team and roles");
    expect(await screen.findByRole("heading", { name: "Team & roles" })).not.toBeNull();
    expect(screen.getByText("Ada Lovelace")).not.toBeNull();
    expect(screen.getByText("Grace Hopper")).not.toBeNull();
    expect(screen.getByText("all powers")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/team", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("assigns a role through the governed API and keeps a 202 action in the approvals state", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ ok: false, pendingApproval: true, reason: "identity approval required" }, 202);
      return jsonResponse(fixture);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamPage />);
    await screen.findByRole("heading", { name: "Team & roles" });

    fireEvent.change(screen.getByRole("combobox", { name: "Change role for Grace Hopper" }), { target: { value: "role-owner" } });

    expect(await screen.findByText("Role assignment needs human approval, check the Approvals inbox.")).not.toBeNull();
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({ action: "assignRole", userId: "member-1", roleId: "role-owner" });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("creates an invite, shows the acceptance URL, and clears the invite fields", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ ok: true, data: { token: "invite-abc" } });
      return jsonResponse(fixture);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamPage />);
    await screen.findByRole("heading", { name: "Team & roles" });

    fireEvent.change(screen.getByLabelText("Invite email address"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Role for invite"), { target: { value: "role-bookkeeper" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    expect(await screen.findByText("Invite created for new@example.com. Share this link:")).not.toBeNull();
    expect(screen.getByRole("link", { name: `${window.location.origin}/invite/invite-abc` })).not.toBeNull();
    await waitFor(() => expect((screen.getByLabelText("Invite email address") as HTMLInputElement).value).toBe(""));
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({ action: "invite", email: "new@example.com", roleId: "role-bookkeeper" });
  });

  it("saves edited permissions and reports a governed action refusal", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ ok: false, error: "Role is protected" }, 422);
      return jsonResponse(fixture);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamPage />);
    await screen.findByRole("heading", { name: "Team & roles" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText("accounting.write"));
    fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Role is protected");
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      action: "setPermissions",
      roleId: "role-bookkeeper",
      permissions: ["accounting.read", "accounting.write"],
    });
  });

  it("normalizes custom role keys", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ ok: true, data: { roleId: "role-reporter" } });
      return jsonResponse(fixture);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamPage />);
    await screen.findByRole("heading", { name: "Team & roles" });

    fireEvent.change(screen.getByLabelText("New role"), { target: { value: "Finance & Reporting" } });
    fireEvent.click(screen.getByRole("button", { name: "＋ Create" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({ action: "createRole", key: "finance-reporting", name: "Finance & Reporting" });
  });

  it("shows a recoverable access error and reloads when asked", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse(fixture));
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamPage />);

    expect(await screen.findByRole("heading", { name: "Could not load team and roles" })).not.toBeNull();
    expect(screen.getByText("You do not have permission to view or change team roles.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Team & roles" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
