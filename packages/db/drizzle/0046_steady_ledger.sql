-- N09 (I2/B06): commit-time ledger enforcement. Until this migration the
-- balanced-books invariant existed only as application-code assertions
-- (erp-core assertBalanced) and the "posted financial documents are
-- immutable" rule existed only as convention. Staged per the audit's
-- migration protocol: constrain new rows, validate existing rows, then
-- enable commit-time enforcement.
--
-- The single escape hatch is the transaction-local maintenance context
-- (app.ledger_maintenance = 'on'), set only by fixture teardowns and
-- declared repair transactions via @chaste/db beginLedgerMaintenance /
-- purgeTenantFinancials. Ordinary runtime code paths fail closed.

--> statement-breakpoint

ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_debit_nonnegative CHECK (debit_minor >= 0) NOT VALID;

--> statement-breakpoint

ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_credit_nonnegative CHECK (credit_minor >= 0) NOT VALID;

--> statement-breakpoint

ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_single_sided CHECK (NOT (debit_minor > 0 AND credit_minor > 0)) NOT VALID;

--> statement-breakpoint

ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_nonzero CHECK (debit_minor > 0 OR credit_minor > 0) NOT VALID;

--> statement-breakpoint

-- Validate-before-enforce: if any historical row violates the contract, this
-- migration refuses with the offending entries named so an operator can
-- quarantine and reconcile them deliberately. History is never rewritten
-- silently (N09 migration protocol).
DO $$
DECLARE
  unbalanced_count int;
  cross_org_count int;
  sample_entries text;
BEGIN
  SELECT count(*) INTO unbalanced_count
  FROM (
    SELECT entry_id FROM journal_lines
    GROUP BY entry_id
    HAVING sum(debit_minor) <> sum(credit_minor)
        OR sum(debit_minor) <= 0
        OR count(*) < 2
  ) bad;
  SELECT count(*) INTO cross_org_count
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id
  JOIN accounts a ON a.id = l.account_id
  WHERE a.org_id <> e.org_id;
  IF unbalanced_count > 0 OR cross_org_count > 0 THEN
    SELECT string_agg(entry_id::text, ', ') INTO sample_entries
    FROM (
      SELECT entry_id FROM journal_lines
      GROUP BY entry_id
      HAVING sum(debit_minor) <> sum(credit_minor) OR sum(debit_minor) <= 0 OR count(*) < 2
      LIMIT 5
    ) s;
    RAISE EXCEPTION 'journal pre-validation failed: % unbalanced/incomplete entries, % cross-org lines; offending entry ids: % — reconcile or quarantine these rows before migrating (N09)',
      unbalanced_count, cross_org_count, coalesce(sample_entries, 'none');
  END IF;
END $$;

--> statement-breakpoint

ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_debit_nonnegative;

--> statement-breakpoint

ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_credit_nonnegative;

--> statement-breakpoint

ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_single_sided;

--> statement-breakpoint

ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_nonzero;

--> statement-breakpoint

-- Refuses any mutation unless the transaction declared ledger maintenance.
-- Serves row-level BEFORE UPDATE/DELETE triggers (returns NEW or OLD to
-- allow the operation) and statement-level BEFORE TRUNCATE triggers.
CREATE OR REPLACE FUNCTION chaste_refuse_ledger_mutation() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.ledger_maintenance', true), '') <> 'on' THEN
    RAISE EXCEPTION '% on % refused: posted ledger rows are immutable; corrections are reversal entries, repairs require the app.ledger_maintenance context', TG_OP, TG_TABLE_NAME;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION chaste_assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  line_count int;
  debits int;
  credits int;
  cross_org int;
BEGIN
  -- The entry may have been removed later in the same transaction (declared
  -- repair); nothing persists, so there is nothing to check.
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.entry_id) THEN
    RETURN NULL;
  END IF;
  SELECT count(*), coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0)
    INTO line_count, debits, credits
  FROM journal_lines WHERE entry_id = NEW.entry_id;
  SELECT count(*) INTO cross_org
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id
  JOIN accounts a ON a.id = l.account_id
  WHERE l.entry_id = NEW.entry_id AND a.org_id <> e.org_id;
  IF cross_org > 0 THEN
    RAISE EXCEPTION 'entry % has a line whose account belongs to another organization', NEW.entry_id;
  END IF;
  IF line_count < 2 THEN
    RAISE EXCEPTION 'entry % committed with % line(s); an entry needs at least two lines', NEW.entry_id, line_count;
  END IF;
  IF debits <> credits THEN
    RAISE EXCEPTION 'entry % committed unbalanced: debits % != credits %', NEW.entry_id, debits, credits;
  END IF;
  IF debits <= 0 THEN
    RAISE EXCEPTION 'entry % committed with zero total', NEW.entry_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION chaste_assert_entry_complete() RETURNS trigger AS $$
DECLARE
  line_count int;
  cross_org int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.id) THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO line_count FROM journal_lines WHERE entry_id = NEW.id;
  IF line_count < 2 THEN
    RAISE EXCEPTION 'entry % committed with % line(s); an entry needs at least two lines', NEW.id, line_count;
  END IF;
  SELECT count(*) INTO cross_org
  FROM journal_lines l
  JOIN accounts a ON a.id = l.account_id
  WHERE l.entry_id = NEW.id AND a.org_id <> NEW.org_id;
  IF cross_org > 0 THEN
    RAISE EXCEPTION 'entry % has a line whose account belongs to another organization', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TRIGGER journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION chaste_refuse_ledger_mutation();

--> statement-breakpoint

CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION chaste_refuse_ledger_mutation();

--> statement-breakpoint

CREATE TRIGGER journal_lines_no_truncate
  BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION chaste_refuse_ledger_mutation();

--> statement-breakpoint

CREATE TRIGGER journal_entries_no_truncate
  BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION chaste_refuse_ledger_mutation();

--> statement-breakpoint

CREATE TRIGGER ledger_events_immutable
  BEFORE UPDATE OR DELETE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION chaste_refuse_ledger_mutation();

--> statement-breakpoint

CREATE TRIGGER ledger_events_no_truncate
  BEFORE TRUNCATE ON ledger_events
  FOR EACH STATEMENT EXECUTE FUNCTION chaste_refuse_ledger_mutation();

--> statement-breakpoint

CREATE CONSTRAINT TRIGGER journal_lines_balanced_at_commit
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION chaste_assert_entry_balanced();

--> statement-breakpoint

CREATE CONSTRAINT TRIGGER journal_entries_complete_at_commit
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION chaste_assert_entry_complete();

--> statement-breakpoint

-- S01/N09 floor: the runtime role appends to and reads the ledger; it never
-- mutates it. ensureAppRole re-applies this revocation after its broad grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaste_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries FROM chaste_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON journal_lines FROM chaste_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON ledger_events FROM chaste_app;
  END IF;
END $$;
