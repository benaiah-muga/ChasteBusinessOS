// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Tool state (.kilo, .codebuddy worktrees) mirrors the repo and is not project code.
    ignores: ["**/node_modules/**", "**/dist/**", "**/.turbo/**", "packages/db/drizzle/**", ".kilo/**", ".codebuddy/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Explicit any is a hole in the contract system agents rely on.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "no-console": [
        "warn",
        { allow: ["warn", "error", "info"] },
      ],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "object-shorthand": ["error", "always"],
    },
  },
  // ── architectural boundaries ────────────────────────────────────────────
  // Dependency direction: inner packages never depend on the app layer.
  {
    files: ["packages/db/**/*.ts", "packages/erp-core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/*", "apps/*"],
              message: "core packages must not depend on the app layer",
            },
          ],
        },
      ],
    },
  },
);
