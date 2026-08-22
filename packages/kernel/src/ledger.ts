import { createHash } from "node:crypto";
import type { ActionContext } from "./capability";

export interface LedgerEntry {
  seq?: number;
  orgId: string | null;
  actorType: string;
  actorId: string | null;
  kind: string;
  capabilityId: string | null;
  payload: unknown;
  prevHash: string | null;
  hash: string;
  occurredAt: Date;
}

export type NewLedgerEntry = Omit<LedgerEntry, "prevHash" | "hash"> & { prevHash?: string };

export interface LedgerStore {
  lastHash(orgId: string | null): Promise<string | null>;
  append(entry: NewLedgerEntry): Promise<number>;
}

/** Genesis hash for a fresh chain. */
export const GENESIS = "0".repeat(64);

export function computeEntryHash(entry: Omit<LedgerEntry, "hash" | "prevHash">, prevHash: string): string {
  const h = createHash("sha256");
  h.update(prevHash);
  h.update(entry.orgId ?? "");
  h.update(entry.actorType);
  h.update(entry.actorId ?? "");
  h.update(entry.kind);
  h.update(entry.capabilityId ?? "");
  h.update(JSON.stringify(entry.payload));
  h.update(String(entry.occurredAt.getTime()));
  return h.digest("hex");
}

/**
 * In-memory ledger store. Production swaps in the Postgres-backed
 * implementation (packages/db) inside the same transaction as the action.
 */
export class InMemoryLedger implements LedgerStore {
  readonly entries: LedgerEntry[] = [];

  async lastHash(): Promise<string | null> {
    const last = this.entries.at(-1);
    return last ? last.hash : GENESIS;
  }

  async append(entry: NewLedgerEntry): Promise<number> {
    const prevHash = entry.prevHash ?? (await this.lastHash()) ?? GENESIS;
    const { prevHash: _p, ...rest } = entry;
    const full: LedgerEntry = { ...rest, prevHash, hash: computeEntryHash(rest, prevHash) };
    this.entries.push(full);
    return this.entries.length;
  }
}

export function ledgerEventFor(ctx: ActionContext, kind: string, capabilityId: string | null, payload: unknown) {
  return {
    orgId: ctx.actor.orgId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    kind,
    capabilityId,
    payload,
    occurredAt: ctx.now,
  };
}
