CREATE TABLE auth_email_outbox (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('verification', 'recovery')),
  recipient text NOT NULL,
  link text NOT NULL,
  token_identifier text,
  expires_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX auth_email_outbox_ready_idx
  ON auth_email_outbox (available_at, lease_expires_at, expires_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaste_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth_email_outbox TO chaste_app;
  END IF;
END $$;
