import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "CHASTE_");
  const legacyWebOrigin = env.CHASTE_LEGACY_WEB_ORIGIN || "http://localhost:3001";

  return {
    plugins: [react()],
    define: {
      __LEGACY_WEB_ORIGIN__: JSON.stringify(legacyWebOrigin),
    },
    server: {
      host: "localhost",
      port: 3000,
      strictPort: true,
      proxy: {
        "/api/auth": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/health": {
          target: "http://127.0.0.1:8080",
        },
        "/api/org": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/approvals": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/ledger": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/sessions": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/durable-runs": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/metrics": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/modules": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/projects": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/team": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/analytics": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/dashboard": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/setup": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/my-work/summarize": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
        "/api/my-work": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
      },
    },
  };
});
