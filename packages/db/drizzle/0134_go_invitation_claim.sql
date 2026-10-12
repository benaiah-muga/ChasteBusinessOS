DO $$
DECLARE
  v_role_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'chaste_invitation_lookup_owner') THEN
    EXECUTE 'CREATE ROLE chaste_invitation_lookup_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS';
  ELSE
    EXECUTE 'ALTER ROLE chaste_invitation_lookup_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS';
  END IF;
  FOR v_role_name IN
    SELECT granted.rolname
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    WHERE member.rolname = 'chaste_invitation_lookup_owner'
  LOOP
    EXECUTE pg_catalog.format('REVOKE %I FROM chaste_invitation_lookup_owner', v_role_name);
  END LOOP;
  FOR v_role_name IN
    SELECT member.rolname
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname = 'chaste_invitation_lookup_owner'
  LOOP
    EXECUTE pg_catalog.format('REVOKE chaste_invitation_lookup_owner FROM %I', v_role_name);
  END LOOP;
END;
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO chaste_invitation_lookup_owner;
--> statement-breakpoint
REVOKE ALL ON TABLE public.invitations FROM chaste_invitation_lookup_owner;
--> statement-breakpoint
GRANT SELECT (token, org_id) ON TABLE public.invitations TO chaste_invitation_lookup_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.chaste_resolve_invitation_org(p_token text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT invitation.org_id
  FROM public.invitations AS invitation
  WHERE p_token IS NOT NULL
    AND pg_catalog.length(p_token) = 32
    AND invitation.token = p_token
  LIMIT 1;
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO chaste_invitation_lookup_owner;
--> statement-breakpoint
ALTER FUNCTION public.chaste_resolve_invitation_org(text) OWNER TO chaste_invitation_lookup_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM chaste_invitation_lookup_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.chaste_resolve_invitation_org(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.chaste_resolve_invitation_org(text) TO chaste_app;
