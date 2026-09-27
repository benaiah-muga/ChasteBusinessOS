const legacyDevelopmentOrigin = "http://localhost:3001";

export function authTrustedOrigins(input: { appUrl: string; isDevelopment: boolean }): string[] {
  const origins = new Set([input.appUrl]);
  if (input.isDevelopment) origins.add(legacyDevelopmentOrigin);
  return [...origins];
}
