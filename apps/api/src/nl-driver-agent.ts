/**
 * Agentic (tool-loop) NL driver — novel, non-deterministic requests that the
 * rule parser misses, so the response is produced by the permission-filtered
 * native function-calling loop (muse-glimmer-30b on NVIDIA NIM). Unlike the
 * deterministic drivers, outcomes are evaluated behaviorally:
 *
 *   - READ requests must yield a prose answer that surfaces real org data
 *     (fails on the "No structured intent matched" fallback or any error part).
 *   - WRITE requests must park a confirm_action whose plan contains the
 *     expected command — proving the model discovered the tool, resolved names
 *     → ids via read tools, and chose the write (which is gated for approval).
 *
 * Confirmations are NOT auto-approved here: the deterministic drivers already
 * cover the confirm/execute path; this driver proves the agentic discovery
 * path end to end.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3001 AUTH_TOKEN=<bearer> \
 *     tsx --env-file=../../.env src/nl-driver-agent.ts
 *
 * Output: per-request pass/warn/fail + JSON summary. Exit code = failures.
 */

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3001";
const AUTH = process.env.AUTH_TOKEN ?? "";

interface UiPart {
  type: string;
  text?: string;
  command?: string;
  input?: Record<string, unknown>;
  steps?: Array<{ command: string; input?: Record<string, unknown>; description?: string }>;
  [key: string]: unknown;
}

interface ChatMessage {
  role: string;
  parts: UiPart[];
}

interface ChatResponse {
  sessionId: string;
  messages: ChatMessage[];
}

async function chat(body: Record<string, unknown>): Promise<ChatResponse> {
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

async function drive(message: string): Promise<UiPart[]> {
  const sessionId = crypto.randomUUID();
  const r1 = await chat({ sessionId, message });
  return (r1.messages ?? [])
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts ?? []);
}

interface AgentCase {
  id: string;
  message: string;
  kind: "read" | "write";
  /** Expected command present in the parked plan (write cases). */
  expectCommand?: string;
  /**
   * Command that must NOT appear in the parked plan: the target already
   * exists, so proposing its create is a redundant write (research doc
   * §Preventing superfluous writes). WARN if it still shows up.
   */
  redundantCreate?: string;
}

const CASES: AgentCase[] = [
  {
    id: "a1",
    message: "What is the total value of purchase orders we have placed so far?",
    kind: "read",
  },
  {
    id: "a2",
    message: "Create a purchase order PO-2026-0100 for Kampala Flour Mills totaling 6,200,000 UGX",
    kind: "write",
    expectCommand: "pur.po.create",
  },
  {
    id: "a3",
    message: "Which vendor supplies our wheat flour and how much have we ordered from them?",
    kind: "read",
  },
  {
    id: "a4",
    message: "Raise an invoice INV-1150 for Ntinda Supermarket for 1,250,000 UGX",
    kind: "write",
    expectCommand: "acc.invoice.create",
  },
  {
    id: "a5",
    message: "Add Kampala Flour Mills as a vendor for purchase orders",
    kind: "write",
    redundantCreate: "pur.vendor.create",
  },
];

function planCommands(parts: UiPart[]): string[] {
  const confirm = parts.find((p) => p.type === "confirm_action");
  const steps = (confirm?.steps ?? confirm?.input?.steps) as
    | Array<{ command: string }>
    | undefined;
  if (steps) return steps.map((s) => s.command);
  const cmd = String(confirm?.command ?? "");
  return cmd ? cmd.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function evaluate(t: AgentCase, parts: UiPart[]): { ok: boolean; warn: boolean; reason: string[] } {
  const reasons: string[] = [];
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ");
  const clarified = parts.some((p) => p.type === "clarify") || text.includes("I need a bit more information to proceed.");

  if (parts.some((p) => p.type === "error")) {
    reasons.push("response contains an error part");
  }
  if (text.includes("No structured intent matched")) {
    reasons.push("pipeline fell back to 'No structured intent matched' (tool loop did not run)");
  }

  if (t.kind === "read") {
    if (!text) reasons.push("no text answer produced");
    if (text.includes("step budget")) {
      reasons.push("tool loop exhausted its budget and rendered raw data instead of answering");
      return { ok: false, warn: true, reason: reasons };
    }
    const citesData =
      /[\d,]+/.test(text) ||
      /PO-|INV-|UGX/i.test(text) ||
      /[A-Z][a-z]+ [A-Z][a-z]+/.test(text);
    if (!citesData) {
      reasons.push("answer does not cite any org data (no amounts, codes, or business names)");
    }
  } else if (t.redundantCreate) {
    // The target already exists in the seed — a create must NOT be proposed.
    const commands = planCommands(parts);
    if (commands.includes(t.redundantCreate)) {
      reasons.push(
        `redundant create ${t.redundantCreate} still proposed in the parked plan (existence gate missed it)`,
      );
      return { ok: false, warn: true, reason: reasons };
    }
    if (commands.length > 0) {
      reasons.push(`unexpected write parked for an existing vendor: [${commands.join(", ")}]`);
      return { ok: false, warn: true, reason: reasons };
    }
    if (!text) reasons.push("no text answer produced");
  } else {
    if (clarified) {
      reasons.push("model requested clarification instead of proposing the write");
      return { ok: false, warn: true, reason: reasons };
    }
    const commands = planCommands(parts);
    if (commands.length === 0) {
      reasons.push("no confirm_action/plan was parked (write not proposed)");
    } else if (t.expectCommand && !commands.includes(t.expectCommand!)) {
      reasons.push(`expected plan to include ${t.expectCommand}, got [${commands.join(", ")}]`);
      return { ok: false, warn: true, reason: reasons };
    }
  }

  return { ok: reasons.length === 0, warn: false, reason: reasons };
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = {};
  let failures = 0;
  console.log(`Agentic NL driver — ${BASE} (token ${AUTH ? "set" : "MISSING"})\n`);
  for (const t of CASES) {
    const label = `${t.id}. ${t.message}`;
    try {
      const parts = await drive(t.message);
      const verdict = evaluate(t, parts);
      const marker = verdict.ok ? "PASS" : verdict.warn ? "WARN" : "FAIL";
      if (!verdict.ok && !verdict.warn) failures += 1;
      const confirm = parts.find((p) => p.type === "confirm_action");
      results[t.id] = {
        message: t.message,
        ok: verdict.ok,
        warn: verdict.warn,
        reasons: verdict.reason,
        parkedPlan: confirm ? planCommands(parts) : null,
        answer: parts.find((p) => p.type === "text")?.text?.slice(0, 200) ?? null,
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
  console.log(`\n${CASES.length - failures}/${CASES.length} passing`);
  console.log(JSON.stringify(results, null, 2));
  process.exit(failures);
}

await main();