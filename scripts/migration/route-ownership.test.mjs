import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allowsPendingAuthOwner } from "./route-ownership-policy.mjs";

const manifest = JSON.parse(readFileSync("docs/migration/route-ownership.json", "utf8"));

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
