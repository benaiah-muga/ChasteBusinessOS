import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    passWithNoTests: true,
    // Match the module suites. Without these, the default 10s hook timeout
    // expires while a fixture database is provisioned and migrated under
    // parallel load, which is how the RLS sweep used to fail.
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
});
