package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoSCIMWriteRouteUsesExternalCapabilityAndIdempotentReceipts(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Fatal("GO_DATABASE_URL or DATABASE_URL is required for SCIM write integration")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed SCIM write fixtures")
		}
		t.Skip("DATABASE_URL is required to seed SCIM write fixtures")
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

	orgID := readContractUUID(t)
	otherOrgID := readContractUUID(t)
	tokenID := readContractUUID(t)
	userID := ""
	foreignUserID := readContractUUID(t)
	additionalUserIDs := []string{foreignUserID}
	rawToken := "scim-write-" + readContractUUID(t)
	tokenHash := sha256.Sum256([]byte(rawToken))
	_, err = owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go SCIM write fixture', $2), ($3::uuid, 'Go SCIM foreign fixture', $4)`,
		orgID, "go-scim-write-"+orgID[:8], otherOrgID, "go-scim-foreign-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Foreign SCIM fixture user')`, foreignUserID, "foreign-scim-write-"+orgID[:8]+"@fixture.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, otherOrgID, foreignUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO scim_tokens (id, org_id, token_hash, label, active, expires_at)
		VALUES ($1::uuid, $2::uuid, $3, 'Go SCIM write fixture', true, clock_timestamp() + interval '1 hour')`,
		tokenID, orgID, hex.EncodeToString(tokenHash[:])); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := owner.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("begin SCIM write cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if _, err := tx.Exec(cleanupCtx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable SCIM write ledger cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM ledger_events WHERE org_id = $1::uuid`, orgID); err != nil {
			t.Errorf("delete SCIM write ledger events: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete SCIM write organization: %v", err)
			return
		}
		if userID != "" {
			if _, err := tx.Exec(cleanupCtx, `DELETE FROM users WHERE id = $1::uuid`, userID); err != nil {
				t.Errorf("delete SCIM write user: %v", err)
				return
			}
		}
		for _, additionalUserID := range additionalUserIDs {
			if _, err := tx.Exec(cleanupCtx, `DELETE FROM users WHERE id = $1::uuid`, additionalUserID); err != nil {
				t.Errorf("delete additional SCIM write user: %v", err)
				return
			}
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit SCIM write cleanup: %v", err)
		}
	})

	handler, err := NewSCIMWriteHandler(runtime, capability.NewExecutor(runtime, "", "", ""), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	invalidTokenRequest := httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", strings.NewReader(`{"userName":"outside@example.test"}`))
	invalidTokenRequest.RemoteAddr = "192.0.2.79:12345"
	invalidTokenRequest.Header.Set("Authorization", "Bearer invalid-scim-token")
	invalidTokenResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidTokenResponse, invalidTokenRequest)
	var invalidTokenError scimErrorResponse
	if invalidTokenResponse.Code != http.StatusUnauthorized || json.Unmarshal(invalidTokenResponse.Body.Bytes(), &invalidTokenError) != nil ||
		invalidTokenError.Status != "401" || invalidTokenError.Detail != "invalid or missing SCIM token" {
		t.Fatalf("invalid SCIM token response status=%d body=%s", invalidTokenResponse.Code, invalidTokenResponse.Body.String())
	}
	email := "scim-write-" + orgID[:8] + "@fixture.test"
	body := `{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"` + email + `","name":{"givenName":"SCIM Fixture"}}`
	request := httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", strings.NewReader(body))
	request.RemoteAddr = "192.0.2.80:12345"
	request.Header.Set("Authorization", "Bearer "+rawToken)
	request.Header.Set("Content-Type", "application/scim+json")
	request.Header.Set("Idempotency-Key", "30000000-0000-4000-8000-000000000001")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("SCIM create status=%d body=%s", response.Code, response.Body.String())
	}
	var resource scimUserResource
	if err := json.Unmarshal(response.Body.Bytes(), &resource); err != nil {
		t.Fatal(err)
	}
	if resource.ID == "" || resource.UserName != email || resource.Name.GivenName != "SCIM Fixture" || !resource.Active ||
		len(resource.Schemas) != 1 || resource.Schemas[0] != "urn:ietf:params:scim:schemas:core:2.0:User" ||
		len(resource.Emails) != 1 || resource.Emails[0] != (scimUserEmail{Value: email, Primary: true}) {
		t.Fatalf("SCIM created resource=%+v", resource)
	}
	userID = resource.ID

	retry := httptest.NewRecorder()
	retryRequest := httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", strings.NewReader(body))
	retryRequest.RemoteAddr = "192.0.2.80:12345"
	retryRequest.Header.Set("Authorization", "Bearer "+rawToken)
	retryRequest.Header.Set("Content-Type", "application/scim+json")
	retryRequest.Header.Set("Idempotency-Key", "30000000-0000-4000-8000-000000000001")
	handler.ServeHTTP(retry, retryRequest)
	if retry.Code != http.StatusCreated {
		t.Fatalf("SCIM retry status=%d body=%s", retry.Code, retry.Body.String())
	}
	var memberships int
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid`, orgID, userID).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if memberships != 1 {
		t.Fatalf("membership count after retry=%d, want one", memberships)
	}
	var createEvents int
	if err := owner.QueryRow(ctx, `
		SELECT count(*)::int FROM ledger_events WHERE org_id=$1::uuid
		AND capability_id='iam.scimProvisionUser' AND actor_type='external'`, orgID).Scan(&createEvents); err != nil {
		t.Fatal(err)
	}
	if createEvents != 1 {
		t.Fatalf("SCIM create ledger events=%d, want one after retry", createEvents)
	}
	var createActorID string
	if err := owner.QueryRow(ctx, `
		SELECT actor_id::text FROM ledger_events
		WHERE org_id = $1::uuid AND capability_id = 'iam.scimProvisionUser' AND actor_type = 'external'
		ORDER BY seq LIMIT 1`, orgID).Scan(&createActorID); err != nil {
		t.Fatal(err)
	}
	if createActorID != tokenID {
		t.Fatalf("SCIM provisioning actor=%s, want token %s", createActorID, tokenID)
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+userID, nil)
	deleteRequest.RemoteAddr = "192.0.2.80:12345"
	deleteRequest.Header.Set("Authorization", "Bearer "+rawToken)
	deleteRequest.Header.Set("Idempotency-Key", "30000000-0000-4000-8000-000000000002")
	deleteResponse := httptest.NewRecorder()
	handler.ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusNoContent {
		t.Fatalf("SCIM deactivation status=%d body=%s", deleteResponse.Code, deleteResponse.Body.String())
	}
	deleteRetry := httptest.NewRecorder()
	deleteRetryRequest := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+userID, nil)
	deleteRetryRequest.RemoteAddr = "192.0.2.80:12345"
	deleteRetryRequest.Header.Set("Authorization", "Bearer "+rawToken)
	deleteRetryRequest.Header.Set("Idempotency-Key", "30000000-0000-4000-8000-000000000002")
	handler.ServeHTTP(deleteRetry, deleteRetryRequest)
	if deleteRetry.Code != http.StatusNoContent {
		t.Fatalf("SCIM deactivation retry status=%d body=%s", deleteRetry.Code, deleteRetry.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid`, orgID, userID).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if memberships != 0 {
		t.Fatalf("membership count after SCIM deactivation=%d, want zero", memberships)
	}
	var allEvents int
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM ledger_events WHERE org_id=$1::uuid AND capability_id='iam.scimProvisionUser' AND actor_type='external'`, orgID).Scan(&allEvents); err != nil {
		t.Fatal(err)
	}
	if allEvents != 2 {
		t.Fatalf("SCIM create/deactivation events=%d, want one per distinct operation", allEvents)
	}

	// A new key marks a new logical provisioning operation. Reusing the exact
	// original request body with its old key would only replay the old receipt.
	reactivateRequest := httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", strings.NewReader(body))
	reactivateRequest.RemoteAddr = "192.0.2.80:12345"
	reactivateRequest.Header.Set("Authorization", "Bearer "+rawToken)
	reactivateRequest.Header.Set("Content-Type", "application/scim+json")
	reactivateRequest.Header.Set("Idempotency-Key", "30000000-0000-4000-8000-000000000003")
	reactivateResponse := httptest.NewRecorder()
	handler.ServeHTTP(reactivateResponse, reactivateRequest)
	if reactivateResponse.Code != http.StatusCreated {
		t.Fatalf("SCIM re-provision status=%d body=%s", reactivateResponse.Code, reactivateResponse.Body.String())
	}
	var reactivated scimUserResource
	if err := json.Unmarshal(reactivateResponse.Body.Bytes(), &reactivated); err != nil {
		t.Fatal(err)
	}
	if reactivated.ID != userID || !reactivated.Active {
		t.Fatalf("SCIM re-provision resource=%+v, want existing active user %s", reactivated, userID)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid`, orgID, userID).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if memberships != 1 {
		t.Fatalf("membership count after re-provision=%d, want one", memberships)
	}
	reactivateRetry := httptest.NewRecorder()
	reactivateRetryRequest := httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", strings.NewReader(body))
	reactivateRetryRequest.RemoteAddr = "192.0.2.80:12345"
	reactivateRetryRequest.Header.Set("Authorization", "Bearer "+rawToken)
	reactivateRetryRequest.Header.Set("Content-Type", "application/scim+json")
	reactivateRetryRequest.Header.Set("Idempotency-Key", "30000000-0000-4000-8000-000000000003")
	handler.ServeHTTP(reactivateRetry, reactivateRetryRequest)
	if reactivateRetry.Code != http.StatusCreated {
		t.Fatalf("SCIM re-provision retry status=%d body=%s", reactivateRetry.Code, reactivateRetry.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM ledger_events WHERE org_id=$1::uuid AND capability_id='iam.scimProvisionUser' AND actor_type='external'`, orgID).Scan(&allEvents); err != nil {
		t.Fatal(err)
	}
	if allEvents != 3 {
		t.Fatalf("SCIM create/deactivate/re-provision events=%d, want one per distinct operation", allEvents)
	}

	standardInitialDelete := httptest.NewRecorder()
	standardInitialDeleteRequest := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+userID, nil)
	standardInitialDeleteRequest.RemoteAddr = "192.0.2.80:12345"
	standardInitialDeleteRequest.Header.Set("Authorization", "Bearer "+rawToken)
	handler.ServeHTTP(standardInitialDelete, standardInitialDeleteRequest)
	if standardInitialDelete.Code != http.StatusNoContent {
		t.Fatalf("standard initial SCIM delete status=%d body=%s", standardInitialDelete.Code, standardInitialDelete.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid`, orgID, userID).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if memberships != 0 {
		t.Fatalf("membership count before standard-client create=%d, want zero", memberships)
	}

	standardCreate := httptest.NewRecorder()
	standardCreateRequest := httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", strings.NewReader(body))
	standardCreateRequest.RemoteAddr = "192.0.2.80:12345"
	standardCreateRequest.Header.Set("Authorization", "Bearer "+rawToken)
	standardCreateRequest.Header.Set("Content-Type", "application/scim+json")
	handler.ServeHTTP(standardCreate, standardCreateRequest)
	if standardCreate.Code != http.StatusCreated {
		t.Fatalf("standard SCIM create status=%d body=%s", standardCreate.Code, standardCreate.Body.String())
	}
	standardCreateRetry := httptest.NewRecorder()
	standardCreateRetryRequest := httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", strings.NewReader(body))
	standardCreateRetryRequest.RemoteAddr = "192.0.2.80:12345"
	standardCreateRetryRequest.Header.Set("Authorization", "Bearer "+rawToken)
	standardCreateRetryRequest.Header.Set("Content-Type", "application/scim+json")
	handler.ServeHTTP(standardCreateRetry, standardCreateRetryRequest)
	if standardCreateRetry.Code != http.StatusCreated {
		t.Fatalf("standard SCIM create retry status=%d body=%s", standardCreateRetry.Code, standardCreateRetry.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM ledger_events WHERE org_id=$1::uuid AND capability_id='iam.scimProvisionUser' AND actor_type='external'`, orgID).Scan(&allEvents); err != nil {
		t.Fatal(err)
	}
	if allEvents != 5 {
		t.Fatalf("SCIM create retry events=%d, want one event for the operation", allEvents)
	}

	standardDelete := httptest.NewRecorder()
	standardDeleteRequest := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+userID, nil)
	standardDeleteRequest.RemoteAddr = "192.0.2.80:12345"
	standardDeleteRequest.Header.Set("Authorization", "Bearer "+rawToken)
	handler.ServeHTTP(standardDelete, standardDeleteRequest)
	if standardDelete.Code != http.StatusNoContent {
		t.Fatalf("standard SCIM delete status=%d body=%s", standardDelete.Code, standardDelete.Body.String())
	}
	standardDeleteRetry := httptest.NewRecorder()
	standardDeleteRetryRequest := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+userID, nil)
	standardDeleteRetryRequest.RemoteAddr = "192.0.2.80:12345"
	standardDeleteRetryRequest.Header.Set("Authorization", "Bearer "+rawToken)
	handler.ServeHTTP(standardDeleteRetry, standardDeleteRetryRequest)
	if standardDeleteRetry.Code != http.StatusNoContent {
		t.Fatalf("standard SCIM delete retry status=%d body=%s", standardDeleteRetry.Code, standardDeleteRetry.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid`, orgID, userID).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if memberships != 0 {
		t.Fatalf("membership count after standard SCIM delete=%d, want zero", memberships)
	}

	standardReprovision := httptest.NewRecorder()
	standardReprovisionRequest := httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", strings.NewReader(body))
	standardReprovisionRequest.RemoteAddr = "192.0.2.80:12345"
	standardReprovisionRequest.Header.Set("Authorization", "Bearer "+rawToken)
	standardReprovisionRequest.Header.Set("Content-Type", "application/scim+json")
	handler.ServeHTTP(standardReprovision, standardReprovisionRequest)
	if standardReprovision.Code != http.StatusCreated {
		t.Fatalf("standard SCIM re-provision status=%d body=%s", standardReprovision.Code, standardReprovision.Body.String())
	}
	standardReprovisionRetry := httptest.NewRecorder()
	standardReprovisionRetryRequest := httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", strings.NewReader(body))
	standardReprovisionRetryRequest.RemoteAddr = "192.0.2.80:12345"
	standardReprovisionRetryRequest.Header.Set("Authorization", "Bearer "+rawToken)
	standardReprovisionRetryRequest.Header.Set("Content-Type", "application/scim+json")
	handler.ServeHTTP(standardReprovisionRetry, standardReprovisionRetryRequest)
	if standardReprovisionRetry.Code != http.StatusCreated {
		t.Fatalf("standard SCIM re-provision retry status=%d body=%s", standardReprovisionRetry.Code, standardReprovisionRetry.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid`, orgID, userID).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if memberships != 1 {
		t.Fatalf("membership count after standard SCIM re-provision=%d, want one", memberships)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM ledger_events WHERE org_id=$1::uuid AND capability_id='iam.scimProvisionUser' AND actor_type='external'`, orgID).Scan(&allEvents); err != nil {
		t.Fatal(err)
	}
	if allEvents != 7 {
		t.Fatalf("standard SCIM lifecycle events=%d, want one per distinct operation", allEvents)
	}

	ownerRoleID := readContractUUID(t)
	if _, err := owner.Exec(ctx, `INSERT INTO roles (id, org_id, key, name, is_system) VALUES ($1::uuid, $2::uuid, 'owner', 'Owner', true)`, ownerRoleID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, userID, ownerRoleID, orgID); err != nil {
		t.Fatal(err)
	}
	lastOwnerDelete := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+userID, nil)
	lastOwnerDelete.RemoteAddr = "192.0.2.80:12345"
	lastOwnerDelete.Header.Set("Authorization", "Bearer "+rawToken)
	lastOwnerResponse := httptest.NewRecorder()
	handler.ServeHTTP(lastOwnerResponse, lastOwnerDelete)
	var lastOwnerError scimErrorResponse
	if lastOwnerResponse.Code != http.StatusConflict || json.Unmarshal(lastOwnerResponse.Body.Bytes(), &lastOwnerError) != nil ||
		lastOwnerError.Status != "409" || lastOwnerError.Detail != "cannot deactivate the organization's last owner" {
		t.Fatalf("last-owner SCIM deactivation status=%d body=%s", lastOwnerResponse.Code, lastOwnerResponse.Body.String())
	}
	lastOwnerRetry := httptest.NewRecorder()
	lastOwnerRetryRequest := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+userID, nil)
	lastOwnerRetryRequest.RemoteAddr = "192.0.2.80:12345"
	lastOwnerRetryRequest.Header.Set("Authorization", "Bearer "+rawToken)
	handler.ServeHTTP(lastOwnerRetry, lastOwnerRetryRequest)
	if lastOwnerRetry.Code != http.StatusConflict {
		t.Fatalf("last-owner SCIM retry status=%d body=%s", lastOwnerRetry.Code, lastOwnerRetry.Body.String())
	}
	var cachedConflicts int
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM action_receipts WHERE org_id=$1::uuid AND capability_id='iam.scimProvisionUser' AND data->>'conflict'='last_owner'`, orgID).Scan(&cachedConflicts); err != nil {
		t.Fatal(err)
	}
	if cachedConflicts != 0 {
		t.Fatalf("automatic SCIM cached %d last-owner conflict receipts", cachedConflicts)
	}

	secondOwnerID := readContractUUID(t)
	additionalUserIDs = append(additionalUserIDs, secondOwnerID)
	if _, err := owner.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Second SCIM fixture owner')`, secondOwnerID, "second-owner-"+orgID[:8]+"@fixture.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, orgID, secondOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, secondOwnerID, ownerRoleID, orgID); err != nil {
		t.Fatal(err)
	}
	resolvedOwnerDelete := httptest.NewRecorder()
	resolvedOwnerDeleteRequest := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+userID, nil)
	resolvedOwnerDeleteRequest.RemoteAddr = "192.0.2.80:12345"
	resolvedOwnerDeleteRequest.Header.Set("Authorization", "Bearer "+rawToken)
	handler.ServeHTTP(resolvedOwnerDelete, resolvedOwnerDeleteRequest)
	if resolvedOwnerDelete.Code != http.StatusNoContent {
		t.Fatalf("SCIM deactivation after owner grant status=%d body=%s", resolvedOwnerDelete.Code, resolvedOwnerDelete.Body.String())
	}

	missingUserID := readContractUUID(t)
	additionalUserIDs = append(additionalUserIDs, missingUserID)
	missingDelete := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+missingUserID, nil)
	missingDelete.RemoteAddr = "192.0.2.80:12345"
	missingDelete.Header.Set("Authorization", "Bearer "+rawToken)
	missingResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingResponse, missingDelete)
	if missingResponse.Code != http.StatusNotFound {
		t.Fatalf("missing-member SCIM deactivation status=%d body=%s", missingResponse.Code, missingResponse.Body.String())
	}
	var missingError scimErrorResponse
	if err := json.Unmarshal(missingResponse.Body.Bytes(), &missingError); err != nil || missingError.Status != "404" || missingError.Detail != "user not found" {
		t.Fatalf("missing-member SCIM error envelope = %+v, err=%v", missingError, err)
	}
	malformedDelete := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/not-a-uuid", nil)
	malformedDelete.RemoteAddr = "192.0.2.82:12345"
	malformedDelete.Header.Set("Authorization", "Bearer "+rawToken)
	malformedResponse := httptest.NewRecorder()
	handler.ServeHTTP(malformedResponse, malformedDelete)
	var malformedError scimErrorResponse
	if err := json.Unmarshal(malformedResponse.Body.Bytes(), &malformedError); malformedResponse.Code != http.StatusNotFound || err != nil || malformedError.Status != "404" || malformedError.Detail != "user not found" {
		t.Fatalf("malformed-user SCIM response status=%d body=%s err=%v", malformedResponse.Code, malformedResponse.Body.String(), err)
	}
	foreignDelete := httptest.NewRecorder()
	foreignDeleteRequest := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+foreignUserID, nil)
	foreignDeleteRequest.RemoteAddr = "192.0.2.83:12345"
	foreignDeleteRequest.Header.Set("Authorization", "Bearer "+rawToken)
	handler.ServeHTTP(foreignDelete, foreignDeleteRequest)
	var foreignError scimErrorResponse
	if err := json.Unmarshal(foreignDelete.Body.Bytes(), &foreignError); foreignDelete.Code != http.StatusNotFound || err != nil || foreignError.Status != "404" || foreignError.Detail != "user not found" {
		t.Fatalf("foreign-member SCIM response status=%d body=%s err=%v", foreignDelete.Code, foreignDelete.Body.String(), err)
	}
	var foreignMemberships int
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid`, otherOrgID, foreignUserID).Scan(&foreignMemberships); err != nil {
		t.Fatal(err)
	}
	if foreignMemberships != 1 {
		t.Fatalf("SCIM foreign delete left %d foreign memberships, want 1", foreignMemberships)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Restored SCIM fixture member')`, missingUserID, "restored-member-"+orgID[:8]+"@fixture.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, orgID, missingUserID); err != nil {
		t.Fatal(err)
	}
	retriedMissingDelete := httptest.NewRecorder()
	retriedMissingDeleteRequest := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users/"+missingUserID, nil)
	retriedMissingDeleteRequest.RemoteAddr = "192.0.2.80:12345"
	retriedMissingDeleteRequest.Header.Set("Authorization", "Bearer "+rawToken)
	handler.ServeHTTP(retriedMissingDelete, retriedMissingDeleteRequest)
	if retriedMissingDelete.Code != http.StatusNoContent {
		t.Fatalf("SCIM deactivation after member restoration status=%d body=%s", retriedMissingDelete.Code, retriedMissingDelete.Body.String())
	}

	invalid := httptest.NewRecorder()
	invalidRequest := httptest.NewRequest(http.MethodPost, "/api/scim/v2/Users", strings.NewReader(`{"userName":"person@localhost"}`))
	invalidRequest.RemoteAddr = "192.0.2.81:12345"
	invalidRequest.Header.Set("Authorization", "Bearer "+rawToken)
	invalidRequest.Header.Set("Idempotency-Key", "30000000-0000-4000-8000-000000000004")
	handler.ServeHTTP(invalid, invalidRequest)
	var invalidError scimErrorResponse
	if invalid.Code != http.StatusBadRequest || json.Unmarshal(invalid.Body.Bytes(), &invalidError) != nil ||
		invalidError.Status != "400" || invalidError.Detail == "" || len(invalidError.Schemas) != 1 ||
		invalidError.Schemas[0] != "urn:ietf:params:scim:api:messages:2.0:Error" {
		t.Fatalf("invalid SCIM payload status=%d body=%s", invalid.Code, invalid.Body.String())
	}
}
