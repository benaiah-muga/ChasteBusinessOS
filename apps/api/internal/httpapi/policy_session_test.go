package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/policy"
)

func TestPolicySessionHandlerReadsMemberPolicyAndKeepsApprovalValues(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakePolicyReader{value: policy.Value{
		MaxRiskAutonomous:   "write",
		MoneyThresholdMinor: 50_000,
		RequiresApprovalFor: json.RawMessage(`[]`),
	}}
	handler := NewPolicySessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, &fakeDirectCapabilityExecutor{}, routinesTestLogger())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodGet, "/api/policy", ""))
	if response.Code != http.StatusOK || reader.orgID != *identity.OrgID {
		t.Fatalf("status=%d reader org=%q body=%s", response.Code, reader.orgID, response.Body.String())
	}
	if got, want := response.Body.String(), `{"canEdit":false,"policy":{"maxRiskAutonomous":"write","moneyThresholdMinor":50000,"requiresApprovalFor":[]}}`+"\n"; got != want {
		t.Fatalf("default response=%s want=%s", got, want)
	}

	identity.Permissions["iam.admin"] = true
	reader.value = policy.Value{
		MaxRiskAutonomous:   "money",
		MoneyThresholdMinor: 125_000,
		RequiresApprovalFor: json.RawMessage(`["identity",7,"money"]`),
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodGet, "/api/policy", ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"canEdit":true`) || !strings.Contains(response.Body.String(), `"requiresApprovalFor":["identity",7,"money"]`) {
		t.Fatalf("configured response=%d %s", response.Code, response.Body.String())
	}
}

func TestPolicySessionHandlerValidatesAndDispatchesGovernedPolicyWrite(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"saved":true}`)}}
	handler := &PolicySessionHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, reader: &fakePolicyReader{}, executor: executor, logger: routinesTestLogger()}
	const intentID = "44444444-4444-4444-8444-444444444444"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/policy", `{"maxRiskAutonomous":"money","moneyThresholdMinor":125000,"requiresApprovalFor":["identity","*"],"intentId":"`+intentID+`","unused":true}`))
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "iam.setOrgPolicy" || executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID || executor.claims.IntentID != intentID {
		t.Fatalf("status=%d calls=%d cap=%q claims=%+v body=%s", response.Code, executor.calls, executor.capID, executor.claims, response.Body.String())
	}
	if string(executor.input) != `{"maxRiskAutonomous":"money","moneyThresholdMinor":125000,"requiresApprovalFor":["identity","*"]}` || !strings.Contains(response.Body.String(), `"ok":true`) || !strings.Contains(response.Body.String(), `"data":{"saved":true}`) {
		t.Fatalf("capability input=%s body=%s", executor.input, response.Body.String())
	}

	for _, body := range []string{
		`{"maxRiskAutonomous":"cosmic"}`,
		`{"maxRiskAutonomous":"read","moneyThresholdMinor":null}`,
		`{"maxRiskAutonomous":"read","requiresApprovalFor":null}`,
		`{"maxRiskAutonomous":"read","requiresApprovalFor":["money","read"]}`,
		`{"maxRiskAutonomous":"read","requiresApprovalFor":["read","read","read","read","read"]}`,
	} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/policy", body))
		if response.Code != http.StatusBadRequest {
			t.Errorf("invalid policy body status=%d want=%d body=%s response=%s", response.Code, http.StatusBadRequest, body, response.Body.String())
		}
	}
	if executor.calls != 1 {
		t.Fatalf("invalid policies reached executor; calls=%d", executor.calls)
	}
}

func TestPolicySessionHandlerPreservesPendingEnvelopeAndRequiresWriteOrigin(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{PendingApproval: true}}
	handler := &PolicySessionHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, reader: &fakePolicyReader{}, executor: executor, logger: routinesTestLogger()}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, routinesSessionRequest(http.MethodPost, "/api/policy", `{"maxRiskAutonomous":"read"}`))
	var pending map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &pending); err != nil {
		t.Fatal(err)
	}
	var hint string
	if err := json.Unmarshal(pending["hint"], &hint); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusAccepted || len(pending) != 2 || string(pending["pendingApproval"]) != "true" || hint != "Policy changes proposed by the workmate wait for approval in the Approvals inbox." {
		t.Fatalf("pending envelope status=%d body=%s", response.Code, response.Body.String())
	}

	request := routinesSessionRequest(http.MethodPost, "/api/policy", `{"maxRiskAutonomous":"read"}`)
	request.Header.Del("Origin")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || executor.calls != 1 {
		t.Fatalf("missing-origin write status=%d executor calls=%d body=%s", response.Code, executor.calls, response.Body.String())
	}
}

func TestMountGoPolicySessionRouteFallsThroughUnsupportedMethodsAndPaths(t *testing.T) {
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "fallback") })
	goRoute := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Route-Owner", "go") })
	handler := MountGoPolicySessionRoute(fallback, goRoute)
	for _, tc := range []struct{ method, path, owner string }{
		{http.MethodGet, "/api/policy", "go"},
		{http.MethodPost, "/api/policy", "go"},
		{http.MethodHead, "/api/policy", "fallback"},
		{http.MethodDelete, "/api/policy", "fallback"},
		{http.MethodGet, "/api/policy/extra", "fallback"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tc.method, tc.path, nil))
		if got := response.Header().Get("X-Route-Owner"); got != tc.owner {
			t.Errorf("%s %s owner=%q want=%q", tc.method, tc.path, got, tc.owner)
		}
	}
}
