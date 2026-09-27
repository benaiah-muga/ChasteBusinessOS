import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { logger } from "@chaste/kernel";
import { createGoLedgerAssertion } from "@/server/go-bridge";
import { recentLedgerEvents } from "@/server/kernel";
import { missingPermission } from "@/server/route-guards";
import { getResolvedUser } from "@/server/session";

const ledgerEventSchema = z.object({
  seq: z.number().int(),
  kind: z.string(),
  capabilityId: z.string().nullable(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  sessionId: z.string().nullable(),
  payload: z.unknown(),
  hash: z.string(),
  prevHash: z.string().nullable(),
  occurredAt: z.string().datetime(),
});

const goLedgerResponseSchema = z.object({ events: z.array(ledgerEventSchema) });
type GoLedgerResponse = z.infer<typeof goLedgerResponseSchema>;

async function readGoLedger(input: { userId: string; orgId: string; limit: number }): Promise<GoLedgerResponse | null> {
  const secret = process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret) {
    logger.warn("Go ledger read unavailable: bridge secret is not configured");
    return null;
  }

  try {
    const assertion = createGoLedgerAssertion(
      { userId: input.userId, orgId: input.orgId, canReadLedger: true },
      secret,
    );
    const baseUrl = process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080";
    const parsedBaseUrl = new URL(baseUrl);
    const bridgeHost = parsedBaseUrl.hostname.replace(/^\[|\]$/g, "");
    const loopbackHttp =
      parsedBaseUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(bridgeHost);
    if (
      parsedBaseUrl.username ||
      parsedBaseUrl.password ||
      (parsedBaseUrl.protocol !== "https:" && !loopbackHttp)
    ) {
      logger.warn("Go ledger read unavailable: bridge URL must use loopback HTTP or HTTPS");
      return null;
    }
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/__go/ledger?limit=${input.limit}`, {
      method: "GET",
      headers: { "X-Chaste-Session-Assertion": assertion },
      cache: "no-store",
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) {
      logger.warn("Go ledger read failed", { status: response.status });
      return null;
    }
    const parsed = goLedgerResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      logger.warn("Go ledger read returned an invalid response");
      return null;
    }
    return parsed.data;
  } catch {
    logger.warn("Go ledger read failed");
    return null;
  }
}

function parseLimit(req: Request): number {
  const raw = Number(new URL(req.url).searchParams.get("limit") ?? 60);
  return Number.isFinite(raw) ? Math.floor(Math.max(1, Math.min(raw, 200))) : 60;
}

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "accounting.read");
  if (denied) return denied;

  const limit = parseLimit(req);
  const goReadEnabled = process.env.GO_LEDGER_READ === "1";
  const shadowEnabled =
    !goReadEnabled && process.env.NODE_ENV === "development" && process.env.GO_LEDGER_SHADOW === "1";
  const legacyPayload = !goReadEnabled || shadowEnabled
    ? { events: await recentLedgerEvents(resolved.orgId, getDb().db, limit) }
    : null;

  if (goReadEnabled || shadowEnabled) {
    const goPayload = await readGoLedger({ userId: resolved.userId, orgId: resolved.orgId, limit });
    if (goReadEnabled && !goPayload) {
      return NextResponse.json(
        { error: "ledger service unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (goPayload && legacyPayload && JSON.stringify(goPayload) !== JSON.stringify(legacyPayload)) {
      logger.warn("Go ledger read differs from legacy data");
    }
    if (goReadEnabled && goPayload) {
      return NextResponse.json(goPayload, { headers: { "Cache-Control": "no-store" } });
    }
  }

  if (!legacyPayload) {
    return NextResponse.json({ error: "ledger service unavailable" }, { status: 503 });
  }
  return NextResponse.json(legacyPayload);
}
