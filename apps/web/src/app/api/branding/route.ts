import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, orgBranding } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry, hasPermissionFor } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * The org's print branding. Reads are direct (masking nothing); writes go
 * through the governed iam.setOrgBranding capability.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [row] = await getDb()
    .db.select({
      logoDataUrl: orgBranding.logoDataUrl,
      accentColor: orgBranding.accentColor,
      invoiceFooter: orgBranding.invoiceFooter,
      layout: orgBranding.layout,
    })
    .from(orgBranding)
    .where(eq(orgBranding.orgId, resolved.orgId))
    .limit(1);
  return NextResponse.json({
    branding: row ?? null,
    canEdit: hasPermissionFor({ permissions: resolved.permissions }, "iam.admin"),
  });
}

const bodySchema = z.object({
  logoDataUrl: z
    .string()
    .regex(/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/)
    .max(300_000)
    .optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  invoiceFooter: z.string().max(300).optional(),
  layout: z.enum(["classic", "modern"]).optional(),
  intentId: z.string().optional(),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("iam.setOrgBranding", ctx, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "Branding changes proposed by the workmate wait for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json({ ok: true });
}
