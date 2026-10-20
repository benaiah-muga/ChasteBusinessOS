import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 20_000,
  },
});
