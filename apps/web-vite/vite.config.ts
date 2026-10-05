import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { createGoRouteProxyPlugin, goRouteProxyFlagsFromEnv } from "./src/api/go-route-proxy.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "CHASTE_");
  const legacyWebOrigin = env.CHASTE_LEGACY_WEB_ORIGIN || "http://localhost:3001";
  const goApiOrigin = env.CHASTE_GO_API_ORIGIN || "http://127.0.0.1:8080";
  const goRouteProxy = createGoRouteProxyPlugin(goRouteProxyFlagsFromEnv(env), goApiOrigin);
  const goInventoryItemSlice = env.CHASTE_GO_INVENTORY_ITEM_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goInventoryImportSlice = env.CHASTE_GO_INVENTORY_IMPORT_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goInventoryCycleCountWrites = env.CHASTE_GO_INVENTORY_CYCLE_COUNT_WRITES === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goPurchasingVendorSlice = env.CHASTE_GO_PURCHASING_VENDOR_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goMarketingSegmentSlice = env.CHASTE_GO_MARKETING_SEGMENT_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goManufacturingDefineBomSlice = env.CHASTE_GO_MANUFACTURING_DEFINE_BOM_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goMessagingSendSlice = env.CHASTE_GO_MESSAGING_SEND_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goPosOpenSessionSlice = env.CHASTE_GO_POS_OPEN_SESSION_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goPosCloseSessionSlice = env.CHASTE_GO_POS_CLOSE_SESSION_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goPosCompleteSaleSlice = env.CHASTE_GO_POS_COMPLETE_SALE_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goPosReturnSaleSlice = env.CHASTE_GO_POS_RETURN_SALE_SLICE === "1" && env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1";
  const goPosShiftSummaryRoute = env.CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE !== "0";

  return {
    plugins: [react(), goRouteProxy],
    define: {
      __LEGACY_WEB_ORIGIN__: JSON.stringify(legacyWebOrigin),
      __GO_INVENTORY_ITEM_SLICE__: JSON.stringify(goInventoryItemSlice),
      __GO_INVENTORY_IMPORT_SLICE__: JSON.stringify(goInventoryImportSlice),
      __GO_INVENTORY_CYCLE_COUNT_WRITES__: JSON.stringify(goInventoryCycleCountWrites),
      __GO_PURCHASING_VENDOR_SLICE__: JSON.stringify(goPurchasingVendorSlice),
      __GO_MARKETING_SEGMENT_SLICE__: JSON.stringify(goMarketingSegmentSlice),
      __GO_MANUFACTURING_DEFINE_BOM_SLICE__: JSON.stringify(goManufacturingDefineBomSlice),
      __GO_MESSAGING_SEND_SLICE__: JSON.stringify(goMessagingSendSlice),
      __GO_POS_OPEN_SESSION_SLICE__: JSON.stringify(goPosOpenSessionSlice),
      __GO_POS_CLOSE_SESSION_SLICE__: JSON.stringify(goPosCloseSessionSlice),
      __GO_POS_COMPLETE_SALE_SLICE__: JSON.stringify(goPosCompleteSaleSlice),
      __GO_POS_RETURN_SALE_SLICE__: JSON.stringify(goPosReturnSaleSlice),
      __GO_POS_SHIFT_SUMMARY_ROUTE__: JSON.stringify(goPosShiftSummaryRoute),
    },
    server: {
      host: "localhost",
      port: 3000,
      strictPort: true,
      proxy: {
        // The catch-all preserves legacy API ownership by default. Specific Go
        // routes are inserted before it only when their Go and Vite flags agree.
        "/api/health": {
          target: goApiOrigin,
        },
        ...(env.CHASTE_GO_SESSION_CAPABILITY_ROUTE === "1" ? {
          "/api/capabilities/execute": { target: goApiOrigin, changeOrigin: false },
        } : {}),
        "/api": {
          target: legacyWebOrigin,
          changeOrigin: false,
        },
      },
    },
  };
});
