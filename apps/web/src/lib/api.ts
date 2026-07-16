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
