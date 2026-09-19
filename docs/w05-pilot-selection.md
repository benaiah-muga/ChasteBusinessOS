# W0.5 - Pilot selection: cohort, workflow and build order

**Status: recommended default, awaiting owner confirmation.** The audit
(§5, §6/I5) requires choosing one pilot cohort and starting with
P01–P04 - "deliver module-specific features only where that cohort needs
them", and "choose P03/P05/P07/P08 by pilot, not all at once". This
document makes that selection on the evidence of what the ledger and
command surfaces can already prove, so the pilot runs on discharged
ground rather than on promises.

## Recommendation

**Pilot cohort:** a small distribution/wholesale business's purchasing and
receiving team - procurement clerk plus warehouse receiver (2–5 people).

**Pilot workflow chain:** receive a delivery against a purchase order →
accept/reject lines with reasons → see what remains outstanding → match
the supplier's bill (three-way) → pay it → correct mistakes (returns,
reversals) - all entered from a calm "My work" home that ranks what needs
attention.

**First product ideas:** P01 (the home) as the entry surface, P05 (the
receiving desk) as the first vertical journey; P04's supplier page follows
within the cohort. P03/P07/P08 wait for pilot evidence, per I5.

## Why this cohort and workflow

1. **The backend for the chain is discharged and pinned, end to end.**
   Every step of the recommended chain has a delivered, ledger-proven
   contract from this audit cycle: the receipt document with
   accepted/rejected/returned/remaining per line (`GATES-N16`), the
   balance contract gating bills and payments with locked money
   application (`GATES-N11`), vendor-payment reversal as a domain
   compensation (`GATES-N12`), stock balances projected with
   constant-cost reads (`GATES-N22`), and overreceipt only under explicit
   authority. No pilot step rests on an open audit finding.
2. **The audit's own P01 example is this workflow.** "Supplier delivered
   8 of 10; accept 8 and leave 2 outstanding" is exactly the receipt
   model `purchasing.listReceipts` now reports - the product idea and the
   engine agree by construction, not by adaptation.
3. **The smallest UI delta.** P05's receiving desk is a thin surface over
   an existing governed capability (`purchasing.receiveGoods` with its
   reject/tolerance inputs), and P01 composes signals, approvals and
   receipt remainders that already exist as ranked-data sources. P03's
   workspace would need statement-import identity first; P07's checkout
   needs the POS cart work surfaced as its own slice - both are real but
   larger lifts.
4. **Measured success is well-defined here.** The audit's provisional
   targets translate directly: unassisted completion of a
   receive-with-exception journey, time from opening home to first
   completed useful action, false-positive dismissals on purchasing
   signals, and preserved partial work across interruptions (the
   operation-receipt machinery from T08/worker-kill already exists to
   build on).

## Alternatives considered

- **Bookkeeper / finance cohort (P03 reconciliation workspace).** The
  N14 allocation model and `accounting.bankReconciliation` are real, but
  P03 needs statement-import identity and idempotency before a pilot can
  run a finite "finish the workspace" job. Second in line after the
  purchasing pilot.
- **Retail POS operator (P07).** Checkout and shift close are strong
  flows, but the pilot would hinge on cart-preservation work still to be
  surfaced as a slice; defer with P03.

## Measurement plan (provisional, per audit §6)

- ≥90% unassisted task completion on the first-use journey: receive a
  3-line delivery with one rejected line, then match and pay the bill.
- Time from opening home to first completed useful action.
- False-positive dismissals and repeated snoozes on purchasing signals.
- No loss of saved draft under the specified interruption tests.
- Report task cohort, sample size and distribution; no general adoption
  claims from a scripted test.

## Build order for the pilot (smallest first)

1. P05 receiving desk UI over `purchasing.receiveGoods`/`listReceipts`
   (accept, reject with reason, remaining visibility).
2. P01 "My work" home: ranked cards from approvals, purchasing signals,
   receipt remainders - deterministic ranking first.
3. P04 supplier page: order, receipts, bills, balance, history in one
   place (all read capabilities exist).
4. Pilot instrumentation for the measurement plan above.

Owner confirmation of the cohort unlocks item 1.
