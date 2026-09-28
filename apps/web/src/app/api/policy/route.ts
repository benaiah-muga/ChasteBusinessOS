import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb, policies } from "@chaste/db";
import { logger } from "@chaste/kernel";
import type { components } from "@/generated/go-internal-v1";
import { createGoPolicyAssertion } from "@/server/go-bridge";
import { actorFromResolved, buildExecutor, buildRegistry, hasPermissionFor } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

type GoPolicyResponse = components["schemas"]["GoPolicyResponse"];

const goPolicyResponseSchema: z.ZodType<GoPolicyResponse> = z.object({
  policy: z.object({
    maxRiskAutonomous: z.string(),
    moneyThresholdMinor: z.number().int(),
    requiresApprovalFor: z.array(z.unknown()),
  }),
  canEdit: z.boolean(),
});

async function readGoPolicy(input: {
  userId: string;
  orgId: string;
  canEdit: boolean;
}): Promise<GoPolicyResponse | null> {
  const secret = process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret) {
    logger.warn("Go policy read unavailable: bridge secret is not configured");
    return null;
  }

  try {
    const assertion = createGoPolicyAssertion(input, secret);
    const baseUrl = process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080";
    const parsedBaseUrl = new URL(baseUrl);
    const bridgeHost = parsedBaseUrl.hostname.replace(/^\[|\]$/g, "");
    const loopbackHttp =
      parsedBaseUrl.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(bridgeHost);
    if (
      parsedBaseUrl.username ||
      parsedBaseUrl.password ||
      (parsedBaseUrl.protocol !== "https:" && !loopbackHttp)
    ) {
      logger.warn("Go policy read unavailable: bridge URL must use loopback HTTP or HTTPS");
      return null;
    }
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/__go/policy`, {
      method: "GET",
      headers: { "X-Chaste-Session-Assertion": assertion },
      cache: "no-store",
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) {
      logger.warn("Go policy read failed", { status: response.status });
      return null;
    }
    const parsed = goPolicyResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      logger.warn("Go policy read returned an invalid response");
      return null;
    }
    return parsed.data;
  } catch {
    logger.warn("Go policy read failed");
    return null;
  }
}

async function readLegacyPolicy(input: { orgId: string; canEdit: boolean }): Promise<GoPolicyResponse> {
  const [row] = await getDb()
    .db.select()
    .from(policies)
    .where(and(eq(policies.orgId, input.orgId), eq(policies.capabilityPattern, "*")))
    .limit(1);
  return {
    policy: {
      maxRiskAutonomous: row?.maxRiskAutonomous ?? "write",
      moneyThresholdMinor: row?.moneyThresholdMinor ?? 50_000,
      requiresApprovalFor: Array.isArray(row?.requiresApprovalFor) ? (row.requiresApprovalFor as string[]) : [],
    },
    canEdit: input.canEdit,
  };
}

async function compareLegacyPolicy(input: {
  legacyPolicy: GoPolicyResponse;
  goPolicy: GoPolicyResponse;
}): Promise<void> {
  if (process.env.NODE_ENV !== "development" || process.env.GO_POLICY_SHADOW !== "1") return;
  const { legacyPolicy, goPolicy } = input;
  const matches =
    goPolicy.canEdit === legacyPolicy.canEdit &&
    goPolicy.policy.maxRiskAutonomous === legacyPolicy.policy.maxRiskAutonomous &&
    goPolicy.policy.moneyThresholdMinor === legacyPolicy.policy.moneyThresholdMinor &&
    goPolicy.policy.requiresApprovalFor.length === legacyPolicy.policy.requiresApprovalFor.length &&
    goPolicy.policy.requiresApprovalFor.every((risk, index) => risk === legacyPolicy.policy.requiresApprovalFor[index]);
  if (!matches) logger.warn("Go policy read differs from legacy data");
}
/**
 * The org's blanket autonomy policy (ADR 0055). Reading is open to members;
 * writing is the governed iam.setOrgPolicy capability (identity-class), so
 * a human admin applies changes directly and the workmate's proposals land
 * in the Approvals inbox.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const canEdit = hasPermissionFor({ permissions: resolved.permissions }, "iam.admin");
  const goReadEnabled = process.env.GO_POLICY_READ === "1";
  const shadowEnabled = process.env.NODE_ENV === "development" && process.env.GO_POLICY_SHADOW === "1";
  const legacyPayload = !goReadEnabled || shadowEnabled ? await readLegacyPolicy({ orgId: resolved.orgId, canEdit }) : null;

  if (goReadEnabled || shadowEnabled) {
    const goPayload = await readGoPolicy({ userId: resolved.userId, orgId: resolved.orgId, canEdit });
    if (goReadEnabled && (!goPayload || goPayload.canEdit !== canEdit)) {
      return NextResponse.json({ error: "policy service unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (goPayload && legacyPayload) await compareLegacyPolicy({ legacyPolicy: legacyPayload, goPolicy: goPayload });
    if (goReadEnabled && goPayload) {
      return NextResponse.json(goPayload, { headers: { "Cache-Control": "no-store" } });
    }
  }

  if (!legacyPayload) return NextResponse.json({ error: "policy service unavailable" }, { status: 503 });
  return NextResponse.json(legacyPayload);
}

const bodySchema = z.object({
  maxRiskAutonomous: z.enum(["read", "write", "money", "identity", "destructive"]),
  moneyThresholdMinor: z.number().int().min(0).max(1_000_000_000).optional(),
  requiresApprovalFor: z.array(z.enum(["identity", "destructive", "money", "*"])).max(4).default([]),
  intentId: z.string().optional(),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("iam.setOrgPolicy", ctx, {
    maxRiskAutonomous: parsed.data.maxRiskAutonomous,
    ...(parsed.data.moneyThresholdMinor !== undefined ? { moneyThresholdMinor: parsed.data.moneyThresholdMinor } : {}),
    requiresApprovalFor: parsed.data.requiresApprovalFor,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "Policy changes proposed by the workmate wait for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json({ ok: true, data: result.data });
}
