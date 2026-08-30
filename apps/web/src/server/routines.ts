import { eq, sql } from "drizzle-orm";
import {
  agentSessions,
  jobs,
  notifications,
  organizations,
  routines,
  tickets,
  type Database,
} from "@chaste/db";
import { nextRoutineRun, parseScheduleText } from "@chaste/erp-core";
import { runAgentLoop, type ActionContext, type Actor, type Logger, type TicketSink } from "@chaste/kernel";
import { OpenAiCompatAdapter, MODELS, resolveClient } from "@chaste/ai";
import { addTokenUsage, appendSessionEvent } from "@/server/session-events";
import { buildExecutor, buildRegistry } from "@/server/kernel";

/**
 * Routine execution (Paperclip-style recurring agent runs).
 *
 * A routine never acts by itself: the worker claims due routines, then each
 * run goes through the same governed executor as interactive chats, as a
 * system actor holding a fixed least-privilege bundle. Routine runs are
 * deliberately read-mostly: they survey the business and report findings as
 * an in-app notification plus a replayable agent session. Anything that
 * needs a write still runs interactively under human authority.
 */

/** Read access + messaging so a run can post its findings on the record. */
export const ROUTINE_PERMISSIONS = [
  "accounting.read",
  "analytics.report",
  "crm.read",
  "documents.read",
  "hr.read",
  "inventory.read",
  "manufacturing.read",
  "messaging.read",
  "messaging.write",
  "purchasing.read",
  "routines.read",
  "support.read",
] as const;

export const NO_ACTION_MARKER = "NO_ACTION";

function routineActor(orgId: string): Actor {
  return { type: "system", id: null, orgId, permissions: new Set(ROUTINE_PERMISSIONS) };
}

export interface DueRoutine {
  id: string;
  orgId: string;
  name: string;
  prompt: string;
  schedule: unknown;
}

/**
 * Claims due routines with SKIP LOCKED, marks them running, and advances
 * their schedule immediately (at-most-once semantics: a crashed worker can
 * skip a beat, but two workers can never double-fire a routine).
 */
export async function claimDueRoutines(db: Database["db"], limit = 10): Promise<DueRoutine[]> {
  const result = (await db.execute(sql`
    UPDATE routines SET last_run_at = now(), last_status = 'running'
    WHERE id IN (
      SELECT id FROM routines
      WHERE enabled = true AND trigger_type = 'schedule' AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, org_id AS "orgId", name, prompt, schedule
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const list: Record<string, unknown>[] = Array.isArray(result) ? result : (result.rows ?? []);
  const claimed: DueRoutine[] = list.map((r) => ({
    id: String(r.id),
    orgId: String(r.orgId),
    name: String(r.name),
    prompt: String(r.prompt),
    schedule: r.schedule,
  }));
  for (const r of claimed) {
    await rescheduleRoutine(db, r.id, r.schedule, new Date());
  }
  return claimed;
}

export async function enqueueRoutineRun(
  db: Database["db"],
  routine: { id: string; orgId: string },
  trigger: "schedule" | "webhook" | "manual",
): Promise<string> {
  const [job] = await db
    .insert(jobs)
    .values({ orgId: routine.orgId, type: "routines.executeRoutine", payload: { routineId: routine.id, trigger } })
    .returning({ id: jobs.id });
  return job!.id;
}

/** Advances next_run_at from the stored structured schedule. */
export async function rescheduleRoutine(db: Database["db"], routineId: string, schedule: unknown, from: Date): Promise<void> {
  const next = nextRoutineRun(schedule as never, from);
  await db.update(routines).set({ nextRunAt: next }).where(eq(routines.id, routineId));
}

const routinePrompt = (name: string, prompt: string, orgName: string) => `You are running the scheduled routine "${name}" for ${orgName}.
${prompt}

Rules for routine runs:
- Investigate with your read tools before concluding anything.
- If everything looks fine, or nothing needs attention, reply with exactly ${NO_ACTION_MARKER} and nothing else.
- If something needs attention, say what, with the concrete numbers or ids, and post one short summary message to the #general channel via messaging.
- You cannot create, post, or approve anything financial; do not try.`;

/**
 * Executes one routine run: headless agent loop, replayable session,
 * notification when the run has something to say.
 */
export async function executeRoutine(
  db: Database["db"],
  log: Logger,
  payload: { routineId: string; trigger: string },
): Promise<void> {
  const [routine] = await db.select().from(routines).where(eq(routines.id, payload.routineId)).limit(1);
  if (!routine) {
    log.warn("routine vanished before run", { routineId: payload.routineId });
    return;
  }
  const finish = async (status: "ok" | "failed", error?: string) => {
    await db
      .update(routines)
      .set({ lastStatus: status, lastError: error ?? null })
      .where(eq(routines.id, routine.id));
  };

  let session: { id: string } | undefined;
  try {
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, routine.orgId))
      .limit(1);
    const [created] = await db
      .insert(agentSessions)
      .values({
        orgId: routine.orgId,
        userId: null,
        title: `Routine: ${routine.name}`.slice(0, 80),
        mode: "assist",
        modelRef: MODELS.primary(),
      })
      .returning({ id: agentSessions.id });
    session = created!;

    const registry = buildRegistry(db).scopedToModules(null);
    const executor = buildExecutor(db, registry);
    const model = new OpenAiCompatAdapter({
      client: resolveClient(MODELS.primary()),
      model: MODELS.primary(),
    });
    const ctx: ActionContext = {
      actor: routineActor(routine.orgId),
      sessionId: session.id,
      now: new Date(),
      services: {},
    };
    const ticketSink: TicketSink = {
      file: async (orgId, title, description) => {
        await db.insert(tickets).values({ orgId, title, description });
      },
    };

    const systemPrompt = `You are the scheduled business runner for "${org?.name ?? "the organization"}", executing a recurring routine. You operate through governed capabilities; the same rules as interactive runs apply: never invent numbers or capabilities, amounts are minor units.`;
    await appendSessionEvent(db, session.id, "user", { text: routine.prompt, routine: routine.name });
    const result = await runAgentLoop(model, registry, executor, ctx, {
      sessionId: session.id,
      systemPrompt,
      userGoal: routinePrompt(routine.name, routine.prompt, org?.name ?? "the organization"),
      maxSteps: 6,
      contextWindow: Number(process.env.MODEL_CONTEXT_WINDOW ?? 131_072),
      noCapabilityNote:
        "No registered capability can do this. State honestly what you are missing, then reply NO_ACTION if it blocks the whole routine.",
    }, ticketSink);
    await appendSessionEvent(db, session.id, "assistant", { text: result.finalMessage });
    await addTokenUsage(db, session.id, result.usage);
    await finish("ok");

    const saidSomething =
      result.finalMessage.trim().length > 0 && !result.finalMessage.trim().startsWith(NO_ACTION_MARKER);
    if (saidSomething) {
      try {
        await db.insert(notifications).values({
          orgId: routine.orgId,
          userId: null,
          kind: "routine.run",
          title: `Routine "${routine.name}" has findings`,
          body: result.finalMessage.slice(0, 500),
          href: "/sessions",
        });
      } catch {
        // A failed feed insert must not flip the run's outcome.
      }
    }
    log.info("routine run finished", {
      routineId: routine.id,
      steps: result.steps,
      saidSomething: Boolean(saidSomething),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish("failed", message.slice(0, 500));
    log.warn("routine run failed", { routineId: routine.id, error: message });
  }
}

/** Worker tick: enqueue due schedule-triggered routine runs. */
export async function tickRoutines(db: Database["db"], log: Logger): Promise<number> {
  const due = await claimDueRoutines(db);
  for (const r of due) {
    await enqueueRoutineRun(db, r, "schedule");
    log.info("routine due; enqueued run", { routineId: r.id, name: r.name });
  }
  return due.length;
}

/** Webhook trigger: Paperclip or any external scheduler can fire this. */
export async function triggerRoutineByWebhookToken(
  db: Database["db"],
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const [routine] = await db
    .select({ id: routines.id, orgId: routines.orgId, enabled: routines.enabled })
    .from(routines)
    .where(eq(routines.webhookToken, token))
    .limit(1);
  if (!routine) return { ok: false, error: "unknown routine token" };
  if (!routine.enabled) return { ok: false, error: "routine is disabled" };
  await enqueueRoutineRun(db, routine, "webhook");
  return { ok: true };
}

/** Where the next scheduled run would land, for UI previews. */
export function previewNextRun(schedule: unknown, from: Date): Date {
  return nextRoutineRun(schedule as never, from);
}

/**
 * Natural-language scheduling fallback: the deterministic parser in
 * erp-core stays the only validator; the model merely normalizes the user's
 * words into a shape that parser accepts. Returns null when either side
 * cannot resolve the phrase.
 */
export async function refineScheduleText(text: string): Promise<string | null> {
  try {
    const { chat } = await import("@chaste/ai");
    const out = await chat(
      [
        {
          role: "system",
          content:
            'Normalize a scheduling phrase into exactly one of these shapes and reply with ONLY the normalized phrase: "every N minutes" (N from 5 to 10080), "every N hours", "daily at HH:MM" (24-hour), "weekdays at HH:MM", "weekly on <dayname> at HH:MM". Examples: "twice a day" -> "every 12 hours"; "each morning at 8" -> "daily at 08:00"; "mondays 9am" -> "weekly on monday at 09:00". If it cannot be expressed in these shapes reply UNPARSEABLE.',
        },
        { role: "user", content: text },
      ],
      { temperature: 0, maxTokens: 40 },
    );
    const normalized = out.trim().split("\n")[0]?.trim() ?? "";
    if (!normalized || normalized.toUpperCase().includes("UNPARSEABLE")) return null;
    return parseScheduleText(normalized).ok ? normalized : null;
  } catch {
    return null;
  }
}
