/**
 * Dynamic natural-language test driver — the ~18 research-doc NL requests
 * (`docs/research/2026-08-15-future-architecture-ai-native-business-os.md`
 * §Proactive Scheduling + §First Fifteen End-to-End Scenarios) driven over the
 * live HTTP API exactly like a real user: `POST /api/v1/ai/chat`, then, when
 * the orchestrator parks a `confirm_action`, approving it with the returned
 * `confirmId`. Every write therefore goes through the same command bus a human
 * uses (AI/manual parity), and every outcome is verified against the expected
 * structured intent rather than free-form prose.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3001 AUTH_TOKEN=<bearer> \
 *     tsx --env-file=../../.env src/nl-driver.ts
 *
 * Output: per-request pass/fail + a JSON summary on stdout. Exit code is the
 * number of failing requests (0 = all green).
 */

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3001";
const AUTH = process.env.AUTH_TOKEN ?? "";

interface UiPart {
  type: string;
  text?: string;
  title?: string;
  id?: string;
  command?: string;
  input?: Record<string, unknown>;
  summary?: string;
  plannedCommand?: string;
  questions?: string[];
  [key: string]: unknown;
}

interface ChatMessage {
  role: string;
  parts: UiPart[];
}

interface ChatResponse {
  sessionId: string;
  messages: ChatMessage[];
  pendingConfirmationId?: string;
}

interface DriveResult {
  message: string;
  parts: UiPart[];
  confirmed: {
    ok: boolean;
    parts: UiPart[];
  };
}

async function chat(
  body: Record<string, unknown>,
): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/api/v1/ai/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`chat HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as ChatResponse;
}

/** Post a message, then confirm any parked write action. Each test uses a
 * fresh session so one conversation never leaks pending/confirm state into the
 * next (the server would otherwise reuse the sticky org+user session). */
async function drive(message: string): Promise<DriveResult> {
  const sessionId = crypto.randomUUID();
  const r1 = await chat({ sessionId, message });
  const parts = (r1.messages ?? []).flatMap((m) => m.parts ?? []);

  let confirmed: DriveResult["confirmed"] = { ok: false, parts: [] };
  if (r1.pendingConfirmationId) {
    const r2 = await chat({
      sessionId,
      confirmId: r1.pendingConfirmationId,
    });
    confirmed = {
      ok: true,
      parts: (r2.messages ?? []).flatMap((m) => m.parts ?? []),
    };
  }

  return { message, parts, confirmed };
}

interface NlTestCase {
  id: string;
  message: string;
  /** Expected command(s) carried by a parked confirm_action (writes). */
  expectCommand?: string | string[];
  /** Expected read-query name(s) answered (explanation.plannedCommand). */
  expectRead?: string | string[];
  /** Expected action.mode for watch-rule intents. */
  expectMode?: string;
}

const TESTS: NlTestCase[] = [
  {
    id: "1",
    message: "Remind me every Friday at 4pm to review stockouts",
    expectCommand: "core.watchRule.create",
    expectMode: "notify",
  },
  {
    id: "2",
    message: "Schedule payroll approval for the 25th, and ping Finance if not approved by 3pm",
    expectCommand: "core.watchRule.create",
    expectMode: "notify",
  },
  {
    id: "3",
    message: "Every morning, tell branch managers which products are at risk of stockout",
    expectCommand: "core.watchRule.create",
    expectMode: "notify",
  },
  {
    id: "4",
    message: "If supplier bills over 5 million arrive, ask me before approval routing",
    expectCommand: "core.watchRule.create",
    expectMode: "request_approval",
  },
  {
    id: "5",
    message: "Follow up with customers whose invoices are overdue by >14 days, draft for approval",
    expectCommand: "core.watchRule.create",
    expectMode: "draft",
  },
  {
    id: "6",
    message: "treat blank tax IDs as unknown",
    expectCommand: "core.importRule.create",
  },
  {
    id: "7",
    message: "split full name into first and last name",
    expectCommand: "core.importRule.create",
  },
  {
    id: "8",
    message: "these two supplier columns are the same supplier",
    expectCommand: "core.importRule.create",
  },
  {
    id: "9",
    message: "show this by branch",
    expectRead: "core.analytics.salesByLocation",
  },
  {
    id: "10",
    message: "make it monthly",
    expectCommand: "core.watchRule.create",
    expectMode: "notify",
  },
  {
    id: "11",
    message: "compare to last quarter",
    expectRead: "core.analytics.marginTrend",
  },
  {
    id: "12",
    message: "turn this into a dashboard",
    expectCommand: "core.dashboard.create",
  },
  {
    id: "13",
    message: "send this every Monday",
    expectCommand: "core.watchRule.create",
    expectMode: "notify",
  },
  {
    id: "14",
    message: "Open a new branch in Nairobi",
    expectCommand: "core.branch.create",
  },
  {
    id: "15",
    message: "inventory is getting low; handle replenishment",
    expectRead: "core.replenishment.propose",
  },
  {
    id: "16",
    message: "why did margins fall this month?",
    expectRead: "core.analytics.marginTrend",
  },
  {
    id: "17",
    message: "show monthly sales by branch and schedule this every Monday",
    expectRead: "core.analytics.salesByLocation",
    expectCommand: "core.watchRule.create",
  },
  {
    id: "18",
    message: "remind branch managers every Friday to review stockouts",
    expectCommand: "core.watchRule.create",
    expectMode: "notify",
  },
];

function evaluate(t: NlTestCase, res: DriveResult): { ok: boolean; reason: string[] } {
  const reasons: string[] = [];
  const allParts = [...res.parts, ...res.confirmed.parts];

  const confirmAction = allParts.find((p) => p.type === "confirm_action");
  const explanations = allParts.filter((p) => p.type === "explanation");
  const plannedCommands = explanations
    .map((p) => String(p.plannedCommand ?? ""))
    .filter(Boolean);

  // Reads that errored mid-flight (e.g. LLM-picked query failing) must fail.
  const readFailed = allParts.some(
    (p) => p.type === "error" || (p.text ?? "").includes("couldn't read that"),
  );
  if (readFailed) reasons.push("a read query failed (error part / 'couldn't read that')");

  const wantCommands = t.expectCommand
    ? Array.isArray(t.expectCommand)
      ? t.expectCommand
      : [t.expectCommand]
    : [];
  for (const c of wantCommands) {
    if (confirmAction?.command !== c) {
      reasons.push(`expected confirm_action.command=${c} got ${confirmAction?.command ?? "none"}`);
    }
  }

  const wantReads = t.expectRead ? (Array.isArray(t.expectRead) ? t.expectRead : [t.expectRead]) : [];
  for (const q of wantReads) {
    if (!plannedCommands.includes(q)) {
      reasons.push(`expected read query ${q} answered, planned=[${plannedCommands.join(", ")}]`);
    }
  }

  if (t.expectMode) {
    const input = (confirmAction?.input ?? {}) as Record<string, unknown>;
    const action = (input.action ?? {}) as Record<string, unknown>;
    if (action.mode !== t.expectMode) {
      reasons.push(`expected action.mode=${t.expectMode} got ${String(action.mode)}`);
    }
  }

  // A write intent must actually be executed (confirmed), not just proposed.
  if (wantCommands.length > 0 && !res.confirmed.ok) {
    reasons.push("write action was not confirmed");
  }
  // A read intent must never park a write confirmation.
  if (wantReads.length > 0 && wantCommands.length === 0 && confirmAction) {
    reasons.push("read intent unexpectedly parked a confirm_action");
  }

  return { ok: reasons.length === 0, reason: reasons };
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = {};
  let failures = 0;
  console.log(`NL driver — ${BASE} (token ${AUTH ? "set" : "MISSING"})\n`);
  for (const t of TESTS) {
    const label = `${t.id.padStart(2, " ")}. ${t.message}`;
    try {
      const res = await drive(t.message);
      const verdict = evaluate(t, res);
      const marker = verdict.ok ? "PASS" : "FAIL";
      if (!verdict.ok) failures += 1;
      const ca = res.parts.concat(res.confirmed.parts).find((p) => p.type === "confirm_action");
      const exp = res.parts.concat(res.confirmed.parts).find((p) => p.type === "explanation");
      results[t.id] = {
        message: t.message,
        ok: verdict.ok,
        reasons: verdict.reason,
        confirmAction: ca ? { command: ca.command, input: ca.input } : null,
        read: exp ? exp.plannedCommand : null,
      };
      console.log(`${marker}  ${label}`);
      if (!verdict.ok) {
        for (const r of verdict.reason) console.log(`      - ${r}`);
      }
    } catch (err) {
      failures += 1;
      results[t.id] = { message: t.message, ok: false, reasons: [(err as Error).message] };
      console.log(`FAIL  ${label}`);
      console.log(`      - ${(err as Error).message}`);
    }
  }
  console.log(`\n${TESTS.length - failures}/${TESTS.length} passing`);
  console.log(JSON.stringify(results, null, 2));
  process.exit(failures);
}

await main();