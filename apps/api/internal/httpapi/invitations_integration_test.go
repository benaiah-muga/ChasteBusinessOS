package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoInvitationLookupAndClaimRespectRuntimeRLSBoundary(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("GO_RUNTIME_INTEGRATION_DATABASE_URL")
	if ownerURL == "" {
		ownerURL = os.Getenv("DATABASE_URL")
	}
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed invitation fixtures")
		}
		t.Skip("DATABASE_URL is required to seed invitation fixtures")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	orgID, inviteeID, roleID := integrationUUID(t), integrationUUID(t), integrationUUID(t)
	tokenBytes := make([]byte, 24)
	if _, err := rand.Read(tokenBytes); err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	if len(token) != 32 {
		t.Fatalf("test token length=%d", len(token))
	}
	t.Cleanup(func() {
		_, _ = owner.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1::uuid`, orgID)
		_, _ = owner.Exec(context.Background(), `DELETE FROM users WHERE id = $1::uuid`, inviteeID)
	})
	if _, err := owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Go Invitation Proof', $2)`, orgID, "go-invite-"+orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, 'invitee@example.test', 'Invitee')`, inviteeID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO roles (id, org_id, key, name) VALUES ($1::uuid, $2::uuid, 'member', 'Member')`, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO invitations (org_id, email, role_id, token, expires_at)
		VALUES ($1::uuid, 'Invitee@Example.test', $2::uuid, $3, now() + interval '1 day')`, orgID, roleID, token); err != nil {
		t.Fatal(err)
	}

	var publicExec, runtimeExec, safeOwner bool
	if err := runtime.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc proc,
			     LATERAL pg_catalog.aclexplode(COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) acl
			WHERE proc.oid = 'public.chaste_resolve_invitation_org(text)'::regprocedure
			  AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
		), pg_catalog.has_function_privilege(current_user, 'public.chaste_resolve_invitation_org(text)', 'EXECUTE'),
		EXISTS (
			SELECT 1 FROM pg_catalog.pg_roles owner_role
			WHERE owner_role.rolname = 'chaste_invitation_lookup_owner'
			  AND owner_role.rolcanlogin = false AND owner_role.rolsuper = false
			  AND owner_role.rolcreatedb = false AND owner_role.rolcreaterole = false
			  AND owner_role.rolbypassrls = true
			  AND pg_catalog.has_column_privilege(owner_role.rolname, 'public.invitations', 'token', 'SELECT')
			  AND pg_catalog.has_column_privilege(owner_role.rolname, 'public.invitations', 'org_id', 'SELECT')
			  AND NOT pg_catalog.has_column_privilege(owner_role.rolname, 'public.invitations', 'email', 'SELECT')
			  AND NOT pg_catalog.has_column_privilege(owner_role.rolname, 'public.invitations', 'role_id', 'SELECT')
			  AND NOT pg_catalog.has_column_privilege(owner_role.rolname, 'public.invitations', 'status', 'SELECT')
			  AND NOT pg_catalog.has_schema_privilege(owner_role.rolname, 'public', 'CREATE')
			  AND NOT pg_catalog.has_table_privilege(owner_role.rolname, 'public.invitations', 'INSERT')
			  AND NOT pg_catalog.has_table_privilege(owner_role.rolname, 'public.invitations', 'UPDATE')
			  AND NOT pg_catalog.has_table_privilege(owner_role.rolname, 'public.invitations', 'DELETE')
			  AND NOT EXISTS (
				SELECT 1 FROM pg_catalog.pg_auth_members membership
				WHERE membership.roleid = owner_role.oid OR membership.member = owner_role.oid
			  )
		)`).Scan(&publicExec, &runtimeExec, &safeOwner); err != nil {
		t.Fatal(err)
	}
	if publicExec || !runtimeExec || !safeOwner {
		t.Fatalf("function ACL/runtime grants unsafe: public_exec=%v runtime_exec=%v safe_owner=%v", publicExec, runtimeExec, safeOwner)
	}

	store := postgresInvitationStore{pool: runtime}
	resolvedOrg, found, err := store.resolveOrg(ctx, token)
	if err != nil || !found || resolvedOrg != orgID {
		t.Fatalf("token resolver org=%q found=%v err=%v", resolvedOrg, found, err)
	}
	var unscopedVisible int
	if err := runtime.QueryRow(ctx, `SELECT count(*) FROM invitations WHERE token = $1`, token).Scan(&unscopedVisible); err != nil {
		t.Fatal(err)
	}
	if unscopedVisible != 0 {
		t.Fatalf("runtime role saw %d invitations without org context", unscopedVisible)
	}
	preview, active, err := store.preview(ctx, orgID, token, time.Now())
	if err != nil || !active || preview.OrgName != "Go Invitation Proof" || preview.RoleName != "Member" {
		t.Fatalf("preview=%#v active=%v err=%v", preview, active, err)
	}
	claim, err := store.claim(ctx, orgID, token, inviteeID, "invitee@example.TEST", true, time.Now())
	if err != nil || claim.status != 0 {
		t.Fatalf("claim=%#v err=%v", claim, err)
	}
	var status string
	if err := owner.QueryRow(ctx, `SELECT status FROM invitations WHERE token = $1`, token).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "accepted" {
		t.Fatalf("invitation status=%q, want accepted", status)
	}
	var membershipCount, roleCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM memberships WHERE org_id = $1::uuid AND user_id = $2::uuid`, orgID, inviteeID).Scan(&membershipCount); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM user_roles WHERE org_id = $1::uuid AND user_id = $2::uuid AND role_id = $3::uuid`, orgID, inviteeID, roleID).Scan(&roleCount); err != nil {
		t.Fatal(err)
	}
	if membershipCount != 1 || roleCount != 1 {
		t.Fatalf("membership count=%d role grant count=%d", membershipCount, roleCount)
	}
}
