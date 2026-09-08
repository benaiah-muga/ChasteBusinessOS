/**
 * Inventory → GL reconciliation (ADR 0033).
 *
 * The stock ledger is operational truth: replaying its append-only
 * movements yields the moving-average value inventory actually holds.
 * The GL inventory account (1200) drifts from that truth for legitimate
 * reasons — bills coded straight to expense, timing, manual entries —
 * so instead of wiring every movement to journal entries, valuation is
 * closed periodically: one balanced adjustment entry brings the GL to
 * the ledger, never the other way round.
 *
 * Sign convention: variance = ledger − GL.
 *   variance > 0 → the books under-state stock (DR 1200, relieve COGS)
 *   variance < 0 → the books over-state stock (expense shrinkage, CR 1200)
 * Zero variance posts nothing; an empty entry must not exist.
 */

import type { JournalLineInput } from "./posting";

export interface InventoryReconciliation {
  /** ledger − GL; the amount by which the GL inventory account is wrong. */
  varianceMinor: number;
  ledgerValueMinor: number;
  glBalanceMinor: number;
}

export function reconcileInventoryValue(
  ledgerValueMinor: number,
  glBalanceMinor: number,
): InventoryReconciliation {
  return {
    varianceMinor: ledgerValueMinor - glBalanceMinor,
    ledgerValueMinor,
    glBalanceMinor,
  };
}

export interface ValuationAdjustmentCodes {
  inventoryCode: string;
  cogsCode: string;
}

/**
 * The one balanced entry that closes the gap. Exactly two lines or none;
 * debits equal credits by construction; applying the entry's net to the GL
 * balance lands exactly on the ledger value.
 */
export function valuationAdjustmentLines(
  varianceMinor: number,
  codes: ValuationAdjustmentCodes,
): JournalLineInput[] {
  if (varianceMinor === 0) return [];
  if (varianceMinor > 0) {
    return [
      { accountCode: codes.inventoryCode, debitMinor: varianceMinor, creditMinor: 0 },
      { accountCode: codes.cogsCode, debitMinor: 0, creditMinor: varianceMinor },
    ];
  }
  const shrinkage = -varianceMinor;
  return [
    { accountCode: codes.cogsCode, debitMinor: shrinkage, creditMinor: 0 },
    { accountCode: codes.inventoryCode, debitMinor: 0, creditMinor: shrinkage },
  ];
}
