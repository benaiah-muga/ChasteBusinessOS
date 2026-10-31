package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type evaluationScriptedProvider struct {
	turns []chatTurn
	calls int
	err   error
}

func (p *evaluationScriptedProvider) Stream(context.Context, []chatMessage, []chatToolSpec, func(string)) (chatTurn, error) {
	if p.err != nil {
		return chatTurn{}, p.err
	}
	if p.calls >= len(p.turns) {
		return chatTurn{message: "No further scripted turn."}, nil
	}
	turn := p.turns[p.calls]
	p.calls++
	return turn, nil
}

func evaluationAdminIdentity() *session.ResolvedUser {
	orgID := "11111111-1111-4111-8111-111111111111"
	return &session.ResolvedUser{
		UserID:        "22222222-2222-4222-8222-222222222222",
		OrgID:         &orgID,
		Permissions:   map[string]bool{"iam.admin": true},
		EmailVerified: true,
		AuthSessionID: "33333333-3333-4333-8333-333333333333",
	}
}

func TestEvaluationRunnerPassesExpectedToolChoice(t *testing.T) {
	scenario, ok := findEvaluationScenario("inventory-proposal-low-stock")
	if !ok {
		t.Fatal("scenario missing")
	}
	provider := &evaluationScriptedProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call-1", Name: "inventory_replenishmentPlan", Arguments: json.RawMessage(`{}`)}}, usage: chatUsage{Input: 10, Output: 2}},
		{toolCalls: []chatToolCall{{ID: "call-2", Name: "purchasing_createPurchaseOrder", Arguments: json.RawMessage(`{"vendorId":"33333333-3333-4333-8333-333333333333","lines":[{"sku":"CEM-1","quantity":10000,"unitPriceMinor":500000}]}`)}}, usage: chatUsage{Input: 5, Output: 2}},
		{message: "The purchase order is waiting for your approval.", usage: chatUsage{Input: 3, Output: 4}},
	}}
	result := runEvaluationScenario(context.Background(), provider, scenario, "deepseek-flash")
	if result.Status != "passed" {
		t.Fatalf("result=%+v, want passed", result)
	}
	if len(result.ToolCalls) != 2 || result.Usage.Input != 18 || result.Usage.Output != 8 {
		t.Fatalf("tool calls=%d usage=%+v", len(result.ToolCalls), result.Usage)
	}
}

func TestEvaluationRunnerFailsWhenForbiddenToolIsCalled(t *testing.T) {
	scenario, ok := findEvaluationScenario("inventory-incoming-covers")
	if !ok {
		t.Fatal("scenario missing")
	}
	provider := &evaluationScriptedProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call-1", Name: "inventory_replenishmentPlan", Arguments: json.RawMessage(`{}`)}}},
		{toolCalls: []chatToolCall{{ID: "call-2", Name: "purchasing_createPurchaseOrder", Arguments: json.RawMessage(`{"vendorId":"33333333-3333-4333-8333-333333333333","lines":[{"sku":"CEM-1","quantity":10000,"unitPriceMinor":500000}]}`)}}},
		{message: "Ordered."},
	}}
	result := runEvaluationScenario(context.Background(), provider, scenario, "deepseek-flash")
	if result.Status != "failed" {
		t.Fatalf("result=%+v, want failed", result)
	}
	for _, check := range result.Checks {
		if check.ID == "no-order" && check.Passed {
			t.Fatal("duplicate-order check passed when the tool was called")
		}
	}
}

func TestEvaluationRunnerReportsModelFailure(t *testing.T) {
	scenario, _ := findEvaluationScenario("inventory-proposal-low-stock")
	provider := &evaluationScriptedProvider{err: errors.New("provider unavailable")}
	result := runEvaluationScenario(context.Background(), provider, scenario, "deepseek-flash")
	if result.Status != "error" || !strings.Contains(result.Error, "model call failed") {
		t.Fatalf("result=%+v, want a model error", result)
	}
}

func TestEvaluationRunnerFailsWhenArgumentsAreWrong(t *testing.T) {
	scenario, ok := findEvaluationScenario("inventory-proposal-low-stock")
	if !ok {
		t.Fatal("scenario missing")
	}
	provider := &evaluationScriptedProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call-1", Name: "inventory_replenishmentPlan", Arguments: json.RawMessage(`{}`)}}},
		{toolCalls: []chatToolCall{{ID: "call-2", Name: "purchasing_createPurchaseOrder", Arguments: json.RawMessage(`{}`)}}},
		{message: "The order is waiting for approval."},
	}}
	result := runEvaluationScenario(context.Background(), provider, scenario, "deepseek-flash")
	if result.Status != "failed" {
		t.Fatalf("result=%+v, want failed for missing order arguments", result)
	}
	for _, check := range result.Checks {
		if check.ID == "vendor" && check.Passed {
			t.Fatal("vendor argument check passed for an empty purchase order")
		}
	}
}

func TestEvaluationProviderRejectsUnsafeEndpointAndEmptyModel(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "test-key")
	t.Setenv("DEEPSEEK_BASE_URL", "http://127.0.0.1:8081")
	if _, _, err := evaluationProviderFromEnv(); err == nil {
		t.Fatal("unsafe HTTP endpoint was accepted")
	}
	t.Setenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
	t.Setenv("DEEPSEEK_MODEL", "   ")
	if _, _, err := evaluationProviderFromEnv(); err == nil {
		t.Fatal("empty model was accepted")
	}
}

func TestEvaluationHandlerListsAndRunsAdminScenarios(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: evaluationAdminIdentity()}
	handler := NewEvaluationSessionHandler(nil, resolver, nil)
	handler.provider = func() (chatProvider, string, error) {
		return &evaluationScriptedProvider{turns: []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call-1", Name: "inventory_replenishmentPlan", Arguments: json.RawMessage(`{}`)}}},
			{toolCalls: []chatToolCall{{ID: "call-2", Name: "purchasing_createPurchaseOrder", Arguments: json.RawMessage(`{"vendorId":"33333333-3333-4333-8333-333333333333","lines":[{"sku":"CEM-1","quantity":10000,"unitPriceMinor":500000}]}`)}}},
			{message: "This is waiting for approval."},
		}}, "deepseek-flash", nil
	}

	listRequest := httptest.NewRequest(http.MethodGet, "/api/evaluations", nil)
	listRequest.AddCookie(&http.Cookie{Name: "chaste_session", Value: "session-cookie"})
	listRecorder := httptest.NewRecorder()
	handler.ServeHTTP(listRecorder, listRequest)
	if listRecorder.Code != http.StatusOK || !strings.Contains(listRecorder.Body.String(), "inventory-proposal-low-stock") {
		t.Fatalf("list status=%d body=%s", listRecorder.Code, listRecorder.Body.String())
	}

	runRequest := directCapabilityRequest(http.MethodPost, `{"scenarioId":"inventory-proposal-low-stock"}`)
	runRecorder := httptest.NewRecorder()
	handler.ServeHTTP(runRecorder, runRequest)
	if runRecorder.Code != http.StatusOK || !strings.Contains(runRecorder.Body.String(), `"status":"passed"`) {
		t.Fatalf("run status=%d body=%s", runRecorder.Code, runRecorder.Body.String())
	}
}

func TestEvaluationHandlerRateLimitsRepeatedRuns(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: evaluationAdminIdentity()}
	handler := NewEvaluationSessionHandler(nil, resolver, nil)
	handler.rateLimit = 1
	handler.provider = func() (chatProvider, string, error) {
		return &evaluationScriptedProvider{turns: []chatTurn{{message: "Nothing to report."}}}, "deepseek-flash", nil
	}
	body := `{"scenarioId":"inventory-proposal-low-stock"}`
	first := httptest.NewRecorder()
	handler.ServeHTTP(first, directCapabilityRequest(http.MethodPost, body))
	if first.Code != http.StatusOK {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, directCapabilityRequest(http.MethodPost, body))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second status=%d body=%s, want 429", second.Code, second.Body.String())
	}
}

func TestEvaluationHandlerRequiresAdmin(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
	handler := NewEvaluationSessionHandler(nil, resolver, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/evaluations", nil)
	request.AddCookie(&http.Cookie{Name: "chaste_session", Value: "session-cookie"})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s, want 403", recorder.Code, recorder.Body.String())
	}
}
