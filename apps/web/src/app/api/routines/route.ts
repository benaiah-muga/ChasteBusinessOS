import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, routines } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { refineScheduleText } from "@/server/routines";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().min(1).max(120),
    prompt: z.string().min(1).max(4000),
    scheduleText: z.string().min(3).max(200),
    withWebhook: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("update"),
    routineId: z.string().uuid(),
    name: z.string().min(1).max(120).optional(),
    prompt: z.string().min(1).max(4000).optional(),
    scheduleText: z.string().min(3).max(200).optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ action: z.literal("delete"), routineId: z.string().uuid() }),
  z.object({ action: z.literal("runNow"), routineId: z.string().uuid() }),
]);

const CAP_BY_ACTION = {
  create: "routines.create",
  update: "routines.update",
  delete: "routines.delete",
  runNow: "routines.runNow",
} as const;

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const result = await buildExecutor(db, buildRegistry(db)).execute("routines.list", ctx, {});
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  // Webhook URLs are joined here, not in the capability output: the token is
  // a trigger capability in itself and stays out of agent-visible results.
  const origin = new URL(req.url).origin;
  const tokenRows = await db
    .select({ id: routines.id, token: routines.webhookToken })
    .from(routines)
    .where(eq(routines.orgId, resolved.orgId));
  const tokenById = new Map(tokenRows.filter((r) => r.token).map((r) => [r.id, r.token!]));
  return NextResponse.json({
    routines: (result.data as { routines: Array<Record<string, unknown>> }).routines.map((r) => ({
      ...r,
      webhookUrl: tokenById.has(r.id as string)
        ? `${origin}/api/routines/webhook/${tokenById.get(r.id as string)}`
        : null,
    })),
  });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const executor = buildExecutor(db, buildRegistry(db));

  let input: z.infer<typeof actionSchema> = parsed.data;

  // Natural-language scheduling: parse deterministically first; only fall
  // back to the model normalizer when the words are not a known shape.
  if ((input.action === "create" || input.action === "update") && input.scheduleText) {
    const { parseScheduleText } = await import("@chaste/erp-core");
    if (!parseScheduleText(input.scheduleText).ok) {
      const refined = await refineScheduleText(input.scheduleText);
      if (refined) {
        input = { ...input, scheduleText: refined } as typeof input;
      } else {
        return NextResponse.json(
          {
            error:
              "Could not read that schedule. Try 'every 30 minutes', 'daily at 08:00', 'weekdays at 9am' or 'weekly on monday at 09:00'.",
          },
          { status: 422 },
        );
      }
    }
  }

  const result: { ok: boolean; data?: unknown; error?: string } = await executor.execute(
    CAP_BY_ACTION[input.action],
    ctx,
    input,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });

  if (input.action === "create") {
    const data = result.data as { webhookToken: string | null; [key: string]: unknown };
    const webhookUrl = data.webhookToken
      ? `${new URL(req.url).origin}/api/routines/webhook/${data.webhookToken}`
      : null;
    return NextResponse.json({ ...data, webhookUrl });
  }
  return NextResponse.json(result.data);
}
