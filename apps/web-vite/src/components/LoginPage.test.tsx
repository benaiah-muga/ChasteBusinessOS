import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { dashboardFixture, myWorkFixture, setupFixture } from "../test/dashboard-fixture";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
}));

vi.mock("../api/auth", () => ({
  authClient: {
    getSession: authMocks.getSession,
    signIn: { email: authMocks.signInEmail },
    signUp: { email: authMocks.signUpEmail },
  },
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/login");
  authMocks.getSession.mockResolvedValue({ data: { user: null } });
  authMocks.signInEmail.mockResolvedValue({ data: { token: "session-token" }, error: null });
  authMocks.signUpEmail.mockResolvedValue({ data: { token: null, user: { id: "user-id" } }, error: null });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    if (path === "/api/dashboard") return Response.json(dashboardFixture);
    if (path === "/api/setup") return Response.json({ items: setupFixture, remaining: 1 });
    if (path === "/api/my-work") return Response.json({ cards: myWorkFixture, generatedAt: "2026-09-27T10:15:00.000Z" });
    if (path === "/api/org") return Response.json({
      activeOrgId: "62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12",
      orgs: [{ id: "62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12", name: "First workspace", baseCurrency: "USD" }],
    });
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Vite login route", () => {
  it("redirects an existing session into the app route", async () => {
    authMocks.getSession.mockResolvedValue({ data: { user: { id: "user-id", name: "Ada Lovelace", email: "ada@example.test" } } });

    render(<App />);

    expect(await screen.findByRole("region", { name: "Financial pulse" })).not.toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  it("signs in with email and navigates after Better Auth returns a session", async () => {
    authMocks.getSession.mockResolvedValueOnce({ data: { user: null } }).mockResolvedValue({
      data: { user: { id: "user-id", name: "Ada Lovelace", email: "ada@example.test" } },
    });
    render(<App />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as HTMLFormElement);

    expect(authMocks.signInEmail).toHaveBeenCalledWith({ email: "ada@example.test", password: "long-password" });
    expect(await screen.findByRole("region", { name: "Financial pulse" })).not.toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  it("keeps a new account on the verification-sent screen when auto sign-in is skipped", async () => {
    render(<App />);
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
    });
    expect(await screen.findByRole("heading", { name: "Check your inbox." })).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("ada@example.test");
    expect(window.location.pathname).toBe("/login");
  });

  it("shows the existing credential error copy and returns from verification to sign-in", async () => {
    authMocks.signInEmail.mockResolvedValue({ data: null, error: { message: "invalid credentials" } });
    render(<App />);

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
});
