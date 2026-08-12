import { createChasteApiClient } from "@chaste/api-client";

/**
 * Browser and server components use HTTP only.
 * Never import @chaste/kernel, @chaste/db, or modules here.
 */

const TOKEN_STORAGE_KEY = "chaste.auth.token";

/** The raw invite/onboarding token is the Bearer credential. */
export function getStoredAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage?.getItem(TOKEN_STORAGE_KEY) ?? null;
}

export function setStoredAuthToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token === null) {
    window.localStorage?.removeItem(TOKEN_STORAGE_KEY);
  } else {
    window.localStorage?.setItem(TOKEN_STORAGE_KEY, token);
  }
}

export function getApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  }
  return process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
}

/**
 * Attach the stored auth token as `Authorization: Bearer <token>` on every
 * request. The API preHandler resolves the acting user from this token
 * (ARCH-1). In production, missing tokens are rejected with 401; the
 * anonymous bootstrap-admin fallback is a dev-only flag (F1 remediation).
 */
function getAuthHeaders(): Record<string, string> {
  const token = getStoredAuthToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function getApiClient() {
  return createChasteApiClient({
    baseUrl: getApiBaseUrl(),
    getHeaders: getAuthHeaders,
  });
}

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(path, getApiBaseUrl()).toString(), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...getAuthHeaders(),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    code?: string;
  };
  if (!res.ok) {
    // F15 — a 401 means the stored credential is invalid/expired; drop it so
    // the UI falls back to login instead of silently acting as no one.
    if (res.status === 401) {
      setStoredAuthToken(null);
    }
    const detail = body.message ?? res.statusText;
    const code = body.code ? ` (${body.code})` : "";
    throw new Error(`${detail}${code}`);
  }
  return body as T;
}
