import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InvitationPage } from "./InvitationPage";
import { authClient } from "../api/auth";
import { invitationsApi } from "../api/invitations";

vi.mock("../api/auth", () => ({
  authClient: {
    getSession: vi.fn(),
    signOut: vi.fn(),
  },
}));
vi.mock("../api/invitations", () => ({
  InvitationApiError: class InvitationApiError extends Error { constructor(readonly status: number, message: string) { super(message); } },
  invitationsApi: { preview: vi.fn(), accept: vi.fn() },
}));

const preview = {
  email: "ada@example.test",
  orgName: "Analytical Engines",
  roleName: "Bookkeeper",
  expiresAt: "2026-10-13T10:00:00Z",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("InvitationPage", () => {
  it("shows invitation details and returns to the invite after sign-in", async () => {
    vi.mocked(invitationsApi.preview).mockResolvedValue(preview);
    vi.mocked(authClient.getSession).mockResolvedValue({ data: null, error: null });
    window.history.replaceState(null, "", "/invite/opaque-token?source=email");

    render(<InvitationPage pathname="/invite/opaque-token" />);

    expect(await screen.findByText("Analytical Engines")).toBeTruthy();
    expect(screen.getByText("Bookkeeper")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in to accept" }).getAttribute("href"))
      .toBe("/login?returnTo=%2Finvite%2Fopaque-token%3Fsource%3Demail");
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
  });

  it("accepts only for a verified matching account and waits for Go success", async () => {
    vi.mocked(invitationsApi.preview).mockResolvedValue(preview);
    vi.mocked(authClient.getSession).mockResolvedValue({ data: {
      user: { id: "user-1", email: "ADA@example.test", emailVerified: true },
      session: { id: "session-1", userId: "user-1", expiresAt: "2026-10-14T10:00:00Z" },
    }, error: null });
    vi.mocked(invitationsApi.accept).mockResolvedValue({ ok: true });

    render(<InvitationPage pathname="/invite/opaque-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText("Your invitation was accepted. Continue to your workspace.")).toBeTruthy();
    expect(invitationsApi.accept).toHaveBeenCalledWith("opaque-token");
  });

  it("does not offer acceptance to mismatched or unverified sessions", async () => {
    vi.mocked(invitationsApi.preview).mockResolvedValue(preview);
    vi.mocked(authClient.getSession).mockResolvedValue({ data: {
      user: { id: "user-1", email: "grace@example.test", emailVerified: false },
      session: { id: "session-1", userId: "user-1", expiresAt: "2026-10-14T10:00:00Z" },
    }, error: null });

    const view = render(<InvitationPage pathname="/invite/opaque-token" />);
    expect(await screen.findByText(/this invitation is for/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
    expect(invitationsApi.accept).not.toHaveBeenCalled();

    view.unmount();
    vi.mocked(authClient.getSession).mockResolvedValue({ data: {
      user: { id: "user-1", email: "ada@example.test", emailVerified: false },
      session: { id: "session-1", userId: "user-1", expiresAt: "2026-10-14T10:00:00Z" },
    }, error: null });
    render(<InvitationPage pathname="/invite/opaque-token" />);
    expect(await screen.findByText(/verify/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
    expect(invitationsApi.accept).not.toHaveBeenCalled();
  });
});
