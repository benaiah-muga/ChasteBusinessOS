export function isGoSetupRequest(method?: string, url?: string): boolean {
  return method === "GET" && /^\/api\/setup(?:\?.*)?$/.test(url ?? "");
}
