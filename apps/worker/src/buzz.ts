/**
 * Buzz bridge — outbound mirror (worker side).
 *
 * Listens for `messaging.message.sent` and POSTs a signed, enriched payload to
 * the configured Buzz workflow webhook. Enabled only when
 * `CHASTE_BUZZ_WEBHOOK_SECRET` is set (a stock install has zero external calls).
 *
 * Failures are non-fatal: they are logged here and the event is still marked
 * processed by the worker — the platform's own record is the source of truth.
 */
import { and, eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import type { OutboxProcessor } from "@chaste/kernel";
import { schema, type Db } from "@chaste/db";

export function buzzEnabled(): boolean {
  return Boolean(process.env.CHASTE_BUZZ_WEBHOOK_SECRET);
}

export function buzzSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Register the outbound mirror handler on the processor. No-op unless the
 * bridge is enabled. Messages that were themselves received via Buzz are
 * skipped so the channel cannot loop back on itself.
 */
export function registerBuzzMirror(
  processor: OutboxProcessor,
  db: Db,
  log: (obj: Record<string, unknown>) => void = (o) => console.log(JSON.stringify(o)),
): boolean {
  if (!buzzEnabled()) return false;

  const secret = process.env.CHASTE_BUZZ_WEBHOOK_SECRET!;
  const webhookUrl = process.env.CHASTE_BUZZ_OUTBOUND_WEBHOOK_URL;
  if (!webhookUrl) {
    log({ service: "chaste-worker", action: "buzz_no_outbound_url", bridge: "disabled" });
    return false;
  }

  processor.on("messaging.message.sent", async (event) => {
    const p = event.payload as { threadId: string; messageId: string; sentById: string };
    const [msg] = await db
      .select()
      .from(schema.msgMessages)
      .where(
        and(
          eq(schema.msgMessages.id, p.messageId),
          eq(schema.msgMessages.organizationId, event.organizationId),
        ),
      )
      .limit(1);
    if (!msg || msg.kind === "system" || msg.body.startsWith("[via Buzz]")) {
      return; // system noise or our own echo — do not mirror
    }
    const [thread] = await db
      .select({ name: schema.msgThreads.name, type: schema.msgThreads.type })
      .from(schema.msgThreads)
      .where(
        and(
          eq(schema.msgThreads.id, p.threadId),
          eq(schema.msgThreads.organizationId, event.organizationId),
        ),
      )
      .limit(1);

    const payload = {
      event: "messaging.message.sent",
      organizationId: event.organizationId,
      threadId: p.threadId,
      threadName: thread?.name ?? null,
      threadType: thread?.type ?? null,
      messageId: p.messageId,
      sentById: p.sentById,
      body: msg.body,
      occurredAt: event.occurredAt,
      correlationId: event.correlationId,
    };

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chaste-signature": buzzSignature(secret, JSON.stringify(payload)),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        log({
          service: "chaste-worker",
          action: "buzz_mirror_http",
          status: res.status,
          error: await res.text().catch(() => ""),
          threadId: p.threadId,
        });
        return;
      }
      log({
        service: "chaste-worker",
        action: "buzz_mirrored",
        threadId: p.threadId,
        messageId: p.messageId,
        status: res.status,
      });
    } catch (err) {
      log({
        service: "chaste-worker",
        action: "buzz_mirror_failed",
        threadId: p.threadId,
        messageId: p.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return true;
}
