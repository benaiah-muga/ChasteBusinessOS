import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __LEGACY_WEB_ORIGIN__: JSON.stringify("http://localhost:3001"),
  },
  test: {
    environment: "jsdom",
    clearMocks: true,
    restoreMocks: true,
  },
});
