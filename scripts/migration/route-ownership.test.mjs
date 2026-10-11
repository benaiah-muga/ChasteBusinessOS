import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  allowsPendingAuthOwner,
  allowsPendingGoOrgPersonaOwner,
  allowsPendingGoMemoryCollectionOwner,
  allowsPendingGoModuleSettingsOwner,
  allowsPendingGoRoutineCollectionOwner,
} from "./route-ownership-policy.mjs";

const manifest = JSON.parse(readFileSync("docs/migration/route-ownership.json", "utf8"));
const overrides = JSON.parse(readFileSync("docs/migration/route-ownership-overrides.json", "utf8"));

test("Go-owned auth namespace stays distinct from pending Better Auth parity", () => {
  const authRoutes = manifest.entries.filter(
    (entry) => entry.kind === "api" && entry.path === "/api/auth/[...all]",
  );

  assert.deepEqual(
    authRoutes.map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "GET", owner: "auth", parity: "pending" },
      { method: "POST", owner: "auth", parity: "pending" },
    ],
  );
});

test("pending auth ownership is limited to the Better Auth catch-all", () => {
  assert.equal(allowsPendingAuthOwner("api", "/api/auth/[...all]", "auth", "pending"), true);
  assert.equal(allowsPendingAuthOwner("api", "/api/analytics", "auth", "pending"), false);
  assert.equal(allowsPendingAuthOwner("page", "/api/auth/[...all]", "auth", "pending"), false);
});

test("pending Go persona ownership is limited to exact organization PUT and PATCH overrides", () => {
  for (const method of ["PUT", "PATCH"]) {
    assert.equal(allowsPendingGoOrgPersonaOwner("api", "/api/org", method, "go", "pending"), true);
  }

  for (const candidate of [
    ["page", "/api/org", "PUT", "go", "pending"],
    ["api", "/api/org/extra", "PUT", "go", "pending"],
    ["api", "/api/org", "GET", "go", "pending"],
    ["api", "/api/org", "DELETE", "go", "pending"],
    ["api", "/api/org", "PATCH", "legacy", "pending"],
    ["api", "/api/org", "PATCH", "go", "verified"],
  ]) {
    assert.equal(allowsPendingGoOrgPersonaOwner(...candidate), false, JSON.stringify(candidate));
  }
});

test("pending Go routine ownership is limited to exact collection GET and POST overrides", () => {
  for (const method of ["GET", "POST"]) {
    assert.equal(allowsPendingGoRoutineCollectionOwner("api", "/api/routines", method, "go", "pending"), true);
  }

  for (const candidate of [
    ["page", "/api/routines", "GET", "go", "pending"],
    ["api", "/api/routines/extra", "GET", "go", "pending"],
    ["api", "/api/routines", "PUT", "go", "pending"],
    ["api", "/api/routines", "DELETE", "go", "pending"],
    ["api", "/api/routines", "POST", "legacy", "pending"],
    ["api", "/api/routines", "GET", "go", "verified"],
  ]) {
    assert.equal(allowsPendingGoRoutineCollectionOwner(...candidate), false, JSON.stringify(candidate));
  }
});

test("pending Go memory ownership is limited to exact collection GET and POST overrides", () => {
  for (const method of ["GET", "POST"]) {
    assert.equal(allowsPendingGoMemoryCollectionOwner("api", "/api/memory", method, "go", "pending"), true);
  }

  for (const candidate of [
    ["page", "/api/memory", "GET", "go", "pending"],
    ["api", "/api/memory/extra", "GET", "go", "pending"],
    ["api", "/api/memory", "PUT", "go", "pending"],
    ["api", "/api/memory", "DELETE", "go", "pending"],
    ["api", "/api/memory", "POST", "legacy", "pending"],
    ["api", "/api/memory", "GET", "go", "verified"],
  ]) {
    assert.equal(allowsPendingGoMemoryCollectionOwner(...candidate), false, JSON.stringify(candidate));
  }
});

test("pending Go module settings ownership is limited to exact collection GET and POST overrides", () => {
  for (const method of ["GET", "POST"]) {
    assert.equal(allowsPendingGoModuleSettingsOwner("api", "/api/module-settings", method, "go", "pending"), true);
  }
  for (const candidate of [
    ["page", "/api/module-settings", "GET", "go", "pending"],
    ["api", "/api/module-settings/extra", "GET", "go", "pending"],
    ["api", "/api/module-settings", "PUT", "go", "pending"],
    ["api", "/api/module-settings", "DELETE", "go", "pending"],
    ["api", "/api/module-settings", "POST", "legacy", "pending"],
    ["api", "/api/module-settings", "GET", "go", "verified"],
  ]) {
    assert.equal(allowsPendingGoModuleSettingsOwner(...candidate), false, JSON.stringify(candidate));
  }
});

test("generated Go route declarations still require verified parity", () => {
  assert.ok(overrides.goRoutes.length > 0);
  assert.ok(overrides.goRoutes.every((route) => route.kind === "api" && route.owner === "go" && route.parity === "verified"));
});

test("organization persona manifest ownership stays Go with parity pending", () => {
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.kind === "api" && entry.path === "/api/org" && ["PUT", "PATCH"].includes(entry.method))
      .map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "PUT", owner: "go", parity: "pending" },
      { method: "PATCH", owner: "go", parity: "pending" },
    ],
  );
});

test("routine collection manifest ownership stays Go with parity pending", () => {
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.kind === "api" && entry.path === "/api/routines")
      .map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "GET", owner: "go", parity: "pending" },
      { method: "POST", owner: "go", parity: "pending" },
    ],
  );
});

test("memory collection manifest ownership stays Go with parity pending", () => {
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.kind === "api" && entry.path === "/api/memory")
      .map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "GET", owner: "go", parity: "pending" },
      { method: "POST", owner: "go", parity: "pending" },
    ],
  );
});

test("module settings collection manifest ownership stays Go with parity pending", () => {
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.kind === "api" && entry.path === "/api/module-settings")
      .map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "GET", owner: "go", parity: "pending" },
      { method: "POST", owner: "go", parity: "pending" },
    ],
  );
});

test("Go-only POS customer lookup has exact generated ownership", () => {
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.path === "/api/pos/customers"),
    [{
      kind: "api",
      path: "/api/pos/customers",
      method: "GET",
      source: "apps/api/internal/httpapi/pos_customers_session.go",
      owner: "go",
      parity: "verified",
    }],
  );
});

test("Go-only POS shift summary has exact generated ownership", () => {
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.path === "/api/pos/shift-summary"),
    [{
      kind: "api",
      path: "/api/pos/shift-summary",
      method: "POST",
      source: "apps/api/internal/httpapi/pos_shift_summary_session.go",
      owner: "go",
      parity: "verified",
    }],
  );
});

test("approvals inbox and decisions have verified Go ownership", () => {
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.path === "/api/approvals"),
    [
      {
        kind: "api",
        path: "/api/approvals",
        method: "GET",
        source: "apps/web/src/app/api/approvals/route.ts",
        owner: "go",
        parity: "verified",
      },
      {
        kind: "api",
        path: "/api/approvals",
        method: "POST",
        source: "apps/web/src/app/api/approvals/route.ts",
        owner: "go",
        parity: "verified",
      },
    ],
  );
});

test("POS page has verified Vite ownership after the authenticated browser flow", () => {
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.kind === "page" && entry.path === "/pos"),
    [{
      kind: "page",
      path: "/pos",
      source: "apps/web/src/app/(app)/pos/page.tsx",
      owner: "vite",
      parity: "verified",
    }],
  );
});

test("approvals page has verified Vite ownership after the authenticated decision flow", () => {
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.kind === "page" && entry.path === "/approvals"),
    [{
      kind: "page",
      path: "/approvals",
      source: "apps/web/src/app/(app)/approvals/page.tsx",
      owner: "vite",
      parity: "verified",
    }],
  );
});

test("CRM reads have verified Go ownership after the authenticated Vite browser proof", () => {
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.kind === "api" && entry.path === "/api/crm"),
    [
      {
        kind: "api",
        path: "/api/crm",
        method: "GET",
        source: "apps/web/src/app/api/crm/route.ts",
        owner: "go",
        parity: "verified",
      },
      {
        kind: "api",
        path: "/api/crm",
        method: "POST",
        source: "apps/web/src/app/api/crm/route.ts",
        owner: "legacy",
        parity: "pending",
      },
    ],
  );
});

test("CRM page has verified Vite ownership after the authenticated runtime proof", () => {
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.kind === "page" && entry.path === "/crm"),
    [{
      kind: "page",
      path: "/crm",
      source: "apps/web/src/app/(app)/crm/page.tsx",
      owner: "vite",
      parity: "verified",
    }],
  );
});
