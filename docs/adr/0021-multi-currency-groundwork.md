# 0021 - Multi-currency groundwork and migration path

Date: 2026-08-24
Status: Accepted (design; implementation deferred)

## Context

The schema hardcodes `"USD"` on invoices, and `journal_entries` carries no
currency at all. Non-goals in v1 named statutory localization, but enterprise
buyers will require multi-currency before GA. Retrofitting currency onto an
immutable ledger is the hardest migration this codebase will ever face, so
the design is fixed now even though the code waits.

## Decision

1. **Currency is a column on `journal_entries`**, defaulting to the org's
   `base_currency`. Every posting within one entry shares one currency;
   cross-currency settlement is expressed as two entries joined by an FX
   linkage row, never as mixed lines.
2. **Amounts stay integer minor units.** Minor-unit exponent differs per
   currency (JPY = 0, USD = 2), so a `currency_minor_units` lookup table
   ships with the change; display formatting moves through it immediately.
3. **FX rates are posted facts, not live lookups.** An `fx_rates` table
   records (org_id, base, quote, rate_num/rate_den integer ratio, effective_at,
   source). Realized gain/loss entries reference the rate row used. No floats.
4. **Trial balance / P&L / balance sheet gain an optional currency parameter**
   and report unrealized FX exposure separately rather than mixing converted
   amounts into base-currency totals silently.

## Migration path

- Phase 1 (mechanical): add nullable `currency` to `journal_entries`; the
  posting service writes the org base currency by default. All existing rows
  backfill to base currency; nothing else changes.
- Phase 2: org settings allow choosing a base currency at onboarding only;
  invoice/bill creation accepts currency + derives minor units from the
  lookup table.
- Phase 3: FX tables, realized/unrealized gain capabilities (money risk,
  threshold-gated), multi-currency reports.

Phase 1 should land before the first paying customer; phases 2-3 follow
demand. The posting service introduced in ADR 0020 makes phase 1 a one-file
change plus migration - which is precisely why it was extracted.
