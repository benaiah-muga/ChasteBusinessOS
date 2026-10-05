package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

func modulesWriteRequest(body string) *http.Request {
	r := directCapabilityRequest(http.MethodPost, body)
	r.URL.Path = "/api/modules"
	return r
}

func TestModulesWriteHandlerExecutesGovernedSwitchboardCapability(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"enabledModules":["iam","projects","routines","signals"]}`)}}
	request := modulesWriteRequest(`{"modules":["projects","projects"],"intentId":"intent-123","ignored":"legacy strips this"}`)
	response := httptest.NewRecorder()

	NewModulesWriteHandler(resolver, executor, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.String() != "{\"ok\":true,\"data\":{\"enabledModules\":[\"iam\",\"projects\",\"routines\",\"signals\"]}}\n" {
		t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || resolver.resolveCalls != 1 || executor.calls != 1 {
		t.Fatalf("headers=%v resolver calls=%d executor calls=%d", response.Header(), resolver.resolveCalls, executor.calls)
	}
	if executor.capID != "iam.setModules" || executor.claims.Subject != identity.UserID || executor.claims.OrganizationID != *identity.OrgID || executor.claims.AuthSessionID != identity.AuthSessionID || executor.claims.IntentID != "intent-123" {
		t.Fatalf("capability=%q claims=%+v", executor.capID, executor.claims)
	}
	if executor.claims.ActorType != "human" || executor.claims.ActorID == nil || *executor.claims.ActorID != identity.UserID || strings.Join(executor.claims.Permissions, ",") != "crm.read,iam.admin,sales.write" {
		t.Fatalf("unexpected authority claims: %+v", executor.claims)
	}
	var input struct {
		Modules []string `json:"modules"`
	}
	if err := json.Unmarshal(executor.input, &input); err != nil {
		t.Fatal(err)
	}
	if strings.Join(input.Modules, ",") != "projects,iam,routines,signals" {
		t.Fatalf("capability input=%s, legacy input order or protected modules changed", executor.input)
	}
}

func TestModulesWriteHandlerPreservesPendingApprovalResponse(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{PendingApproval: true, ApprovalRationale: "Needs review"}}
	response := httptest.NewRecorder()

	NewModulesWriteHandler(resolver, executor, nil).ServeHTTP(response, modulesWriteRequest(`{"modules":["projects"]}`))

	want := "{\"hint\":\"Module changes proposed by the workmate wait for approval in the Approvals inbox.\",\"pendingApproval\":true}\n"
	if response.Code != http.StatusAccepted || response.Body.String() != want {
		t.Fatalf("status=%d body=%q, want pending response %q", response.Code, response.Body.String(), want)
	}
}

func TestModulesWriteHandlerRejectsUnauthorizedRequestsBeforeExecution(t *testing.T) {
	tests := []struct {
		name   string
		status int
		setup  func(*fakeDirectSessionResolver, *http.Request)
	}{
		{
			name:   "missing permission",
			status: http.StatusForbidden,
			setup:  func(_ *fakeDirectSessionResolver, _ *http.Request) {},
		},
		{
			name:   "cross origin cookie write",
			status: http.StatusForbidden,
			setup: func(resolver *fakeDirectSessionResolver, request *http.Request) {
				resolver.resolved.Permissions["iam.admin"] = true
				request.Header.Set("Origin", "https://attacker.example")
			},
		},
		{
			name:   "requested organization mismatch",
			status: http.StatusUnauthorized,
			setup: func(resolver *fakeDirectSessionResolver, request *http.Request) {
				resolver.resolved.Permissions["iam.admin"] = true
				request.Header.Set("X-Organization-ID", "99999999-9999-4999-8999-999999999999")
			},
		},
		{
			name:   "unknown module",
			status: http.StatusBadRequest,
			setup: func(resolver *fakeDirectSessionResolver, request *http.Request) {
				resolver.resolved.Permissions["iam.admin"] = true
				request.Body = io.NopCloser(strings.NewReader(`{"modules":["unknown"]}`))
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
			executor := &fakeDirectCapabilityExecutor{}
			request := modulesWriteRequest(`{"modules":["projects"]}`)
			test.setup(resolver, request)
			response := httptest.NewRecorder()

			NewModulesWriteHandler(resolver, executor, nil).ServeHTTP(response, request)

			if response.Code != test.status || executor.calls != 0 {
				t.Fatalf("status=%d executor calls=%d body=%s", response.Code, executor.calls, response.Body.String())
			}
		})
	}
}

func TestModulesWriteHandlerAcceptsBearerClients(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	resolver := &fakeDirectSessionResolver{resolved: identity}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"enabledModules":[]}`)}}
	request := httptest.NewRequest(http.MethodPost, "/api/modules", strings.NewReader(`{"modules":["projects"]}`))
	request.Header.Set("Authorization", "Bearer bearer-token")
	request.Header.Set("X-Organization-ID", *identity.OrgID)
	response := httptest.NewRecorder()

	NewModulesWriteHandler(resolver, executor, nil).ServeHTTP(response, request)

	if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.bearer != "bearer-token" || executor.calls != 1 {
		t.Fatalf("status=%d bearer calls=%d token=%q executor calls=%d body=%s", response.Code, resolver.bearerCalls, resolver.bearer, executor.calls, response.Body.String())
	}
}
