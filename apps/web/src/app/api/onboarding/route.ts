import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { runOnboarding } from "@/server/onboarding";
import { getResolvedUser } from "@/server/session";

const bodySchema = z.object({
  orgName: z.string().min(2).max(80),
  businessDescription: z.string().min(20).max(8000),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (resolved.orgId) return NextResponse.json({ error: "already onboarded" }, { status: 409 });

  const body = bodySchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body", detail: body.error.issues }, { status: 400 });

  try {
    const result = await runOnboarding(getDb().db, {
      userId: resolved.userId,
      userEmail: resolved.email,
      orgName: body.data.orgName,
      businessDescription: body.data.businessDescription,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 422 });
  }
}
