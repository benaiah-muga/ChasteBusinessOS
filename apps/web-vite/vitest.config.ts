import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
  },
  test: {
    environment: "jsdom",
    clearMocks: true,
    restoreMocks: true,
  },
});
