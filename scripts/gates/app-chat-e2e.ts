/**
 * Gate G10: end-to-end through the running web app.
 *
 * Signs up a real user over HTTP, onboards an org, then drives the agent
 * chat over the configured provider (GLM) asserting the wire protocol:
 * step events, deltas, usage accounting, an ask_user round trip, and
 * mid-run steering injection (observable as a persisted steering event).
 *
 * Usage: pnpm exec tsx scripts/gates/app-chat-e2e.ts  (dev server on :3000)
 */
import "./env";

const BASE = process.env.GATE_BASE_URL ?? "http://localhost:3000";

/** better-auth CSRF: every mutating request must carry its Origin. */
const ORIGIN_HEADERS = { origin: BASE } as const;

interface Line {
  type: string;
  text?: string;
  name?: string;
  step?: number;
  maxSteps?: number;
  id?: string;
  question?: string;
  options?: string[];
  sessionId?: string;
  usage?: { turn?: { input: number; output: number }; session?: { input: number; output: number } };
}

function cookieFrom(res: Response): string {
  const cookies = res.headers.getSetCookie();
  return cookies
    .map((c) => c.split(";")[0]!)
    .filter(Boolean)
    .join("; ");
}

async function readStream(res: Response): Promise<Line[]> {
  const lines: Line[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const p of parts) {
      if (p.trim()) lines.push(JSON.parse(p) as Line);
    }
  }
  return lines;
}

async function chat(cookie: string, body: object): Promise<Line[]> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...ORIGIN_HEADERS },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
  return readStream(res);
}

async function main(): Promise<void> {
  // 1) Sign up a real session over HTTP.
  const email = `gate-${Date.now()}@chaste.test`;
  const signup = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ORIGIN_HEADERS },
    body: JSON.stringify({ email, password: "gate-password-1A", name: "Gate Ten" }),
  });
  if (!signup.ok) throw new Error(`sign-up failed: ${signup.status} ${await signup.text()}`);
  const cookie = cookieFrom(signup);
  if (!cookie) throw new Error("no session cookie from sign-up");

  // 2) Onboard the org (seeds accounts; makes one embedding call).
  const onboarding = await fetch(`${BASE}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...ORIGIN_HEADERS },
    body: JSON.stringify({
      orgName: "Gate Ten Trading",
      businessDescription:
        "A small hardware store selling tools and building materials to walk-in customers and local contractors.",
    }),
  });
  if (!onboarding.ok) throw new Error(`onboarding failed: ${onboarding.status} ${await onboarding.text()}`);

  // 3) Plain chat: assert step events, deltas, usage (turn + session).
  const first = await chat(cookie, { message: "Reply with one short sentence greeting me." });
  const hasStep = first.some((l) => l.type === "step" && (l.step ?? 0) > 0);
  const deltaChars = first.filter((l) => l.type === "delta").reduce((n, l) => n + (l.text?.length ?? 0), 0);
  const done = first.find((l) => l.type === "done");
  if (!hasStep) throw new Error("no step event on the wire");
  if (deltaChars === 0) throw new Error("no deltas received");
  if (!done) throw new Error("no done event");
  const turnIn = done.usage?.turn?.input ?? 0;
  const sessionIn = done.usage?.session?.input ?? 0;
  if (turnIn <= 0 || sessionIn < turnIn) {
    throw new Error(`usage accounting wrong: turn=${turnIn} session=${sessionIn}`);
  }
  const sessionId = done.sessionId!;
  if (!sessionId) throw new Error("no sessionId in done");
  console.log(`[G10] protocol OK: steps+deltas+usage (turn in=${turnIn}, session in=${sessionIn})`);

  // 4) Steering: queue a message into the live store, next run must persist it.
  const steer = await fetch(`${BASE}/api/chat/steer`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...ORIGIN_HEADERS },
    body: JSON.stringify({ sessionId, message: "From now on prefer very short answers." }),
  });
  if (!steer.ok) throw new Error(`steer failed: ${steer.status}`);
  const second = await chat(cookie, { sessionId, message: "Acknowledge in a few words." });
  if (!second.some((l) => l.type === "done")) throw new Error("second run never finished");

  const replay = await fetch(`${BASE}/api/sessions/${sessionId}`, { headers: { cookie } });
  if (!replay.ok) throw new Error(`replay fetch failed: ${replay.status}`);
  const replayJson = (await replay.json()) as { events?: Array<{ role: string; content: { steering?: boolean } }> };
  const steered = replayJson.events?.some((e) => e.role === "user" && e.content?.steering === true);
  if (!steered) throw new Error("steering message never reached the trajectory");

  // 5) ask_user round trip: the answer becomes the next user turn.
  const askRun = await chat(cookie, {
    sessionId,
    message:
      "You must call the ask_user tool now. I want to add a customer but I have not told you the name. Ask me one clarifying question with exactly two short options.",
  });
  const ask = askRun.find((l) => l.type === "ask");
  if (!ask || !ask.question) throw new Error("ask_user never surfaced on the wire");
  if (!ask.options || ask.options.length < 2) throw new Error(`ask had no options: ${JSON.stringify(ask)}`);
  const answer = ask.options[0]!;
  const final = await chat(cookie, { sessionId, message: answer });
  const finalDone = final.find((l) => l.type === "done");
  if (!finalDone) throw new Error("final turn never finished");

  console.log(`[G10] APP CHAT E2E OK: asked "${ask.question}", answered "${answer}"`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
