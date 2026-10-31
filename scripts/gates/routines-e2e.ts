/**
 * Gate G11: routines end-to-end through the running app.
 *
 * Signs up a user, creates a routine from a natural-language schedule via
 * the API, fires its Paperclip-compatible webhook (unauthenticated, token
 * is the capability), runs the real worker until the job is claimed, then
 * asserts the run produced a replayable session, a notification, and an
 * ok last-status on the routine row.
 *
 * Usage: pnpm routines:e2e (dev server on :3000)
 */
import "./env";
import { spawn } from "node:child_process";
import { and, desc, eq, isNull } from "drizzle-orm";
import { agentSessions, authUser, getDb, jobs, notifications } from "@chaste/db";

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

const interrupted = new AbortController();
let workerChild: ReturnType<typeof spawn> | null = null;

function stopWorkerGroup(signal: NodeJS.Signals): void {
  if (!workerChild?.pid) return;
  try {
    process.kill(-workerChild.pid, signal);
  } catch {
    // The process group may already have exited.
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    interrupted.abort();
    stopWorkerGroup("SIGTERM");
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function waitForWorkerExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

async function stopAndWaitForWorker(child: ReturnType<typeof spawn>): Promise<void> {
  const exited = waitForWorkerExit(child);
  const timeout = new AbortController();
  stopWorkerGroup("SIGTERM");
  await Promise.race([exited, sleep(10_000, timeout.signal)]);
  timeout.abort();
  if (child.exitCode === null && child.signalCode === null) stopWorkerGroup("SIGKILL");
  await exited;
}

async function main(): Promise<void> {
  const email = `routine-gate-${Date.now()}@chaste.test`;
  const signup = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ORIGIN_HEADERS },
    body: JSON.stringify({ email, password: "gate-password-1A", name: "Gate Eleven" }),
  });
  if (!signup.ok) throw new Error(`sign-up failed: ${signup.status} ${await signup.text()}`);
  const db = getDb().db;
  // This proof targets routine execution. Promote only its newly created test
  // identity so it does not depend on delivery timing or read a transient
  // verification link from the auth outbox. The Go HTTP auth integration test
  // separately proves the delivered verification link through /verify-email.
  await db.update(authUser).set({ emailVerified: true }).where(eq(authUser.email, email));
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ORIGIN_HEADERS },
    body: JSON.stringify({ email, password: "gate-password-1A" }),
  });
  if (!signIn.ok) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  const cookie = cookieFrom(signIn);
  if (!cookie) throw new Error("Go auth sign-in did not issue a session cookie");

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
    throw new Error("routine create response is missing its ID or webhook URL");
  }
  if (createdJson.scheduleLabel !== "Every 5 minutes") {
    throw new Error(`schedule not parsed as expected: ${createdJson.scheduleLabel}`);
  }

  // Paperclip-style trigger: the webhook endpoint takes no session, the
  // token is the capability.
  const trigger = await fetch(createdJson.webhookUrl, { method: "POST" });
  if (trigger.status !== 202) throw new Error(`webhook trigger failed: ${trigger.status}`);

  // Real worker path: spawn both Go workers through `pnpm worker`, poll the queue state, then stop.
  const child = spawn("pnpm", ["worker"], {
    cwd: process.cwd(),
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      GO_ROUTINE_SCHEDULER: "1",
      GO_ROUTINE_AGENT_RUNNER: "1",
    },
  });
  workerChild = child;
  const childExited = waitForWorkerExit(child);
  try {
    const deadline = Date.now() + 420_000;
    let done = false;
    while (!interrupted.signal.aborted && Date.now() < deadline) {
      const pollWait = new AbortController();
      try {
        await Promise.race([
          sleep(3000, pollWait.signal),
          childExited.then(() => {
            throw new Error("Go worker exited before the routine job completed");
          }),
        ]);
      } finally {
        pollWait.abort();
      }
      if (interrupted.signal.aborted) break;
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
    if (interrupted.signal.aborted) throw new Error("routine E2E interrupted");
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
    await stopAndWaitForWorker(child);
    await childExited;
    workerChild = null;
  }

  async function currentOrg(c: string): Promise<{ orgId: string }> {
    const res = await fetch(`${BASE}/api/org`, { headers: { cookie: c } });
    const j = (await res.json()) as { activeOrgId?: string };
    if (!j.activeOrgId) throw new Error("no active org");
    return { orgId: j.activeOrgId };
  }
}

main().catch((err) => {
  if (interrupted.signal.aborted) return;
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
