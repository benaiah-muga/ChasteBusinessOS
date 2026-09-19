-- Stock-ledger immutability, following ADR 0052's pattern: quantity truth is
-- append-only. Corrections are compensating movements (production reversals,
-- transfer reversals, cycle-count postings) - never edits to history. The
-- single escape hatch is the same transaction-local maintenance context
-- (app.ledger_maintenance = 'on') declared by fixture teardowns and repair
-- transactions via beginLedgerMaintenance / purgeTenantFinancials.

--> statement-breakpoint

CREATE TRIGGER stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION chaste_refuse_ledger_mutation();

--> statement-breakpoint

CREATE TRIGGER stock_movements_no_truncate
  BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION chaste_refuse_ledger_mutation();

--> statement-breakpoint

-- The runtime role appends to and reads the stock ledger; it never mutates
-- it. ensureAppRole re-applies this revocation after its broad grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaste_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON stock_movements FROM chaste_app;
  END IF;
END $$;
