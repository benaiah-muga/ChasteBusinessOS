-- The NOLOGIN claim owner may enumerate organization ids only so it can set
-- the tenant context before reading the narrow routine scheduling metadata.
CREATE POLICY jobs_claim_owner_organization_ids
ON public.organizations
FOR SELECT
TO PUBLIC
USING (current_user = 'chaste_jobs_claim_owner');
