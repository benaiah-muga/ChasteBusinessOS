import { documentBalance } from "@chaste/erp-core";

export interface DocumentMoneyRow {
  totalMinor: number;
  creditedMinor: number;
  paidMinor: number;
}

/**
 * N11: the one outstanding-balance projection for web surfaces. Credits
 * reduce what the customer (or the org) still owes; over-allocation clamps
 * at zero instead of hiding credit behind a negative number.
 */
export function documentOutstanding(row: DocumentMoneyRow): number {
  return documentBalance(row).outstandingMinor;
}

export function sumOutstanding(rows: DocumentMoneyRow[]): number {
  return rows.reduce((s, r) => s + documentOutstanding(r), 0);
}
