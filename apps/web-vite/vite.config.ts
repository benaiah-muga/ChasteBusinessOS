import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { createGoRouteProxyPlugin, goProjectsWritesFromEnv, goPurchasingPaymentRunsFromEnv, goRouteProxyFlagsFromEnv } from "./src/api/go-route-proxy.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL("../..", import.meta.url)), ["CHASTE_", "GO_"]);
  const goApiOrigin = env.CHASTE_GO_API_ORIGIN || "http://127.0.0.1:8080";
  const goRouteProxy = createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv(env), goApiOrigin);
  const goInventoryItemSlice = env.CHASTE_GO_INVENTORY_ITEM_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goProjectsWrites = goProjectsWritesFromEnv(env);
  const goPurchasingPaymentRuns = goPurchasingPaymentRunsFromEnv(env);

  return {
    plugins: [react(), goRouteProxy],
    define: {
      __GO_INVENTORY_ITEM_SLICE__: JSON.stringify(goInventoryItemSlice),
      __GO_PROJECTS_WRITES__: JSON.stringify(goProjectsWrites),
      __GO_PURCHASING_PAYMENT_RUNS__: JSON.stringify(goPurchasingPaymentRuns),
    },
    server: {
      host: "localhost",
      port: 3000,
      strictPort: true,
      proxy: {
        // Unclaimed API routes stay on Go, where missing handlers return 404.
        // Vite does not send API traffic to the compatibility app.
        "/api/health": {
          target: goApiOrigin,
        },
        "/api/capabilities/execute": { target: goApiOrigin, changeOrigin: false },
        "/api": {
          target: goApiOrigin,
          changeOrigin: false,
        },
      },
    },
  };
});
