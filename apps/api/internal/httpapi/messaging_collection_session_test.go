package httpapi

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	messagingCollectionTestOrgID        = "11111111-1111-4111-8111-111111111111"
	messagingCollectionTestUserID       = "22222222-2222-4222-8222-222222222222"
	messagingCollectionTestConversation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	messagingCollectionTestMessage      = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	messagingCollectionTestAttachment   = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	messagingCollectionTestMember       = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
)

func messagingCollectionTestIdentity() *session.ResolvedUser {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"messaging.read": true, "messaging.write": true}
	return identity
}

func messagingCollectionTestRequest(method, target, body string) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.TLS = &tls.ConnectionState{}
	r.Host = "app.example.test"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://app.example.test")
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "session-cookie"})
	r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: messagingCollectionTestOrgID})
	return r
}

func messagingCollectionTestServer(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor) http.Handler {
	return MountGoMessagingCollectionRoute(nil, NewMessagingCollectionHandler(resolver, executor, nil))
}

func decodeMessagingCollectionInput(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var input map[string]any
	if err := json.Unmarshal(raw, &input); err != nil {
		t.Fatalf("decode executor input %s: %v", raw, err)
	}
	return input
}

func TestMessagingCollectionHandlerDispatchesReadsThroughGovernedCapabilities(t *testing.T) {
	t.Run("conversation list", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"conversations":[],"me":"` + messagingCollectionTestUserID + `"}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, "/api/conversations", ""))
		if response.Code != http.StatusOK || executor.capID != "messaging.listConversations" {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
		if !strings.Contains(response.Body.String(), messagingCollectionTestUserID) {
			t.Fatalf("body=%s, want capability payload passthrough", response.Body.String())
		}
	})

	t.Run("thread read carries cursors", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"messages":[],"me":"` + messagingCollectionTestUserID + `"}`)}}
		target := "/api/conversations/" + messagingCollectionTestConversation + "/messages?limit=25&before=" + messagingCollectionTestMessage
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, target, ""))
		if response.Code != http.StatusOK || executor.capID != "messaging.readMessages" {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
		input := decodeMessagingCollectionInput(t, executor.input)
		if input["conversationId"] != messagingCollectionTestConversation || input["limit"] != float64(25) || input["before"] != messagingCollectionTestMessage {
			t.Fatalf("input=%s", executor.input)
		}
	})

	t.Run("thread read rejects unknown cursor", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		target := "/api/conversations/" + messagingCollectionTestConversation + "/messages?before=not-a-uuid"
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, target, ""))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("search needs two characters", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, "/api/messages/search?q=a", ""))
		if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"results":[]}` || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("search dispatches trimmed query", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"results":[]}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, "/api/messages/search?q=%20hello%20", ""))
		if response.Code != http.StatusOK || executor.capID != "messaging.searchMessages" {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
		if string(executor.input) != `{"query":"hello"}` {
			t.Fatalf("input=%s", executor.input)
		}
	})

	t.Run("people widen limit without query", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"people":[]}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, "/api/conversations/people", ""))
		if response.Code != http.StatusOK || executor.capID != "messaging.listPeople" {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
		if string(executor.input) != `{"limit":100}` {
			t.Fatalf("input=%s", executor.input)
		}
	})

	t.Run("people narrow limit with query", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"people":[]}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, "/api/conversations/people?q=ada", ""))
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		if string(executor.input) != `{"limit":30,"query":"ada"}` {
			t.Fatalf("input=%s", executor.input)
		}
	})
}

func TestMessagingCollectionHandlerDispatchesWritesThroughGovernedCapabilities(t *testing.T) {
	t.Run("create conversation", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"conversationId":"` + messagingCollectionTestConversation + `"}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodPost, "/api/conversations", `{"title":"General"}`))
		if response.Code != http.StatusCreated || executor.capID != "messaging.createConversation" {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
		if string(executor.input) != `{"agentEnabled":false,"kind":"channel","title":"General"}` {
			t.Fatalf("input=%s", executor.input)
		}
	})

	t.Run("patch conversation variants", func(t *testing.T) {
		cases := []struct {
			name         string
			body         string
			capabilityID string
			wantInput    string
		}{
			{"rename", `{"action":"update","title":"Roadmap"}`, "messaging.updateConversation", `{"conversationId":"` + messagingCollectionTestConversation + `","title":"Roadmap"}`},
			{"archive defaults true", `{"action":"archive"}`, "messaging.archiveConversation", `{"archived":true,"conversationId":"` + messagingCollectionTestConversation + `"}`},
			{"leave", `{"action":"leave"}`, "messaging.leaveConversation", `{"conversationId":"` + messagingCollectionTestConversation + `"}`},
			{"add member", `{"action":"addMember","userId":"` + messagingCollectionTestMember + `"}`, "messaging.addMember", `{"conversationId":"` + messagingCollectionTestConversation + `","userId":"` + messagingCollectionTestMember + `"}`},
			{"delete", `{"action":"delete"}`, "messaging.deleteConversation", `{"conversationId":"` + messagingCollectionTestConversation + `"}`},
		}
		for _, test := range cases {
			t.Run(test.name, func(t *testing.T) {
				executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"ok":true}`)}}
				response := httptest.NewRecorder()
				messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
					ServeHTTP(response, messagingCollectionTestRequest(http.MethodPatch, "/api/conversations/"+messagingCollectionTestConversation, test.body))
				if response.Code != http.StatusOK || executor.capID != test.capabilityID {
					t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
				}
				if string(executor.input) != test.wantInput {
					t.Fatalf("input=%s want=%s", executor.input, test.wantInput)
				}
			})
		}
	})

	t.Run("send message without inline agent reply", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"messageId":"` + messagingCollectionTestMessage + `"}`)}}
		body := `{"body":"ping","mentions":[{"type":"user","id":"` + messagingCollectionTestMember + `"}],"attachmentIds":["` + messagingCollectionTestAttachment + `"]}`
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodPost, "/api/conversations/"+messagingCollectionTestConversation+"/messages", body))
		if response.Code != http.StatusOK || executor.capID != "messaging.sendMessage" {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
		if strings.TrimSpace(response.Body.String()) != `{"ok":true,"agentReply":null}` {
			t.Fatalf("body=%s, want null agentReply envelope", response.Body.String())
		}
		input := decodeMessagingCollectionInput(t, executor.input)
		if input["conversationId"] != messagingCollectionTestConversation || input["body"] != "ping" {
			t.Fatalf("input=%s", executor.input)
		}
	})

	t.Run("read cursor preserves null presence", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"conversationId":"` + messagingCollectionTestConversation + `"}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodPost, "/api/conversations/"+messagingCollectionTestConversation+"/read", `{"readAt":null}`))
		if response.Code != http.StatusOK || executor.capID != "messaging.advanceReadCursor" {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
		if string(executor.input) != `{"conversationId":"`+messagingCollectionTestConversation+`","readAt":null}` {
			t.Fatalf("input=%s", executor.input)
		}
	})

	t.Run("read cursor accepts empty body", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"conversationId":"` + messagingCollectionTestConversation + `"}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodPost, "/api/conversations/"+messagingCollectionTestConversation+"/read", ""))
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		if string(executor.input) != `{"conversationId":"`+messagingCollectionTestConversation+`"}` {
			t.Fatalf("input=%s", executor.input)
		}
	})

	t.Run("read cursor rejects invalid position", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodPost, "/api/conversations/"+messagingCollectionTestConversation+"/read", `{"readAt":"yesterday"}`))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("edit message", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"messageId":"` + messagingCollectionTestMessage + `"}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodPatch, "/api/messages/"+messagingCollectionTestMessage, `{"body":"fixed"}`))
		if response.Code != http.StatusOK || executor.capID != "messaging.editMessage" {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
		if !strings.Contains(response.Body.String(), `"ok":true`) {
			t.Fatalf("body=%s, want ok envelope", response.Body.String())
		}
	})

	t.Run("delete message uses query intent", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"messageId":"` + messagingCollectionTestMessage + `"}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodDelete, "/api/messages/"+messagingCollectionTestMessage+"?intentId=delete-intent", ""))
		if response.Code != http.StatusOK || executor.capID != "messaging.deleteMessage" || executor.claims.IntentID != "delete-intent" {
			t.Fatalf("status=%d capability=%q intent=%q body=%s", response.Code, executor.capID, executor.claims.IntentID, response.Body.String())
		}
	})

	t.Run("pin message", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"pinned":true}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodPatch, "/api/messages/"+messagingCollectionTestMessage+"/pin", `{"pinned":true}`))
		if response.Code != http.StatusOK || executor.capID != "messaging.setMessagePin" || strings.TrimSpace(response.Body.String()) != `{"ok":true}` {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
	})

	t.Run("react to message", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"ok":true}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodPost, "/api/messages/"+messagingCollectionTestMessage+"/reactions", `{"emoji":"🎉","active":true}`))
		if response.Code != http.StatusOK || executor.capID != "messaging.setMessageReaction" {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
	})

	t.Run("delete pending attachment", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"removed":true}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodDelete, "/api/conversations/"+messagingCollectionTestConversation+"/attachments", `{"attachmentId":"`+messagingCollectionTestAttachment+`"}`))
		if response.Code != http.StatusOK || executor.capID != "messaging.deletePendingAttachment" || strings.TrimSpace(response.Body.String()) != `{"ok":true}` {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
	})
}

func TestMessagingCollectionHandlerUploadsAttachments(t *testing.T) {
	uploadRequest := func(filename string, content []byte) *http.Request {
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		part, err := writer.CreateFormFile("file", filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		r := messagingCollectionTestRequest(http.MethodPost, "/api/conversations/"+messagingCollectionTestConversation+"/attachments", buffer.String())
		r.Header.Set("Content-Type", writer.FormDataContentType())
		return r
	}

	t.Run("uploads through capability", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"attachmentId":"` + messagingCollectionTestAttachment + `"}`)}}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, uploadRequest("notes.txt", []byte("hello world")))
		if response.Code != http.StatusOK || executor.capID != "messaging.uploadMessageAttachment" {
			t.Fatalf("status=%d capability=%q body=%s", response.Code, executor.capID, response.Body.String())
		}
		var body struct {
			AttachmentID string `json:"attachmentId"`
			Filename     string `json:"filename"`
			SizeBytes    int    `json:"sizeBytes"`
		}
		if json.Unmarshal(response.Body.Bytes(), &body) != nil || body.AttachmentID != messagingCollectionTestAttachment || body.Filename != "notes.txt" || body.SizeBytes != 11 {
			t.Fatalf("body=%s", response.Body.String())
		}
		input := decodeMessagingCollectionInput(t, executor.input)
		if input["conversationId"] != messagingCollectionTestConversation || input["filename"] != "notes.txt" || input["contentBase64"] != "aGVsbG8gd29ybGQ=" {
			t.Fatalf("input=%s", executor.input)
		}
	})

	t.Run("empty file refused", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, uploadRequest("empty.txt", nil))
		if response.Code != http.StatusRequestEntityTooLarge || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("oversized file refused", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, uploadRequest("big.bin", bytes.Repeat([]byte("a"), messagingCollectionAttachmentMaxBytes+1)))
		if response.Code != http.StatusRequestEntityTooLarge || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("long filename refused", func(t *testing.T) {
		executor := &fakeDirectCapabilityExecutor{}
		response := httptest.NewRecorder()
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
			ServeHTTP(response, uploadRequest(strings.Repeat("n", 256), []byte("x")))
		if response.Code != http.StatusBadRequest || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})
}

func TestMessagingCollectionHandlerRejectsMalformedRequestsBeforeDispatch(t *testing.T) {
	cases := []struct {
		name   string
		method string
		target string
		body   string
		status int
	}{
		{"unknown create field", http.MethodPost, "/api/conversations", `{"title":"General","extra":true}`, http.StatusBadRequest},
		{"missing title", http.MethodPost, "/api/conversations", `{"kind":"channel"}`, http.StatusBadRequest},
		{"unknown action", http.MethodPatch, "/api/conversations/" + messagingCollectionTestConversation, `{"action":"explode"}`, http.StatusBadRequest},
		{"non-uuid conversation", http.MethodPatch, "/api/conversations/not-a-uuid", `{"action":"leave"}`, http.StatusBadRequest},
		{"send unknown field", http.MethodPost, "/api/conversations/" + messagingCollectionTestConversation + "/messages", `{"body":"hi","channel":"x"}`, http.StatusBadRequest},
		{"send null body", http.MethodPost, "/api/conversations/" + messagingCollectionTestConversation + "/messages", `{"body":null}`, http.StatusBadRequest},
		{"bad reaction emoji", http.MethodPost, "/api/messages/" + messagingCollectionTestMessage + "/reactions", `{"emoji":"👽","active":true}`, http.StatusBadRequest},
		{"missing pin state", http.MethodPatch, "/api/messages/" + messagingCollectionTestMessage + "/pin", `{}`, http.StatusBadRequest},
		{"too many attachments", http.MethodPost, "/api/conversations/" + messagingCollectionTestConversation + "/messages", `{"body":"hi","attachmentIds":["` + messagingCollectionTestAttachment + `","` + messagingCollectionTestAttachment + `","` + messagingCollectionTestAttachment + `","` + messagingCollectionTestAttachment + `","` + messagingCollectionTestAttachment + `","` + messagingCollectionTestAttachment + `"]}`, http.StatusBadRequest},
		{"malformed json", http.MethodPost, "/api/conversations", `{"title":`, http.StatusBadRequest},
		{"invalid thread limit", http.MethodGet, "/api/conversations/" + messagingCollectionTestConversation + "/messages?limit=0", "", http.StatusBadRequest},
		{"search text too long", http.MethodGet, "/api/messages/search?q=" + strings.Repeat("x", 101), "", http.StatusBadRequest},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{}`)}}
			response := httptest.NewRecorder()
			messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
				ServeHTTP(response, messagingCollectionTestRequest(test.method, test.target, test.body))
			if response.Code != test.status || executor.calls != 0 {
				t.Fatalf("status=%d want=%d calls=%d body=%s", response.Code, test.status, executor.calls, response.Body.String())
			}
		})
	}
}

func TestMessagingCollectionHandlerEnforcesAuthOriginPermissionAndModule(t *testing.T) {
	dispatched := func() (*fakeDirectCapabilityExecutor, *httptest.ResponseRecorder) {
		executor := &fakeDirectCapabilityExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"conversations":[],"me":"` + messagingCollectionTestUserID + `"}`)}}
		return executor, httptest.NewRecorder()
	}

	t.Run("no session", func(t *testing.T) {
		executor, response := dispatched()
		messagingCollectionTestServer(&fakeDirectSessionResolver{err: session.ErrNoSession}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, "/api/conversations", ""))
		if response.Code != http.StatusUnauthorized || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d", response.Code, executor.calls)
		}
	})

	t.Run("missing messaging permission", func(t *testing.T) {
		executor, response := dispatched()
		identity := directTestIdentity()
		identity.Permissions = map[string]bool{"crm.read": true}
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: identity}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, "/api/conversations", ""))
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("write without write permission", func(t *testing.T) {
		executor, response := dispatched()
		identity := directTestIdentity()
		identity.Permissions = map[string]bool{"messaging.read": true}
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: identity}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodPost, "/api/conversations", `{"title":"General"}`))
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("cross origin write", func(t *testing.T) {
		executor, response := dispatched()
		r := messagingCollectionTestRequest(http.MethodPost, "/api/conversations", `{"title":"General"}`)
		r.Header.Set("Origin", "https://attacker.example")
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).ServeHTTP(response, r)
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("module disabled", func(t *testing.T) {
		executor, response := dispatched()
		identity := messagingCollectionTestIdentity()
		identity.ModulesRestricted = true
		identity.EnabledModules = []string{"crm"}
		messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: identity}, executor).
			ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, "/api/conversations", ""))
		if response.Code != http.StatusForbidden || executor.calls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", response.Code, executor.calls, response.Body.String())
		}
	})

	t.Run("resolver or executor unavailable", func(t *testing.T) {
		for _, handler := range []http.Handler{
			MountGoMessagingCollectionRoute(nil, NewMessagingCollectionHandler(nil, nil, nil)),
			MountGoMessagingCollectionRoute(nil, NewMessagingCollectionHandler(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, nil, nil)),
		} {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, "/api/conversations", ""))
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		}
	})
}

func TestMessagingCollectionHandlerMapsCapabilityOutcomes(t *testing.T) {
	cases := []struct {
		name   string
		result capability.Result
		err    error
		status int
	}{
		{"pending approval", capability.Result{PendingApproval: true, ApprovalID: "approval-1"}, nil, http.StatusAccepted},
		{"not a member", capability.Result{}, capability.ErrNotMember, http.StatusForbidden},
		{"conversation missing", capability.Result{}, errors.New("conversation not found"), http.StatusNotFound},
		{"domain refusal", capability.Result{}, errors.New("you can only edit your own messages"), http.StatusUnprocessableEntity},
		{"internal failure", capability.Result{}, &pgconn.PgError{Code: "08006"}, http.StatusInternalServerError},
		{"module refusal", capability.Result{OK: false, Error: `module "messaging" is disabled for this organization`}, nil, http.StatusForbidden},
		{"forbidden refusal", capability.Result{OK: false, Error: "forbidden: missing permission: messaging.write"}, nil, http.StatusForbidden},
		{"domain refusal envelope", capability.Result{OK: false, Error: "only the channel creator can delete it"}, nil, http.StatusUnprocessableEntity},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCapabilityExecutor{result: test.result, err: test.err}
			response := httptest.NewRecorder()
			messagingCollectionTestServer(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, executor).
				ServeHTTP(response, messagingCollectionTestRequest(http.MethodGet, "/api/conversations", ""))
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body.String())
			}
			if test.status == http.StatusInternalServerError && strings.Contains(response.Body.String(), "08006") {
				t.Fatalf("internal error leaked database detail: %s", response.Body.String())
			}
		})
	}
}

func TestMessagingCollectionMountLeavesOtherRoutesToBase(t *testing.T) {
	base := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusTeapot, map[string]string{"handler": "base"})
	})
	route := NewMessagingCollectionHandler(&fakeDirectSessionResolver{resolved: messagingCollectionTestIdentity()}, &fakeDirectCapabilityExecutor{}, nil)
	handler := MountGoMessagingCollectionRoute(base, route)

	fallback := httptest.NewRecorder()
	handler.ServeHTTP(fallback, messagingCollectionTestRequest(http.MethodGet, "/api/conversations/"+messagingCollectionTestConversation+"/presence", ""))
	if fallback.Code != http.StatusTeapot {
		t.Fatalf("status=%d body=%s, want base handler fallback", fallback.Code, fallback.Body.String())
	}

	methodNotAllowed := httptest.NewRecorder()
	MountGoMessagingCollectionRoute(nil, route).
		ServeHTTP(methodNotAllowed, messagingCollectionTestRequest(http.MethodDelete, "/api/conversations", ""))
	if methodNotAllowed.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d body=%s, want 405 from the mount mux", methodNotAllowed.Code, methodNotAllowed.Body.String())
	}
}
