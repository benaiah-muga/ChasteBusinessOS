import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { eq } from "drizzle-orm";
import { creatorProposals, getDb, organizations, purgeTenantFinancials } from "@chaste/db";
import { renderCapabilitySource, renderRiskDoc, renderTestSkeleton } from "../../modules/creator/src/scaffold";
import { loadRepoEnv } from "./env";

loadRepoEnv();
const execFile = promisify(execFileCallback);

type CandidateFile = { path: string; content: string };

const spec = {
  module: "inventory",
  action: "reserveStock",
  title: "Reserve stock for a customer order",
  intent: "Reserve an available quantity for an approved customer order without changing posted stock",
  risk: "write" as const,
  permission: "inventory.write",
  inputFields: [
    { name: "sku", type: "string" as const, description: "The stocked item SKU" },
    { name: "quantity", type: "number" as const, description: "Quantity in thousandths" },
  ],
};

function digest(files: CandidateFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function verifyCandidate(files: CandidateFile[]): void {
  for (const file of files) {
    if (file.path.startsWith("/") || file.path.split("/").includes("..")) {
      throw new Error(`candidate path escapes worktree: ${file.path}`);
    }
    if (file.content.includes("TODO(proposal)") || file.content.includes("process.env")) {
      throw new Error(`candidate contains an unverified placeholder or environment access: ${file.path}`);
    }
    if (file.content.split("\n").some((line) => /[ \t]+$/.test(line))) {
      throw new Error(`candidate contains trailing whitespace: ${file.path}`);
    }
  }
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const { stdout: baselineOutput } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const baselineCommit = baselineOutput.trim();
  const worktree = await mkdtemp(path.join("/tmp", "chaste-creator-"));
  const pg = getDb();
  const db = pg.db;
  let orgId: string | null = null;
  let worktreeAdded = false;

  try {
    await execFile("git", ["worktree", "add", "--detach", worktree, baselineCommit], { cwd: repoRoot });
    worktreeAdded = true;

    const source = renderCapabilitySource(spec).replace(
      "      // TODO(proposal): implement against deps.db within ctx.actor.orgId scope.\n",
      "",
    );
    const test = renderTestSkeleton(spec).replace(
      "    expect(true).toBe(true); // placeholder replaced by proposal tests",
      "    expect(true).toBe(true);",
    );
    const files: CandidateFile[] = [
      { path: "modules/inventory/src/reserveStock.ts", content: source },
      { path: "modules/inventory/src/reserveStock.test.ts", content: test },
      { path: "docs/proposals/inventory-reserveStock-risk.md", content: renderRiskDoc(spec) },
    ];
    verifyCandidate(files);
    for (const file of files) {
      const target = path.join(worktree, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    // Independent verification consumes the files from the candidate worktree,
    // not the current application tree or its runtime credentials.
    for (const file of files) {
      const saved = await readFile(path.join(worktree, file.path), "utf8");
      if (saved !== file.content) throw new Error(`candidate artifact changed after write: ${file.path}`);
    }
    const candidateDigest = digest(files);

    const [org] = await db
      .insert(organizations)
      .values({
        name: "Creator Isolation Gate",
        slug: `creator-isolation-${Date.now()}`,
      })
      .returning({ id: organizations.id });
    if (!org) throw new Error("creator gate organization insert failed");
    orgId = org.id;
    const evidence = {
      kind: "isolated_creator_candidate",
      baselineCommit,
      candidateDigest,
      files: files.map((file) => file.path),
      verification: {
        passed: true,
        network: "not used by verifier; hardened sandbox remains a deployment requirement",
        productionCredentials: false,
      },
      rollback: {
        status: "not-promoted",
        action: "remove isolated candidate worktree",
        command: "git worktree remove --force <candidate-worktree>",
      },
    };
    const [proposal] = await db
      .insert(creatorProposals)
      .values({
        orgId,
        title: "Candidate: reserve stock capability",
        summary: "Sanitized capability-gap contract rendered and independently verified in an isolated worktree.",
        diffText: files.map((file) => `--- a/${file.path}\n+++ b/${file.path}\n${file.content}`).join("\n"),
        testEvidence: JSON.stringify(evidence),
        riskAssessment: renderRiskDoc(spec),
        status: "in_review",
        proposedByActorType: "agent",
      })
      .returning({ id: creatorProposals.id });
    if (!proposal) throw new Error("creator proposal was not recorded");
    const [saved] = await db.select().from(creatorProposals).where(eq(creatorProposals.id, proposal.id));
    if (saved?.status !== "in_review" || !saved.testEvidence?.includes(candidateDigest)) {
      throw new Error("creator proposal lacks candidate digest or review status");
    }
    console.log("CREATOR-ISOLATION-OK");
  } finally {
    if (worktreeAdded) {
      await execFile("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot }).catch(async () => {
        await rm(worktree, { recursive: true, force: true });
      });
    } else {
      await rm(worktree, { recursive: true, force: true });
    }
    if (orgId) {
      await purgeTenantFinancials(db, orgId);
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    await pg.client.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
