/** @type {import('next').NextConfig} */
const nextConfig = {
  // Cache Components (ADR 0028): routes validate for instant navigation;
  // segments not yet converted opt out via `export const instant = false`.
  cacheComponents: true,
  // Build hosts can expose dozens of cores (Render's builder reported 48);
  // Next sizes its page-data worker pool from `cpu count - 1` (DefaultServerConfig
  // in config-shared), and 47 workers importing the full capability kernel blew
  // the build container's memory on Render. Cap workers so any CI host builds
  // within 8 GB instead of parallelizing into an OOM.
  experimental: { cpus: 4 },
  transpilePackages: ["@chaste/kernel", "@chaste/db", "@chaste/ai"],
  serverExternalPackages: ["postgres"],
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
