import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { agentSessions, getDb, organizations, tickets } from "@chaste/db";
import { hasPermission as hasPermissionFor, logger, runAgentLoop, type TicketSink } from "@chaste/kernel";
import { OpenAiCompatAdapter, MODELS, nimClient, resolveClient } from "@chaste/ai";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { appendSessionEvent, addTokenUsage } from "@/server/session-events";
import { getResolvedUser } from "@/server/session";
import { chatLimitForUser } from "@/server/rate-limit";
import { resolveEnabledModules } from "@/app/(app)/_shell/modules";

export const maxDuration = 120;

const bodySchema = z.object({
  message: z.string().min(1).max(8000),
  sessionId: z.string().uuid().optional(),
  mode: z.enum(["assist", "creator"]).default("assist"),
});

const systemPromptFor = (orgName: string) => `You are the ChasteBusinessOS assistant for "${orgName}".
You operate an ERP through registered capabilities. Rules:
- Prefer tools over prose when the user wants something done; confirm results with specifics (numbers, ids).
- Amounts are in minor units (cents). Quantities are thousandths of a unit.
- If a tool returns pendingApproval: true, tell the user approval is required and it's waiting in the Approvals inbox.
- Before saying you can't know something, call documents.searchMemory; ingested documents and policies live there.
- For data questions (revenue trends, aging, top customers, stock): call the matching analytics.* extractor first, then answer only from its rows. To produce a full report, call analytics.renderReport with sections built from the extracted frames and hand the user the numbers verbatim.
- If no capability fits, say so honestly and call file_ticket.
- Never invent capabilities, accounts, or numbers.
Writing style:
- Never use em dashes or en dashes; use commas, colons, or periods instead.
- Keep replies short and plain: short paragraphs, minimal markdown. Bold (**like this**) sparingly for key numbers only.`;
const creatorAddendum = `

Creator Mode is active. You may propose changes to this platform itself via
creator.submitProposal. A proposal must contain: what changes and why, a real
unified diff, how you verified it, and an honest risk assessment including who
could be affected. You cannot merge anything yourself; say so plainly.`;

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, { asAgent: true });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  // Each turn can fan out into a multi-step paid model loop; cap per-user
  // spend before doing any work.
  const limit = chatLimitForUser(resolved.userId);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "too many requests" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
    );
  }

  const body = bodySchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const registry = buildRegistry(db).scopedToModules(
    resolveEnabledModules(resolved.enabledModules),
  );
  const executor = buildExecutor(db, registry);
  const usingOpenRouter = process.env.MODEL_PROVIDER === "openrouter";
  const modelRef = MODELS.primary();
  const model = new OpenAiCompatAdapter({
    client: resolveClient(usingOpenRouter ? `openrouter/${modelRef}` : modelRef),
    model: modelRef,
    // Upstream shared pools (e.g. stealth/ox-alpha) throttle under load;
    // falling back to the primary NIM model keeps agent turns honest
    // instead of dying mid-conversation.
    fallback:
      process.env.NVIDIA_API_KEY && usingOpenRouter
        ? { client: nimClient(), model: process.env.MODEL_PRIMARY_NIM ?? "moonshotai/kimi-k2.6" }
        : undefined,
  });

  let sessionId = body.data.sessionId;
  if (sessionId) {
    // Ownership gate: a client-supplied session id must belong to this user
    // in this org, otherwise trajectory events and token usage would be
    // appended to someone else's replayable record.
    const [owned] = await db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, sessionId),
          eq(agentSessions.orgId, ctx.actor.orgId),
          eq(agentSessions.userId, resolved.userId),
        ),
      )
      .limit(1);
    if (!owned) return NextResponse.json({ error: "session not found" }, { status: 404 });
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

  await appendSessionEvent(db, sessionId, "user", { text: body.data.message });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        // Creator Mode is permission-gated at the session level too.
        const wantsCreator = body.data.mode === "creator";
        if (wantsCreator && !hasPermissionFor(ctx.actor, "platform.creator")) {
          send({ type: "error", error: "your role does not include platform.creator" });
          controller.close();
          return;
        }
        const result = await runAgentLoop(
          model,
          registry,
          executor,
          ctx,
          {
            sessionId,
            systemPrompt:
              systemPromptFor(org?.name ?? "your organization") + (wantsCreator ? creatorAddendum : ""),
            userGoal: body.data!.message,
            maxSteps: 8,
            onDelta: (text) => send({ type: "delta", text }),
            onEvent: (event) => {
              if (event.role === "tool_call") {
                const c = event.content as { name: string };
                send({ type: "tool", name: c.name });
              }
              if (event.role === "tool_call" || event.role === "tool_result") {
                // Fire-and-forget persistence, but failures are logged:
                // silent trajectory gaps made replay/audit untrustworthy.
                void appendSessionEvent(db, sessionId, event.role, event.content as object);
              }
            },
          },
          ticketSink,
        );
        await appendSessionEvent(db, sessionId, "assistant", { text: result.finalMessage });
        // Token accounting incl. cached prompt tokens (KV-cache hit rate);
        // accumulated atomically server-side (no lost updates).
        await addTokenUsage(db, sessionId, result.usage);
        send({ type: "done", sessionId, reply: result.finalMessage });
      } catch (err) {
        logger.error("agent loop failed", {
          sessionId,
          orgId: ctx.actor.orgId,
          error: err instanceof Error ? err.message : String(err),
        });
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
