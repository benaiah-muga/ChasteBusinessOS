import { eq } from "drizzle-orm";
import { accounts, type Database } from "@chaste/db";
import { currencyMinorUnits, DEFAULT_CHART_OF_ACCOUNTS } from "@chaste/erp-core";
import { embed } from "@chaste/ai";
import { ledgerEventFor } from "@chaste/kernel";
import {
  memberships,
  memories,
  notifications,
  organizations,
  policies,
  rolePermissions,
  roles,
  userRoles,
} from "@chaste/db";
import { STEP_META } from "@/lib/onboarding-plan";
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
 * Setup steps a workspace can defer. Anything left `pending` is surfaced back
 * to the user later rather than silently forgotten — the point of tracking
 * them is that "skipped" must never become "lost".
 */
export const ONBOARDING_STEPS = [
  "business_profile",
  "import_customers",
  "import_products",
  "connect_source",
  "invite_team",
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];
export type StepStatus = "done" | "pending" | "skipped";

export interface OnboardingState {
  path: "fresh" | "import" | "connect";
  steps: Partial<Record<OnboardingStepKey, StepStatus>>;
  startedAt: string;
  finishedAt?: string;
}

function isStepKey(v: string): v is OnboardingStepKey {
  return (ONBOARDING_STEPS as readonly string[]).includes(v);
}

/** Reads `{ settings: { onboarding } }`, tolerating a null or oddly shaped blob. */
export function parseOnboardingState(settings: unknown): OnboardingState | null {
  if (!settings || typeof settings !== "object") return null;
  const raw = (settings as Record<string, unknown>).onboarding;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const steps: OnboardingState["steps"] = {};
  if (o.steps && typeof o.steps === "object") {
    for (const [k, v] of Object.entries(o.steps as Record<string, unknown>)) {
      if (isStepKey(k) && (v === "done" || v === "pending" || v === "skipped")) steps[k] = v;
    }
  }
  return {
    path: o.path === "import" || o.path === "connect" ? o.path : "fresh",
    steps,
    startedAt: typeof o.startedAt === "string" ? o.startedAt : new Date().toISOString(),
    finishedAt: typeof o.finishedAt === "string" ? o.finishedAt : undefined,
  };
}

/**
 * The plain-language → working-ERP pipeline:
 * profile description is embedded into org memory; a standard chart of
 * accounts is seeded; the creator gets an owner role with full authority.
 */
export async function runOnboarding(
  db: Database["db"],
  params: {
    userId: string;
    userEmail: string;
    orgName: string;
    businessDescription: string;
    /** Base reporting currency (ADR 0021 phase 2): chosen once, at onboarding. */
    baseCurrency?: string;
    /** Which of the three entry paths the user picked. */
    path?: "fresh" | "import" | "connect";
    /** Steps the user chose to defer; recorded so the app can offer them again. */
    deferredSteps?: string[];
  },
): Promise<OnboardingResult> {
  const baseCurrency = (params.baseCurrency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseCurrency) || currencyMinorUnits(baseCurrency) === null) {
    throw new Error(`unsupported base currency: ${baseCurrency}`);
  }
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
      .values({
        name: params.orgName,
        slug,
        profileDescription: params.businessDescription,
        baseCurrency,
        settings: {
          onboarding: {
            path: params.path ?? "fresh",
            steps: Object.fromEntries(
              (params.deferredSteps ?? []).filter(isStepKey).map((k) => [k, "pending"]),
            ),
            startedAt: new Date().toISOString(),
          } satisfies OnboardingState,
        },
      })
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

  // Ledger entry after commit, the chain writer runs on its own connection.
  const ledger = new PgLedgerStore(db);
  const ctx = {
    actor: { type: "human" as const, id: params.userId, orgId: result.orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  await ledger.append(ledgerEventFor(ctx as never, "organization.created", null, { orgId: result.orgId, name: params.orgName }));

  return result;
}

/**
 * Records one setup step as done or deferred, after the org exists. Idempotent,
 * so a retry after a flaky network cannot double-count.
 *
 * Deferring also drops a notification in the org's bell. Skipping is meant to
 * feel safe, but "safe" has to be earned: the step has to come back somewhere
 * the user will actually see it, not just live in a settings blob.
 */
export async function setOnboardingStep(
  db: Database["db"],
  orgId: string,
  key: OnboardingStepKey,
  status: StepStatus,
  userId?: string,
): Promise<OnboardingState> {
  const [row] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) throw new Error("organization not found");

  const state =
    parseOnboardingState(row.settings) ??
    ({ path: "fresh", steps: {}, startedAt: new Date().toISOString() } satisfies OnboardingState);
  const previous = state.steps[key];
  state.steps[key] = status;

  await db
    .update(organizations)
    .set({ settings: { ...((row.settings ?? {}) as Record<string, unknown>), onboarding: state } })
    .where(eq(organizations.id, orgId));

  // Only a fresh deferral earns a notification; re-choosing it would spam.
  if (status !== "done" && previous !== status) {
    const meta = STEP_META[key];
    await db.insert(notifications).values({
      orgId,
      userId: userId ?? null,
      kind: "system",
      title: `${meta.title} — ${status === "skipped" ? "skipped during setup" : "left for later"}`,
      body: meta.why,
      href: meta.fix.href,
    });
  }

  return state;
}

/** Seals the setup so the app stops offering the checklist. */
export async function completeOnboarding(
  db: Database["db"],
  orgId: string,
): Promise<OnboardingState> {
  const [row] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) throw new Error("organization not found");

  const state =
    parseOnboardingState(row.settings) ??
    ({ path: "fresh", steps: {}, startedAt: new Date().toISOString() } satisfies OnboardingState);
  state.finishedAt = new Date().toISOString();

  await db
    .update(organizations)
    .set({ settings: { ...((row.settings ?? {}) as Record<string, unknown>), onboarding: state } })
    .where(eq(organizations.id, orgId));

  return state;
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
