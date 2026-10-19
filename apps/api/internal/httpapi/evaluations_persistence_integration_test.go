package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEvaluationRunPersistenceIntegration(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for the evaluation persistence proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for the evaluation persistence proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := orgParityEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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
	fixture := seedOrgParityFixture(t, owner, secret)
	orgID := fixture.orgA
	t.Cleanup(func() {
		_, _ = owner.Exec(context.Background(), `DELETE FROM evaluation_runs WHERE org_id = $1::uuid`, orgID)
	})
	resolved := &session.ResolvedUser{
		UserID: fixture.userID, OrgID: &orgID, Permissions: map[string]bool{"iam.admin": true},
		EmailVerified: true, AuthSessionID: "44444444-4444-4444-8444-444444444444",
	}
	handler := NewEvaluationSessionHandler(runtime, &fakeDirectSessionResolver{resolved: resolved}, nil)
	handler.provider = func() (chatProvider, string, error) {
		return &evaluationScriptedProvider{turns: []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call-1", Name: "inventory_replenishmentPlan", Arguments: json.RawMessage(`{}`)}}},
			{toolCalls: []chatToolCall{{ID: "call-2", Name: "purchasing_createPurchaseOrder", Arguments: json.RawMessage(`{"vendorId":"33333333-3333-4333-8333-333333333333","lines":[{"quantity":10000,"unitPriceMinor":500000}]}`)}}},
			{message: "The order is waiting for approval."},
		}}, "deepseek-flash", nil
	}

	runRecorder := httptest.NewRecorder()
	handler.ServeHTTP(runRecorder, directCapabilityRequest(http.MethodPost, `{"scenarioId":"inventory-proposal-low-stock"}`))
	if runRecorder.Code != http.StatusOK {
		t.Fatalf("run status=%d body=%s", runRecorder.Code, runRecorder.Body.String())
	}
	var run EvaluationRunResult
	if err := json.Unmarshal(runRecorder.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}
	if !run.Persisted || run.CreatedAt.IsZero() || run.Status != "passed" {
		t.Fatalf("run persisted=%t createdAt=%s status=%s", run.Persisted, run.CreatedAt, run.Status)
	}

	listRequest := httptest.NewRequest(http.MethodGet, "/api/evaluations", nil)
	listRequest.AddCookie(&http.Cookie{Name: "chaste_session", Value: "session-cookie"})
	listRecorder := httptest.NewRecorder()
	handler.ServeHTTP(listRecorder, listRequest)
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", listRecorder.Code, listRecorder.Body.String())
	}
	var catalog struct {
		RecentRuns []EvaluationRunResult `json:"recentRuns"`
	}
	if err := json.Unmarshal(listRecorder.Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.RecentRuns) != 1 || catalog.RecentRuns[0].ScenarioID != "inventory-proposal-low-stock" || !catalog.RecentRuns[0].Persisted {
		t.Fatalf("recent runs=%+v", catalog.RecentRuns)
	}
	var count int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM evaluation_runs WHERE org_id = $1::uuid`, orgID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("database count=%d, want 1", count)
	}
}
