import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, outboxMessages, type Database } from "@chaste/db";
import type { Logger } from "@chaste/kernel";

const webhookPayload = z.object({
  url: z.string().url(),
  body: z.record(z.string(), z.unknown()),
});

const emailPayload = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(998),
  text: z.string(),
  customerId: z.string().uuid().optional(),
});

export type OutboxInput =
  | {
      orgId: string;
      kind: "webhook";
      dedupeKey: string;
      payload: z.infer<typeof webhookPayload>;
    }
  | {
      orgId: string;
      kind: "email";
      dedupeKey: string;
      payload: z.infer<typeof emailPayload>;
    };

export interface ClaimedOutboxMessage {
  id: string;
  orgId: string;
  kind: string;
  dedupeKey: string;
  providerOperationId: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  workerId: string;
  fencingToken: number;
}

export interface OutboxProcessOptions {
  workerId?: string;
  leaseMs?: number;
  now?: Date;
}

const DEFAULT_LEASE_MS = 60_000;
const UNKNOWN_OUTCOME = "provider outcome unknown; reconcile before retrying";

export async function enqueueOutboxMessage(db: Database["db"], input: OutboxInput): Promise<string> {
  const [inserted] = await db
    .insert(outboxMessages)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      providerOperationId: randomUUID(),
      payload: input.payload,
    })
    .onConflictDoNothing({ target: [outboxMessages.orgId, outboxMessages.dedupeKey] })
    .returning({ id: outboxMessages.id });
  if (inserted) return inserted.id;
  const [existing] = await db
    .select({ id: outboxMessages.id })
    .from(outboxMessages)
    .where(sql`${outboxMessages.orgId} = ${input.orgId} AND ${outboxMessages.dedupeKey} = ${input.dedupeKey}`)
    .limit(1);
  if (!existing) throw new Error("outbox dedupe conflict without an existing row");
  return existing.id;
}

async function markExpiredOutboxUnknown(db: Database["db"], now: Date): Promise<void> {
  await db
    .update(outboxMessages)
    .set({
      status: "unknown",
      lastError: "outbox lease expired during external delivery; provider outcome is unknown",
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      sql`${outboxMessages.status} = 'processing' AND ${outboxMessages.leaseExpiresAt} <= ${now.toISOString()}::timestamptz`,
    );
}

export async function claimOutboxMessage(
  db: Database["db"],
  workerId: string,
  leaseMs: number,
  now: Date,
): Promise<ClaimedOutboxMessage | null> {
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const result = (await db.execute(sql`
    UPDATE outbox_messages
    SET status = 'processing',
        attempts = attempts + 1,
        lease_owner = ${workerId},
        lease_expires_at = ${leaseExpiresAt.toISOString()}::timestamptz,
        fencing_token = fencing_token + 1,
        updated_at = ${now.toISOString()}::timestamptz
    WHERE id = (
      SELECT id FROM outbox_messages
      WHERE status = 'pending' AND attempts < max_attempts
        AND available_at <= ${now.toISOString()}::timestamptz
      ORDER BY available_at, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, org_id, kind, dedupe_key, provider_operation_id, payload,
      attempts, max_attempts, fencing_token
  `)) as unknown as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    kind: String(row.kind),
    dedupeKey: String(row.dedupe_key),
    providerOperationId: String(row.provider_operation_id),
    payload: row.payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    workerId,
    fencingToken: Number(row.fencing_token),
  };
}

async function finalizeOutboxMessage(
  db: Database["db"],
  message: ClaimedOutboxMessage,
  patch: {
    status: "pending" | "sent" | "unknown" | "failed";
    lastError?: string | null;
    providerReceipt?: unknown | null;
    availableAt?: Date;
  },
): Promise<boolean> {
  const values: {
    status: string;
    lastError: string | null;
    providerReceipt: unknown;
    leaseOwner: null;
    leaseExpiresAt: null;
    updatedAt: Date;
    completedAt: Date | null;
    availableAt?: Date;
  } = {
    status: patch.status,
    lastError: patch.lastError ?? null,
    providerReceipt: patch.providerReceipt ?? null,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
    completedAt: patch.status === "pending" ? null : new Date(),
  };
  if (patch.availableAt) values.availableAt = patch.availableAt;
  const [row] = await db
    .update(outboxMessages)
    .set(values)
    .where(
      sql`${outboxMessages.id} = ${message.id} AND ${outboxMessages.status} = 'processing' AND ${outboxMessages.leaseOwner} = ${message.workerId} AND ${outboxMessages.fencingToken} = ${message.fencingToken}`,
    )
    .returning({ id: outboxMessages.id });
  return Boolean(row);
}

export async function reconcileOutboxMessage(input: {
  db: Database["db"];
  orgId: string;
  outboxId: string;
  status: "sent" | "failed";
  providerReceipt?: unknown;
  note?: string;
}): Promise<boolean> {
  const [row] = await input.db
    .update(outboxMessages)
    .set({
      status: input.status,
      providerReceipt: input.providerReceipt ?? null,
      lastError: input.note ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      sql`${outboxMessages.id} = ${input.outboxId} AND ${outboxMessages.orgId} = ${input.orgId} AND ${outboxMessages.status} = 'unknown'`,
    )
    .returning({ id: outboxMessages.id });
  return Boolean(row);
}

function headerSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.trim();
}

async function dispatchWebhook(
  message: ClaimedOutboxMessage,
  payload: z.infer<typeof webhookPayload>,
): Promise<{ status: "sent" | "pending" | "unknown" | "failed"; error?: string; receipt?: unknown; retryAfterMs?: number }> {
  const response = await fetch(payload.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": message.providerOperationId,
      "x-chaste-outbox-id": message.id,
    },
    body: JSON.stringify(payload.body),
    signal: AbortSignal.timeout(5_000),
  });
  const receipt = { status: response.status, providerOperationId: message.providerOperationId };
  if (response.ok) return { status: "sent", receipt };
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "");
    return {
      status: "pending",
      error: `webhook rate limited (${response.status})`,
      receipt,
      retryAfterMs: Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter * 1_000, 1_000), 300_000) : 30_000,
    };
  }
  if (response.status >= 400 && response.status < 500) {
    return { status: "failed", error: `webhook rejected (${response.status})`, receipt };
  }
  return { status: "unknown", error: `webhook provider outcome unknown (${response.status})`, receipt };
}

async function dispatchEmail(
  message: ClaimedOutboxMessage,
  payload: z.infer<typeof emailPayload>,
): Promise<{ status: "sent" | "failed"; error?: string; receipt?: unknown }> {
  if (!process.env.SMTP_HOST) return { status: "failed", error: "SMTP is not configured" };
  const nodemailer = (await import("nodemailer")).default;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
  const info = await transport.sendMail({
    from: process.env.SMTP_FROM ?? "chaste@localhost",
    to: payload.to,
    subject: headerSafe(payload.subject),
    text: payload.text,
    messageId: `<${message.providerOperationId}@chaste.local>`,
  });
  return { status: "sent", receipt: { messageId: info.messageId ?? message.providerOperationId } };
}

async function marketingRecipientError(
  db: Database["db"],
  message: ClaimedOutboxMessage,
  payload: z.infer<typeof emailPayload>,
): Promise<string | null> {
  if (!payload.customerId) return null;
  const [customer] = await db
    .select({ email: customers.email, marketingOptOut: customers.marketingOptOut, deactivatedAt: customers.deactivatedAt })
    .from(customers)
    .where(and(eq(customers.id, payload.customerId), eq(customers.orgId, message.orgId)))
    .limit(1);
  if (!customer || customer.deactivatedAt || customer.marketingOptOut || customer.email !== payload.to) {
    return "marketing recipient is no longer eligible at dispatch time";
  }
  return null;
}

export async function processOneOutbox(
  db: Database["db"],
  log: Logger,
  options: OutboxProcessOptions = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const workerId = options.workerId ?? `${process.pid}:${crypto.randomUUID()}`;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  await markExpiredOutboxUnknown(db, now);
  const message = await claimOutboxMessage(db, workerId, leaseMs, now);
  if (!message) return false;

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void db
      .update(outboxMessages)
      .set({ leaseExpiresAt: new Date(Date.now() + leaseMs), updatedAt: new Date() })
      .where(
        sql`${outboxMessages.id} = ${message.id} AND ${outboxMessages.status} = 'processing' AND ${outboxMessages.leaseOwner} = ${message.workerId} AND ${outboxMessages.fencingToken} = ${message.fencingToken}`,
      )
      .returning({ id: outboxMessages.id })
      .then(([row]) => {
        if (!row) leaseLost = true;
      })
      .catch(() => undefined);
  }, Math.max(100, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();

  try {
    let result: Awaited<ReturnType<typeof dispatchWebhook>>;
    if (message.kind === "webhook") {
      result = await dispatchWebhook(message, webhookPayload.parse(message.payload));
    } else if (message.kind === "email") {
      const payload = emailPayload.parse(message.payload);
      const eligibilityError = await marketingRecipientError(db, message, payload);
      result = eligibilityError ? { status: "failed", error: eligibilityError } : await dispatchEmail(message, payload);
    } else {
      result = { status: "failed", error: `unknown outbox kind: ${message.kind}` };
    }
    const finalized =
      !leaseLost &&
      (await finalizeOutboxMessage(db, message, {
        status: result.status,
        lastError: result.error,
        providerReceipt: result.receipt,
        availableAt: result.retryAfterMs ? new Date(Date.now() + result.retryAfterMs) : undefined,
      }));
    if (!finalized) log.warn("outbox acknowledgement fenced", { outboxId: message.id });
    if (result.status === "unknown") log.warn(UNKNOWN_OUTCOME, { outboxId: message.id });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    const finalized =
      !leaseLost &&
      (await finalizeOutboxMessage(db, message, { status: "unknown", lastError: `${UNKNOWN_OUTCOME}: ${messageText}` }));
    if (!finalized) log.warn("outbox failure acknowledgement fenced", { outboxId: message.id });
    log.warn(UNKNOWN_OUTCOME, { outboxId: message.id, error: messageText });
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
