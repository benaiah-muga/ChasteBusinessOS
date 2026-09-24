import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const skipDevMigrations =
  process.env.NODE_ENV === "development" && process.env.AUTO_MIGRATE_ON_BOOT !== "1";
const migrationImport = "@chaste/db/migrate";
const migrationTarget = skipDevMigrations
  ? fileURLToPath(new URL("./src/noop-migrations.ts", import.meta.url))
  : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Docker image ships Next's traced standalone server and only the
  // runtime files it needs, rather than the full workspace node_modules.
  output: "standalone",
  // Cache Components (ADR 0028): routes validate for instant navigation;
  // segments not yet converted opt out via `export const instant = false`.
  cacheComponents: true,
  transpilePackages: ["@chaste/kernel", "@chaste/db", "@chaste/ai"],
  serverExternalPackages: ["postgres"],
  ...(migrationTarget
    ? {
        turbopack: { resolveAlias: { [migrationImport]: "./apps/web/src/noop-migrations.ts" } },
        webpack(config) {
          config.resolve.alias[migrationImport] = migrationTarget;
          return config;
        },
      }
    : {}),
  async headers() {
    // Baseline hardening for every response. Next's App Router needs
    // 'unsafe-inline'/'unsafe-eval' for its hydration and dev runtime;
    // tightening to nonces requires middleware-level work and is tracked
    // separately. frame-ancestors + XFO kill clickjacking today.
    const securityHeaders = [
      {
        key: "Content-Security-Policy",
        value: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "form-action 'self'",
          "base-uri 'self'",
          "object-src 'none'",
        ].join("; "),
      },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      {
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      },
    ];
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
