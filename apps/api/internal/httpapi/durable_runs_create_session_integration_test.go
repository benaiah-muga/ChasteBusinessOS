package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	durableHTTPProfile           = `{"id":"erp-prod","version":"1.0.0","environment":"erp-prod","authority":{"allowSourceWrites":false,"allowProcessLaunch":false,"allowCodeExecution":false,"allowRegistryMutation":false,"allowNetwork":true},"allowedModules":["accounting","crm"]}`
	durableHTTPBundles           = `[{"id":"core","version":"1.0.0","serviceIds":["ledger","mailer"]}]`
	durableHTTPPatches           = `[{"id":"defaults","version":"2.0.0","values":{"retention":{"days":90},"label":"erp"}}]`
	durableHTTPProfileDigest     = "a667f8842fe5203faa9f2174079f2b6f7e1de17cdb025fcd3f243d5bb706c81d"
	durableHTTPCompositionDigest = "75b91e4570ef5fe6ab768475ae605ac6d132221a94b356d7edc4ec8deebda1c5"
)

func TestDurableRunCreateHTTPDispatchesWithResolvedSessionAndPersistsTenantRows(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("GO_DATABASE_URL or DATABASE_URL is required for durable-run HTTP integration coverage")
		}
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal("resolve runtime database connection")
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed durable-run HTTP fixtures")
		}
		t.Skip("DATABASE_URL is required to seed durable-run HTTP fixtures")
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal("connect fixture database owner")
	}
	t.Cleanup(owner.Close)
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal("connect runtime database role")
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	orgID := integrationUUID(t)
	userID := integrationUUID(t)
	roleID := integrationUUID(t)
	compositionID := integrationUUID(t)
	compositionApprovalID := integrationUUID(t)
	runID := integrationUUID(t)
	stamp := time.Now().UTC().UnixNano()
	email := fmt.Sprintf("durable-run-http-%d@example.test", stamp)
	authUserID := "durable-run-http-user-" + orgID[:8]
	authSessionID := "durable-run-http-session-" + orgID[:8]
	authToken := "durable-run-http-token-" + orgID[:8]
	const sessionSecret = "durable-run-http-session-secret-0123456789abcdef"
	if _, err := owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Durable run HTTP fixture', $2)`, orgID, "durable-run-http-"+orgID[:8]); err != nil {
		t.Fatal("seed organization")
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id=$1::uuid`, orgID); err != nil {
			t.Errorf("delete durable-run HTTP organization fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM users WHERE id=$1::uuid`, userID); err != nil {
			t.Errorf("delete durable-run HTTP domain user fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_session WHERE id=$1`, authSessionID); err != nil {
			t.Errorf("delete durable-run HTTP auth session fixture")
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id=$1`, authUserID); err != nil {
			t.Errorf("delete durable-run HTTP auth user fixture")
		}
	})

	if _, err := owner.Exec(ctx, `INSERT INTO auth_user (id, name, email, email_verified) VALUES ($1, 'Durable Run HTTP', $2, true)`, authUserID, email); err != nil {
		t.Fatal("seed verified Better Auth user")
	}
	if _, err := owner.Exec(ctx, `INSERT INTO auth_session (id, expires_at, token, user_id) VALUES ($1, clock_timestamp()+interval '1 day', $2, $3)`, authSessionID, authToken, authUserID); err != nil {
		t.Fatal("seed Better Auth session")
	}
	if _, err := owner.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Durable Run HTTP')`, userID, email); err != nil {
		t.Fatal("seed domain user")
	}
	if _, err := owner.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, orgID, userID); err != nil {
		t.Fatal("seed organization membership")
	}
	if _, err := owner.Exec(ctx, `INSERT INTO roles (id, org_id, key, name) VALUES ($1::uuid, $2::uuid, 'durable_run_http', 'Durable run HTTP')`, roleID, orgID); err != nil {
		t.Fatal("seed role")
	}
	if _, err := owner.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, userID, roleID, orgID); err != nil {
		t.Fatal("seed role assignment")
	}
	for _, permission := range []string{"harness.approve", "crm.read"} {
		if _, err := owner.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, $2, $3::uuid)`, roleID, permission, orgID); err != nil {
			t.Fatalf("seed %s permission", permission)
		}
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO harness_compositions (id, org_id, profile_id, profile_version, environment, profile_digest, composition_digest, profile, bundles, patches)
		VALUES ($1::uuid, $2::uuid, 'erp-prod', '1.0.0', 'erp-prod', $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
		compositionID, orgID, durableHTTPProfileDigest, durableHTTPCompositionDigest, durableHTTPProfile, durableHTTPBundles, durableHTTPPatches); err != nil {
		t.Fatal("seed approved harness composition")
	}
	compositionApproval, err := json.Marshal(map[string]string{"compositionId": compositionID, "compositionDigest": durableHTTPCompositionDigest})
	if err != nil {
		t.Fatal("encode composition approval payload")
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO approvals (id, org_id, capability_id, risk_class, payload, rationale, status)
		VALUES ($1::uuid, $2::uuid, 'harness.approveComposition', 'write', $3::jsonb, 'durable run HTTP test', 'executed')`,
		compositionApprovalID, orgID, compositionApproval); err != nil {
		t.Fatal("seed executed composition approval")
	}

	resolver, err := session.NewResolver(runtime, sessionSecret)
	if err != nil {
		t.Fatal("create Better Auth session resolver")
	}
	durableRuns := NewDurableRunsSessionHandler(runtime, resolver, nil)
	route := MountGoSessionReadRoutes(http.NotFoundHandler(), nil, nil, durableRuns)
	body := fmt.Sprintf(`{"runId":%q,"goal":"Read customer records for the review","harnessCompositionId":%q,"harnessCompositionDigest":%q,"compositionApprovalId":%q,"steps":[{"capabilityId":"crm.listCustomers","input":{}}]}`,
		runID, compositionID, durableHTTPCompositionDigest, compositionApprovalID)
	request := httptest.NewRequest(http.MethodPost, "/api/durable-runs", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+authToken)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	route.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("POST status=%d body=%s", response.Code, response.Body.String())
	}
	var responseBody struct {
		RunID    string `json:"runId"`
		Status   string `json:"status"`
		Replayed bool   `json:"replayed"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &responseBody); err != nil || responseBody.RunID != runID || responseBody.Status != "pending" || responseBody.Replayed {
		t.Fatalf("POST response=%s err=%v", response.Body.String(), err)
	}

	var gotOrg, gotActor, gotComposition, gotDigest string
	if err := owner.QueryRow(ctx, `
		SELECT org_id::text, initiated_by_actor_id::text, harness_composition_id::text, harness_composition_digest
		FROM agent_runs WHERE id=$1::uuid`, runID).Scan(&gotOrg, &gotActor, &gotComposition, &gotDigest); err != nil {
		t.Fatal("load persisted durable run")
	}
	if gotOrg != orgID || gotActor != userID || gotComposition != compositionID || gotDigest != durableHTTPCompositionDigest {
		t.Fatalf("persisted run tenant/actor/composition mismatch: org=%q actor=%q composition=%q digest=%q", gotOrg, gotActor, gotComposition, gotDigest)
	}
	if got := countDurableRunHTTPRows(t, ctx, owner, `SELECT count(*) FROM agent_run_steps WHERE org_id=$1::uuid AND run_id=$2::uuid AND capability_id='crm.listCustomers'`, orgID, runID); got != 1 {
		t.Fatalf("persisted steps=%d, want one Go capability step", got)
	}
	if got := countDurableRunHTTPRows(t, ctx, owner, `SELECT count(*) FROM jobs WHERE org_id=$1::uuid AND run_id=$2::uuid AND run_step_index=0 AND type='crm.listCustomers'`, orgID, runID); got != 1 {
		t.Fatalf("persisted linked jobs=%d, want one tenant-scoped capability job", got)
	}
}

func countDurableRunHTTPRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(ctx, query, args...).Scan(&count); err != nil {
		t.Fatal("count durable-run HTTP fixture rows")
	}
	return count
}
