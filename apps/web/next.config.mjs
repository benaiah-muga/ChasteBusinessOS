import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@chaste/api-client", "@chaste/ui-schema"],
  // Keep tracing inside this monorepo (avoid parent lockfile confusion)
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
