import { readFileSync } from "node:fs";
import process from "node:process";
import console from "node:console";

/**
 * Compares the TypeScript session authority's decision with the Go resolver's
 * for the same cookies. Any disagreement is a defect that would let Go serve a
 * session TypeScript would refuse, or the reverse, so it exits non-zero.
 *
 * Usage: node scripts/probe/compare-session-parity.mjs <ts.json> <go.json>
 */

const [, , tsPath, goPath] = process.argv;
if (!tsPath || !goPath) {
  console.error("usage: compare-session-parity.mjs <ts.json> <go.json>");
  process.exit(2);
}

const ts = JSON.parse(readFileSync(tsPath, "utf8"));
const go = JSON.parse(readFileSync(goPath, "utf8"));

if (ts.error) {
  console.error("TypeScript authority reported an error:", ts.error);
  process.exit(3);
}
if (go.error) {
  console.error("Go resolver reported an error:", go.error);
  process.exit(4);
}

/**
 * The TypeScript route exposes only the active organization and the org list.
 * Everything Go reports beyond that has no oracle here, so it is compared only
 * for internal consistency rather than asserted equal.
 */
const differences = [];

const tsActiveOrg = ts.activeOrgId ?? null;
if ((go.orgId ?? null) !== tsActiveOrg) {
  differences.push(`active organization: TypeScript ${tsActiveOrg} vs Go ${go.orgId ?? null}`);
}

const tsOrgIds = (ts.orgs ?? []).map((org) => org.id).sort();
const goOrgIds = [...(go.allOrgIds ?? [])].sort();
if (JSON.stringify(tsOrgIds) !== JSON.stringify(goOrgIds)) {
  differences.push(`memberships: TypeScript ${JSON.stringify(tsOrgIds)} vs Go ${JSON.stringify(goOrgIds)}`);
}

// The route lists every organization with its own currency, so the comparable
// currency is the one belonging to the ACTIVE organization. Comparing against
// orgs[0] would flag a correct org switch as a mismatch.
const activeOrgRow = (ts.orgs ?? []).find((org) => org.id === tsActiveOrg);
if (activeOrgRow?.baseCurrency && go.baseCurrency && activeOrgRow.baseCurrency !== go.baseCurrency) {
  differences.push(
    `base currency for the active organization: TypeScript ${activeOrgRow.baseCurrency} vs Go ${go.baseCurrency}`,
  );
}

// An unverified session must resolve to no organization at all, and the
// legacy route answers that as an empty list.
if (tsActiveOrg === null && goOrgIds.length > 0) {
  differences.push(`TypeScript exposed no organization but Go reported ${JSON.stringify(goOrgIds)}`);
}

// Internal consistency: a resolved organization with no permissions, or an
// unverified session that resolved an organization, is a defect regardless of
// what the oracle said.
if (!go.emailVerified && go.orgId) {
  differences.push(`unverified session resolved an organization: ${go.orgId}`);
}
if (go.orgId && !Array.isArray(go.permissions)) {
  differences.push("resolved organization without a permissions array");
}
if (!go.orgId && go.permissions && go.permissions.length > 0) {
  differences.push(`no organization but permissions ${JSON.stringify(go.permissions)}`);
}
if (go.orgId && !go.allOrgIds.includes(go.orgId)) {
  differences.push(`active organization ${go.orgId} is not in the membership list`);
}

if (differences.length > 0) {
  console.error("SESSION PARITY FAILED");
  for (const difference of differences) console.error(`  - ${difference}`);
  process.exit(1);
}

console.log("session parity OK");
console.log(`  active organization: ${go.orgId}`);
console.log(`  memberships: ${go.allOrgIds.length}`);
console.log(`  permissions: ${go.permissions.length}`);
console.log(`  email verified: ${go.emailVerified}`);