import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import test from "node:test";
import { allowsPendingAuthOwner } from "./route-ownership-policy.mjs";

const manifest = JSON.parse(readFileSync("docs/migration/route-ownership.json", "utf8"));
const overrides = JSON.parse(readFileSync("docs/migration/route-ownership-overrides.json", "utf8"));
const census = JSON.parse(readFileSync("docs/migration/retired-route-census.json", "utf8"));

test("frozen route census reproduces the live manifest byte-for-byte", () => {
  const output = execFileSync(process.execPath, ["scripts/migration/route-ownership.mjs", "--check", "--frozen"], {
    encoding: "utf8",
  });
  assert.match(output, /Routes: 94 files, 167 methods, 30 pages\./);
});

test("retired route census keeps every source entry the manifest cites", () => {
  assert.equal(census.schemaVersion, 1);
  assert.equal(census.routeFiles.length, 94);
  assert.equal(census.pageFiles.length, 30);
  const censusKeys = new Set(census.entries.map((entry) => `${entry.kind}:${entry.path}:${entry.method ?? ""}`));
  for (const entry of manifest.entries) {
    if (!entry.source.startsWith("apps/web/")) continue;
    assert.ok(
      censusKeys.has(`${entry.kind}:${entry.path}:${entry.method ?? ""}`),
      `manifest entry ${entry.kind}:${entry.path}:${entry.method ?? ""} is missing from the frozen census`,
    );
  }
});

test("retired route census freezes the full legacy surface", () => {
  assert.equal(census.entries.filter((entry) => entry.kind === "api").length, 158);
  assert.equal(census.entries.filter((entry) => entry.kind === "page").length, 30);
  assert.ok(census.entries.every((entry) => entry.owner === "legacy" && entry.parity === "pending"));
  assert.ok(census.entries.every((entry) => entry.source.startsWith("apps/web/src/app/")));
});

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

test("Vite AI configuration methods are verified Go-owned routes", () => {
  const aiConfigRoutes = manifest.entries.filter(
    (entry) => entry.kind === "api" && entry.path === "/api/ai-config",
  );

  assert.deepEqual(
    aiConfigRoutes.map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "GET", owner: "go", parity: "verified" },
      { method: "POST", owner: "go", parity: "verified" },
    ],
  );
});

test("pending auth ownership is limited to the Better Auth catch-all", () => {
  assert.equal(allowsPendingAuthOwner("api", "/api/auth/[...all]", "auth", "pending"), true);
  assert.equal(allowsPendingAuthOwner("api", "/api/analytics", "auth", "pending"), false);
  assert.equal(allowsPendingAuthOwner("page", "/api/auth/[...all]", "auth", "pending"), false);
});

test("every API method except the Better Auth catch-all is verified Go", () => {
  const nonVerified = manifest.entries.filter(
    (entry) => entry.kind === "api" && entry.parity !== "verified",
  );

  assert.deepEqual(
    nonVerified.map(({ path, method, owner, parity }) => ({ path, method, owner, parity })),
    [
      { path: "/api/auth/[...all]", method: "GET", owner: "auth", parity: "pending" },
      { path: "/api/auth/[...all]", method: "POST", owner: "auth", parity: "pending" },
    ],
  );
});

test("generated Go route declarations require verified parity", () => {
  assert.ok(overrides.goRoutes.length > 0);
  assert.ok(overrides.goRoutes.every((route) => route.kind === "api" && route.owner === "go" && route.parity === "verified"));
});

test("attachment and routine webhook ownership is method-specific", () => {
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.path === "/api/message-attachments/[id]"),
    [{
      kind: "api",
      path: "/api/message-attachments/[id]",
      method: "GET",
      source: "apps/web/src/app/api/message-attachments/[id]/route.ts",
      owner: "go",
      parity: "verified",
    }],
  );
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.path === "/api/routines/webhook/[token]"),
    [
      {
        kind: "api",
        path: "/api/routines/webhook/[token]",
        method: "GET",
        source: "apps/web/src/app/api/routines/webhook/[token]/route.ts",
        owner: "go",
        parity: "verified",
      },
      {
        kind: "api",
        path: "/api/routines/webhook/[token]",
        method: "POST",
        source: "apps/web/src/app/api/routines/webhook/[token]/route.ts",
        owner: "go",
        parity: "verified",
      },
    ],
  );
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.path === "/api/scim/v2/Users" && entry.method === "DELETE"),
    [{
      kind: "api",
      path: "/api/scim/v2/Users",
      method: "DELETE",
      source: "apps/web/src/app/api/scim/v2/Users/route.ts",
      owner: "go",
      parity: "verified",
    }],
  );
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.path === "/api/scim/v2/Users/[id]"),
    [
      { kind: "api", path: "/api/scim/v2/Users/[id]", method: "GET", source: "apps/web/src/app/api/scim/v2/Users/[id]/route.ts", owner: "go", parity: "verified" },
      { kind: "api", path: "/api/scim/v2/Users/[id]", method: "DELETE", source: "apps/web/src/app/api/scim/v2/Users/[id]/route.ts", owner: "go", parity: "verified" },
    ],
  );
});

test("Vite-only Go endpoints have generated ownership without Next source entries", () => {
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.path === "/api/conversations/[id]/agent-reply" || entry.path === "/api/go/documents/[id]/content"),
    [
      {
        kind: "api",
        path: "/api/conversations/[id]/agent-reply",
        method: "POST",
        source: "apps/api/internal/httpapi/messaging_agent_session.go",
        owner: "go",
        parity: "verified",
      },
      {
        kind: "api",
        path: "/api/go/documents/[id]/content",
        method: "GET",
        source: "apps/api/internal/httpapi/document_content_download.go",
        owner: "go",
        parity: "verified",
      },
    ],
  );
});

test("organization persona manifest ownership is verified Go", () => {
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.kind === "api" && entry.path === "/api/org" && ["PUT", "PATCH"].includes(entry.method))
      .map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "PUT", owner: "go", parity: "verified" },
      { method: "PATCH", owner: "go", parity: "verified" },
    ],
  );
});

test("routine collection manifest ownership is verified Go", () => {
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.kind === "api" && entry.path === "/api/routines")
      .map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "GET", owner: "go", parity: "verified" },
      { method: "POST", owner: "go", parity: "verified" },
    ],
  );
});

test("memory collection manifest ownership is verified Go", () => {
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.kind === "api" && entry.path === "/api/memory")
      .map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "GET", owner: "go", parity: "verified" },
      { method: "POST", owner: "go", parity: "verified" },
    ],
  );
});

test("module settings collection manifest ownership is verified Go", () => {
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.kind === "api" && entry.path === "/api/module-settings")
      .map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "GET", owner: "go", parity: "verified" },
      { method: "POST", owner: "go", parity: "verified" },
    ],
  );
});

test("policy collection manifest ownership is verified Go", () => {
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.kind === "api" && entry.path === "/api/policy")
      .map(({ method, owner, parity }) => ({ method, owner, parity })),
    [
      { method: "GET", owner: "go", parity: "verified" },
      { method: "POST", owner: "go", parity: "verified" },
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

test("Go-only durable-run creation has exact generated ownership", () => {
  assert.deepEqual(
    manifest.entries.filter((entry) => entry.path === "/api/durable-runs" && entry.method === "POST"),
    [{
      kind: "api",
      path: "/api/durable-runs",
      method: "POST",
      source: "apps/api/internal/httpapi/durable_runs_create_session.go",
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

test("CRM collection reads and writes have verified Go ownership", () => {
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
        owner: "go",
        parity: "verified",
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
