package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type bootstrapTestInput struct {
	sessionToken string
	orgName      string
	description  string
	currency     string
	path         string
	steps        []string
	intent       string
}

func callOrganizationBootstrap(ctx context.Context, db *pgxpool.Pool, input bootstrapTestInput) (string, bool, error) {
	var orgID string
	var replayed bool
	err := db.QueryRow(ctx, `
		SELECT org_id::text, replayed
		FROM public.chaste_bootstrap_organization($1, $2, $3, $4, $5, $6::text[], $7)`,
		input.sessionToken, input.orgName, input.description, input.currency, input.path, input.steps, input.intent,
	).Scan(&orgID, &replayed)
	return orgID, replayed, err
}

func TestGoOrganizationBootstrapDatabaseBoundary(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to seed organization bootstrap fixtures")
		}
		t.Skip("DATABASE_URL is required to seed organization bootstrap fixtures")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtimeConfig, err := pgxpool.ParseConfig(runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	runtimeConfig.MaxConns = 8
	runtime, err := pgxpool.NewWithConfig(ctx, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}
	assertBootstrapOwnerRole(t, ctx, runtime)

	verifiedID := integrationUUID(t)
	memberID := integrationUUID(t)
	rollbackID := integrationUUID(t)
	unverifiedID := integrationUUID(t)
	concurrentID := integrationUUID(t)
	conflictID := integrationUUID(t)
	differentIntentID := integrationUUID(t)
	exhaustionID := integrationUUID(t)
	memberOrgID := integrationUUID(t)
	var createdOrgIDs []string
	var collisionSlugs []string
	users := []struct {
		id       string
		email    string
		verified bool
	}{
		{id: verifiedID, email: "bootstrap-" + verifiedID[:8] + "@fixture.test", verified: true},
		{id: memberID, email: "bootstrap-" + memberID[:8] + "@fixture.test", verified: true},
		{id: rollbackID, email: "bootstrap-" + rollbackID[:8] + "@fixture.test", verified: true},
		{id: unverifiedID, email: "bootstrap-" + unverifiedID[:8] + "@fixture.test", verified: false},
		{id: concurrentID, email: "bootstrap-" + concurrentID[:8] + "@fixture.test", verified: true},
		{id: conflictID, email: "bootstrap-" + conflictID[:8] + "@fixture.test", verified: true},
		{id: differentIntentID, email: "bootstrap-" + differentIntentID[:8] + "@fixture.test", verified: true},
		{id: exhaustionID, email: "bootstrap-" + exhaustionID[:8] + "@fixture.test", verified: true},
	}
	tokens := make(map[string]string, len(users))
	for _, user := range users {
		token := "bootstrap-token-" + integrationUUID(t)
		tokens[user.id] = token
		if _, err := owner.Exec(ctx, `
			INSERT INTO auth_user (id, name, email, email_verified)
			VALUES ($1, 'Bootstrap fixture', $2, $3)`, user.id, user.email, user.verified); err != nil {
			t.Fatal(err)
		}
		if _, err := owner.Exec(ctx, `
			INSERT INTO auth_session (id, expires_at, token, user_id)
			VALUES ($1, $2, $3, $4)`, integrationUUID(t), time.Now().Add(time.Hour), token, user.id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO users (email, name) VALUES ($1, 'Existing member')`, users[1].email); err != nil {
		t.Fatal(err)
	}
	var memberUserID string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM users WHERE email = $1`, users[1].email).Scan(&memberUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Existing member workspace', $2)`,
		memberOrgID, "bootstrap-member-"+memberOrgID[:8]); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, memberOrgID, memberUserID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE name = ANY($1::text[])`, []string{
			"Verified \"Cafe\" Workspace " + verifiedID[:8],
			"Rollback Bootstrap Workspace " + rollbackID[:8],
		}); err != nil {
			t.Errorf("delete created bootstrap organizations: %v", err)
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id = $1::uuid`, memberOrgID); err != nil {
			t.Errorf("delete bootstrap fixture organization: %v", err)
		}
		for _, orgID := range createdOrgIDs {
			if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id = $1::uuid`, orgID); err != nil {
				t.Errorf("delete concurrent bootstrap organization: %v", err)
			}
		}
		if len(collisionSlugs) > 0 {
			if _, err := owner.Exec(cleanupCtx, `DELETE FROM public.organizations WHERE slug = ANY($1::text[])`, collisionSlugs); err != nil {
				t.Errorf("delete bootstrap slug collision fixtures: %v", err)
			}
		}
		for _, user := range users {
			if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_session WHERE user_id = $1`, user.id); err != nil {
				t.Errorf("delete bootstrap auth session: %v", err)
			}
			if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id = $1`, user.id); err != nil {
				t.Errorf("delete bootstrap auth user: %v", err)
			}
			if _, err := owner.Exec(cleanupCtx, `DELETE FROM users WHERE email = $1`, user.email); err != nil {
				t.Errorf("delete bootstrap domain user: %v", err)
			}
		}
	})

	if err := assertBootstrapDenied(ctx, runtime, bootstrapTestInput{
		sessionToken: "invalid-session-token",
		orgName:      "Should Never Exist",
		description:  "This workspace must not be created without a valid session.",
		currency:     "USD",
		path:         "fresh",
	}); err != nil {
		t.Fatal(err)
	}
	if err := assertBootstrapDenied(ctx, runtime, bootstrapTestInput{
		sessionToken: tokens[unverifiedID],
		orgName:      "Unverified Workspace",
		description:  "This workspace requires a verified email session.",
		currency:     "USD",
		path:         "fresh",
	}); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []bootstrapTestInput{
		{sessionToken: tokens[verifiedID], orgName: "Unsupported Currency Workspace", description: "A three letter currency shape is required by onboarding validation.", currency: "US1", path: "fresh"},
		{sessionToken: tokens[verifiedID], orgName: "Unsupported Metadata Workspace", description: "The onboarding path is validated as a closed set of supported values.", currency: "USD", path: "server_admin"},
	} {
		if err := assertBootstrapDenied(ctx, runtime, invalid); err != nil {
			t.Fatal(err)
		}
	}
	assertBootstrapSlugExhaustionRollback(t, ctx, owner, runtime, users[7], tokens[exhaustionID], &collisionSlugs)

	input := bootstrapTestInput{
		sessionToken: tokens[verifiedID],
		orgName:      "Verified \"Cafe\" Workspace " + verifiedID[:8],
		description:  "A verified owner's café setup uses quotes, Unicode, and an auditable profile.\nKeep the exact retry payload.",
		currency:     "UGX",
		path:         "import",
		steps:        []string{"invite_team", "import_customers"},
		intent:       "bootstrap-intent-" + integrationUUID(t),
	}
	orgID, replayed, err := callOrganizationBootstrap(ctx, runtime, input)
	if err != nil {
		t.Fatalf("create verified workspace: %v", err)
	}
	if orgID == "" || replayed {
		t.Fatalf("first bootstrap returned org=%q replayed=%t", orgID, replayed)
	}
	var actualOwnerID string
	if err := owner.QueryRow(ctx, `
		SELECT membership.user_id::text
		FROM public.memberships AS membership
		WHERE membership.org_id = $1::uuid`, orgID).Scan(&actualOwnerID); err != nil {
		t.Fatal(err)
	}
	if actualOwnerID == "" || actualOwnerID == memberUserID {
		t.Fatalf("workspace owner = %q, expected identity derived from verified session", actualOwnerID)
	}
	var expectedOwnerID string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM users WHERE email = $1`, users[0].email).Scan(&expectedOwnerID); err != nil {
		t.Fatal(err)
	}
	if actualOwnerID != expectedOwnerID {
		t.Fatalf("workspace owner = %q, verified session resolved to %q", actualOwnerID, expectedOwnerID)
	}
	var accountCount, ownerGrantCount, policyCount, memoryCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.accounts WHERE org_id = $1::uuid`, orgID).Scan(&accountCount); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `
		SELECT count(*) FROM public.user_roles AS user_role
		JOIN public.roles AS role ON role.id = user_role.role_id
		JOIN public.role_permissions AS permission ON permission.role_id = role.id
		WHERE user_role.org_id = $1::uuid AND user_role.user_id = $2::uuid
		  AND role.key = 'owner' AND permission.permission_key = '*'`, orgID, actualOwnerID).Scan(&ownerGrantCount); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.policies WHERE org_id = $1::uuid AND capability_pattern = '*' AND money_threshold_minor = 50000`, orgID).Scan(&policyCount); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.memories WHERE org_id = $1::uuid AND kind = 'business_profile' AND source = 'onboarding' AND vector_dims(embedding) = 1024`, orgID).Scan(&memoryCount); err != nil {
		t.Fatal(err)
	}
	if accountCount != 11 || ownerGrantCount != 1 || policyCount != 1 || memoryCount != 1 {
		t.Fatalf("bootstrap seed counts accounts=%d owner_grants=%d policies=%d memories=%d", accountCount, ownerGrantCount, policyCount, memoryCount)
	}
	var intentHash string
	if err := owner.QueryRow(ctx, `SELECT payload_hash FROM public.bootstrap_intents WHERE user_id = $1::uuid AND intent_id = $2`, actualOwnerID, input.intent).Scan(&intentHash); err != nil {
		t.Fatal(err)
	}
	expectedHash := legacyBootstrapPayloadHash(t, input)
	if intentHash != expectedHash {
		t.Fatalf("bootstrap payload hash = %s, want legacy-compatible %s", intentHash, expectedHash)
	}

	replayID, replayed, err := callOrganizationBootstrap(ctx, runtime, input)
	if err != nil || replayID != orgID || !replayed {
		t.Fatalf("same actor and intent replay org=%q replayed=%t err=%v, want %q/true", replayID, replayed, err, orgID)
	}
	conflict := input
	conflict.description += " Changed."
	if _, _, err := callOrganizationBootstrap(ctx, runtime, conflict); err == nil {
		t.Fatal("same actor reused an intent with changed details")
	}

	parallelInput := bootstrapTestInput{
		sessionToken: tokens[concurrentID], orgName: "Concurrent Bootstrap Workspace " + concurrentID[:8],
		description: "Concurrent retries with the same verified actor and intent create one workspace.",
		currency:    "USD", path: "fresh", intent: "parallel-intent-" + integrationUUID(t),
	}
	parallelResults := runConcurrentBootstrap(t, ctx, runtime, []bootstrapTestInput{parallelInput, parallelInput, parallelInput, parallelInput, parallelInput})
	parallelOrgID := ""
	createdCount := 0
	for _, result := range parallelResults {
		if result.err != nil {
			t.Fatalf("concurrent same-intent replay failed: %v", result.err)
		}
		if parallelOrgID == "" {
			parallelOrgID = result.orgID
		} else if result.orgID != parallelOrgID {
			t.Fatalf("concurrent replay returned org %q, expected %q", result.orgID, parallelOrgID)
		}
		if !result.replayed {
			createdCount++
		}
	}
	if createdCount != 1 {
		t.Fatalf("concurrent same-intent created %d workspaces, want exactly one", createdCount)
	}
	createdOrgIDs = append(createdOrgIDs, parallelOrgID)

	conflictingInput := bootstrapTestInput{
		sessionToken: tokens[conflictID], orgName: "Concurrent Conflict Workspace " + conflictID[:8],
		description: "Concurrent payloads sharing one intent must settle to one committed payload.",
		currency:    "USD", path: "fresh", intent: "conflict-intent-" + integrationUUID(t),
	}
	conflictingInput2 := conflictingInput
	conflictingInput2.orgName += " Changed"
	conflictResults := runConcurrentBootstrap(t, ctx, runtime, []bootstrapTestInput{conflictingInput, conflictingInput2})
	conflictCreated, conflictRejected := 0, 0
	for _, result := range conflictResults {
		if result.err != nil {
			var postgresErr *pgconn.PgError
			if !errors.As(result.err, &postgresErr) || postgresErr.Message != "bootstrap intent conflict" {
				t.Fatalf("concurrent conflicting intent returned unexpected error: %v", result.err)
			}
			conflictRejected++
		} else {
			conflictCreated++
			createdOrgIDs = append(createdOrgIDs, result.orgID)
		}
	}
	if conflictCreated != 1 || conflictRejected != 1 {
		t.Fatalf("concurrent conflict outcomes created=%d rejected=%d, want 1/1", conflictCreated, conflictRejected)
	}

	differentIntentA := bootstrapTestInput{
		sessionToken: tokens[differentIntentID], orgName: "Different Intent Workspace A " + differentIntentID[:8],
		description: "Concurrent different intents for one verified actor must serialize to one workspace.",
		currency:    "USD", path: "fresh", intent: "different-intent-a-" + integrationUUID(t),
	}
	differentIntentB := differentIntentA
	differentIntentB.orgName = "Different Intent Workspace B " + differentIntentID[:8]
	differentIntentB.intent = "different-intent-b-" + integrationUUID(t)
	differentIntentResults := runConcurrentBootstrap(t, ctx, runtime, []bootstrapTestInput{differentIntentA, differentIntentB})
	differentCreated, differentRejected := 0, 0
	for _, result := range differentIntentResults {
		if result.err != nil {
			var postgresErr *pgconn.PgError
			if !errors.As(result.err, &postgresErr) || postgresErr.Message != "user already belongs to an organization" {
				t.Fatalf("concurrent different intent returned unexpected error: %v", result.err)
			}
			differentRejected++
		} else {
			differentCreated++
			createdOrgIDs = append(createdOrgIDs, result.orgID)
		}
	}
	if differentCreated != 1 || differentRejected != 1 {
		t.Fatalf("concurrent different-intent outcomes created=%d rejected=%d, want 1/1", differentCreated, differentRejected)
	}

	// Another verified user's session cannot read or replay the first user's
	// receipt, and because that identity already belongs to a workspace it
	// cannot create a second one either.
	otherInput := input
	otherInput.sessionToken = tokens[memberID]
	if _, _, err := callOrganizationBootstrap(ctx, runtime, otherInput); err == nil {
		t.Fatal("another user's session replayed the first user's bootstrap receipt")
	} else {
		var postgresErr *pgconn.PgError
		if !errors.As(err, &postgresErr) || postgresErr.Message != "user already belongs to an organization" {
			t.Fatalf("another user's session did not resolve to its own membership boundary: %v", err)
		}
	}

	if _, err := runtime.Exec(ctx, `INSERT INTO public.organizations (name, slug) VALUES ('Unscoped runtime insert', $1)`, "unscoped-"+integrationUUID(t)[:8]); err == nil {
		t.Fatal("runtime role inserted an organization outside the bootstrap function without app.org_id")
	}

	assertBootstrapRollback(t, ctx, owner, runtime, users[2], tokens[rollbackID])
}

func assertBootstrapDenied(ctx context.Context, runtime *pgxpool.Pool, input bootstrapTestInput) error {
	if _, _, err := callOrganizationBootstrap(ctx, runtime, input); err == nil {
		return fmt.Errorf("bootstrap accepted invalid or unverified session %q", input.sessionToken)
	}
	return nil
}

type bootstrapCallResult struct {
	orgID    string
	replayed bool
	err      error
}

func runConcurrentBootstrap(t *testing.T, ctx context.Context, runtime *pgxpool.Pool, inputs []bootstrapTestInput) []bootstrapCallResult {
	t.Helper()
	start := make(chan struct{})
	results := make(chan bootstrapCallResult, len(inputs))
	for _, input := range inputs {
		input := input
		go func() {
			<-start
			orgID, replayed, err := callOrganizationBootstrap(ctx, runtime, input)
			results <- bootstrapCallResult{orgID: orgID, replayed: replayed, err: err}
		}()
	}
	close(start)
	out := make([]bootstrapCallResult, 0, len(inputs))
	for range inputs {
		out = append(out, <-results)
	}
	return out
}

func assertBootstrapOwnerRole(t *testing.T, ctx context.Context, runtime *pgxpool.Pool) {
	t.Helper()
	var login, superuser, createDB, createRole, inherit, replication, bypassRLS bool
	var appCanExecute, publicCanExecute, otherCanExecute, appCanAssume bool
	var ownerMembershipCount int
	err := runtime.QueryRow(ctx, `
		SELECT owner_role.rolcanlogin, owner_role.rolsuper,
		       owner_role.rolcreatedb, owner_role.rolcreaterole, owner_role.rolinherit,
		       owner_role.rolreplication, owner_role.rolbypassrls,
		       pg_catalog.has_function_privilege('chaste_app', function_row.oid, 'EXECUTE'),
		       EXISTS (
		         SELECT 1 FROM pg_catalog.aclexplode(COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))) acl
		         WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
		       ),
		       EXISTS (
		         SELECT 1 FROM pg_catalog.aclexplode(COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))) acl
		         WHERE acl.grantee NOT IN (0, owner_role.oid, (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'chaste_app'))
		           AND acl.privilege_type = 'EXECUTE'
		       ),
		       pg_catalog.pg_has_role('chaste_app', owner_role.oid, 'MEMBER'),
	       (SELECT count(*) FROM pg_catalog.pg_auth_members membership
	        WHERE membership.roleid = owner_role.oid OR membership.member = owner_role.oid)
		FROM pg_catalog.pg_roles AS owner_role
		JOIN pg_catalog.pg_proc AS function_row ON function_row.proname = 'chaste_bootstrap_organization'
		WHERE owner_role.rolname = 'chaste_bootstrap_owner' AND function_row.pronamespace = 'public'::regnamespace`).Scan(
		&login, &superuser, &createDB, &createRole, &inherit, &replication, &bypassRLS,
		&appCanExecute, &publicCanExecute, &otherCanExecute, &appCanAssume, &ownerMembershipCount,
	)
	if err != nil {
		t.Fatalf("read dedicated bootstrap role boundary: %v", err)
	}
	if login || superuser || createDB || createRole || inherit || replication || bypassRLS {
		t.Fatalf("bootstrap owner role attributes are unsafe: login=%t superuser=%t createdb=%t createrole=%t inherit=%t replication=%t bypassrls=%t",
			login, superuser, createDB, createRole, inherit, replication, bypassRLS)
	}
	if !appCanExecute || publicCanExecute || otherCanExecute || appCanAssume || ownerMembershipCount != 0 {
		t.Fatalf("bootstrap function grants or memberships are unsafe: chaste_app execute=%t public execute=%t other role execute=%t app member of owner=%t owner membership edges=%d", appCanExecute, publicCanExecute, otherCanExecute, appCanAssume, ownerMembershipCount)
	}
	var procOwner, searchPath string
	if err := runtime.QueryRow(ctx, `
		SELECT pg_catalog.pg_get_userbyid(proowner),
		       COALESCE((SELECT setting FROM pg_catalog.unnest(proconfig) setting WHERE setting LIKE 'search_path=%'), '')
		FROM pg_catalog.pg_proc WHERE proname = 'chaste_bootstrap_organization' AND pronamespace = 'public'::regnamespace`).Scan(&procOwner, &searchPath); err != nil {
		t.Fatalf("read bootstrap function ownership: %v", err)
	}
	if procOwner != "chaste_bootstrap_owner" || searchPath != "search_path=pg_catalog" {
		t.Fatalf("bootstrap function owner/search_path = %q/%q", procOwner, searchPath)
	}
	var membershipSelect, membershipInsert, membershipUpdate, membershipDelete bool
	if err := runtime.QueryRow(ctx, `
		SELECT pg_catalog.has_table_privilege('chaste_bootstrap_owner', 'public.memberships', 'SELECT'),
		       pg_catalog.has_table_privilege('chaste_bootstrap_owner', 'public.memberships', 'INSERT'),
		       pg_catalog.has_table_privilege('chaste_bootstrap_owner', 'public.memberships', 'UPDATE'),
		       pg_catalog.has_table_privilege('chaste_bootstrap_owner', 'public.memberships', 'DELETE')`).Scan(
		&membershipSelect, &membershipInsert, &membershipUpdate, &membershipDelete); err != nil {
		t.Fatalf("read bootstrap table privileges: %v", err)
	}
	if membershipSelect || !membershipInsert || membershipUpdate || membershipDelete {
		t.Fatalf("bootstrap owner membership privileges are too broad or incomplete: select=%t insert=%t update=%t delete=%t", membershipSelect, membershipInsert, membershipUpdate, membershipDelete)
	}
	var authSessionSelect, authUserSelect, userSelect, ownerCanCreate bool
	if err := runtime.QueryRow(ctx, `
		SELECT pg_catalog.has_table_privilege('chaste_bootstrap_owner', 'public.auth_session', 'SELECT'),
		       pg_catalog.has_table_privilege('chaste_bootstrap_owner', 'public.auth_user', 'SELECT'),
		       pg_catalog.has_table_privilege('chaste_bootstrap_owner', 'public.users', 'SELECT'),
		       pg_catalog.has_schema_privilege('chaste_bootstrap_owner', 'public', 'CREATE')`).Scan(
		&authSessionSelect, &authUserSelect, &userSelect, &ownerCanCreate); err != nil {
		t.Fatalf("read bootstrap identity table privileges: %v", err)
	}
	if authSessionSelect || authUserSelect || userSelect || ownerCanCreate {
		t.Fatalf("bootstrap owner has excess access session=%t auth_user=%t domain_user=%t schema_create=%t", authSessionSelect, authUserSelect, userSelect, ownerCanCreate)
	}
}

func legacyBootstrapPayloadHash(t *testing.T, input bootstrapTestInput) string {
	t.Helper()
	steps := append([]string(nil), input.steps...)
	// The fixture identifiers are ASCII, matching the legacy Array.sort order.
	for i := 0; i < len(steps); i++ {
		for j := i + 1; j < len(steps); j++ {
			if steps[j] < steps[i] {
				steps[i], steps[j] = steps[j], steps[i]
			}
		}
	}
	payload := struct {
		OrgName             string   `json:"orgName"`
		BusinessDescription string   `json:"businessDescription"`
		BaseCurrency        string   `json:"baseCurrency"`
		Path                string   `json:"path"`
		DeferredSteps       []string `json:"deferredSteps"`
	}{input.orgName, input.description, input.currency, input.path, steps}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	// JSON.stringify does not HTML-escape characters that Go's encoder escapes.
	encoded = []byte(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(string(encoded), `\u003c`, "<"), `\u003e`, ">"), `\u0026`, "&"))
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func assertBootstrapSlugExhaustionRollback(t *testing.T, ctx context.Context, owner, runtime *pgxpool.Pool, user struct {
	id       string
	email    string
	verified bool
}, token string, collisionSlugs *[]string) {
	t.Helper()
	baseSlug := "slug-exhaustion-" + user.id[:8]
	for _, suffix := range []string{"", "-2", "-3", "-4", "-5"} {
		*collisionSlugs = append(*collisionSlugs, baseSlug+suffix)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO public.organizations (name, slug)
		SELECT 'Bootstrap slug collision fixture ' || candidate.slug, candidate.slug
		FROM unnest($1::text[]) AS candidate(slug)`, *collisionSlugs); err != nil {
		t.Fatal(err)
	}
	input := bootstrapTestInput{
		sessionToken: token,
		orgName:      "Slug Exhaustion " + user.id[:8],
		description:  "All five candidate slugs are occupied, so bootstrap must roll back cleanly.",
		currency:     "USD",
		path:         "fresh",
		intent:       "slug-exhaustion-" + integrationUUID(t),
	}
	if _, _, err := callOrganizationBootstrap(ctx, runtime, input); err == nil {
		t.Fatal("bootstrap succeeded after all five candidate slugs were occupied")
	} else {
		var postgresErr *pgconn.PgError
		if !errors.As(err, &postgresErr) || postgresErr.Message != "failed to create organization" {
			t.Fatalf("slug exhaustion returned unexpected error: %v", err)
		}
	}
	var orgs, accounts, roles, policies, memories, memberships, receipts, users int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.organizations WHERE slug = ANY($1::text[])`, *collisionSlugs).Scan(&orgs); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.accounts WHERE org_id IN (SELECT id FROM public.organizations WHERE slug = ANY($1::text[]))`, *collisionSlugs).Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.roles WHERE org_id IN (SELECT id FROM public.organizations WHERE slug = ANY($1::text[]))`, *collisionSlugs).Scan(&roles); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.policies WHERE org_id IN (SELECT id FROM public.organizations WHERE slug = ANY($1::text[]))`, *collisionSlugs).Scan(&policies); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.memories WHERE org_id IN (SELECT id FROM public.organizations WHERE slug = ANY($1::text[]))`, *collisionSlugs).Scan(&memories); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = $1)`, user.email).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.bootstrap_intents WHERE user_id IN (SELECT id FROM public.users WHERE email = $1) AND intent_id = $2`, user.email, input.intent).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.users WHERE email = $1`, user.email).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if orgs != 5 || accounts != 0 || roles != 0 || policies != 0 || memories != 0 || memberships != 0 || receipts != 0 || users != 0 {
		t.Fatalf("slug exhaustion rollback left rows collision_orgs=%d accounts=%d roles=%d policies=%d memories=%d memberships=%d receipts=%d domain_users=%d",
			orgs, accounts, roles, policies, memories, memberships, receipts, users)
	}
}

func assertBootstrapRollback(t *testing.T, ctx context.Context, owner, runtime *pgxpool.Pool, user struct {
	id       string
	email    string
	verified bool
}, token string) {
	t.Helper()
	triggerID := integrationUUID(t)[:8]
	functionName := "bootstrap_fail_membership_" + triggerID
	triggerName := "bootstrap_fail_membership_" + triggerID
	if _, err := owner.Exec(ctx, fmt.Sprintf(`
		CREATE FUNCTION public.%s() RETURNS trigger
		LANGUAGE plpgsql AS $body$
		BEGIN
			IF EXISTS (
				SELECT 1 FROM public.users AS domain_user
				WHERE domain_user.id = NEW.user_id AND domain_user.email = '%s'
			) THEN
				RAISE EXCEPTION 'injected bootstrap failure';
			END IF;
			RETURN NEW;
		END;
		$body$;
		CREATE TRIGGER %s BEFORE INSERT ON public.memberships
		FOR EACH ROW EXECUTE FUNCTION public.%s()`, functionName, user.email, triggerName, functionName)); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = owner.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON public.memberships; DROP FUNCTION IF EXISTS public.%s()`, triggerName, functionName))
	}()

	input := bootstrapTestInput{
		sessionToken: token,
		orgName:      "Rollback Bootstrap Workspace " + user.id[:8],
		description:  "This workspace must roll back every row on a seed failure.",
		currency:     "USD",
		path:         "fresh",
		steps:        []string{"invite_team"},
		intent:       "rollback-intent-" + integrationUUID(t),
	}
	if _, _, err := callOrganizationBootstrap(ctx, runtime, input); err == nil {
		t.Fatal("injected membership failure did not abort bootstrap")
	}
	var organizations, receipts, accounts, roles, policies, memories, memberships, userRoles, domainUsers int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.organizations WHERE name = $1`, input.orgName).Scan(&organizations); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.bootstrap_intents WHERE intent_id = $1`, input.intent).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.accounts WHERE name = 'Cash' AND org_id IN (SELECT id FROM public.organizations WHERE name = $1)`, input.orgName).Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.roles WHERE org_id IN (SELECT id FROM public.organizations WHERE name = $1)`, input.orgName).Scan(&roles); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.policies WHERE org_id IN (SELECT id FROM public.organizations WHERE name = $1)`, input.orgName).Scan(&policies); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.memories WHERE org_id IN (SELECT id FROM public.organizations WHERE name = $1)`, input.orgName).Scan(&memories); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.users WHERE email = $1`, user.email).Scan(&domainUsers); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.memberships AS membership JOIN public.users AS domain_user ON domain_user.id = membership.user_id WHERE domain_user.email = $1`, user.email).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.user_roles AS user_role JOIN public.users AS domain_user ON domain_user.id = user_role.user_id WHERE domain_user.email = $1`, user.email).Scan(&userRoles); err != nil {
		t.Fatal(err)
	}
	if organizations != 0 || receipts != 0 || accounts != 0 || roles != 0 || policies != 0 || memories != 0 || memberships != 0 || userRoles != 0 || domainUsers != 0 {
		t.Fatalf("failed bootstrap left rows organizations=%d receipts=%d accounts=%d roles=%d policies=%d memories=%d memberships=%d user_roles=%d domain_users=%d", organizations, receipts, accounts, roles, policies, memories, memberships, userRoles, domainUsers)
	}
}
