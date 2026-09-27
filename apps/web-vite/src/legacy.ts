export function legacyUrl(path: string): string {
  const safePath = path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : "/";
  const origin = import.meta.env.DEV ? __LEGACY_WEB_ORIGIN__ : window.location.origin;
  return new URL(safePath, origin).toString();
}

export function redirectToLegacy(path: string): void {
  if (import.meta.env.DEV) window.location.replace(legacyUrl(path));
}
