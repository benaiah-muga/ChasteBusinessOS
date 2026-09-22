import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, harnessCompositions } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { inspectComposition } from "@chaste/harness";
import { getResolvedUser } from "@/server/session";
import { parseHarnessComposition } from "@/server/harness-compositions";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const mayInspect =
    hasPermission({ permissions: resolved.permissions }, "iam.admin") ||
    hasPermission({ permissions: resolved.permissions }, "harness.approve");
  if (!mayInspect) return NextResponse.json({ error: "requires harness.approve permission" }, { status: 403 });

  const rows = await getDb()
    .db.select()
    .from(harnessCompositions)
    .where(eq(harnessCompositions.orgId, resolved.orgId))
    .orderBy(desc(harnessCompositions.createdAt))
    .limit(50);
  return NextResponse.json({
    compositions: rows.map((row) => {
      const parsed = parseHarnessComposition(row);
      return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        inspection: inspectComposition({
          profile: parsed.profile,
          profileDigest: row.profileDigest,
          compositionDigest: row.compositionDigest,
          bundles: parsed.bundles,
          patches: parsed.patches,
        }),
      };
    }),
  });
}
