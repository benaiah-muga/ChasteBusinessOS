import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, ssoConnections } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * SSO connection management (groundwork). Stores IdP metadata, entity id,
 * SSO URL, public signing certificate, domain routing. Actual SAML/OIDC
 * assertion exchange is performed by the identity provider integration
 * (better-auth SSO plugin) at login time; this surface is the admin CRUD.
 */

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission({ permissions: resolved.permissions }, "iam.admin")) {
    return NextResponse.json({ error: "requires iam.admin permission" }, { status: 403 });
  }
  const rows = await getDb().db
    .select({
      id: ssoConnections.id,
      protocol: ssoConnections.protocol,
      label: ssoConnections.label,
      idpEntityId: ssoConnections.idpEntityId,
      ssoUrl: ssoConnections.ssoUrl,
      domain: ssoConnections.domain,
      status: ssoConnections.status,
      createdAt: ssoConnections.createdAt,
    })
    .from(ssoConnections)
    .where(eq(ssoConnections.orgId, resolved.orgId));
  return NextResponse.json({ connections: rows });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission({ permissions: resolved.permissions }, "iam.admin")) {
    return NextResponse.json({ error: "requires iam.admin permission" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as {
    protocol?: string;
    label?: string;
    idpEntityId?: string;
    ssoUrl?: string;
    idpCertificate?: string;
    domain?: string;
  } | null;
  if (!body?.protocol || !["saml", "oidc"].includes(body.protocol)) {
    return NextResponse.json({ error: "protocol must be saml or oidc" }, { status: 400 });
  }
  if (!body.idpEntityId || !body.ssoUrl || !body.label) {
    return NextResponse.json({ error: "label, idpEntityId and ssoUrl required" }, { status: 400 });
  }
  if (body.domain && !/^[a-z0-9.-]+$/i.test(body.domain)) {
    return NextResponse.json({ error: "domain must be a bare hostname" }, { status: 400 });
  }
  const [row] = await getDb().db
    .insert(ssoConnections)
    .values({
      orgId: resolved.orgId,
      protocol: body.protocol,
      label: body.label,
      idpEntityId: body.idpEntityId,
      ssoUrl: body.ssoUrl,
      idpCertificate: body.idpCertificate ?? null,
      domain: body.domain ?? null,
      createdByUserId: resolved.userId,
    })
    .returning({ id: ssoConnections.id });
  return NextResponse.json({ id: row!.id }, { status: 201 });
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
    .update(ssoConnections)
    .set({ status: "disabled" })
    .where(and(eq(ssoConnections.orgId, resolved.orgId), eq(ssoConnections.id, id)));
  return NextResponse.json({ ok: true });
}
