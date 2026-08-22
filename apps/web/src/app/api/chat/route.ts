import { NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { agentSessions, getDb, organizations, sessionEvents, tickets } from "@chaste/db";
import { runAgentLoop, type TicketSink } from "@chaste/kernel";
import { OpenAiCompatAdapter, MODELS } from "@chaste/ai";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

export const maxDuration = 120;

const bodySchema = z.object({
  message: z.string().min(1).max(8000),
  sessionId: z.string().uuid().optional(),
});

const systemPromptFor = (orgName: string) => `You are the ChasteBusinessOS assistant for "${orgName}".
You operate an ERP through registered capabilities. Rules:
- Prefer tools over prose when the user wants something done; confirm results with specifics (numbers, ids).
- Amounts are in minor units (cents). Quantities are thousandths of a unit.
- If a tool returns pendingApproval: true, tell the user approval is required and it's waiting in the Approvals inbox.
- If no capability fits, say so honestly and call file_ticket.
- Never invent capabilities, accounts, or numbers.`;

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, { asAgent: true });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const body = bodySchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const model = new OpenAiCompatAdapter({ model: MODELS.primary() });

  let sessionId = body.data.sessionId;
  if (sessionId) {
    await db.update(agentSessions).set({ updatedAt: new Date() }).where(eq(agentSessions.id, sessionId));
  } else {
    const [session] = await db
      .insert(agentSessions)
      .values({
        orgId: ctx.actor.orgId,
        userId: ctx.actor.id,
        title: body.data.message.slice(0, 80),
        mode: "assist",
        modelRef: MODELS.primary(),
      })
      .returning({ id: agentSessions.id });
    sessionId = session!.id;
  }
  ctx.sessionId = sessionId;

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, ctx.actor.orgId))
    .limit(1);

  const ticketSink: TicketSink = {
    file: async (orgId, title, description) => {
      await db.insert(tickets).values({ orgId, title, description });
    },
  };

  let seq =
    (
      await db
        .select({ seq: sessionEvents.seq })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId))
        .orderBy(desc(sessionEvents.seq))
        .limit(1)
    )[0]?.seq ?? 0;
  await db.insert(sessionEvents).values({ sessionId, seq: ++seq, role: "user", content: { text: body.data.message } });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await runAgentLoop(
          model,
          registry,
          executor,
          ctx,
          {
            sessionId,
            systemPrompt: systemPromptFor(org?.name ?? "your organization"),
            userGoal: body.data!.message,
            maxSteps: 8,
            onDelta: (text) => send({ type: "delta", text }),
            onEvent: (event) => {
              if (event.role === "tool_call") {
                const c = event.content as { name: string };
                send({ type: "tool", name: c.name });
              }
              if (event.role === "tool_call" || event.role === "tool_result") {
                seq += 1;
                void db
                  .insert(sessionEvents)
                  .values({ sessionId, seq, role: event.role, content: event.content as object })
                  .catch(() => {});
              }
            },
          },
          ticketSink,
        );
        seq += 1;
        await db.insert(sessionEvents).values({ sessionId, seq, role: "assistant", content: { text: result.finalMessage } });
        send({ type: "done", sessionId, reply: result.finalMessage });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-session-id": sessionId ?? "",
    },
  });
}
