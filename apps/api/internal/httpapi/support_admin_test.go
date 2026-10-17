package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	supportAdminTestOrgID        = "a1a1a1a1-1111-4111-8111-111111111111"
	supportAdminTestUserID       = "b2b2b2b2-2222-4222-8222-222222222222"
	supportAdminTestSessionID    = "c3c3c3c3-3333-4333-8333-333333333333"
	supportAdminTestConversation = "d4d4d4d4-4444-4444-8444-444444444444"
	supportAdminTestCustomer     = "e5e5e5e5-5555-4555-8555-555555555555"
	supportAdminTestMessageID    = "f6f6f6f6-6666-4666-8666-666666666666"
)

func supportAdminIdentity(permissions ...string) *session.ResolvedUser {
	granted := map[string]bool{}
	for _, permission := range permissions {
		granted[permission] = true
	}
	orgID := supportAdminTestOrgID
	return &session.ResolvedUser{
		UserID: supportAdminTestUserID, OrgID: &orgID,
		Permissions: granted, EmailVerified: true, AuthSessionID: supportAdminTestSessionID,
	}
}

func supportAdminRequest(method, target, body string) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.TLS = &tls.ConnectionState{}
	r.Host = "app.example.test"
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	r.Header.Set("Origin", "https://app.example.test")
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: supportAdminTestOrgID})
	return r
}

func TestSupportAdminRoutingGuards(t *testing.T) {
	handlerFor := func(identity *session.ResolvedUser, executor *fakeDirectCapabilityExecutor) http.Handler {
		t.Helper()
		return newSupportAdminHandler(&fakeDirectSessionResolver{resolved: identity}, executor, nil, nil, nil, nil)
	}

	t.Run("unsupported method", func(t *testing.T) {
		response := httptest.NewRecorder()
		handlerFor(supportAdminIdentity("support.read"), &fakeDirectCapabilityExecutor{}).
			ServeHTTP(response, supportAdminRequest(http.MethodDelete, "/api/support", ""))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, POST" {
			t.Fatalf("status=%d allow=%q body=%s", response.Code, response.Header().Get("Allow"), response.Body.String())
		}
	})

	t.Run("missing session", func(t *testing.T) {
		handler := newSupportAdminHandler(&fakeDirectSessionResolver{err: session.ErrNoSession}, &fakeDirectCapabilityExecutor{}, nil, nil, nil, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support", ""))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("module disabled", func(t *testing.T) {
		identity := supportAdminIdentity("support.read")
		identity.ModulesRestricted = true
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		handlerFor(identity, executor).ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support", ""))
		if response.Code != http.StatusNotFound || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("read permission required", func(t *testing.T) {
		response := httptest.NewRecorder()
		handlerFor(supportAdminIdentity(), &fakeDirectCapabilityExecutor{}).
			ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support", ""))
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "forbidden: missing permission: support.read") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("write permission required before execution", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		handlerFor(supportAdminIdentity("support.read"), executor).ServeHTTP(response,
			supportAdminRequest(http.MethodPost, "/api/support", `{"action":"create","customerId":"`+supportAdminTestCustomer+`","subject":"Broken"}`))
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "forbidden: missing permission: support.write") || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("cookie action requires same origin", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{}
		request := supportAdminRequest(http.MethodPost, "/api/support", `{"action":"resolve","conversationId":"`+supportAdminTestConversation+`"}`)
		request.Header.Del("Origin")
		response := httptest.NewRecorder()
		handlerFor(supportAdminIdentity("support.read", "support.write"), executor).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "same-origin") || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
}

func TestSupportAdminReadsThroughCapabilities(t *testing.T) {
	detailJSON := `{"conversation":{"id":"` + supportAdminTestConversation + `","customerId":"` + supportAdminTestCustomer +
		`","customerName":"Ada","subject":"Printer smokes","status":"open","priority":"normal","category":null,"assignedUserId":null,"slaDueAt":null,"customerEmail":"ada@example.test"},` +
		`"messages":[{"id":"` + supportAdminTestMessageID + `","orgId":"` + supportAdminTestOrgID + `","conversationId":"` + supportAdminTestConversation +
		`","senderType":"customer","senderUserId":null,"body":"It smokes","createdAt":"2026-01-01T00:00:00.000Z"}]}`

	newHandler := func(result capability.Result, err error) (http.Handler, *fakeDirectCapabilityExecutor) {
		t.Helper()
		executor := &fakeDirectCapabilityExecutor{result: result, err: err}
		return newSupportAdminHandler(&fakeDirectSessionResolver{resolved: supportAdminIdentity("support.read")}, executor, nil, nil, nil, nil), executor
	}

	t.Run("library", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{"canned":[],"articles":[]}`)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support?library=1", ""))
		if response.Code != http.StatusOK || executor.capID != "support.listLibrary" || string(executor.input) != `{}` {
			t.Fatalf("status=%d cap=%q input=%s body=%s", response.Code, executor.capID, executor.input, response.Body.String())
		}
	})

	t.Run("conversation list is customer bound", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{"conversations":[]}`)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support", ""))
		if response.Code != http.StatusOK || executor.capID != "support.listConversations" ||
			string(executor.input) != `{"limit":100,"customerBoundOnly":true}` {
			t.Fatalf("status=%d cap=%q input=%s body=%s", response.Code, executor.capID, executor.input, response.Body.String())
		}
	})

	t.Run("conversation detail drops customer email", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(detailJSON)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support?id="+supportAdminTestConversation, ""))
		if response.Code != http.StatusOK || executor.capID != "support.readConversation" ||
			string(executor.input) != `{"conversationId":"`+supportAdminTestConversation+`","limit":200}` {
			t.Fatalf("status=%d cap=%q input=%s body=%s", response.Code, executor.capID, executor.input, response.Body.String())
		}
		var body struct {
			Conversation map[string]any `json:"conversation"`
			Messages     []struct {
				Body string `json:"body"`
			} `json:"messages"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if _, present := body.Conversation["customerEmail"]; present {
			t.Fatalf("conversation response leaked customerEmail: %s", response.Body.String())
		}
		if body.Conversation["customerId"] != supportAdminTestCustomer || len(body.Messages) != 1 || body.Messages[0].Body != "It smokes" {
			t.Fatalf("body=%s", response.Body.String())
		}
	})

	t.Run("unbound conversation is not found", func(t *testing.T) {
		unbound := strings.Replace(detailJSON, `"customerId":"`+supportAdminTestCustomer+`"`, `"customerId":null`, 1)
		handler, _ := newHandler(capability.Result{OK: true, Data: json.RawMessage(unbound)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support?id="+supportAdminTestConversation, ""))
		if response.Code != http.StatusNotFound {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("invalid id is not found without execution", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support?id=Users", ""))
		if response.Code != http.StatusNotFound || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("missing conversation is not found", func(t *testing.T) {
		handler, _ := newHandler(capability.Result{}, errors.New("conversation not found"))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support?id="+supportAdminTestConversation, ""))
		if response.Code != http.StatusNotFound {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("executor refusal is forbidden", func(t *testing.T) {
		handler, _ := newHandler(capability.Result{OK: false, Error: "forbidden: missing permission: support.read"}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support", ""))
		if response.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestSupportAdminActionsThroughCapabilities(t *testing.T) {
	newHandler := func(result capability.Result, err error) (http.Handler, *fakeDirectCapabilityExecutor) {
		t.Helper()
		executor := &fakeDirectCapabilityExecutor{result: result, err: err}
		return newSupportAdminHandler(&fakeDirectSessionResolver{resolved: supportAdminIdentity("support.read", "support.write")}, executor, nil, nil, nil, nil), executor
	}

	t.Run("send posts as staff and carries the intent", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{"messageId":"` + supportAdminTestMessageID + `"}`)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support",
			`{"action":"send","conversationId":"`+supportAdminTestConversation+`","body":"On it","from":"customer","intentId":"intent-9"}`))
		if response.Code != http.StatusOK || executor.capID != "support.postMessage" ||
			string(executor.input) != `{"body":"On it","conversationId":"`+supportAdminTestConversation+`"}` {
			t.Fatalf("status=%d cap=%q input=%s body=%s", response.Code, executor.capID, executor.input, response.Body.String())
		}
		if executor.claims.IntentID != "intent-9" || executor.claims.Subject != supportAdminTestUserID {
			t.Fatalf("claims=%+v", executor.claims)
		}
		var body struct {
			OK   bool            `json:"ok"`
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal(response.Body.Bytes(), &body) != nil || !body.OK || string(body.Data) != `{"messageId":"`+supportAdminTestMessageID+`"}` {
			t.Fatalf("body=%s", response.Body.String())
		}
	})

	t.Run("create strips action and intent", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{"conversationId":"` + supportAdminTestConversation + `"}`)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support",
			`{"action":"create","customerId":"`+supportAdminTestCustomer+`","subject":"Broken","intentId":"intent-create"}`))
		if response.Code != http.StatusOK || executor.capID != "support.startConversation" ||
			string(executor.input) != `{"customerId":"`+supportAdminTestCustomer+`","subject":"Broken"}` || executor.claims.IntentID != "intent-create" {
			t.Fatalf("status=%d cap=%q input=%s claims=%+v body=%s", response.Code, executor.capID, executor.input, executor.claims, response.Body.String())
		}
	})

	t.Run("null intent is absent", func(t *testing.T) {
		handler, executor := newHandler(capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support",
			`{"action":"resolve","conversationId":"`+supportAdminTestConversation+`","intentId":null}`))
		if response.Code != http.StatusOK || executor.claims.IntentID != "" {
			t.Fatalf("status=%d claims=%+v body=%s", response.Code, executor.claims, response.Body.String())
		}
	})

	t.Run("unknown and missing actions are invalid", func(t *testing.T) {
		for _, body := range []string{`{"action":"explode"}`, `{}`, `{"action":5}`, `not json`} {
			executor := &fakeDirectCapabilityExecutor{}
			handler := newSupportAdminHandler(&fakeDirectSessionResolver{resolved: supportAdminIdentity("support.read", "support.write")}, executor, nil, nil, nil, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support", body))
			if response.Code != http.StatusBadRequest || executor.calls != 0 {
				t.Fatalf("body=%q status=%d calls=%d response=%s", body, response.Code, executor.calls, response.Body.String())
			}
		}
	})

	t.Run("pending approval is accepted", func(t *testing.T) {
		handler, _ := newHandler(capability.Result{OK: false, PendingApproval: true, Error: "needs approval"}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support",
			`{"action":"resolve","conversationId":"`+supportAdminTestConversation+`"}`))
		if response.Code != http.StatusAccepted {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		var body map[string]any
		if json.Unmarshal(response.Body.Bytes(), &body) != nil || body["ok"] != false || body["pendingApproval"] != true || body["reason"] != "needs approval" {
			t.Fatalf("body=%s", response.Body.String())
		}
	})

	t.Run("domain refusals are unprocessable", func(t *testing.T) {
		handler, _ := newHandler(capability.Result{}, errors.New("conversation is resolved; reopen it first"))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support",
			`{"action":"message","conversationId":"`+supportAdminTestConversation+`","body":"Hello"}`))
		if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "reopen it first") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("executor forbidden result is forbidden", func(t *testing.T) {
		handler, _ := newHandler(capability.Result{OK: false, Error: "forbidden: missing permission: support.write"}, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support",
			`{"action":"resolve","conversationId":"`+supportAdminTestConversation+`"}`))
		if response.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

type supportAdminDraftReaderFake struct {
	draftContext   supportReplyDraftContext
	err            error
	calls          int
	orgID          string
	conversationID string
}

func (f *supportAdminDraftReaderFake) Load(_ context.Context, orgID, conversationID string) (supportReplyDraftContext, error) {
	f.calls++
	f.orgID, f.conversationID = orgID, conversationID
	return f.draftContext, f.err
}

type supportAdminDraftGeneratorFake struct {
	draft  string
	err    error
	calls  int
	userID string
}

func (f *supportAdminDraftGeneratorFake) Draft(_ context.Context, _, userID, _ string, _ supportReplyDraftContext) (string, error) {
	f.calls++
	f.userID = userID
	return f.draft, f.err
}

func TestSupportAdminDraftUsesSharedPipeline(t *testing.T) {
	newHandler := func(reader *supportAdminDraftReaderFake, generator *supportAdminDraftGeneratorFake, limiter *supportReplyDraftRateLimiter) http.Handler {
		t.Helper()
		return newSupportAdminHandler(
			&fakeDirectSessionResolver{resolved: supportAdminIdentity("support.read")},
			&fakeDirectCapabilityExecutor{}, reader, generator, limiter, nil,
		)
	}
	body := `{"action":"draft","conversationId":"` + supportAdminTestConversation + `"}`

	t.Run("draft is trimmed", func(t *testing.T) {
		reader := &supportAdminDraftReaderFake{draftContext: supportReplyDraftContext{CustomerName: "Ada"}}
		generator := &supportAdminDraftGeneratorFake{draft: "  Hello there. \n"}
		response := httptest.NewRecorder()
		newHandler(reader, generator, nil).ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support", body))
		if response.Code != http.StatusOK || reader.calls != 1 || generator.calls != 1 {
			t.Fatalf("status=%d reader=%d generator=%d body=%s", response.Code, reader.calls, generator.calls, response.Body.String())
		}
		if reader.orgID != supportAdminTestOrgID || reader.conversationID != supportAdminTestConversation || generator.userID != supportAdminTestUserID {
			t.Fatalf("reader org=%q conversation=%q generator user=%q", reader.orgID, reader.conversationID, generator.userID)
		}
		var decoded struct {
			Draft string `json:"draft"`
		}
		if json.Unmarshal(response.Body.Bytes(), &decoded) != nil || decoded.Draft != "Hello there." {
			t.Fatalf("body=%s", response.Body.String())
		}
	})

	t.Run("missing conversation is not found", func(t *testing.T) {
		reader := &supportAdminDraftReaderFake{err: errSupportReplyDraftConversationNotFound}
		response := httptest.NewRecorder()
		newHandler(reader, &supportAdminDraftGeneratorFake{}, nil).ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support", body))
		if response.Code != http.StatusNotFound {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("empty transcript is a bad request", func(t *testing.T) {
		reader := &supportAdminDraftReaderFake{err: errSupportReplyDraftNoMessages}
		response := httptest.NewRecorder()
		newHandler(reader, &supportAdminDraftGeneratorFake{}, nil).ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support", body))
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "nothing to answer yet") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("generator failure is a bad gateway", func(t *testing.T) {
		reader := &supportAdminDraftReaderFake{draftContext: supportReplyDraftContext{CustomerName: "Ada"}}
		response := httptest.NewRecorder()
		newHandler(reader, &supportAdminDraftGeneratorFake{err: errors.New("model unavailable")}, nil).
			ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support", body))
		if response.Code != http.StatusBadGateway {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("draft budget is enforced", func(t *testing.T) {
		limiter := newSupportReplyDraftRateLimiter(nil)
		key := supportAdminTestOrgID + ":" + supportAdminTestUserID
		for {
			allowed, _ := limiter.allow(key)
			if !allowed {
				break
			}
		}
		response := httptest.NewRecorder()
		newHandler(&supportAdminDraftReaderFake{}, &supportAdminDraftGeneratorFake{}, limiter).
			ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support", body))
		if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") == "" {
			t.Fatalf("status=%d retryAfter=%q body=%s", response.Code, response.Header().Get("Retry-After"), response.Body.String())
		}
	})
}

func TestSupportAdminExecutorErrorsNeverAnswer200(t *testing.T) {
	handlerFor := func(err error) (http.Handler, *fakeDirectCapabilityExecutor) {
		t.Helper()
		executor := &fakeDirectCapabilityExecutor{err: err}
		return newSupportAdminHandler(&fakeDirectSessionResolver{resolved: supportAdminIdentity("support.read", "support.write")}, executor, nil, nil, nil, nil), executor
	}

	t.Run("read infrastructure error answers 500 with a body", func(t *testing.T) {
		handler, _ := handlerFor(&pgconn.PgError{Code: "08006", Message: "connection failure"})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodGet, "/api/support", ""))
		if response.Code != http.StatusInternalServerError || strings.TrimSpace(response.Body.String()) != `{"error":"internal error"}` {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("action infrastructure error answers 500 with a body", func(t *testing.T) {
		handler, _ := handlerFor(&pgconn.PgError{Code: "08006", Message: "connection failure"})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support",
			`{"action":"resolve","conversationId":"`+supportAdminTestConversation+`"}`))
		if response.Code != http.StatusInternalServerError || strings.TrimSpace(response.Body.String()) != `{"error":"internal error"}` {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("unclassified domain errors classify instead of answering 200", func(t *testing.T) {
		handler, _ := handlerFor(errors.New("conversation is already resolved"))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, supportAdminRequest(http.MethodPost, "/api/support",
			`{"action":"resolve","conversationId":"`+supportAdminTestConversation+`"}`))
		if response.Code != http.StatusUnprocessableEntity || strings.TrimSpace(response.Body.String()) != `{"error":"conversation is already resolved"}` {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}
