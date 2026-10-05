-- Seeds a user who belongs to two organizations with deliberately different
-- roles, permissions, currency, and module state, plus one unverified user.
--
-- Organization ids are supplied by the caller so each run is isolated. Posted
-- ledger rows cannot be deleted, so a fixed-id fixture would permanently
-- collide with its own history on the second run.
--
-- Invoke as: psql -v org_a=<uuid> -v org_b=<uuid> -v run=<tag> -f <this file>

BEGIN;

-- Organization A: no saved module list (every module available), USD.
INSERT INTO organizations (id, name, slug, base_currency, enabled_modules)
VALUES (:'org_a', 'Parity Org A', 'parity-org-a-' || :'run', 'USD', NULL);

-- Organization B: a saved module list that excludes several modules, and a
-- different currency, so a resolver that ignored the switch would be obvious.
INSERT INTO organizations (id, name, slug, base_currency, enabled_modules)
VALUES (:'org_b', 'Parity Org B', 'parity-org-b-' || :'run', 'EUR', '["crm"]'::jsonb);

INSERT INTO users (email, name)
VALUES ('parity-multi-' || :'run' || '@example.test', 'Parity Multi')
RETURNING id \gset multi_

INSERT INTO users (email, name)
VALUES ('parity-unverified-' || :'run' || '@example.test', 'Parity Unverified')
RETURNING id \gset unverified_

INSERT INTO memberships (org_id, user_id) VALUES
  (:'org_a', :'multi_id'), (:'org_b', :'multi_id');

-- Distinct roles per organization so the permission set proves which org was
-- actually selected. \gset needs exactly one row, so each is selected alone.
INSERT INTO roles (org_id, key, name) VALUES
  (:'org_a', 'parity-a-owner-' || :'run', 'Owner A'),
  (:'org_b', 'parity-b-reader-' || :'run', 'Reader B');

SELECT id AS role_a_id FROM roles WHERE key = 'parity-a-owner-' || :'run' \gset
SELECT id AS role_b_id FROM roles WHERE key = 'parity-b-reader-' || :'run' \gset

INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES
  (:'role_a_id', 'iam.admin', :'org_a'),
  (:'role_a_id', 'accounting.post', :'org_a'),
  (:'role_b_id', 'crm.read', :'org_b');

INSERT INTO user_roles (user_id, role_id, org_id) VALUES
  (:'multi_id', :'role_a_id', :'org_a'),
  (:'multi_id', :'role_b_id', :'org_b');

-- The unverified account also holds an Owner role, so the N03 guard is proven
-- against an identity that would otherwise have full access.
INSERT INTO memberships (org_id, user_id) VALUES (:'org_a', :'unverified_id');

INSERT INTO roles (id, org_id, key, name)
VALUES (gen_random_uuid(), :'org_a', 'parity-unverified-owner-' || :'run', 'Owner')
RETURNING id \gset unverified_role_

INSERT INTO role_permissions (role_id, permission_key, org_id)
VALUES (:'unverified_role_id', 'iam.admin', :'org_a');

INSERT INTO user_roles (user_id, role_id, org_id)
VALUES (:'unverified_id', :'unverified_role_id', :'org_a');

-- The verified multi-tenant auth account.
INSERT INTO auth_user (id, name, email, email_verified)
VALUES ('paritymulti' || :'run', 'Parity Multi', 'parity-multi-' || :'run' || '@example.test', true);

INSERT INTO auth_session (id, expires_at, token, user_id)
VALUES ('parity-multisess' || :'run', now() + interval '1 day',
        'parity-multi-token-' || :'run', 'paritymulti' || :'run');

-- The unverified auth account.
INSERT INTO auth_user (id, name, email, email_verified)
VALUES ('parityunverif' || :'run', 'Parity Unverified', 'parity-unverified-' || :'run' || '@email.test', false);

INSERT INTO auth_session (id, expires_at, token, user_id)
VALUES ('parity-unverifsess' || :'run', now() + interval '1 day',
        'parity-unverified-token-' || :'run', 'parityunverif' || :'run');

COMMIT;