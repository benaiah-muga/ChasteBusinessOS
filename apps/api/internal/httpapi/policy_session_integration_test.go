package httpapi

import (
	"context"
	"crypto/tls"
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
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/policy"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPolicySessionHandlerRuntimeRLSAndGovernedWrites(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for policy session integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for policy session integration proof")
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
	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["crm","iam"]'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatalf("enable iam in reader organization: %v", err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, money_threshold_minor, requires_approval_for)
		VALUES ($1::uuid, '*', 'money', 125000, '["identity","*"]'::jsonb)`, fixture.orgA); err != nil {
		t.Fatalf("seed organization policy: %v", err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewPolicySessionHandler(resolver, policy.NewPostgresReader(runtime), capability.NewExecutor(runtime, "", "", ""), slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := func(method, body, organizationID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://app.example.test/api/policy", strings.NewReader(body))
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

	configured := request(http.MethodGet, "", fixture.orgA)
	if configured.Code != http.StatusOK || !strings.Contains(configured.Body.String(), `"maxRiskAutonomous":"money"`) || !strings.Contains(configured.Body.String(), `"moneyThresholdMinor":125000`) || !strings.Contains(configured.Body.String(), `"requiresApprovalFor":["identity","*"]`) || !strings.Contains(configured.Body.String(), `"canEdit":true`) {
		t.Fatalf("configured policy read status=%d body=%s", configured.Code, configured.Body.String())
	}
	defaults := request(http.MethodGet, "", fixture.orgB)
	if defaults.Code != http.StatusOK || !strings.Contains(defaults.Body.String(), `"maxRiskAutonomous":"write"`) || !strings.Contains(defaults.Body.String(), `"moneyThresholdMinor":50000`) || !strings.Contains(defaults.Body.String(), `"requiresApprovalFor":[]`) || !strings.Contains(defaults.Body.String(), `"canEdit":false`) {
		t.Fatalf("default policy read status=%d body=%s", defaults.Code, defaults.Body.String())
	}

	denied := request(http.MethodPost, `{"maxRiskAutonomous":"read","intentId":"33333333-3333-4333-8333-333333333333"}`, fixture.orgB)
	if denied.Code != http.StatusUnprocessableEntity || !strings.Contains(denied.Body.String(), "iam.admin") {
		t.Fatalf("write without iam.admin status=%d body=%s", denied.Code, denied.Body.String())
	}
	var policyCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM policies WHERE org_id=$1::uuid AND capability_pattern='*'`, fixture.orgB).Scan(&policyCount); err != nil || policyCount != 0 {
		t.Fatalf("foreign policy rows after denied write=%d err=%v", policyCount, err)
	}
	pending := request(http.MethodPost, `{"maxRiskAutonomous":"read","intentId":"33333333-3333-4333-8333-333333333334"}`, fixture.orgA)
	if pending.Code != http.StatusAccepted || !strings.Contains(pending.Body.String(), `"pendingApproval":true`) || !strings.Contains(pending.Body.String(), "Approvals inbox") {
		t.Fatalf("policy approval requirement status=%d body=%s", pending.Code, pending.Body.String())
	}
	if _, err := owner.Exec(ctx, `UPDATE policies SET requires_approval_for='[]'::jsonb WHERE org_id=$1::uuid AND capability_pattern='*'`, fixture.orgA); err != nil {
		t.Fatalf("clear approval requirement for direct human write proof: %v", err)
	}

	allowed := request(http.MethodPost, `{"maxRiskAutonomous":"destructive","moneyThresholdMinor":9000,"requiresApprovalFor":["money"],"intentId":"44444444-4444-4444-8444-444444444444"}`, fixture.orgA)
	if allowed.Code != http.StatusOK || !strings.Contains(allowed.Body.String(), `"ok":true`) {
		t.Fatalf("authorized policy write status=%d body=%s", allowed.Code, allowed.Body.String())
	}
	var risk string
	var threshold int64
	var approvals string
	if err := owner.QueryRow(ctx, `SELECT max_risk_autonomous, money_threshold_minor, requires_approval_for::text FROM policies WHERE org_id=$1::uuid AND capability_pattern='*'`, fixture.orgA).Scan(&risk, &threshold, &approvals); err != nil || risk != "destructive" || threshold != 9000 || approvals != `["money"]` {
		t.Fatalf("saved policy risk=%q threshold=%d approvals=%q err=%v", risk, threshold, approvals, err)
	}
	var auditCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id='iam.setOrgPolicy'`, fixture.orgA).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("policy audit count=%d err=%v", auditCount, err)
	}
}
