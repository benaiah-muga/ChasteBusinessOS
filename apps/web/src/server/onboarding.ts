import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accounts, bootstrapIntents, type Database } from "@chaste/db";
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
  /** True when this call replayed a receipt from an earlier identical intent. */
  replayed?: boolean;
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
 *
 * B01: tenant creation cannot require an existing tenant, so this is the one
 * declared bootstrap exception to the governed command path — it is
 * session-authenticated, seeds only the caller's own membership, and is
 * intent-keyed: a retry after a lost response replays the receipt committed
 * with the organization instead of creating a second tenant, and reusing an
 * intent id with a different payload is refused. Subsequent setup changes go
 * through ordinary governed capabilities.
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
    /** Client action identity (B02 semantics): stable across retries of one intended bootstrap. */
    intentId?: string;
  },
): Promise<OnboardingResult> {
  const baseCurrency = (params.baseCurrency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseCurrency) || currencyMinorUnits(baseCurrency) === null) {
    throw new Error(`unsupported base currency: ${baseCurrency}`);
  }
  const payloadHash = bootstrapPayloadHash(params);

  // Replay before anything else: after a lost response the session may
  // already resolve an org, and the caller still needs the original receipt.
  if (params.intentId) {
    const [receipt] = await db
      .select({ orgId: bootstrapIntents.orgId, payloadHash: bootstrapIntents.payloadHash })
      .from(bootstrapIntents)
      .where(and(eq(bootstrapIntents.userId, params.userId), eq(bootstrapIntents.intentId, params.intentId)))
      .limit(1);
    if (receipt) {
      if (receipt.payloadHash !== payloadHash) {
        throw new Error("bootstrap intent conflict: this intent id was used with a different payload");
      }
      if (receipt.orgId) return { orgId: receipt.orgId, replayed: true };
    }
  }

  const existing = await db.select().from(memberships).where(eq(memberships.userId, params.userId)).limit(1);
  if (existing.length > 0) throw new Error("user already belongs to an organization");

  const result = await db.transaction(async (tx) => {
    // Slug uniqueness settles inside the transaction: a pre-flight check
    // races concurrent bootstraps, the unique constraint does not. Each
    // attempt runs under a savepoint so a clash rolls back only the org
    // insert and the suffix walk retries against committed state.
    const base = slugify(params.orgName);
    let slug = base;
    let org: { id: string } | undefined;
    for (let attempt = 0; attempt < 5 && !org; attempt++) {
      try {
        org = await tx.transaction(async (nested) => {
          const [row] = await nested
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
          return row;
        });
      } catch (err) {
        const code =
          (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (code !== "23505") throw err;
        slug = `${base}-${attempt + 2}`;
      }
    }
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

    // The zero vector commits with the org so the business profile is never
    // lost to a provider hiccup; the real embedding upgrades it post-commit
    // (T08: no provider call inside the transaction).
    await tx.insert(memories).values({
      orgId: org.id,
      kind: "business_profile",
      source: "onboarding",
      content: params.businessDescription,
      embedding: ZERO_VECTOR,
    });

    // The receipt commits atomically with the org it describes (T08).
    if (params.intentId) {
      await tx.insert(bootstrapIntents).values({
        userId: params.userId,
        intentId: params.intentId,
        payloadHash,
        orgId: org.id,
      });
    }

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

  // Best-effort embedding upgrade, outside the transaction (T08).
  void upgradeEmbedding(db, result.orgId, params.businessDescription);

  return result;
}

function bootstrapPayloadHash(params: {
  orgName: string;
  businessDescription: string;
  baseCurrency?: string;
  path?: "fresh" | "import" | "connect";
  deferredSteps?: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        orgName: params.orgName,
        businessDescription: params.businessDescription,
        baseCurrency: (params.baseCurrency ?? "USD").toUpperCase(),
        path: params.path ?? "fresh",
        deferredSteps: [...(params.deferredSteps ?? [])].sort(),
      }),
    )
    .digest("hex");
}

const ZERO_VECTOR = new Array(Number(process.env.EMBEDDING_DIMENSIONS ?? 1024)).fill(0);

async function upgradeEmbedding(db: Database["db"], orgId: string, text: string): Promise<void> {
  try {
    const [vec] = await embed([text], { inputType: "passage" });
    if (!vec) return;
    await db
      .update(memories)
      .set({ embedding: vec })
      .where(eq(memories.orgId, orgId));
  } catch {
    // Retrieval degrades gracefully on the zero vector; retry is harmless.
  }
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
