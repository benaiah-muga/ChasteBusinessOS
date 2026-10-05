import { NextResponse } from "next/server";
import { getDb } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { DurableRunResponseLimitError, getDurableRun } from "@/server/durable-runs";
import { getResolvedUser } from "@/server/session";
import { durableRunResponseExceedsBounds } from "@/server/response-limits";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const isAdmin = hasPermission({ permissions: resolved.permissions }, "iam.admin");
  let detail: Awaited<ReturnType<typeof getDurableRun>>;
  try {
    detail = await getDurableRun(getDb().db, resolved.orgId, id, { userId: resolved.userId, admin: isAdmin });
  } catch (error) {
    if (error instanceof DurableRunResponseLimitError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    throw error;
  }
  if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });

  const serialize = (value: Date | null) => value?.toISOString() ?? null;
  const response = {
    run: {
      ...detail.run,
      createdAt: detail.run.createdAt.toISOString(),
      updatedAt: detail.run.updatedAt.toISOString(),
      startedAt: serialize(detail.run.startedAt),
      finishedAt: serialize(detail.run.finishedAt),
    },
    steps: detail.steps.map((step) => ({
      ...step,
      createdAt: step.createdAt.toISOString(),
      startedAt: serialize(step.startedAt),
      finishedAt: serialize(step.finishedAt),
    })),
  };
  if (durableRunResponseExceedsBounds(response, detail.steps.length)) {
    return NextResponse.json({ error: "durable run detail exceeds response limits" }, { status: 413 });
  }
  return NextResponse.json(response);
}
