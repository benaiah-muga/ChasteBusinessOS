import { NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import {
  conversations,
  getDb,
  messages,
  organizations,
  users,
} from "@chaste/db";
import { MODELS, OpenAiCompatAdapter } from "@chaste/ai";
import { runAgentLoop } from "@chaste/kernel";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

type Params = { params: Promise<{ id: string }> };

async function loadConversation(id: string, orgId: string) {
  const db = getDb().db;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.orgId, orgId)))
    .limit(1);
  return conv ?? null;
}

export async function GET(_req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const conv = await loadConversation(id, resolved.orgId);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows = await getDb()
    .db.select(
      { id: messages.id, senderType: messages.senderType, body: messages.body, createdAt: messages.createdAt },
    )
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt))
    .limit(200);
  return NextResponse.json({ conversation: conv, messages: rows });
}

const sendSchema = z.object({ body: z.string().min(1).max(8000) });

export async function POST(req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const conv = await loadConversation(id, resolved.orgId);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = sendSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  // Human posts through the same capability pipeline as the agent.
  const humanCtx = actorFromResolved(resolved, {});
  if (!humanCtx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const sent = await executor.execute("messaging.sendMessage", humanCtx, {
    conversationId: id,
    body: parsed.data.body,
  });
  if (!sent.ok && !sent.pendingApproval) {
    return NextResponse.json({ error: sent.error }, { status: 422 });
  }

  let agentReply: string | null = null;

  if (conv.agentEnabled) {
    // The agent catches up on the thread, then answers under its own authority.
    const nameRows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users);
    const namesById = new Map(nameRows.map((u) => [u.id, u.name ?? u.email]));

    const history = await db
      .select({ senderType: messages.senderType, senderUserId: messages.senderUserId, body: messages.body })
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt))
      .limit(30);
    const transcript = history
      .slice(-12)
      .map((m) => `${m.senderType === "agent" ? "Chaste (you)" : (namesById.get(m.senderUserId ?? "") ?? "colleague")}: ${m.body}`)
      .join("\n");

    const [orgRow] = await db
      .select({ profileDescription: organizations.profileDescription })
      .from(organizations)
      .where(eq(organizations.id, resolved.orgId))
      .limit(1);

    const agentCtx = actorFromResolved(resolved, { asAgent: true });
    if (agentCtx) {
      const result = await runAgentLoop(
        new OpenAiCompatAdapter({ model: MODELS.primary() }),
        registry,
        executor,
        agentCtx,
        {
          sessionId: crypto.randomUUID(),
          systemPrompt: `You are Chaste, the AI co-worker in the internal chat "${conv.title}" of an ERP organization. You can use capabilities when a colleague asks for something operational. Be concise and collegial.${orgRow?.profileDescription ? `\nBusiness context: ${orgRow.profileDescription}` : ""}`,
          userGoal: `Recent conversation:\n${transcript}\n\nRespond to the latest message as Chaste. Post your reply using messaging.sendMessage to conversation ${id}.`,
          maxSteps: 5,
        },
        { file: async () => {} },
      );
      agentReply = result.finalMessage || null;
    }
  }

  return NextResponse.json({ ok: true, agentReply });
}
