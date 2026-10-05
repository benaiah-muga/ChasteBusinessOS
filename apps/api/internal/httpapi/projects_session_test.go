package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type fakeProjectsCollectionReader struct {
	calls  int
	claims authbridge.CapabilityClaims
	input  json.RawMessage
	result capability.Result
	err    error
}

func (f *fakeProjectsCollectionReader) ReadProjectCollection(_ context.Context, claims authbridge.CapabilityClaims, input json.RawMessage) (capability.Result, error) {
	f.calls++
	f.claims, f.input = claims, input
	return f.result, f.err
}

func projectsTestIdentity() *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions["projects.read"] = true
	identity.Permissions["projects.write"] = true
	return identity
}

func projectsSessionRequest(method, path, body string) *http.Request {
	r := directCapabilityRequest(method, body)
	parsed, err := url.Parse(path)
	if err != nil {
		panic(err)
	}
	r.URL.Path = parsed.Path
	r.URL.RawQuery = parsed.RawQuery
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: *projectsTestIdentity().OrgID})
	return r
}

func TestProjectsSessionHandlerUsesSessionForCollectionAndBoardReads(t *testing.T) {
	t.Run("collection delegates to org scoped collection reader", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		reader := &fakeProjectsCollectionReader{result: capability.Result{OK: true, Data: json.RawMessage(`{"projects":[]}`)}}
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, reader, nil).ServeHTTP(response, projectsSessionRequest(http.MethodGet, "/api/projects", ""))
		if response.Code != http.StatusOK || reader.calls != 1 || executor.calls != 0 || response.Body.String() != "{\"projects\":[]}\n" {
			t.Fatalf("status=%d reader=%d executor=%d body=%s", response.Code, reader.calls, executor.calls, response.Body.String())
		}
		if reader.claims.Subject != projectsTestIdentity().UserID || reader.claims.OrganizationID != *projectsTestIdentity().OrgID || reader.claims.CapabilityID != capability.ProjectCollectionReadOperationID || reader.claims.AuthSessionID != projectsTestIdentity().AuthSessionID || string(reader.input) != `{}` {
			t.Fatalf("unexpected collection scope claims=%+v input=%s", reader.claims, reader.input)
		}
	})

	t.Run("board uses governed projects.listBoard capability", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"columns":[]}`)}}
		reader := &fakeProjectsCollectionReader{}
		r := projectsSessionRequest(http.MethodGet, "/api/projects?projectId=11111111-1111-4111-8111-111111111111", "")
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, reader, nil).ServeHTTP(response, r)
		if response.Code != http.StatusOK || executor.calls != 1 || reader.calls != 0 || executor.capID != capability.ProjectBoardReadCapabilityID || string(executor.input) != `{"projectId":"11111111-1111-4111-8111-111111111111"}` {
			t.Fatalf("status=%d executor=%+v reader=%d body=%s", response.Code, executor, reader.calls, response.Body.String())
		}
	})
}

func TestProjectsSessionHandlerMatchesLegacyReadQuerySelection(t *testing.T) {
	t.Run("ignores unrelated query parameters", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		reader := &fakeProjectsCollectionReader{result: capability.Result{OK: true, Data: json.RawMessage(`{"projects":[]}`)}}
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, reader, nil).ServeHTTP(response, projectsSessionRequest(http.MethodGet, "/api/projects?source=page", ""))
		if response.Code != http.StatusOK || executor.calls != 0 || reader.calls != 1 {
			t.Fatalf("status=%d executor calls=%d collection calls=%d body=%s", response.Code, executor.calls, reader.calls, response.Body.String())
		}
	})

	t.Run("uses the first projectId when repeated", func(t *testing.T) {
		firstID := "11111111-1111-4111-8111-111111111111"
		secondID := "22222222-2222-4222-8222-222222222222"
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"columns":[]}`)}}
		reader := &fakeProjectsCollectionReader{}
		response := httptest.NewRecorder()
		path := "/api/projects?source=page&projectId=" + firstID + "&projectId=" + secondID
		NewProjectsSessionHandler(resolver, executor, reader, nil).ServeHTTP(response, projectsSessionRequest(http.MethodGet, path, ""))
		if response.Code != http.StatusOK || executor.calls != 1 || reader.calls != 0 || string(executor.input) != `{"projectId":"`+firstID+`"}` {
			t.Fatalf("status=%d executor calls=%d collection calls=%d input=%s body=%s", response.Code, executor.calls, reader.calls, executor.input, response.Body.String())
		}
	})
}

func TestProjectsSessionHandlerRunsWritesThroughExecutor(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"projectId":"44444444-4444-4444-8444-444444444444"}`)}}
	reader := &fakeProjectsCollectionReader{}
	r := projectsSessionRequest(http.MethodPost, "/api/projects", `{"action":"createProject","name":"New site","dueAt":"2026-10-05T12:30:00Z","intentId":"55555555-5555-4555-8555-555555555555"}`)
	response := httptest.NewRecorder()
	NewProjectsSessionHandler(resolver, executor, reader, nil).ServeHTTP(response, r)
	if response.Code != http.StatusOK || executor.calls != 1 || executor.capID != "projects.createProject" || executor.claims.IntentID != "55555555-5555-4555-8555-555555555555" {
		t.Fatalf("status=%d capability=%q claims=%+v body=%s", response.Code, executor.capID, executor.claims, response.Body.String())
	}
	if !strings.Contains(string(executor.input), `"name":"New site"`) || !strings.Contains(string(executor.input), `"dueAt":"2026-10-05T12:30:00Z"`) {
		t.Fatalf("unexpected executor input: %s", executor.input)
	}
}

func TestProjectsSessionHandlerRequiresAnIntentIDForWrites(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "missing", body: `{"action":"createProject","name":"Site"}`},
		{name: "wrong type", body: `{"action":"createProject","name":"Site","intentId":42}`},
		{name: "empty", body: `{"action":"createProject","name":"Site","intentId":""}`},
		{name: "whitespace only", body: `{"action":"createProject","name":"Site","intentId":"  "}`},
		{name: "overlong", body: `{"action":"createProject","name":"Site","intentId":"` + strings.Repeat("x", 201) + `"}`},
		{name: "control character", body: `{"action":"createProject","name":"Site","intentId":"bad\nintent"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
			executor := &fakeDirectCapabilityExecutor{}
			response := httptest.NewRecorder()
			NewProjectsSessionHandler(resolver, executor, &fakeProjectsCollectionReader{}, nil).ServeHTTP(
				response,
				projectsSessionRequest(http.MethodPost, "/api/projects", test.body),
			)
			if response.Code != http.StatusBadRequest || executor.calls != 0 || !strings.Contains(response.Body.String(), `"error":"invalid body"`) {
				t.Fatalf("status=%d calls=%d body=%s, want invalid request rejected before execution", response.Code, executor.calls, response.Body.String())
			}
		})
	}
}

func TestProjectsSessionHandlerAcceptsLegacyMinutePrecisionDate(t *testing.T) {
	resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
	executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"projectId":"44444444-4444-4444-8444-444444444444"}`)}}
	response := httptest.NewRecorder()
	body := `{"action":"createProject","name":"Minute date","dueAt":"2026-10-05T12:30Z","intentId":"55555555-5555-4555-8555-555555555555"}`
	NewProjectsSessionHandler(resolver, executor, &fakeProjectsCollectionReader{}, nil).ServeHTTP(response, projectsSessionRequest(http.MethodPost, "/api/projects", body))
	if response.Code != http.StatusOK || executor.calls != 1 || !strings.Contains(string(executor.input), `"dueAt":"2026-10-05T12:30Z"`) {
		t.Fatalf("status=%d calls=%d input=%s body=%s, want legacy-valid minute timestamp dispatched", response.Code, executor.calls, executor.input, response.Body.String())
	}
}

func TestProjectsSessionHandlerPreservesApprovalAndValidationResponses(t *testing.T) {
	t.Run("pending approval envelope", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{PendingApproval: true, ApprovalID: "approval-1", ApprovalRationale: "review required"}}
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, &fakeProjectsCollectionReader{}, nil).ServeHTTP(response, projectsSessionRequest(http.MethodPost, "/api/projects", `{"action":"archiveProject","projectId":"11111111-1111-4111-8111-111111111111","intentId":"55555555-5555-4555-8555-555555555555"}`))
		if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"pendingApproval":true`) || !strings.Contains(response.Body.String(), `"approvalId":"approval-1"`) {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("invalid write body", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, &fakeProjectsCollectionReader{}, nil).ServeHTTP(response, projectsSessionRequest(http.MethodPost, "/api/projects", `{"action":"moveTask","taskId":"bad","status":"doing"}`))
		if response.Code != http.StatusBadRequest || executor.calls != 0 || !strings.Contains(response.Body.String(), `"error":"invalid body"`) {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("optional null is rejected like the legacy Zod schema", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, &fakeProjectsCollectionReader{}, nil).ServeHTTP(response, projectsSessionRequest(http.MethodPost, "/api/projects", `{"action":"createProject","name":"Site","dueAt":null}`))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s, want null optional field rejected before execution", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("offset date is rejected like the legacy Zod schema", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, &fakeProjectsCollectionReader{}, nil).ServeHTTP(response, projectsSessionRequest(http.MethodPost, "/api/projects", `{"action":"createProject","name":"Site","dueAt":"2026-10-05T12:30:00+00:00"}`))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s, want offset timestamp rejected before execution", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("integer-valued decimal position is accepted", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"moved":true,"status":"doing"}`)}}
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, &fakeProjectsCollectionReader{}, nil).ServeHTTP(response, projectsSessionRequest(http.MethodPost, "/api/projects", `{"action":"moveTask","taskId":"11111111-1111-4111-8111-111111111111","status":"doing","position":1.0,"intentId":"55555555-5555-4555-8555-555555555555"}`))
		if response.Code != http.StatusOK || executor.calls != 1 || !strings.Contains(string(executor.input), `"position":1`) {
			t.Fatalf("status=%d calls=%d input=%s body=%s, want numeric integer dispatched", response.Code, executor.calls, executor.input, response.Body.String())
		}
	})

	t.Run("reader error maps to auth status", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		reader := &fakeProjectsCollectionReader{err: capability.ErrNotMember}
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, &fakeDirectCapabilityExecutor{}, reader, nil).ServeHTTP(response, projectsSessionRequest(http.MethodGet, "/api/projects", ""))
		if response.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestProjectsSessionHandlerRejectsUnauthenticatedAndCrossOriginCookieWrites(t *testing.T) {
	t.Run("missing session", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{err: errors.New("no session")}
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, &fakeProjectsCollectionReader{}, nil).ServeHTTP(response, projectsSessionRequest(http.MethodPost, "/api/projects", `{"action":"createProject","name":"Site"}`))
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d", response.Code, executor.calls)
		}
	})

	t.Run("cross origin cookie write", func(t *testing.T) {
		resolver := &fakeDirectSessionResolver{resolved: projectsTestIdentity()}
		executor := &fakeDirectCapabilityExecutor{}
		r := projectsSessionRequest(http.MethodPost, "/api/projects", `{"action":"createProject","name":"Site"}`)
		r.Header.Set("Origin", "https://attacker.example")
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, &fakeProjectsCollectionReader{}, nil).ServeHTTP(response, r)
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d", response.Code, executor.calls)
		}
	})

	t.Run("bearer client organization is checked", func(t *testing.T) {
		identity := projectsTestIdentity()
		resolver := &fakeDirectSessionResolver{resolved: identity}
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"projectId":"x"}`)}}
		r := httptest.NewRequest(http.MethodPost, "/api/projects", strings.NewReader(`{"action":"createProject","name":"Site"}`))
		r.Header.Set("Authorization", "Bearer token")
		r.Header.Set("X-Organization-ID", "99999999-9999-4999-8999-999999999999")
		response := httptest.NewRecorder()
		NewProjectsSessionHandler(resolver, executor, &fakeProjectsCollectionReader{}, nil).ServeHTTP(response, r)
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d", response.Code, executor.calls)
		}
	})
}
