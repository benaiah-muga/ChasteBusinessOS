package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeRoutinesWebhookTokenReader struct {
	tokens map[string]string
	err    error
}

func routinesTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func (r fakeRoutinesWebhookTokenReader) ForOrganization(context.Context, string) (map[string]string, error) {
	return r.tokens, r.err
}

func routinesTestIdentity() *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions["routines.read"] = true
	identity.Permissions["routines.write"] = true
	return identity
}

func routinesSessionRequest(method, path, body string) *http.Request {
	r := directCapabilityRequest(method, body)
	parsed, err := url.Parse(path)
	if err != nil {
		panic(err)
	}
	r.URL.Path, r.URL.RawQuery = parsed.Path, parsed.RawQuery
	return r
}

func TestRoutinesSessionHandlerListsCapabilityRowsWithWebhookURLs(t *testing.T) {
	const routineID = "44444444-4444-4444-8444-444444444444"
	resolver := &fakeDirectSessionResolver{resolved: routinesTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"routines":[{"id":"` + routineID + `","name":"Morning","scheduleLabel":"Daily at 08:00","triggerType":"webhook","enabled":true,"nextRunAt":null,"lastRunAt":null,"lastStatus":null,"lastError":null}]}`)}}
	tokens := fakeRoutinesWebhookTokenReader{tokens: map[string]string{routineID: "opaque-token"}}
	handler := &RoutinesSessionHandler{resolver: resolver, executor: executor, tokenReader: tokens, logger: routinesTestLogger()}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodGet, "/api/routines", ""))
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "routines.list" || string(executor.input) != `{}` {
		t.Fatalf("status=%d calls=%d capability=%q input=%s body=%s", response.Code, executor.calls, executor.capID, executor.input, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"webhookUrl":"https://app.example.test/api/routines/webhook/opaque-token"`) || strings.Contains(response.Body.String(), `"webhookToken"`) {
		t.Fatalf("unexpected webhook exposure or URL origin: %s", response.Body.String())
	}
	if executor.claims.Subject != routinesTestIdentity().UserID || executor.claims.OrganizationID != *routinesTestIdentity().OrgID || executor.claims.AuthSessionID != routinesTestIdentity().AuthSessionID {
		t.Fatalf("routines.list claims not derived from session: %+v", executor.claims)
	}
}

func TestRoutinesSessionHandlerCreatesWebhookURLAndDispatchesGovernedWrite(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: routinesTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"routineId":"44444444-4444-4444-8444-444444444444","schedule":{"kind":"weekly","atTime":"09:00","dayOfWeek":1},"scheduleLabel":"Weekly on Monday at 09:00","nextRunAt":"2026-10-12T09:00:00.000Z","webhookToken":"opaque-token"}`)}}
	handler := &RoutinesSessionHandler{resolver: resolver, executor: executor, tokenReader: fakeRoutinesWebhookTokenReader{}, logger: routinesTestLogger()}
	body := `{"action":"create","name":"Weekly review","prompt":"Check balances","scheduleText":"weekly on monday at 09:00","withWebhook":true,"intentId":"55555555-5555-4555-8555-555555555555"}`
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/routines", body))
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "routines.create" || executor.claims.IntentID != "55555555-5555-4555-8555-555555555555" {
		t.Fatalf("status=%d calls=%d capability=%q claims=%+v body=%s", response.Code, executor.calls, executor.capID, executor.claims, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"webhookUrl":"https://app.example.test/api/routines/webhook/opaque-token"`) {
		t.Fatalf("create response omitted absolute webhook URL: %s", response.Body.String())
	}
	if strings.Contains(string(executor.input), `"action"`) || !strings.Contains(string(executor.input), `"scheduleText":"weekly on monday at 09:00"`) {
		t.Fatalf("unexpected capability input: %s", executor.input)
	}
}

func TestRoutinesSessionHandlerDispatchesAllGovernedMutationActions(t *testing.T) {
	const routineID = "44444444-4444-4444-8444-444444444444"
	for _, tc := range []struct {
		name, body, capabilityID string
	}{
		{
			name: "update", capabilityID: "routines.update",
			body: `{"action":"update","routineId":"` + routineID + `","enabled":false,"intentId":"55555555-5555-4555-8555-555555555555"}`,
		},
		{
			name: "delete", capabilityID: "routines.delete",
			body: `{"action":"delete","routineId":"` + routineID + `","intentId":"55555555-5555-4555-8555-555555555555"}`,
		},
		{
			name: "run now", capabilityID: "routines.runNow",
			body: `{"action":"runNow","routineId":"` + routineID + `","intentId":"55555555-5555-4555-8555-555555555555"}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
			handler := &RoutinesSessionHandler{
				resolver: &fakeDirectSessionResolver{resolved: routinesTestIdentity()}, executor: executor,
				tokenReader: fakeRoutinesWebhookTokenReader{}, logger: routinesTestLogger(),
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/routines", tc.body))
			if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != tc.capabilityID {
				t.Fatalf("status=%d calls=%d capability=%q response=%s", response.Code, executor.calls, executor.capID, response.Body.String())
			}
			if strings.Contains(string(executor.input), `"action"`) || strings.Contains(string(executor.input), `"intentId"`) {
				t.Fatalf("transport fields leaked into governed input: %s", executor.input)
			}
		})
	}
}

func TestRoutinesSessionHandlerReturnsPendingApprovalEnvelope(t *testing.T) {
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{
		PendingApproval: true, ApprovalID: "approval-1", ApprovalRationale: "Routine deletion requires review.",
	}}
	handler := &RoutinesSessionHandler{
		resolver: &fakeDirectSessionResolver{resolved: routinesTestIdentity()}, executor: executor,
		tokenReader: fakeRoutinesWebhookTokenReader{}, logger: routinesTestLogger(),
	}
	body := `{"action":"delete","routineId":"44444444-4444-4444-8444-444444444444","intentId":"55555555-5555-4555-8555-555555555555"}`
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/routines", body))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) || !strings.Contains(response.Body.String(), `"approvalId":"approval-1"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRoutinesSessionHandlerReturnsActionableScheduleValidation(t *testing.T) {
	const guidance = "could not parse the schedule: try 'twice a day', 'each morning at 8', 'every 30 minutes', 'daily at 08:00', 'weekdays at 9am' or 'weekly on monday at 09:00'"
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: false, Error: guidance}}
	handler := &RoutinesSessionHandler{
		resolver: &fakeDirectSessionResolver{resolved: routinesTestIdentity()}, executor: executor,
		tokenReader: fakeRoutinesWebhookTokenReader{}, logger: routinesTestLogger(),
	}
	body := `{"action":"create","name":"Routine","prompt":"Check invoices","scheduleText":"a few times a day","intentId":"55555555-5555-4555-8555-555555555555"}`
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/routines", body))
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), guidance) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRoutinesSessionHandlerRejectsInvalidWritesBeforeExecution(t *testing.T) {
	for _, body := range []string{
		`{`,
		`{"action":"create","name":"Routine","prompt":"Prompt","scheduleText":"daily at 08:00"}`,
		`{"action":"create","name":"Routine","prompt":"Prompt","scheduleText":"x","intentId":"55555555-5555-4555-8555-555555555555"}`,
		`{"action":"unknown","intentId":"55555555-5555-4555-8555-555555555555"}`,
		`{"action":"delete","routineId":"not-a-uuid","intentId":"55555555-5555-4555-8555-555555555555"}`,
	} {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
		handler := &RoutinesSessionHandler{resolver: &fakeDirectSessionResolver{resolved: routinesTestIdentity()}, executor: executor, tokenReader: fakeRoutinesWebhookTokenReader{}, logger: routinesTestLogger()}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/routines", body))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Errorf("body=%s status=%d calls=%d response=%s", body, response.Code, executor.calls, response.Body.String())
		}
	}
}

func TestMountGoRoutinesRouteFallsThroughUnsupportedMethodsAndPaths(t *testing.T) {
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("go")) })
	legacy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("legacy")) })
	handler := MountGoRoutinesRoute(legacy, goRoute)
	for _, tc := range []struct {
		method, path, want string
	}{
		{http.MethodGet, "/api/routines", "go"},
		{http.MethodPost, "/api/routines", "go"},
		{http.MethodDelete, "/api/routines", "legacy"},
		{http.MethodHead, "/api/routines", "legacy"},
		{http.MethodPost, "/api/routines/webhook/token", "legacy"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tc.method, tc.path, nil))
		if response.Body.String() != tc.want {
			t.Errorf("%s %s body=%q want %q", tc.method, tc.path, response.Body.String(), tc.want)
		}
	}
}
