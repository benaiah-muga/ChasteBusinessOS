import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CapturedRequest = { path: string; method: string; body: unknown; credentials: RequestCredentials | undefined; cache: RequestCache | undefined };

function pathnameOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return new URL(input, window.location.origin).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

describe("Go auth browser client", () => {
  let requests: CapturedRequest[];

  beforeEach(async () => {
    vi.resetModules();
    requests = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      requests.push({
        path: pathnameOf(input),
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        body,
        credentials: init?.credentials,
        cache: init?.cache,
      });
      if (pathnameOf(input).endsWith("/sign-up/email")) {
        return Response.json({ token: null, user: { id: "user-id", email: "ada@example.test", name: "Ada Lovelace" } });
      }
      if (pathnameOf(input).endsWith("/sign-in/email")) {
        return Response.json({ token: null, user: { id: "user-id", email: "ada@example.test", name: "Ada Lovelace" } });
      }
      if (pathnameOf(input).endsWith("/sign-out")) return Response.json({ success: true });
      if (pathnameOf(input).endsWith("/send-verification-email") || pathnameOf(input).endsWith("/reset-password")) return Response.json({ status: true });
      if (pathnameOf(input).endsWith("/request-password-reset")) return Response.json({ status: true, message: "If an account exists, a reset link was sent." });
      return Response.json(null);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Go's session endpoint and accepts its signed-out response", async () => {
    const { authClient } = await import("./auth");
    const result = await authClient.getSession();

    expect(result.data).toBeNull();
    expect(requests).toEqual([{ path: "/api/auth/get-session", method: "GET", body: null, credentials: "same-origin", cache: "no-store" }]);
  });

  it("accepts the Go session response shape for an authenticated browser session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      user: {
        id: "user-id",
        name: "Ada Lovelace",
        email: "ada@example.test",
        emailVerified: true,
        image: null,
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-02T10:00:00Z",
      },
      session: {
        id: "session-id",
        userId: "user-id",
        expiresAt: "2026-09-09T10:00:00Z",
        createdAt: "2026-09-02T10:00:00Z",
        updatedAt: "2026-09-02T10:00:00Z",
      },
    })));
    const { authClient } = await import("./auth");

    const result = await authClient.getSession();

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      user: { id: "user-id", name: "Ada Lovelace", email: "ada@example.test" },
      session: { id: "session-id", userId: "user-id", expiresAt: "2026-09-09T10:00:00Z" },
    });
  });

  it("uses Go email sign-in with the submitted credentials", async () => {
    const { authClient } = await import("./auth");
    const result = await authClient.signIn.email({ email: "ada@example.test", password: "long-password" });

    expect(result.data?.user.email).toBe("ada@example.test");
    expect(requests).toEqual([{
      path: "/api/auth/sign-in/email",
      method: "POST",
      body: { email: "ada@example.test", password: "long-password" },
      credentials: "same-origin",
      cache: "no-store",
    }]);
  });

  it("uses Go email sign-up and preserves its pending-verification response", async () => {
    const { authClient } = await import("./auth");
    const result = await authClient.signUp.email({
      email: "ada@example.test",
      password: "long-password",
      name: "Ada Lovelace",
    });

    expect(result.data?.token).toBeNull();
    expect(requests).toEqual([{
      path: "/api/auth/sign-up/email",
      method: "POST",
      body: { email: "ada@example.test", password: "long-password", name: "Ada Lovelace" },
      credentials: "same-origin",
      cache: "no-store",
    }]);
  });

  it("revokes the Go session on sign out", async () => {
    const { authClient } = await import("./auth");
    const result = await authClient.signOut();

    expect(result.data?.success).toBe(true);
    expect(requests).toEqual([{ path: "/api/auth/sign-out", method: "POST", body: {}, credentials: "same-origin", cache: "no-store" }]);
  });

  it("uses Go verification and recovery routes with no-store same-origin requests", async () => {
    const { authClient } = await import("./auth");
    const sendResult = await authClient.sendVerificationEmail("ada@example.test");
    const requestResult = await authClient.requestPasswordReset("ada@example.test");
    const resetResult = await authClient.resetPassword("secret-reset-token", "new-password");

    expect(sendResult.data?.status).toBe(true);
    expect(requestResult.data?.status).toBe(true);
    expect(resetResult.data?.status).toBe(true);
    expect(requests).toEqual([
      { path: "/api/auth/send-verification-email", method: "POST", body: { email: "ada@example.test", callbackURL: "/login?verified=1" }, credentials: "same-origin", cache: "no-store" },
      { path: "/api/auth/request-password-reset", method: "POST", body: { email: "ada@example.test", redirectTo: "/reset-password" }, credentials: "same-origin", cache: "no-store" },
      { path: "/api/auth/reset-password", method: "POST", body: { token: "secret-reset-token", newPassword: "new-password" }, credentials: "same-origin", cache: "no-store" },
    ]);
  });

  it("returns the Go error message for rejected credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { message: "Invalid email or password" },
      { status: 401 },
    )));
    const { authClient } = await import("./auth");

    await expect(authClient.signIn.email({ email: "ada@example.test", password: "wrong-password" }))
      .resolves.toEqual({ data: null, error: { message: "Invalid email or password" } });
  });

  it("rejects malformed successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: null, user: { id: "user-id" } })));
    const { authClient } = await import("./auth");

    await expect(authClient.signIn.email({ email: "ada@example.test", password: "long-password" }))
      .resolves.toEqual({ data: null, error: { message: "The Go authentication service returned an unexpected response" } });
  });

  it("surfaces network failures for the login UI to catch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network unavailable"); }));
    const { authClient } = await import("./auth");

    await expect(authClient.getSession()).rejects.toThrow("Could not reach the Go authentication service");
  });
});
