package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

type unusedApprovalCapabilityExecutor struct{}

func (unusedApprovalCapabilityExecutor) Execute(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error) {
	return capability.Result{}, errors.New("rejection unexpectedly executed approval payload")
}

func TestPostgresApprovalDecisionSessionHandlerResolvesSessionAuthorizesAndAudits(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		t.Skip("DATABASE_URL is required to seed approval decision fixtures")
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

	orgID, userID, roleID, approvalID := integrationUUID(t), integrationUUID(t), integrationUUID(t), integrationUUID(t)
	authUserID := "approval-decision-user-" + integrationUUID(t)
	authSessionID := "approval-decision-session-" + integrationUUID(t)
	token := "approval-decision-token-" + integrationUUID(t)
	email := "approval-decision-" + userID[:8] + "@fixture.test"
	if _, err := owner.Exec(ctx, `INSERT INTO organizations (id,name,slug) VALUES ($1::uuid,'Approval decision fixture',$2)`, orgID, "approval-decision-"+orgID[:8]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := owner.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("begin approval decision fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		if _, err := tx.Exec(cleanupCtx, `SELECT set_config('app.ledger_maintenance','on',true)`); err != nil {
			t.Errorf("enable approval decision ledger cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM ledger_events WHERE org_id=$1::uuid`, orgID); err != nil {
			t.Errorf("delete approval decision ledger events: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM approvals WHERE org_id=$1::uuid`, orgID); err != nil {
			t.Errorf("delete approval decision rows: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM organizations WHERE id=$1::uuid`, orgID); err != nil {
			t.Errorf("delete approval decision organization: %v", err)
			return
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit approval decision fixture cleanup: %v", err)
			return
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_session WHERE id=$1`, authSessionID); err != nil {
			t.Errorf("delete approval decision session: %v", err)
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id=$1`, authUserID); err != nil {
			t.Errorf("delete approval decision auth user: %v", err)
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM users WHERE id=$1::uuid`, userID); err != nil {
			t.Errorf("delete approval decision domain user: %v", err)
		}
	})
	if _, err := owner.Exec(ctx, `INSERT INTO users (id,email,name) VALUES ($1::uuid,$2,'Approval reviewer')`, userID, email); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO auth_user (id,name,email,email_verified) VALUES ($1,'Approval reviewer',$2,true)`, authUserID, email); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO auth_session (id,expires_at,token,user_id) VALUES ($1,$2,$3,$4)`, authSessionID, time.Now().Add(time.Hour), token, authUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO memberships (org_id,user_id) VALUES ($1::uuid,$2::uuid)`, orgID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO roles (id,org_id,key,name,is_system) VALUES ($1::uuid,$2::uuid,'fixture_reviewer','Fixture reviewer',false)`, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO role_permissions (role_id,permission_key,org_id) VALUES ($1::uuid,'accounting.read',$2::uuid)`, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO user_roles (user_id,role_id,org_id) VALUES ($1::uuid,$2::uuid,$3::uuid)`, userID, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO approvals (id,org_id,requested_by_user_id,capability_id,risk_class,payload,status) VALUES ($1::uuid,$2::uuid,$3::uuid,'accounting.recordPayment','money','{"amountMinor":1000}'::jsonb,'pending')`, approvalID, orgID, userID); err != nil {
		t.Fatal(err)
	}
	resolver, err := session.NewResolver(runtime, "approval-decision-session-secret-0123456789")
	if err != nil {
		t.Fatal(err)
	}
	decider := capability.NewApprovalDecider(runtime, unusedApprovalCapabilityExecutor{})
	handler := NewApprovalDecisionSessionHandler(resolver, decider, nil)
	postReject := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/approvals?id="+approvalID, strings.NewReader(`{"decision":"reject","comment":"Reviewed"}`))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("X-Organization-ID", orgID)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	denied := postReject()
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "you lack authority") {
		t.Fatalf("rejection without capability permission status=%d body=%s, want 403", denied.Code, denied.Body.String())
	}
	var status string
	if err := owner.QueryRow(ctx, `SELECT status FROM approvals WHERE id=$1::uuid`, approvalID).Scan(&status); err != nil || status != "pending" {
		t.Fatalf("unauthorized approval status=%q err=%v, want pending", status, err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO role_permissions (role_id,permission_key,org_id) VALUES ($1::uuid,'accounting.post',$2::uuid)`, roleID, orgID); err != nil {
		t.Fatal(err)
	}

	accepted := postReject()
	if accepted.Code != http.StatusOK || !strings.Contains(accepted.Body.String(), `"status":"rejected"`) {
		t.Fatalf("authorized session rejection status=%d body=%s, want 200 rejected", accepted.Code, accepted.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM approvals WHERE id=$1::uuid`, approvalID).Scan(&status); err != nil || status != "rejected" {
		t.Fatalf("final approval status=%q err=%v, want rejected", status, err)
	}
	var decisionEvents int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.rejected' AND actor_id=$2::uuid`, orgID, userID).Scan(&decisionEvents); err != nil || decisionEvents != 1 {
		t.Fatalf("approval rejection audit events=%d err=%v, want one", decisionEvents, err)
	}
}
