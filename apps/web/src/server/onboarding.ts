import { eq } from "drizzle-orm";
import { accounts, type Database } from "@chaste/db";
import { DEFAULT_CHART_OF_ACCOUNTS } from "@chaste/erp-core";
import { embed } from "@chaste/ai";
import { ledgerEventFor } from "@chaste/kernel";
import { memberships, memories, organizations, policies, rolePermissions, roles, userRoles } from "@chaste/db";
import { PgLedgerStore } from "./kernel";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "org"
  );
}

export interface OnboardingResult {
  orgId: string;
}

/**
 * The plain-language → working-ERP pipeline:
 * profile description is embedded into org memory; a standard chart of
 * accounts is seeded; the creator gets an owner role with full authority.
 */
export async function runOnboarding(
  db: Database["db"],
  params: { userId: string; userEmail: string; orgName: string; businessDescription: string },
): Promise<OnboardingResult> {
  const existing = await db.select().from(memberships).where(eq(memberships.userId, params.userId)).limit(1);
  if (existing.length > 0) throw new Error("user already belongs to an organization");

  const base = slugify(params.orgName);
  let slug = base;
  for (let i = 2; ; i++) {
    const clash = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
    if (clash.length === 0) break;
    slug = `${base}-${i}`;
  }

  const result = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: params.orgName, slug, profileDescription: params.businessDescription })
      .returning({ id: organizations.id });
    if (!org) throw new Error("failed to create organization");

    await tx.insert(accounts).values(
      DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({
        orgId: org.id,
        code: a.code,
        name: a.name,
        type: a.type,
      })),
    );

    const [ownerRole] = await tx
      .insert(roles)
      .values({ orgId: org.id, key: "owner", name: "Owner", isSystem: true })
      .returning({ id: roles.id });
    if (!ownerRole) throw new Error("failed to create owner role");
    await tx.insert(rolePermissions).values({ roleId: ownerRole.id, permissionKey: "*", orgId: org.id });

    await tx.insert(userRoles).values({ userId: params.userId, roleId: ownerRole.id, orgId: org.id });
    await tx.insert(memberships).values({ orgId: org.id, userId: params.userId });

    await tx.insert(policies).values([
      { orgId: org.id, capabilityPattern: "*", maxRiskAutonomous: "write", moneyThresholdMinor: 50_000 },
    ]);

    await tx.insert(memories).values({
      orgId: org.id,
      kind: "business_profile",
      source: "onboarding",
      content: params.businessDescription,
      embedding: await getEmbedding(params.businessDescription),
    });

    return { orgId: org.id };
  });

  // Ledger entry after commit — the chain writer runs on its own connection.
  const ledger = new PgLedgerStore(db);
  const ctx = {
    actor: { type: "human" as const, id: params.userId, orgId: result.orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  await ledger.append(ledgerEventFor(ctx as never, "organization.created", null, { orgId: result.orgId, name: params.orgName }));

  return result;
}

async function getEmbedding(text: string): Promise<number[]> {
  try {
    const [vec] = await embed([text], { inputType: "passage" });
    return vec ?? new Array(Number(process.env.EMBEDDING_DIMENSIONS ?? 1024)).fill(0);
  } catch {
    // Embeddings are best-effort at onboarding; retrieval degrades gracefully.
    return new Array(Number(process.env.EMBEDDING_DIMENSIONS ?? 1024)).fill(0);
  }
}
