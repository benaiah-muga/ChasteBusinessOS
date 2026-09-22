import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * Conversation lifecycle: rename, workmate participation, archive/restore,
 * leave, add member, delete. Thin route - auth plus dispatch; every rule
 * (membership, DM restrictions, creator checks) lives in the capability.
 */
const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"),
    title: z.string().min(1).max(80).optional(),
    agentEnabled: z.boolean().optional(),
    intentId: z.string().optional(),
  }),
  z.object({
    action: z.literal("archive"),
    archived: z.boolean().default(true),
    intentId: z.string().optional(),
  }),
  z.object({ action: z.literal("leave"), intentId: z.string().optional() }),
  z.object({ action: z.literal("addMember"), userId: z.string().uuid(), intentId: z.string().optional() }),
  z.object({ action: z.literal("delete"), intentId: z.string().optional() }),
]);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  const result = await (async () => {
    switch (parsed.data.action) {
      case "update":
        return executor.execute("messaging.updateConversation", ctx, {
          conversationId: id,
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.agentEnabled !== undefined ? { agentEnabled: parsed.data.agentEnabled } : {}),
        });
      case "archive":
        return executor.execute("messaging.archiveConversation", ctx, { conversationId: id, archived: parsed.data.archived });
      case "leave":
        return executor.execute("messaging.leaveConversation", ctx, { conversationId: id });
      case "addMember":
        return executor.execute("messaging.addMember", ctx, { conversationId: id, userId: parsed.data.userId });
      case "delete":
        return executor.execute("messaging.deleteConversation", ctx, { conversationId: id });
    }
  })();

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "This change waits for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json({ ok: true, data: result.data });
}
