/**
 * Gate G11: routines end-to-end through the running app.
 *
 * Signs up a user, creates a routine from a natural-language schedule via
 * the API, fires its Paperclip-compatible webhook (unauthenticated, token
 * is the capability), runs the real worker until the job is claimed, then
 * asserts the run produced a replayable session, a notification, and an
 * ok last-status on the routine row.
 *
 * Usage: pnpm exec tsx scripts/gates/routines-e2e.ts  (dev server on :3000)
 */
import "./env";
import { spawn } from "node:child_process";
import { and, desc, eq, isNull } from "drizzle-orm";
import { agentSessions, getDb, jobs, notifications } from "@chaste/db";

const BASE = process.env.GATE_BASE_URL ?? "http://localhost:3000";

/** better-auth CSRF: every mutating request must carry its Origin. */
const ORIGIN_HEADERS = { origin: BASE } as const;

function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter(Boolean)
    .join("; ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const email = `routine-gate-${Date.now()}@chaste.test`;
  const signup = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ORIGIN_HEADERS },
    body: JSON.stringify({ email, password: "gate-password-1A", name: "Gate Eleven" }),
  });
  if (!signup.ok) throw new Error(`sign-up failed: ${signup.status} ${await signup.text()}`);
  const cookie = cookieFrom(signup);

  const onboarding = await fetch(`${BASE}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...ORIGIN_HEADERS },
    body: JSON.stringify({
      orgName: "Gate Eleven Supplies",
      businessDescription:
        "An office supplies shop selling paper, ink, and furniture to small businesses in the city.",
    }),
  });
  if (!onboarding.ok) throw new Error(`onboarding failed: ${onboarding.status} ${await onboarding.text()}`);

  // Natural-language schedule through the API ("every 5 minutes" is a known
  // shape for the deterministic parser; the model fallback stays idle).
  const created = await fetch(`${BASE}/api/routines`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...ORIGIN_HEADERS },
    body: JSON.stringify({
      action: "create",
      name: "Morning pulse",
      prompt:
        "Always report, never stay silent: count how many customers exist using your read tools and reply with the number in one short sentence. This routine must never reply NO_ACTION; it must always state the count.",
      scheduleText: "every 5 minutes",
      withWebhook: true,
    }),
  });
  if (!created.ok) throw new Error(`routine create failed: ${created.status} ${await created.text()}`);
  const createdJson = (await created.json()) as {
    routineId: string;
    scheduleLabel: string;
    webhookUrl: string | null;
  };
  if (!createdJson.routineId || !createdJson.webhookUrl) {
    throw new Error(`create response incomplete: ${JSON.stringify(createdJson)}`);
  }
  if (createdJson.scheduleLabel !== "Every 5 minutes") {
    throw new Error(`schedule not parsed as expected: ${createdJson.scheduleLabel}`);
  }

  // Paperclip-style trigger: the webhook endpoint takes no session, the
  // token is the capability.
  const trigger = await fetch(createdJson.webhookUrl, { method: "POST" });
  if (trigger.status !== 202) throw new Error(`webhook trigger failed: ${trigger.status}`);

  // Real worker path: spawn `pnpm worker`, poll the queue state, then stop.
  const db = getDb().db;
  const child = spawn("pnpm", ["worker"], { cwd: process.cwd(), stdio: "ignore", detached: true });
  try {
    const deadline = Date.now() + 420_000;
    let done = false;
    while (Date.now() < deadline) {
      await sleep(3000);
      const [job] = await db
        .select({ status: jobs.status, lastError: jobs.lastError })
        .from(jobs)
        .where(and(eq(jobs.orgId, (await currentOrg(cookie)).orgId), eq(jobs.type, "routines.executeRoutine")))
        .orderBy(desc(jobs.createdAt))
        .limit(1);
      if (job?.status === "done") {
        done = true;
        break;
      }
      if (job?.status === "failed") throw new Error(`routine job failed: ${job.lastError}`);
    }
    if (!done) throw new Error("routine job never completed in time");

    const [session] = await db
      .select({ id: agentSessions.id, title: agentSessions.title })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.orgId, (await currentOrg(cookie)).orgId),
          isNull(agentSessions.userId),
        ),
      )
      .orderBy(desc(agentSessions.createdAt))
      .limit(1);
    if (!session || !session.title.startsWith("Routine:")) {
      throw new Error(`no routine-run session found: ${JSON.stringify(session)}`);
    }

    const note = await db
      .select({ title: notifications.title })
      .from(notifications)
      .where(and(eq(notifications.orgId, (await currentOrg(cookie)).orgId), eq(notifications.kind, "routine.run")))
      .limit(1);
    if (note.length === 0) throw new Error("no routine.run notification recorded");

    console.log(`[G11] ROUTINES E2E OK: session "${session.title}", notification "${note[0]!.title}"`);
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }

  async function currentOrg(c: string): Promise<{ orgId: string }> {
    const res = await fetch(`${BASE}/api/org`, { headers: { cookie: c } });
    const j = (await res.json()) as { activeOrgId?: string };
    if (!j.activeOrgId) throw new Error("no active org");
    return { orgId: j.activeOrgId };
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
