CREATE UNIQUE INDEX auth_account_oidc_subject_unique
  ON auth_account (issuer, account_id)
  WHERE provider_id = 'oidc' AND issuer IS NOT NULL;
