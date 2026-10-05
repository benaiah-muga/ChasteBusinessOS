import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordResetPage } from "./PasswordResetPage";

const authMocks = vi.hoisted(() => ({ resetPassword: vi.fn(), navigate: vi.fn() }));

vi.mock("../api/auth", () => ({ authClient: { resetPassword: authMocks.resetPassword } }));
vi.mock("../navigation", () => ({ navigate: authMocks.navigate }));

beforeEach(() => {
  window.history.replaceState(null, "", "/reset-password?token=one-time-secret");
  authMocks.resetPassword.mockResolvedValue({ data: { status: true }, error: null });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
});

describe("Vite password reset page", () => {
  it("removes the one-time token from browser history and submits it only to Go", async () => {
    render(<PasswordResetPage />);
    expect(window.location.pathname + window.location.search).toBe("/reset-password");
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-new-long-password" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a-new-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() => expect(authMocks.resetPassword).toHaveBeenCalledWith("one-time-secret", "a-new-long-password"));
    expect(await screen.findByRole("status")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to sign in" }));
    expect(authMocks.navigate).toHaveBeenCalledWith("/login", true);
  });

  it("blocks mismatched passwords before making an auth request", async () => {
    render(<PasswordResetPage />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-new-long-password" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(authMocks.resetPassword).not.toHaveBeenCalled();
  });

  it("shows a safe expired-link state without retaining a token in the URL", () => {
    window.history.replaceState(null, "", "/reset-password?error=INVALID_TOKEN");
    render(<PasswordResetPage />);

    expect(screen.getByRole("heading", { name: "This link has expired." })).not.toBeNull();
    expect(window.location.pathname + window.location.search).toBe("/reset-password");
  });
});
