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
