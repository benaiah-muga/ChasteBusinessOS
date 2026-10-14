package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRoutinesSessionHandlerWorksThroughRuntimeRLS(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for routines session integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for routines session integration proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := orgParityEnv(t)
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

	fixture := seedOrgParityFixture(t, owner, secret)
	for _, permission := range []string{"routines.read", "routines.write"} {
		if _, err := owner.Exec(ctx, `
			INSERT INTO role_permissions (role_id, permission_key, org_id)
			SELECT role_id, $1, org_id FROM user_roles WHERE user_id=$2::uuid AND org_id=$3::uuid`,
			permission, fixture.userID, fixture.orgA); err != nil {
			t.Fatalf("grant %s: %v", permission, err)
		}
	}
	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["crm","routines"]'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatalf("enable routines in foreign organization fixture: %v", err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		SELECT role_id, 'routines.read', org_id FROM user_roles WHERE user_id=$1::uuid AND org_id=$2::uuid`,
		fixture.userID, fixture.orgB); err != nil {
		t.Fatalf("grant routines.read in foreign organization: %v", err)
	}
	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewRoutinesSessionHandler(runtime, resolver, capability.NewExecutor(runtime, "", "", ""), slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := func(method, body, organizationID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://app.example.test/api/routines", strings.NewReader(body))
		r.TLS = &tls.ConnectionState{}
		r.Host = "app.example.test"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://app.example.test")
		r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
		r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: organizationID})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response
	}

	listed := request(http.MethodGet, "", fixture.orgA)
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), `"routines":[]`) {
		t.Fatalf("runtime GET status=%d body=%s", listed.Code, listed.Body.String())
	}
	created := request(http.MethodPost, `{"action":"create","name":"Runtime HTTP proof","prompt":"Check overdue invoices","scheduleText":"weekdays at 9am","withWebhook":false,"intentId":"55555555-5555-4555-8555-555555555555"}`, fixture.orgA)
	if created.Code != http.StatusOK {
		t.Fatalf("runtime POST status=%d body=%s", created.Code, created.Body.String())
	}
	var result struct {
		RoutineID string `json:"routineId"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &result); err != nil || result.RoutineID == "" {
		t.Fatalf("runtime POST response=%s error=%v", created.Body.String(), err)
	}
	t.Cleanup(func() {
		if _, err := owner.Exec(context.Background(), `DELETE FROM routines WHERE id=$1::uuid AND org_id=$2::uuid`, result.RoutineID, fixture.orgA); err != nil {
			t.Errorf("delete runtime routines fixture row: %v", err)
		}
	})
	listed = request(http.MethodGet, "", fixture.orgA)
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), result.RoutineID) || !strings.Contains(listed.Body.String(), "Runtime HTTP proof") {
		t.Fatalf("runtime readback status=%d body=%s", listed.Code, listed.Body.String())
	}
	if strings.Contains(listed.Body.String(), "webhookToken") {
		t.Fatalf("runtime GET exposed a webhook token: %s", listed.Body.String())
	}
	foreignOrgList := request(http.MethodGet, "", fixture.orgB)
	if foreignOrgList.Code != http.StatusOK || strings.Contains(foreignOrgList.Body.String(), result.RoutineID) || strings.Contains(foreignOrgList.Body.String(), "Runtime HTTP proof") {
		t.Fatalf("foreign organization routines list leaked org A row: status=%d body=%s", foreignOrgList.Code, foreignOrgList.Body.String())
	}
}

func TestPgRoutinesWebhookTokenReaderScopesTokensByOrganization(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed routines integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed routines integration fixtures")
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

	orgID, otherOrgID := readContractUUID(t), readContractUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go routines token fixture', $2),
		($3::uuid, 'Go routines token foreign fixture', $4)`,
		orgID, "go-routines-token-"+orgID[:8], otherOrgID, "go-routines-token-foreign-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := owner.Exec(context.Background(), `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete routines token fixture organizations: %v", err)
		}
	})

	localToken := orgID
	foreignToken := otherOrgID
	for _, fixture := range []struct {
		orgID string
		token string
		name  string
	}{
		{orgID: orgID, token: localToken, name: "Local routine"},
		{orgID: otherOrgID, token: foreignToken, name: "Foreign routine"},
	} {
		if _, err := owner.Exec(ctx, `
			INSERT INTO routines (org_id, name, prompt, schedule, enabled, trigger_type, webhook_token)
			VALUES ($1::uuid, $2, 'Routine fixture prompt', '{"kind":"interval","everyMinutes":60}'::jsonb, true, 'webhook', $3)`,
			fixture.orgID, fixture.name, fixture.token); err != nil {
			t.Fatalf("insert %s: %v", fixture.name, err)
		}
	}
	const disabledToken = "ffffffff-ffff-4fff-8fff-ffffffffffff"
	if _, err := owner.Exec(ctx, `
		INSERT INTO routines (org_id, name, prompt, schedule, enabled, trigger_type, webhook_token)
		VALUES ($1::uuid, 'Disabled webhook routine', 'Routine fixture prompt', '{"kind":"interval","everyMinutes":60}'::jsonb, false, 'webhook', $2)`, orgID, disabledToken); err != nil {
		t.Fatalf("insert disabled routine: %v", err)
	}

	tokens, err := (pgRoutinesWebhookTokenReader{pool: runtime}).ForOrganization(ctx, orgID)
	if err != nil {
		t.Fatalf("read scoped webhook tokens: %v", err)
	}
	if len(tokens) != 1 {
		t.Fatalf("scoped token count = %d, want 1: %#v", len(tokens), tokens)
	}
	if tokensValue := tokensValueForToken(tokens, localToken); tokensValue == "" {
		t.Fatalf("local token not returned: %#v", tokens)
	}
	if tokensValue := tokensValueForToken(tokens, foreignToken); tokensValue != "" {
		t.Fatalf("foreign token leaked into organization result: %#v", tokens)
	}
	var localRoutineID string
	for id, token := range tokens {
		if token == localToken {
			localRoutineID = id
		}
	}
	if localRoutineID == "" {
		t.Fatalf("local routine id is missing from token result: %#v", tokens)
	}
	queued, err := (pgRoutinesWebhookEnqueuer{pool: runtime}).Enqueue(ctx, localToken)
	if err != nil || !queued {
		t.Fatalf("enqueue local webhook: queued=%t err=%v", queued, err)
	}
	queued, err = (pgRoutinesWebhookEnqueuer{pool: runtime}).Enqueue(ctx, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
	if err != nil || queued {
		t.Fatalf("unknown webhook token was accepted: queued=%t err=%v", queued, err)
	}
	queued, err = (pgRoutinesWebhookEnqueuer{pool: runtime}).Enqueue(ctx, disabledToken)
	if err != nil || queued {
		t.Fatalf("disabled webhook token was accepted: queued=%t err=%v", queued, err)
	}
	var enqueuedJobs int
	if err := owner.QueryRow(ctx, `
		SELECT count(*) FROM jobs
		WHERE org_id=$1::uuid AND type='routines.executeRoutine'
		  AND payload->>'routineId'=$2 AND payload->>'trigger'='webhook'`, orgID, localRoutineID).Scan(&enqueuedJobs); err != nil {
		t.Fatal(err)
	}
	if enqueuedJobs != 1 {
		t.Fatalf("queued webhook jobs=%d, want 1", enqueuedJobs)
	}
}

func tokensValueForToken(tokens map[string]string, token string) string {
	for _, value := range tokens {
		if value == token {
			return value
		}
	}
	return ""
}
