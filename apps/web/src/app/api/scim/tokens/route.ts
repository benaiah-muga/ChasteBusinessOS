import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { getDb, scimTokens } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { getResolvedUser } from "@/server/session";

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await getDb().db
    .select({
      id: scimTokens.id,
      label: scimTokens.label,
      active: scimTokens.active,
      expiresAt: scimTokens.expiresAt,
      lastUsedAt: scimTokens.lastUsedAt,
      createdAt: scimTokens.createdAt,
    })
    .from(scimTokens)
    .where(eq(scimTokens.orgId, resolved.orgId));
  return NextResponse.json({ tokens: rows });
}

/**
 * Creates a SCIM bearer token. The raw token is returned exactly once;
 * only its SHA-256 lands in the database. Expiry policy (0054): tokens live
 * 90 days by default (1–365 configurable); rotation is create-new then
 * deactivate-old, and the IdP route refuses expired tokens outright.
 */
export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission({ permissions: resolved.permissions }, "iam.admin")) {
    return NextResponse.json({ error: "requires iam.admin permission" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { label?: string; expiresInDays?: number };
  const expiresInDays = body.expiresInDays ?? 90;
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
    return NextResponse.json({ error: "expiresInDays must be an integer between 1 and 365" }, { status: 400 });
  }
  const raw = `scim_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
  const [row] = await getDb().db
    .insert(scimTokens)
    .values({
      orgId: resolved.orgId,
      tokenHash: hashToken(raw),
      label: body.label ?? "IdP provisioning",
      expiresAt,
      createdByUserId: resolved.userId,
    })
    .returning({ id: scimTokens.id, label: scimTokens.label, expiresAt: scimTokens.expiresAt });
  return NextResponse.json({ token: raw, id: row!.id, label: row!.label, expiresAt: row!.expiresAt }, { status: 201 });
}

export async function DELETE(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission({ permissions: resolved.permissions }, "iam.admin")) {
    return NextResponse.json({ error: "requires iam.admin permission" }, { status: 403 });
  }
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await getDb().db
    .update(scimTokens)
    .set({ active: false })
    .where(and(eq(scimTokens.orgId, resolved.orgId), eq(scimTokens.id, id)));
  return NextResponse.json({ ok: true });
}
