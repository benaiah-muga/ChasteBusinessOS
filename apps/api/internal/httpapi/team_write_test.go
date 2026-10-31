package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func teamWriteRequest(body string) *http.Request {
	request := directCapabilityRequest(http.MethodPost, body)
	request.URL.Path = "/api/team"
	return request
}

func TestTeamWriteHandlerExecutesGovernedIAMActions(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		capability string
		input      string
		output     string
	}{
		{
			name:       "create role",
			body:       `{"action":"createRole","key":"finance-admin","name":"Finance Admin","intentId":"role-intent"}`,
			capability: "iam.createRole",
			input:      `{"key":"finance-admin","name":"Finance Admin"}`,
			output:     `{"roleId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`,
		},
		{
			name:       "set permissions",
			body:       `{"action":"setPermissions","roleId":"role-1","permissions":["sales.read","sales.write"],"intentId":"permissions-intent"}`,
			capability: "iam.updateRolePermissions",
			input:      `{"roleId":"role-1","permissions":["sales.read","sales.write"]}`,
			output:     `{"permissionCount":2}`,
		},
		{
			name:       "assign role",
			body:       `{"action":"assignRole","userId":"user-1","roleId":"role-1","intentId":"assign-intent"}`,
			capability: "iam.assignRole",
			input:      `{"userId":"user-1","roleId":"role-1"}`,
			output:     `{"assigned":true}`,
		},
		{
			name:       "assignment already exists",
			body:       `{"action":"assignRole","userId":"user-1","roleId":"role-1","intentId":"assign-existing-intent"}`,
			capability: "iam.assignRole",
			input:      `{"userId":"user-1","roleId":"role-1"}`,
			output:     `{"assigned":false}`,
		},
		{
			name:       "invite",
			body:       `{"action":"invite","email":"teammate@example.com","roleId":"role-1","intentId":"invite-intent"}`,
			capability: "iam.inviteMember",
			input:      `{"email":"teammate@example.com","roleId":"role-1"}`,
			output:     `{"invitationId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","token":"opaque-token","expiresAt":"2026-10-05T00:00:00Z"}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: directTestIdentity()}
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(test.output)}}
			response := httptest.NewRecorder()
			NewTeamWriteHandler(resolver, executor, nil).ServeHTTP(response, teamWriteRequest(test.body))

			if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != test.capability {
				t.Fatalf("status=%d calls=%d capability=%q body=%s", response.Code, executor.calls, executor.capID, response.Body.String())
			}
			if string(executor.input) != test.input {
				t.Fatalf("input=%s, want %s", executor.input, test.input)
			}
			if executor.claims.Subject != directTestIdentity().UserID || executor.claims.OrganizationID != *directTestIdentity().OrgID || executor.claims.AuthSessionID != directTestIdentity().AuthSessionID {
				t.Fatalf("claims did not come from resolved session: %+v", executor.claims)
			}
			if test.name == "create role" && executor.claims.IntentID != "role-intent" {
				t.Fatalf("intent id=%q", executor.claims.IntentID)
			}
			if got := response.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control=%q", got)
			}
		})
	}
}

func TestTeamEmailValidationMatchesZodPracticalEmailProfile(t *testing.T) {
	for _, value := range []string{"person@example.com", "o'hara+tag@example.test", "a_b@example-domain.co"} {
		if !validTeamEmail(value) {
			t.Errorf("valid practical email %q was rejected", value)
		}
	}
	for _, value := range []string{"", ".person@example.com", "first..last@example.com", "person@localhost", "person@example.c", "person@exämple.com"} {
		if validTeamEmail(value) {
			t.Errorf("invalid practical email %q was accepted", value)
		}
	}
}

func TestValidTeamWriteOutputRequiresContractShapedIdentifiersAndTimestamp(t *testing.T) {
	for _, test := range []struct {
		capabilityID string
		body         string
	}{
		{capabilityID: "iam.createRole", body: `{"roleId":"role-1"}`},
		{capabilityID: "iam.updateRolePermissions", body: `{"permissionCount":-1}`},
		{capabilityID: "iam.inviteMember", body: `{"invitationId":"invite-1","token":"token","expiresAt":"tomorrow"}`},
	} {
		if validTeamWriteOutput(test.capabilityID, json.RawMessage(test.body)) {
			t.Errorf("accepted malformed %s output %s", test.capabilityID, test.body)
		}
	}
}

func TestTeamWriteHandlerPreservesApprovalAndValidationEnvelopes(t *testing.T) {
	body := `{"action":"assignRole","userId":"user-1","roleId":"role-1","intentId":"assign-intent"}`
	t.Run("approval", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{PendingApproval: true, ApprovalRationale: "identity changes need review"}}
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, teamWriteRequest(body))
		if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) || !strings.Contains(response.Body.String(), `"reason":"identity changes need review"`) {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("capability validation failure", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{Error: "role not found"}}
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, teamWriteRequest(body))
		if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), `"error":"role not found"`) {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("expected IAM domain refusal", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{err: capability.IAMDomainError("role not found")}
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, teamWriteRequest(body))
		if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), `"ok":false`) || !strings.Contains(response.Body.String(), `"error":"role not found"`) {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("invalid capability output", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"assigned":"yes"}`)}}
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, teamWriteRequest(body))
		if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "team service unavailable") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("session invalidated by executor", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{err: capability.ErrSessionInvalid}
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, teamWriteRequest(body))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestTeamWriteHandlerRejectsInvalidBodiesBeforeExecution(t *testing.T) {
	for _, body := range []string{
		`{`,
		`{"action":"assignRole","userId":"user-1","roleId":"role-1"}`,
		`{"action":"assignRole","userId":"user-1","roleId":"role-1","intentId":"  "}`,
		`{"action":"assignRole","userId":"user-1","roleId":"role-1","intentId":null}`,
		`{"action":"assignRole","userId":"user-1","roleId":"role-1","intentId":"` + strings.Repeat("x", 201) + `"}`,
		`{"action":"assignRole","userId":"user-1","roleId":"role-1","intentId":"` + strings.Repeat("🙂", 101) + `"}`,
		`{"action":"assignRole","userId":"user-1","roleId":"role-1","intentId":"bad\nintent"}`,
		`{"action":"createRole","key":"Bad Key","name":"Name"}`,
		`{"action":"createRole","key":"valid-key","name":""}`,
		`{"action":"createRole","key":"valid-key","name":"` + strings.Repeat("🙂", 31) + `","intentId":"create-role-intent"}`,
		`{"action":"setPermissions","roleId":"role-1","permissions":[""]}`,
		`{"action":"assignRole","userId":"","roleId":"role-1"}`,
		`{"action":"invite","email":"not-an-email","roleId":"role-1"}`,
		`{"action":"invite","email":"person@localhost","roleId":"role-1"}`,
		`{"action":"unknown"}`,
		`{"action":"invite","email":"a@example.com","roleId":"role-1","intentId":"one"} {}`,
	} {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"assigned":true}`)}}
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, teamWriteRequest(body))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Errorf("body=%s status=%d calls=%d response=%s", body, response.Code, executor.calls, response.Body.String())
		}
	}
}

func TestValidTeamIntentIDMatchesECMAScriptWhitespace(t *testing.T) {
	if validTeamIntentID("\uFEFF") {
		t.Fatal("a JavaScript-trimmed blank intent ID was accepted")
	}
	if !validTeamIntentID("\u0085") {
		t.Fatal("a value not trimmed by JavaScript was rejected")
	}
}

func TestTeamWriteHandlerRequiresVerifiedOrgAndCookieOrigin(t *testing.T) {
	t.Run("missing session", func(t *testing.T) {
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{err: session.ErrNoSession}, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, teamWriteRequest(`{"action":"createRole","key":"finance-admin","name":"Finance"}`))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("unverified identity", func(t *testing.T) {
		identity := directTestIdentity()
		identity.EmailVerified = false
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: identity}, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, teamWriteRequest(`{"action":"createRole","key":"finance-admin","name":"Finance"}`))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("organization header mismatch", func(t *testing.T) {
		request := teamWriteRequest(`{"action":"createRole","key":"finance-admin","name":"Finance","intentId":"create-role-intent"}`)
		request.Header.Set("X-Organization-ID", "aaaaaaaa-0000-4000-8000-000000000001")
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("cross origin cookie request", func(t *testing.T) {
		request := teamWriteRequest(`{"action":"createRole","key":"finance-admin","name":"Finance"}`)
		request.Header.Set("Origin", "https://attacker.example")
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
	t.Run("bearer clients may use another origin", func(t *testing.T) {
		request := teamWriteRequest(`{"action":"createRole","key":"finance-admin","name":"Finance","intentId":"create-role-intent"}`)
		request.Header.Set("Authorization", "Bearer opaque-session-token")
		request.Header.Set("Origin", "https://client.example")
		identity := directTestIdentity()
		resolver := &fakeDirectSessionResolver{resolved: identity}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"roleId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`)}}
		response := httptest.NewRecorder()
		NewTeamWriteHandler(resolver, executor, nil).ServeHTTP(response, request)
		if response.Code != http.StatusOK || resolver.bearerCalls != 1 || resolver.bearer != "opaque-session-token" || executor.calls != 1 {
			t.Fatalf("status=%d resolver=%+v calls=%d body=%s", response.Code, resolver, executor.calls, response.Body.String())
		}
	})
}

func TestTeamWriteHandlerIgnoresUnknownPropertiesAndEnforcesBodyLimit(t *testing.T) {
	t.Run("unknown properties are ignored", func(t *testing.T) {
		body := `{"action":"assignRole","userId":"user-1","roleId":"role-1","intentId":"assign-intent","futureField":{"ignored":true}}`
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"assigned":true}`)}}
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, teamWriteRequest(body))
		if response.Code != http.StatusOK || executor.calls != 1 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
	t.Run("oversized body is rejected", func(t *testing.T) {
		body := `{"action":"assignRole","userId":"user-1","roleId":"role-1","intentId":"assign-intent","padding":"` + strings.Repeat("x", teamWriteBodyLimit) + `"}`
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"assigned":true}`)}}
		response := httptest.NewRecorder()
		NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, executor, nil).ServeHTTP(response, teamWriteRequest(body))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
}

func TestTeamWriteHandlerMethodAndExecutorErrors(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/team", nil)
	response := httptest.NewRecorder()
	NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{}, nil).ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("status=%d Allow=%q body=%s", response.Code, response.Header().Get("Allow"), response.Body.String())
	}

	response = httptest.NewRecorder()
	NewTeamWriteHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, &fakeDirectCapabilityExecutor{err: errors.New("database unavailable")}, nil).ServeHTTP(response, teamWriteRequest(`{"action":"createRole","key":"finance-admin","name":"Finance","intentId":"create-role-intent"}`))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMountGoTeamRouteOwnsUnsupportedMethodsAndPreservesFlagFallback(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	read := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	write := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusCreated) })
	route := MountGoTeamRoute(base, read, write)
	response := httptest.NewRecorder()
	route.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/team", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, POST" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	response = httptest.NewRecorder()
	route.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/team/", nil))
	if response.Code != http.StatusTeapot {
		t.Fatalf("non-exact path status=%d", response.Code)
	}
	response = httptest.NewRecorder()
	MountGoTeamRoute(base, nil, write).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/team", nil))
	if response.Code != http.StatusTeapot {
		t.Fatalf("disabled method did not fall back: status=%d", response.Code)
	}
}
