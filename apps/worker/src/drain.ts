/**
 * ARCH-9/REL-2 — outbox drain.
 *
 * Claims a batch via `FOR UPDATE SKIP LOCKED`, dispatches each event to the
 * processor, then acks (`markProcessed`) or records a failure (`markFailed`).
 * `markFailed` schedules an exponential retry via `next_attempt_at` and, once
 * `maxRetries` is exhausted, copies the event to the dead-letter queue and
 * returns `deadLettered: true` so the caller can notify operators.
 *
 * This module is free of Postgres/Redis imports on purpose: the retry/DLQ
 * accounting is unit-tested with fakes, while the adapter behavior is covered
 * by the Postgres e2e suite.
 */
import type { DomainEvent } from "@chaste/kernel";

export interface OutboxEventRow {
  id: string;
  type: string;
  organizationId: string;
  occurredAt: Date;
  payload: unknown;
  correlationId: string | null;
  causationId: string | null;
}

export interface OutboxDrainSource {
  claimUnprocessed(limit: number, leaseMs: number): Promise<OutboxEventRow[]>;
  markProcessed(id: string): Promise<void>;
  markFailed(
    id: string,
    error: unknown,
    opts: { maxRetries: number; backoffMs: number; errorCode?: string },
  ): Promise<{ deadLettered: boolean; attempts: number }>;
}

export interface EventProcessor {
  process(event: DomainEvent): Promise<void>;
}

export interface DrainOptions {
  batch?: number;
  leaseMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  errorCode?: string;
}

export interface DrainResult {
  claimed: number;
  processed: number;
  failed: number;
  deadLettered: number;
}

export function toDomainEvent(row: OutboxEventRow): DomainEvent {
  return {
    id: row.id,
    type: row.type,
    organizationId: row.organizationId,
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload,
    correlationId: row.correlationId ?? undefined,
    causationId: row.causationId ?? undefined,
  };
}

export async function drainOnce(
  source: OutboxDrainSource,
  processor: EventProcessor,
  notifyDeadLetter: (row: OutboxEventRow) => Promise<void>,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const batch = opts.batch ?? 50;
  const leaseMs = opts.leaseMs ?? 60_000;
  const maxRetries = opts.maxRetries ?? 3;
  const backoffMs = opts.backoffMs ?? 10_000;

  const claimed = await source.claimUnprocessed(batch, leaseMs);
  const result: DrainResult = { claimed: claimed.length, processed: 0, failed: 0, deadLettered: 0 };

  for (const row of claimed) {
    try {
      await processor.process(toDomainEvent(row));
      await source.markProcessed(row.id);
      result.processed += 1;
    } catch (err) {
      result.failed += 1;
      const outcome = await source.markFailed(row.id, err, { maxRetries, backoffMs, errorCode: opts.errorCode });
      if (outcome.deadLettered) {
        result.deadLettered += 1;
        try {
          await notifyDeadLetter(row);
        } catch (notifyErr) {
          // Notification is best-effort — the event is already safely in the
          // DLQ, so a failed notification must not take the drain down.
          console.error(
            JSON.stringify({
              service: "chaste-worker",
              action: "dead_letter_notify_failed",
              eventId: row.id,
              error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
            }),
          );
        }
      }
    }
  }
  return result;
}
