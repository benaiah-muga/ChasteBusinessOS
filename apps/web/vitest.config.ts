import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/", import.meta.url)),
    },
  },
  // tsconfig sets `jsx: "preserve"` so Next can compile it; tests need it built.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globalSetup: ["./vitest.global-setup.ts"],
    testTimeout: 20_000,
    // 18 files share one fixture database per run; under parallel load a
    // beforeAll can legitimately exceed the 10s default (products.test.ts).
    hookTimeout: 30_000,
  },
});
