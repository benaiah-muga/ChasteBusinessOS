import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// F21 — security headers. connect-src includes the API origin so the browser
// can reach it; API_URL/NEXT_PUBLIC_API_URL are the deployment origins.
const apiOrigin = (
  process.env.API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3001"
).replace(/\/$/, "");

// Next dev compiles with eval-source-map devtool, which needs 'unsafe-eval'
// to execute modules under CSP. Production builds ship real bundles and keep
// the strict policy (no unsafe-eval).
const isDev = process.env.NODE_ENV === "development";
const scriptSrc = `'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`;

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@chaste/api-client", "@chaste/ui-schema"],
  // Keep tracing inside this monorepo (avoid parent lockfile confusion)
  outputFileTracingRoot: path.join(__dirname, "../.."),
  async headers() {
    return [
      {
        // Apply to all routes.
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next.js injects inline bootstrap scripts/styles; a strict nonce
              // scheme is tracked as follow-up (F11/F21 hardening).
              `script-src ${scriptSrc}`,
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              `font-src 'self' https://fonts.gstatic.com`,
              "img-src 'self' data: blob:",
              `connect-src 'self' ${apiOrigin} https://fonts.googleapis.com https://fonts.gstatic.com`,
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // Only meaningful over HTTPS; harmless otherwise.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
