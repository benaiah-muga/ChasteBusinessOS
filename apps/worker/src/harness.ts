/**
 * C5 — follow-up harness. A due follow-up re-enters the agent orchestrator as a
 * synthesized turn under its owning user/org policy, persists the session, and
 * transitions the durable job to done/failed.
 *
 * The registries and Postgres-backed stores are built by the shared
 * `@chaste/runtime` factory — the same one apps/api consumes — so standing
 * rules / wakes / skills minted over HTTP are honored here with no
 * process-local store drift.
 */
import {
  createAiProvider,
  runFollowUpTurn,
  type ChatSessionState,
  type OrchestratorDeps,
} from "@chaste/ai-core";
import type { AppConfig } from "@chaste/config";
import {
  createCommandHelpers,
  createDb,
  getUserWithOrg,
  resolveUserPermissions,
  schema,
  type Db,
} from "@chaste/db";
import {
  autonomyLevelSchema,
  createRequestContext,
  type Actor,
} from "@chaste/kernel";
import { createRuntime, type Runtime } from "@chaste/runtime";
import { eq } from "drizzle-orm";

export interface FollowUpHarness {
  db: Db;
  cfg: AppConfig;
  runtime: Runtime;
  deps: (autonomy: ReturnType<typeof autonomyLevelSchema.parse>, activeBranch?: { name: string; code: string }) => OrchestratorDeps;
  sessionStore: Runtime["sessionStore"];
}

export async function createFollowUpHarness(
  cfg: AppConfig,
  db: Db = createDb(cfg.databaseUrl),
  providerOverride?: OrchestratorDeps["provider"],
): Promise<FollowUpHarness> {
  const runtime = await createRuntime(cfg, db);
  const { commands, queries, inbox, wakes, skills, audit, outbox, sessionStore } = runtime;
  const provider = providerOverride ?? createAiProvider(cfg.ai);

  return {
    db,
    cfg,
    runtime,
    sessionStore,
    deps: (autonomy, activeBranch) => ({
      commands,
      queries,
      helpers: createCommandHelpers({ audit, outbox, db }),
      autonomy,
      provider,
      allowFullAutonomous: cfg.allowFullAutonomous,
      inbox,
      wake: wakes,
      skills,
      defaultInboxVisibility: cfg.ai.defaultInboxVisibility,
      activeBranch,
    }),
  };
}

export async function runFollowUp(harness: FollowUpHarness, followUpId: string, requestId?: string) {
  const { db, cfg, sessionStore } = harness;
  const [fu] = await db
    .select()
    .from(schema.followUps)
    .where(eq(schema.followUps.id, followUpId))
    .limit(1);
  if (!fu || fu.status !== "running") {
    return { status: fu ? `not_${fu.status}` : "not_found" };
  }

  const userRow = await getUserWithOrg(db, fu.userId);
  if (!userRow || !userRow.isActive) {
    await db.update(schema.followUps).set({ status: "failed" }).where(eq(schema.followUps.id, followUpId));
    return { status: "user_missing" };
  }
  const permissions = await resolveUserPermissions(db, fu.userId);
  const autonomy = autonomyLevelSchema.catch(cfg.defaultAutonomy).parse(userRow.autonomy);
  const actor: Actor = {
    kind: "ai_assisted",
    userId: fu.userId,
    organizationId: fu.organizationId,
    displayName: userRow.displayName,
    permissions: new Set(permissions),
    aiRunId: crypto.randomUUID(),
  };
  const ctx = createRequestContext({ actor, requestId, autonomy });

  let sessionId = fu.sessionId ?? crypto.randomUUID();
  let dbSession = fu.sessionId ? await sessionStore.load(sessionId) : undefined;
  let session: ChatSessionState;
  if (dbSession) {
    session = {
      id: dbSession.id,
      messages: dbSession.messages as ChatSessionState["messages"],
      pending: dbSession.pending as ChatSessionState["pending"],
      unattended: dbSession.unattended ?? false,
      compactionState: dbSession.compactionState as ChatSessionState["compactionState"],
    };
  } else {
    const sticky = await sessionStore.loadByOrgUser(fu.organizationId, fu.userId);
    if (sticky) {
      sessionId = sticky.id;
      session = {
        id: sticky.id,
        messages: sticky.messages as ChatSessionState["messages"],
        pending: sticky.pending as ChatSessionState["pending"],
        unattended: sticky.unattended ?? false,
        compactionState: sticky.compactionState as ChatSessionState["compactionState"],
      };
    } else {
      await sessionStore.create(sessionId, fu.organizationId, fu.userId);
      session = { id: sessionId, messages: [] };
    }
  }

  let activeBranch: { name: string; code: string } | undefined;
  const branchId = fu.branchId ?? session.activeBranchId;
  if (branchId) {
    const [branch] = await db
      .select({ name: schema.branches.name, code: schema.branches.code })
      .from(schema.branches)
      .where(eq(schema.branches.id, branchId))
      .limit(1);
    if (branch) activeBranch = branch;
  }

  try {
    const result = await runFollowUpTurn(harness.deps(autonomy, activeBranch), {
      session,
      ctx,
      goal: fu.goal,
    });
    await sessionStore.save(
      sessionId,
      result.session.messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.parts,
        createdAt: m.createdAt,
      })),
      result.session.pending,
      {
        unattended: result.session.unattended ?? false,
        compactionState: result.session.compactionState ?? null,
      },
    );
    await db
      .update(schema.followUps)
      .set({ status: "done", firedAt: new Date(), sessionId })
      .where(eq(schema.followUps.id, followUpId));
    return { status: "done", sessionId };
  } catch (err) {
    await db.update(schema.followUps).set({ status: "failed" }).where(eq(schema.followUps.id, followUpId));
    return { status: "failed", sessionId, error: err instanceof Error ? err.message : String(err) };
  }
}
