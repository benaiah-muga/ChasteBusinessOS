package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresApprovalInboxMatchesLegacyVisibilityOrderingLimitsAndDocumentScope(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		t.Skip("DATABASE_URL is required to seed approval inbox fixtures")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
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
		t.Fatalf("runtime role: %v", err)
	}

	orgID, foreignOrgID, userID, roleID := readContractUUID(t), readContractUUID(t), readContractUUID(t), readContractUUID(t)
	authUserID, authSessionID := "approval-inbox-user-"+readContractUUID(t), "approval-inbox-session-"+readContractUUID(t)
	email := "approval-inbox-" + userID[:8] + "@fixture.test"
	_, err = owner.Exec(ctx, `INSERT INTO organizations (id,name,slug) VALUES ($1,'Approval inbox fixture',$2),($3,'Approval inbox foreign fixture',$4)`, orgID, "approval-inbox-"+orgID[:8], foreignOrgID, "approval-inbox-foreign-"+foreignOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = owner.Exec(context.Background(), `DELETE FROM organizations WHERE id IN ($1::uuid,$2::uuid)`, orgID, foreignOrgID)
		_, _ = owner.Exec(context.Background(), `DELETE FROM auth_session WHERE id=$1`, authSessionID)
		_, _ = owner.Exec(context.Background(), `DELETE FROM auth_user WHERE id=$1`, authUserID)
		_, _ = owner.Exec(context.Background(), `DELETE FROM users WHERE id=$1::uuid`, userID)
	})
	if _, err = owner.Exec(ctx, `INSERT INTO users (id,email,name) VALUES ($1::uuid,$2,'Inbox Approver')`, userID, email); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO auth_user (id,name,email,email_verified) VALUES ($1,'Inbox Approver',$2,true)`, authUserID, email); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO auth_session (id,expires_at,token,user_id) VALUES ($1,$2,$3,$4)`, authSessionID, time.Now().Add(time.Hour), "token-"+readContractUUID(t), authUserID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO memberships (org_id,user_id) VALUES ($1::uuid,$2::uuid)`, orgID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO roles (id,org_id,key,name,is_system) VALUES ($1::uuid,$2::uuid,'fixture_accountant','Fixture accountant',false)`, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO role_permissions (role_id,permission_key,org_id) VALUES ($1::uuid,'accounting.post',$2::uuid)`, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO user_roles (user_id,role_id,org_id) VALUES ($1::uuid,$2::uuid,$3::uuid)`, userID, roleID, orgID); err != nil {
		t.Fatal(err)
	}
	localDoc, foreignDoc := readContractUUID(t), readContractUUID(t)
	if _, err = owner.Exec(ctx, `INSERT INTO documents (id,org_id,title,source_type,created_by_actor_type) VALUES ($1::uuid,$2::uuid,'Local proof','text','human'),($3::uuid,$4::uuid,'Foreign secret','text','human')`, localDoc, orgID, foreignDoc, foreignOrgID); err != nil {
		t.Fatal(err)
	}

	base := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Millisecond)
	for index := 0; index < 105; index++ {
		payload := json.RawMessage(`{"value":1}`)
		if index == 104 {
			payload = json.RawMessage(fmt.Sprintf(`{"documentId":%q,"sourceDocumentId":%q}`, localDoc, foreignDoc))
		}
		if _, err = owner.Exec(ctx, `INSERT INTO approvals (org_id,requested_by_user_id,capability_id,risk_class,payload,status,created_at) VALUES ($1::uuid,$2::uuid,'accounting.recordPayment','money',$3::jsonb,'pending',$4)`, orgID, userID, payload, base.Add(time.Duration(index)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	for index := 0; index < 4; index++ {
		if _, err = owner.Exec(ctx, `INSERT INTO approvals (org_id,capability_id,risk_class,payload,status,created_at) VALUES ($1::uuid,'iam.createRole','identity','{}'::jsonb,'pending',$2)`, orgID, base.Add(time.Duration(200+index)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	for index := 0; index < 30; index++ {
		status := []string{"approved", "executed", "rejected", "expired"}[index%4]
		if _, err = owner.Exec(ctx, `INSERT INTO approvals (org_id,requested_by_user_id,capability_id,risk_class,payload,status,created_at,decided_at) VALUES ($1::uuid,$2::uuid,'accounting.recordPayment','money','{}'::jsonb,$3,$4,$5)`, orgID, userID, status, base.Add(time.Duration(index)*time.Minute), base.Add(time.Duration(index)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	for index := 0; index < 4; index++ {
		status := []string{"approved", "executed", "rejected", "expired"}[index]
		decidedAt := base.Add(time.Duration(100+index) * time.Minute)
		if _, err = owner.Exec(ctx, `INSERT INTO approvals (org_id,capability_id,risk_class,payload,status,created_at,decided_at) VALUES ($1::uuid,'iam.createRole','identity','{}'::jsonb,$2,$3,$3)`, orgID, status, decidedAt); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = owner.Exec(ctx, `INSERT INTO approvals (org_id,capability_id,risk_class,payload,status,created_at,decided_at) VALUES ($1::uuid,'accounting.recordPayment','money','{}'::jsonb,'executed',$2,$2)`, foreignOrgID, base.Add(500*time.Minute)); err != nil {
		t.Fatal(err)
	}

	claims := authbridge.ApprovalInboxClaims{Subject: userID, OrganizationID: orgID, AuthSessionID: authSessionID, Permissions: []string{"accounting.post"}}
	registry := map[string]string{"accounting.recordPayment": "accounting.post", "iam.createRole": "iam.admin"}
	result, err := NewPostgresApprovalInboxReader(runtime).ReadApprovalInbox(ctx, claims, registry)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Approvals) != 96 || len(result.History) != 21 {
		t.Fatalf("got pending=%d history=%d, want 96 and 21 after legacy limit-before-permission filtering", len(result.Approvals), len(result.History))
	}
	if result.Approvals[0].CapabilityID != "accounting.recordPayment" || result.Approvals[0].CreatedAt <= result.Approvals[len(result.Approvals)-1].CreatedAt {
		t.Fatal("pending inbox is not descending by createdAt")
	}
	if result.History[0].DecidedAt == nil || result.History[len(result.History)-1].DecidedAt == nil || *result.History[0].DecidedAt <= *result.History[len(result.History)-1].DecidedAt {
		t.Fatal("history is not descending by decidedAt")
	}
	for _, row := range append(result.Approvals, result.History...) {
		if row.CapabilityID == "iam.createRole" || row.OrgID != orgID {
			t.Fatalf("invisible or foreign row leaked: %+v", row)
		}
	}
	latest := result.Approvals[0]
	if latest.RaisedBy.Kind != "human" || latest.RaisedBy.Name != "Inbox Approver" {
		t.Fatalf("legacy attribution mismatch: %+v", latest.RaisedBy)
	}
	if len(latest.RelatedDocuments) != 1 || latest.RelatedDocuments[0].ID != localDoc || latest.RelatedDocuments[0].Title != "Local proof" {
		t.Fatalf("related documents crossed scope or lost title: %+v", latest.RelatedDocuments)
	}
}
