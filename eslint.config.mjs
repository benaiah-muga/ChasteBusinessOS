// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/.turbo/**", "**/next-env.d.ts", "packages/db/drizzle/**", "apps/web/public/**"],
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
  // Dependency direction: inner packages never depend on modules or apps.
  {
    files: ["packages/kernel/**/*.ts", "packages/db/**/*.ts", "packages/erp-core/**/*.ts", "packages/ai/**/*.ts", "packages/plugin-kit/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@chaste/module-*", "@/server/*", "apps/*"],
              message: "core packages must not depend on ERP modules or the app layer",
            },
          ],
        },
      ],
    },
  },
  // Modules are independent bounded contexts: no cross-module imports,
  // except HR/POS/purchasing/inventory importing the shared posting service
  // (ADR 0020; inventory added by ADR 0033 for valuation postings).
  // Manufacturing and sales sit outside the restricted lists deliberately:
  // they consume the sanctioned seams (inventory's stock writer and ATP
  // helpers, accounting's invoice writer) as their designed integration
  // surface (ADR 0036 for sales).
  {
    files: ["modules/{crm,messaging,iam,documents,creator}/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@chaste/module-*"],
              message: "modules communicate through capabilities, not direct imports",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["modules/{hr,pos,purchasing,inventory}/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // Exact names so "@chaste/module-accounting/posting" stays allowed.
          paths: [
            "@chaste/module-accounting",
            "@chaste/module-crm",
            "@chaste/module-messaging",
            "@chaste/module-iam",
            "@chaste/module-inventory",
            "@chaste/module-documents",
            "@chaste/module-creator",
            "@chaste/module-pos",
            "@chaste/module-purchasing",
            "@chaste/module-hr",
          ].map((name) => ({
            name,
            message: "the only allowed cross-module import is @chaste/module-accounting/posting",
          })),
        },
      ],
    },
  },
);
