package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newChatSteerTestSuite(options chatTestHandlerOptions) (*chatSteerSessionHandler, *fakeDirectSessionResolver, *fakeChatSessionStore, *chatSteeringStore) {
	store := options.store
	if store == nil {
		store = newFakeChatSessionStore()
	}
	resolved := options.resolved
	if resolved == nil {
		resolved = chatTestIdentity()
	}
	resolver := &fakeDirectSessionResolver{resolved: resolved}
	steering := newChatSteeringStore()
	handler := &chatSteerSessionHandler{resolver: resolver, store: store, steering: steering}
	return handler, resolver, store, steering
}

func chatSteerTestRequest(method, body string, options chatTestRequestOptions) *http.Request {
	request := chatTestRequest(method, body, options)
	request.URL.Path = "/api/chat/steer"
	return request
}

func TestChatSteerSessionHandlerAuthAndValidationLevels(t *testing.T) {
	sessionID := "55555555-5555-4555-8555-555555555555"
	validBody := `{"sessionId":"` + sessionID + `","message":"steer"}`
	cases := []struct {
		name       string
		body       string
		options    chatTestRequestOptions
		mutate     func(*fakeDirectSessionResolver)
		wantStatus int
		wantError  string
	}{
		{name: "resolver error", body: validBody, options: chatTestRequestOptions{cookie: true, origin: true}, mutate: func(r *fakeDirectSessionResolver) { r.err = errors.New("bad") }, wantStatus: http.StatusUnauthorized, wantError: "unauthorized"},
		{name: "nil session", body: validBody, options: chatTestRequestOptions{cookie: true, origin: true}, mutate: func(r *fakeDirectSessionResolver) { r.resolved = nil }, wantStatus: http.StatusUnauthorized, wantError: "unauthorized"},
		{name: "unverified", body: validBody, options: chatTestRequestOptions{cookie: true, origin: true}, mutate: func(r *fakeDirectSessionResolver) { r.resolved.EmailVerified = false }, wantStatus: http.StatusUnauthorized, wantError: "unauthorized"},
		{name: "missing auth session", body: validBody, options: chatTestRequestOptions{cookie: true, origin: true}, mutate: func(r *fakeDirectSessionResolver) { r.resolved.AuthSessionID = "" }, wantStatus: http.StatusUnauthorized, wantError: "unauthorized"},
		{name: "no organization", body: validBody, options: chatTestRequestOptions{cookie: true, origin: true}, mutate: func(r *fakeDirectSessionResolver) { r.resolved.OrgID = nil }, wantStatus: http.StatusUnauthorized, wantError: "unauthorized"},
		{name: "org header mismatch", body: validBody, options: chatTestRequestOptions{cookie: true, origin: true, header: map[string]string{"X-Organization-ID": "99999999-9999-4999-8999-999999999999"}}, wantStatus: http.StatusForbidden, wantError: "organization access denied"},
		{name: "cookie without same origin", body: validBody, options: chatTestRequestOptions{cookie: true}, wantStatus: http.StatusForbidden, wantError: "forbidden"},
		{name: "missing session id", body: `{"message":"steer"}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "null session id", body: `{"sessionId":null,"message":"steer"}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "bad session id", body: `{"sessionId":"nope","message":"steer"}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "empty message", body: `{"sessionId":"` + sessionID + `","message":""}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "message too long", body: `{"sessionId":"` + sessionID + `","message":"` + strings.Repeat("x", 8001) + `"}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "unknown field", body: `{"sessionId":"` + sessionID + `","message":"steer","extra":1}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
		{name: "trailing json", body: validBody + `{}`, options: chatTestRequestOptions{cookie: true, origin: true}, wantStatus: http.StatusBadRequest, wantError: "invalid body"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, resolver, _, _ := newChatSteerTestSuite(chatTestHandlerOptions{})
			if testCase.mutate != nil {
				testCase.mutate(resolver)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, chatSteerTestRequest(http.MethodPost, testCase.body, testCase.options))
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status=%d body=%s, want %d", recorder.Code, recorder.Body.String(), testCase.wantStatus)
			}
			var body map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("body=%s", recorder.Body.String())
			}
			if body["error"] != testCase.wantError {
				t.Fatalf("error=%q, want %q", body["error"], testCase.wantError)
			}
		})
	}
}

func TestChatSteerSessionHandlerRejectsNonPost(t *testing.T) {
	handler, _, _, _ := newChatSteerTestSuite(chatTestHandlerOptions{})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, chatSteerTestRequest(http.MethodGet, "", chatTestRequestOptions{cookie: true, origin: true}))
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != "POST" {
		t.Fatalf("status=%d allow=%q", recorder.Code, recorder.Header().Get("Allow"))
	}
}

func TestChatSteerSessionHandlerNotFoundForUnownedSession(t *testing.T) {
	handler, _, _, _ := newChatSteerTestSuite(chatTestHandlerOptions{})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, chatSteerTestRequest(http.MethodPost,
		`{"sessionId":"66666666-6666-4666-8666-666666666666","message":"steer"}`,
		chatTestRequestOptions{cookie: true, origin: true}))
	if recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), "session not found") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestChatSteerSessionHandlerQueuesForOwnedSession(t *testing.T) {
	store := newFakeChatSessionStore()
	sessionID := store.createID
	store.owned[sessionID] = true
	handler, _, _, steering := newChatSteerTestSuite(chatTestHandlerOptions{store: store})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, chatSteerTestRequest(http.MethodPost,
		`{"sessionId":"`+sessionID+`","message":"redirect please"}`, chatTestRequestOptions{cookie: true, origin: true}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var body map[string]bool
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || !body["queued"] {
		t.Fatalf("body=%s, want queued:true", recorder.Body.String())
	}
	drained := steering.drain(sessionID)
	if len(drained) != 1 || drained[0] != "redirect please" {
		t.Fatalf("drained=%v", drained)
	}
	if len(steering.drain(sessionID)) != 0 {
		t.Fatal("drain must clear the queue")
	}
}

func TestChatSteerSessionHandlerBearerSkipsSameOrigin(t *testing.T) {
	store := newFakeChatSessionStore()
	sessionID := store.createID
	store.owned[sessionID] = true
	handler, resolver, _, steering := newChatSteerTestSuite(chatTestHandlerOptions{store: store})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, chatSteerTestRequest(http.MethodPost,
		`{"sessionId":"`+sessionID+`","message":"go"}`, chatTestRequestOptions{bearer: true}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if resolver.bearerCalls != 1 {
		t.Fatalf("bearer calls=%d", resolver.bearerCalls)
	}
	if queued := steering.drain(sessionID); len(queued) != 1 {
		t.Fatalf("queued=%v", queued)
	}
}

func TestChatSteeringStoreBoundsQueues(t *testing.T) {
	store := newChatSteeringStore()
	for index := 0; index < chatSteeringMaxPerSession+6; index++ {
		store.push("session", fmt.Sprintf("m%d", index))
	}
	drained := store.drain("session")
	if len(drained) != chatSteeringMaxPerSession {
		t.Fatalf("drained=%d, want the bound %d", len(drained), chatSteeringMaxPerSession)
	}
	if drained[0] != "m6" || drained[len(drained)-1] != fmt.Sprintf("m%d", chatSteeringMaxPerSession+5) {
		t.Fatalf("queue did not drop oldest: %v", drained[:2])
	}
	store.push("session", "after")
	if next := store.drain("session"); len(next) != 1 || next[0] != "after" {
		t.Fatalf("drain=%v", next)
	}
}
