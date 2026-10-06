import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { eq } from "drizzle-orm";
import { organizations } from "@chaste/db";
import {
  ONBOARDING_STEPS,
  completeOnboarding,
  parseOnboardingState,
  setOnboardingStep,
} from "@/server/onboarding";
import { getResolvedUser } from "@/server/session";
import { proxyGoOnboardingCreate } from "@/server/onboarding-go-proxy";

/**
 * Every failure carries a machine-readable `code` so the wizard can explain
 * what happened in plain language and offer the right way out, instead of
 * echoing a server string at someone who just wanted to set up their books.
 */
type ErrorCode =
  | "unauthorized"
  | "already_onboarded"
  | "intent_conflict"
  | "rate_limited"
  | "invalid"
  | "not_found"
  | "server_error";

function fail(code: ErrorCode, message: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, code, ...extra }, { status });
}

const stepKeySchema = z.enum(ONBOARDING_STEPS);

const updateSchema = z.object({
  step: stepKeySchema.optional(),
  status: z.enum(["done", "pending", "skipped"]).optional(),
  complete: z.boolean().optional(),
});

export async function POST(req: Request) {
  // Go resolves the live session and is the sole organization bootstrap writer.
  return proxyGoOnboardingCreate(req);
}

/**
 * Where this workspace is in its setup. Drives the dashboard checklist, which
 * is the whole point of tracking deferred steps: skipped must never mean lost.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved) {
    return fail("unauthorized", "Your session has expired. Sign in again to continue.", 401);
  }
  if (!resolved.orgId) {
    return NextResponse.json({ state: null, steps: [] });
  }

  const [row] = await getDb()
    .db.select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, resolved.orgId))
    .limit(1);

  const state = row ? parseOnboardingState(row.settings) : null;
  if (!state || state.finishedAt) {
    return NextResponse.json({ state: state ?? null, steps: [] });
  }

  // Only unfinished steps are worth a checklist line.
  const steps = ONBOARDING_STEPS.filter((k) => state.steps[k] === "pending" || state.steps[k] === "skipped").map(
    (k) => ({ key: k, status: state.steps[k] }),
  );
  return NextResponse.json({ state, steps });
}

/** Marks a deferred step done, defers it, or seals the whole setup. */
export async function PATCH(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved) {
    return fail("unauthorized", "Your session has expired. Sign in again to continue.", 401);
  }
  if (!resolved.orgId) {
    return fail("not_found", "Set up your workspace first.", 409);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid", "Could not read that request.", 400);
  }

  const body = updateSchema.safeParse(raw);
  if (!body.success) return fail("invalid", "That doesn't look right.", 400);

  try {
    const db = getDb().db;
    if (body.data.complete) {
      return NextResponse.json({ state: await completeOnboarding(db, resolved.orgId) });
    }
    if (!body.data.step || !body.data.status) {
      return fail("invalid", "A step and a status are both required.", 400);
    }
    const state = await setOnboardingStep(db, resolved.orgId, body.data.step, body.data.status, resolved.userId);
    return NextResponse.json({ state });
  } catch (err) {
    return fail("server_error", err instanceof Error ? err.message : String(err), 422);
  }
}
