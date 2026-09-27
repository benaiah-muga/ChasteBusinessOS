import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { cookies } from "next/headers";
import { memberships, organizations } from "@chaste/db";
import { hasPermission, logger } from "@chaste/kernel";
import { createGoOrgSwitchAssertion } from "@/server/go-bridge";
import { ACTIVE_ORG_COOKIE, getResolvedUser } from "@/server/session";
import { getDb } from "@chaste/db";

/** Orgs the signed-in user belongs to. */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!resolved.emailVerified) return NextResponse.json({ activeOrgId: null, orgs: [] });

  const all = await getDb()
    .db.select({ id: organizations.id, name: organizations.name, baseCurrency: organizations.baseCurrency })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, resolved.userId));

  return NextResponse.json({ activeOrgId: resolved.orgId, orgs: all });
}

const bodySchema = z.object({ orgId: z.string().uuid() });
const goOrgSwitchResponseSchema = z.object({ ok: z.literal(true) });

function isLoopbackHttpOrHttps(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host);
  return !url.username && !url.password && (url.protocol === "https:" || loopbackHttp);
}

function hasExpectedActiveOrgCookie(header: string | null, orgId: string): header is string {
  if (!header) return false;
  const [cookie, ...attributes] = header.split(";").map((part) => part.trim());
  if (cookie !== `${ACTIVE_ORG_COOKIE}=${orgId}` || attributes.length !== 4) return false;
  const normalized = attributes.map((attribute) => attribute.toLowerCase());
  return ["path=/", "max-age=7776000", "httponly", "samesite=lax"].every((expected) =>
    normalized.includes(expected),
  );
}

function orgServiceUnavailable() {
  return NextResponse.json(
    { error: "organization service unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function switchOrganizationInGo(input: { userId: string; orgId: string }): Promise<Response> {
  const secret = process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret) {
    logger.warn("Go organization switch unavailable: bridge secret is not configured");
    return orgServiceUnavailable();
  }

  try {
    const assertion = createGoOrgSwitchAssertion(input, secret);
    const baseUrl = process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080";
    const parsedBaseUrl = new URL(baseUrl);
    if (!isLoopbackHttpOrHttps(parsedBaseUrl)) {
      logger.warn("Go organization switch unavailable: bridge URL must use loopback HTTP or HTTPS");
      return orgServiceUnavailable();
    }
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/__go/org/switch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chaste-Session-Assertion": assertion,
      },
      body: JSON.stringify({ orgId: input.orgId }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    });

    if (response.status === 403) {
      const body = await response.json().catch(() => null);
      if (body && typeof body === "object" && "error" in body && body.error === "not a member of that organization") {
        return NextResponse.json(
          { error: "not a member of that organization" },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      logger.warn("Go organization switch returned an unexpected forbidden response");
      return orgServiceUnavailable();
    }
    if (!response.ok) {
      logger.warn("Go organization switch failed", { status: response.status });
      return orgServiceUnavailable();
    }

    const parsedBody = goOrgSwitchResponseSchema.safeParse(await response.json().catch(() => null));
    const setCookie = response.headers.get("set-cookie");
    if (!parsedBody.success || !hasExpectedActiveOrgCookie(setCookie, input.orgId)) {
      logger.warn("Go organization switch returned an invalid response");
      return orgServiceUnavailable();
    }

    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store", "Set-Cookie": setCookie } },
    );
  } catch {
    logger.warn("Go organization switch failed");
    return orgServiceUnavailable();
  }
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!resolved.emailVerified) {
    return NextResponse.json({ error: "email verification required" }, { status: 403 });
  }

  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  if (process.env.GO_ORG_SWITCH === "1") {
    return switchOrganizationInGo({ userId: resolved.userId, orgId: body.data.orgId });
  }

  const db = getDb().db;
  const [m] = await db
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.orgId, body.data.orgId), eq(memberships.userId, resolved.userId)),
    )
    .limit(1);
  if (!m) return NextResponse.json({ error: "not a member of that organization" }, { status: 403 });

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, body.data.orgId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  return NextResponse.json({ ok: true });
}

const soulSchema = z.object({ agentSoul: z.string().max(8000) });

/**
 * Updates the org's standing agent persona (SOUL). Admin-gated: this text
 * steers every agent turn for the whole organization.
 */
export async function PATCH(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission({ permissions: resolved.permissions }, "iam.admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = soulSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  await db
    .update(organizations)
    .set({ agentSoul: body.data.agentSoul.trim() || null })
    .where(eq(organizations.id, resolved.orgId));
  return NextResponse.json({ ok: true });
}

/** Returns the org's current SOUL text for the settings editor. */
export async function PUT() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [org] = await getDb()
    .db.select({ agentSoul: organizations.agentSoul })
    .from(organizations)
    .where(eq(organizations.id, resolved.orgId))
    .limit(1);
  return NextResponse.json({ agentSoul: org?.agentSoul ?? "" });
}
