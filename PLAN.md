# PLAN — M13 Implementation (Retail & reach)

Continuation. M7–M12 ✅ (archived). M13 demand confirmed by the owner
proceeding; explicitly no tracking pixels, no journeys, no landing pages.

## Leaves

| Leaf | Deliverable | Ledger | State |
|---|---|---|---|
| 13.1 | POS returns: reversal-style sale return (money back, stock back, books balanced) | GATES.md 13.1-G* | pending |
| 13.2 | Registers & shift summaries: per-session sales/cash/variance read | GATES.md 13.2-G* | pending |
| 13.3 | Marketing-lite: saved segments, campaigns with send log, opt-out honored — no tracking pixels | GATES.md 13.3-G* | pending |
| INT | Repo gate, full tests, M6–M12 regressions | GATES.md INT-G* | pending |

## Design decisions (binding)

- Returns are reversal-style (ADR 0037 discipline): pos.returnSale credits
  the invoice (creditedMinor), posts DR revenue+tax / CR cash through the
  shared posting path, and writes positive stock legs — never edits the
  sale. Always-gate money class like reverseEntry.
- Shift summaries derive from sessions + sales + JE cash legs; nothing new
  to reconcile.
- Marketing: segments are saved deterministic filters (opt-in + min spend);
  sendCampaign resolves recipients, HONORS marketingOptOut, and writes an
  append-only send log — the log is the analytics. Transport is the send
  log itself (no email transport exists in-repo; documented honestly).
- ADR 0040 records retail/marketing decisions.

## Status log (append-only)

- 2026-09-01 — M12 archived; M13 PLAN + GATES authored.
- 2026-09-01 — All leaves done: POS returns (always-gated reversal with
  stock restore), register shift summaries, marketing-lite (segments,
  campaigns, opt-out, send-log analytics). ADR 0040 written; ROADMAP +
  CHANGELOG updated. gate-check: 11/11 PASS, exit 0 — M13 CLOSED.
  M7–M13 ALL SHIPPED. Remaining: expert review + commit; UI surfaces for
  M9–M13 capabilities are the natural follow-up.
