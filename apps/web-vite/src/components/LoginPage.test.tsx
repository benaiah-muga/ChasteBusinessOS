import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  sendVerificationEmail: vi.fn(),
  requestPasswordReset: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../api/auth", () => ({
  authClient: {
    getSession: authMocks.getSession,
    signIn: { email: authMocks.signInEmail },
    signUp: { email: authMocks.signUpEmail },
    sendVerificationEmail: authMocks.sendVerificationEmail,
    requestPasswordReset: authMocks.requestPasswordReset,
  },
}));

vi.mock("../navigation", () => ({ navigate: authMocks.navigate }));

beforeEach(() => {
  authMocks.getSession.mockResolvedValue({ data: { user: null } });
    authMocks.signInEmail.mockResolvedValue({ data: { token: null }, error: null });
  authMocks.signUpEmail.mockResolvedValue({ data: { token: null, user: { id: "user-id" } }, error: null });
  authMocks.sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null });
  authMocks.requestPasswordReset.mockResolvedValue({ data: { status: true, message: "If an account exists, a reset link was sent." }, error: null });
  authMocks.navigate.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Vite login page", () => {
  it("redirects an existing Go auth session into the app", async () => {
    authMocks.getSession.mockResolvedValue({ data: { user: { id: "user-id", name: "Ada Lovelace", email: "ada@example.test" } } });

    render(<LoginPage />);

    await waitFor(() => expect(authMocks.navigate).toHaveBeenCalledWith("/", true));
  });

  it("signs in with email and navigates after Go auth returns a session", async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as HTMLFormElement);

    expect(authMocks.signInEmail).toHaveBeenCalledWith({ email: "ada@example.test", password: "long-password" });
    await waitFor(() => expect(authMocks.navigate).toHaveBeenCalledWith("/", true));
  });

  it("keeps the generic Go sign-up response on a noncommittal verification screen", async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    const password = screen.getByLabelText("Password");
    fireEvent.change(password, { target: { value: "long-password" } });
    expect(password.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.getAttribute("type")).toBe("text");
    expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form") as HTMLFormElement);

    expect(authMocks.signUpEmail).toHaveBeenCalledWith({
      email: "ada@example.test",
      password: "long-password",
      name: "Ada Lovelace",
      callbackURL: "/login?verified=1",
    });
    expect(await screen.findByRole("heading", { name: "Check your inbox." })).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("ada@example.test");
    expect(screen.getByRole("status").textContent).toContain("If you created a new account");
    expect(screen.getByRole("status").textContent).toContain("If you already have an account");
    expect(screen.getByRole("status").textContent).not.toContain("We sent a verification link");
    expect(authMocks.navigate).not.toHaveBeenCalled();
  });

  it("shows the credential error and returns from verification to sign-in", async () => {
    authMocks.signInEmail.mockResolvedValue({ data: null, error: { message: "invalid credentials" } });
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as HTMLFormElement);
    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("That email and password did not match.");

    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    authMocks.signUpEmail.mockResolvedValue({ data: { token: null, user: { id: "user-id" } }, error: null });
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form") as HTMLFormElement);
    await screen.findByRole("heading", { name: "Check your inbox." });
    fireEvent.click(screen.getByRole("button", { name: /Back to sign in/ }));
    expect(await screen.findByRole("heading", { name: "Good to see you." })).not.toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password"));
  });

  it("explains that Go auth sent a fresh verification link for an unverified account", async () => {
    authMocks.signInEmail.mockResolvedValue({ data: null, error: { message: "Email not verified" } });
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as HTMLFormElement);

    expect(await screen.findByRole("heading", { name: "Check your inbox." })).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("That email isn't verified yet. We just sent a fresh link");
    expect(authMocks.sendVerificationEmail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
    await waitFor(() => expect(authMocks.sendVerificationEmail).toHaveBeenCalledWith("ada@example.test"));
    expect(await screen.findByText("If this account still needs verification, check your inbox for a new link.")).not.toBeNull();
  });

  it("clears an old resend notice before handling another unverified account", async () => {
    authMocks.signInEmail.mockResolvedValue({ data: null, error: { message: "Email not verified" } });
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as HTMLFormElement);
    await screen.findByRole("heading", { name: "Check your inbox." });
    fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
    await screen.findByText("If this account still needs verification, check your inbox for a new link.");

    fireEvent.click(screen.getByRole("button", { name: /Back to sign in/ }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "grace@example.test" } });
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as HTMLFormElement);

    await screen.findByRole("heading", { name: "Check your inbox." });
    expect(screen.queryByText("If this account still needs verification, check your inbox for a new link.")).toBeNull();
    expect(screen.getByRole("button", { name: "Resend verification email" })).not.toBeNull();
  });

  it("requests password recovery without revealing whether the address is registered", async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(authMocks.requestPasswordReset).toHaveBeenCalledWith("ada@example.test");
    expect(await screen.findByRole("status")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain("If the address has an account");
  });

  it("shows a verification-complete notice after Go redirects back", () => {
    window.history.replaceState(null, "", "/login?verified=1");
    render(<LoginPage />);
    expect(screen.getByRole("status").textContent).toContain("Email verified");
    window.history.replaceState(null, "", "/login");
  });
});
