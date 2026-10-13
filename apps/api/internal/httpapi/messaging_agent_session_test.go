package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func TestMessagingAgentHandlerRequiresPostAndDependencies(t *testing.T) {
	handler := NewMessagingAgentHandler(nil, nil, nil, nil)
	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/conversations/11111111-1111-4111-8111-111111111111/agent-reply", nil))
	if get.Code != http.StatusMethodNotAllowed || get.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("GET status=%d allow=%q", get.Code, get.Header().Get("Allow"))
	}
	post := httptest.NewRecorder()
	handler.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/api/conversations/11111111-1111-4111-8111-111111111111/agent-reply", strings.NewReader(`{}`)))
	if post.Code != http.StatusServiceUnavailable {
		t.Fatalf("POST status=%d body=%s", post.Code, post.Body.String())
	}
}

func TestMessagingAgentCompletionUsesConfiguredProviderAndParsesCapabilityCalls(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			t.Errorf("request=%s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("authorization=%q", got)
		}
		var body struct {
			Model    string                      `json:"model"`
			Messages []messagingAgentChatMessage `json:"messages"`
			Tools    []struct {
				Type     string `json:"type"`
				Function struct {
					Name       string         `json:"name"`
					Parameters map[string]any `json:"parameters"`
				} `json:"function"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Model != "test-model" || len(body.Messages) != 2 || body.Messages[1].Role != "user" || !strings.Contains(string(body.Messages[1].Content), "untrusted_conversation") || len(body.Tools) != 1 || body.Tools[0].Function.Name != "crm_listCustomers" || body.Tools[0].Function.Parameters["type"] != "object" {
			t.Errorf("provider messages=%+v tools=%+v model=%q", body.Messages, body.Tools, body.Model)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"crm_listCustomers","arguments":"{}"}}]}}],"usage":{"prompt_tokens":15,"completion_tokens":3}}`))
	}))
	defer provider.Close()
	handler := NewMessagingAgentHandler(nil, nil, nil, nil).(*messagingAgentHandler)
	handler.client = provider.Client()
	config := messagingAIConfig{BaseURL: provider.URL + "/v1", APIKey: "test-key"}
	config.Models.Primary = "test-model"
	completion, err := handler.completeMessagingTurn(context.Background(), config, []messagingAgentChatMessage{
		{Role: "system", Content: messagingJSON("prompt")},
		{Role: "user", Content: messagingJSON("<untrusted_conversation>Mira: ship the report</untrusted_conversation>")},
	}, []map[string]any{{"type": "function", "function": map[string]any{"name": "crm_listCustomers", "description": "List customers", "parameters": json.RawMessage(`{"type":"object"}`)}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(completion.Choices) != 1 || len(completion.Choices[0].Message.ToolCalls) != 1 || completion.Choices[0].Message.ToolCalls[0].Function.Name != "crm_listCustomers" || completion.Usage.Input != 15 || completion.Usage.Output != 3 {
		t.Fatalf("completion=%+v", completion)
	}
}

type recordingMessagingAgentExecutor struct {
	claims       authbridge.CapabilityClaims
	capabilityID string
	input        json.RawMessage
	result       capability.Result
}

func (executor *recordingMessagingAgentExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	executor.claims = claims
	executor.capabilityID = capabilityID
	executor.input = append(json.RawMessage(nil), input...)
	return executor.result, nil
}

func TestMessagingAgentToolExecutesWithUserAndSessionScope(t *testing.T) {
	orgID := "22222222-2222-4222-8222-222222222222"
	actorID := "33333333-3333-4333-8333-333333333333"
	sessionID := "44444444-4444-4444-8444-444444444444"
	rootIntent := "55555555-5555-4555-8555-555555555555"
	user := &session.ResolvedUser{UserID: actorID, OrgID: &orgID, AuthSessionID: "auth-session", Permissions: map[string]bool{"crm.read": true}}
	executor := &recordingMessagingAgentExecutor{result: capability.Result{OK: true, Data: json.RawMessage(`{"ok":true}`)}}
	handler := NewMessagingAgentHandler(nil, nil, executor, nil).(*messagingAgentHandler)
	tool := capability.AgentToolSpec{ID: "crm.listCustomers", Permission: "crm.read", Risk: "read"}
	call := messagingAgentToolCall{ID: "call-1", Type: "function"}
	call.Function.Name = messagingToolName(tool.ID)
	call.Function.Arguments = `{"limit":5}`
	result := handler.executeMessagingAgentTool(context.Background(), user, sessionID, rootIntent, 1, 0, map[string]capability.AgentToolSpec{call.Function.Name: tool}, call)
	if !reflect.DeepEqual(result, executor.result) || executor.capabilityID != tool.ID || string(executor.input) != call.Function.Arguments {
		t.Fatalf("result=%+v executed=%q input=%s", result, executor.capabilityID, executor.input)
	}
	if executor.claims.ActorType != "agent" || executor.claims.Subject != actorID || executor.claims.OrganizationID != orgID || executor.claims.AgentSessionID != sessionID || executor.claims.AuthSessionID != user.AuthSessionID || executor.claims.IntentID == "" {
		t.Fatalf("agent capability claims=%+v", executor.claims)
	}
	firstIntent := executor.claims.IntentID
	call.Function.Arguments = `{"limit":10}`
	_ = handler.executeMessagingAgentTool(context.Background(), user, sessionID, rootIntent, 1, 0, map[string]capability.AgentToolSpec{call.Function.Name: tool}, call)
	if executor.claims.IntentID != firstIntent || executor.claims.InputSHA256 == "" {
		t.Fatalf("tool intent should remain stable when a retry changes model arguments: claims=%+v", executor.claims)
	}
}

func TestMessagingAgentIntentIDIsDeterministicUUID(t *testing.T) {
	first := deterministicMessagingUUID("chat-reply:action")
	if first != deterministicMessagingUUID("chat-reply:action") || !isUUID(first) || first == deterministicMessagingUUID("chat-reply:other") {
		t.Fatalf("unexpected deterministic ID %q", first)
	}
}

func TestMessagingAgentTriggerIntentIsBoundToOrganizationConversationAndMessage(t *testing.T) {
	orgID := "22222222-2222-4222-8222-222222222222"
	conversationID := "33333333-3333-4333-8333-333333333333"
	messageID := "44444444-4444-4444-8444-444444444444"
	first := messagingTriggerIntentID(orgID, conversationID, messageID)
	if !isUUID(first) || first != messagingTriggerIntentID(orgID, conversationID, messageID) {
		t.Fatalf("trigger intent is not a stable UUID: %q", first)
	}
	if first == messagingTriggerIntentID("55555555-5555-4555-8555-555555555555", conversationID, messageID) ||
		first == messagingTriggerIntentID(orgID, "66666666-6666-4666-8666-666666666666", messageID) ||
		first == messagingTriggerIntentID(orgID, conversationID, "77777777-7777-4777-8777-777777777777") {
		t.Fatal("trigger intent must change when its organization, conversation, or message changes")
	}
}

func TestMessagingTriggerLocksSerializeOneMessageAndHonorCancellation(t *testing.T) {
	var locks messagingTriggerLocks
	releaseFirst, err := locks.acquire(context.Background(), "org:conversation:message")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := locks.acquire(ctx, "org:conversation:message"); err == nil {
		t.Fatal("canceled waiter acquired a held message lock")
	}

	acquired := make(chan func(), 1)
	go func() {
		release, err := locks.acquire(context.Background(), "org:conversation:message")
		if err != nil {
			acquired <- nil
			return
		}
		acquired <- release
	}()
	select {
	case <-acquired:
		t.Fatal("same-message work was not serialized")
	case <-time.After(20 * time.Millisecond):
	}
	releaseFirst()
	select {
	case release := <-acquired:
		if release == nil {
			t.Fatal("waiting lock acquisition failed")
		}
		release()
	case <-time.After(time.Second):
		t.Fatal("waiting same-message work did not proceed after release")
	}
	locks.mu.Lock()
	defer locks.mu.Unlock()
	if len(locks.locks) != 0 {
		t.Fatalf("trigger lock entries leaked: %d", len(locks.locks))
	}
}
