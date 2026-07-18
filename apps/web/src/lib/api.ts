import { createChasteApiClient } from "@chaste/api-client";

/**
 * Browser and server components use HTTP only.
 * Never import @chaste/kernel, @chaste/db, or modules here.
 */
export function getApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  }
  return process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
}

export function getApiClient() {
  return createChasteApiClient({
    baseUrl: getApiBaseUrl(),
  });
}

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(path, getApiBaseUrl()).toString(), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { message?: string }).message ?? res.statusText);
  }
  return body as T;
}
