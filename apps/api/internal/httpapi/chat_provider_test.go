package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func chatTestProviderConfig(baseURL string) myWorkSummaryConfig {
	return myWorkSummaryConfig{provider: "openai-compat", baseURL: baseURL, apiKey: "test-key", primaryModel: "test-model"}
}

func chatSSEServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(handler))
}

func writeChatSSE(t *testing.T, w http.ResponseWriter, chunks ...string) {
	t.Helper()
	w.Header().Set("Content-Type", "text/event-stream")
	for _, chunk := range chunks {
		if _, err := io.WriteString(w, "data: "+chunk+"\n\n"); err != nil {
			return
		}
	}
}

func TestChatProviderStreamsContentToolsAndUsage(t *testing.T) {
	t.Setenv("GO_AUTH_MODE", "development")
	var received map[string]any
	server := chatSSEServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization=%q", got)
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &received)
		writeChatSSE(t, w,
			`{"choices":[{"delta":{"content":"Hel"}}]}`,
			`{"choices":[{"delta":{"content":"lo"}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"crm_","arguments":"{\"qu"}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"abc","function":{"name":"listCustomers","arguments":"ery\":\"a\"}"}}]}}]}`,
			`{"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":3}}}`,
			`[DONE]`,
		)
	})
	defer server.Close()
	provider := newOpenAIChatProvider(chatTestProviderConfig(server.URL))
	var deltas []string
	turn, err := provider.Stream(context.Background(),
		[]chatMessage{{Role: "system", Content: "s"}, {Role: "user", Content: "u"}},
		[]chatToolSpec{{Name: "crm_listCustomers", Description: "d", Parameters: json.RawMessage(`{"type":"object"}`)}},
		func(text string) { deltas = append(deltas, text) },
	)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if turn.message != "Hello" {
		t.Fatalf("message=%q, want Hello", turn.message)
	}
	if strings.Join(deltas, "") != "Hello" {
		t.Fatalf("deltas=%v", deltas)
	}
	if len(turn.toolCalls) != 1 || turn.toolCalls[0].ID != "call_abc" || turn.toolCalls[0].Name != "crm_listCustomers" {
		t.Fatalf("toolCalls=%+v", turn.toolCalls)
	}
	if string(turn.toolCalls[0].Arguments) != `{"query":"a"}` {
		t.Fatalf("arguments=%s", turn.toolCalls[0].Arguments)
	}
	if turn.usage != (chatUsage{Input: 10, Output: 5, CachedInput: 3}) {
		t.Fatalf("usage=%+v", turn.usage)
	}
	if received["model"] != "test-model" || received["stream"] != true {
		t.Fatalf("request=%v", received)
	}
	if _, ok := received["stream_options"].(map[string]any)["include_usage"]; !ok {
		t.Fatalf("stream_options=%v, want include_usage", received["stream_options"])
	}
}

func TestChatProviderKeepsReasoningSeparateFromTheAnswer(t *testing.T) {
	t.Setenv("GO_AUTH_MODE", "development")
	server := chatSSEServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeChatSSE(t, w,
			`{"choices":[{"delta":{"reasoning_content":"Thinking"}}]}`,
			`{"choices":[{"delta":{"reasoning":" harder"}}]}`,
			`[DONE]`,
		)
	})
	defer server.Close()
	turn, err := newOpenAIChatProvider(chatTestProviderConfig(server.URL)).Stream(context.Background(), nil, nil, nil)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if turn.message != "" || turn.reasoning != "Thinking harder" {
		t.Fatalf("message=%q reasoning=%q, want reasoning kept out of the answer", turn.message, turn.reasoning)
	}
}

func TestChatProviderReadsAlternateCachedUsageField(t *testing.T) {
	t.Setenv("GO_AUTH_MODE", "development")
	server := chatSSEServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeChatSSE(t, w,
			`{"choices":[{"delta":{"content":"ok"}}]}`,
			`{"usage":{"prompt_tokens":7,"completion_tokens":2,"cache_read_input_tokens":4}}`,
			`[DONE]`,
		)
	})
	defer server.Close()
	turn, err := newOpenAIChatProvider(chatTestProviderConfig(server.URL)).Stream(context.Background(), nil, nil, nil)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if turn.usage != (chatUsage{Input: 7, Output: 2, CachedInput: 4}) {
		t.Fatalf("usage=%+v", turn.usage)
	}
}

func TestChatProviderSortsToolCallIndicesAndIgnoresMalformedFrames(t *testing.T) {
	t.Setenv("GO_AUTH_MODE", "development")
	server := chatSSEServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeChatSSE(t, w,
			`not-json`,
			`{"choices":[{"delta":{"tool_calls":[{"index":2,"id":"c","function":{"name":"third","arguments":"{}"}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"first","arguments":"{}"}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"second","arguments":"{}"}}]}}]}`,
			`[DONE]`,
		)
	})
	defer server.Close()
	turn, err := newOpenAIChatProvider(chatTestProviderConfig(server.URL)).Stream(context.Background(), nil, nil, nil)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if len(turn.toolCalls) != 3 {
		t.Fatalf("toolCalls=%+v", turn.toolCalls)
	}
	for index, want := range []string{"a", "b", "c"} {
		if turn.toolCalls[index].ID != want {
			t.Fatalf("toolCalls[%d]=%q, want %q (index order)", index, turn.toolCalls[index].ID, want)
		}
	}
}

func TestChatProviderReportsGenericProviderErrorWithoutBody(t *testing.T) {
	t.Setenv("GO_AUTH_MODE", "development")
	server := chatSSEServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"message":"secret upstream detail"}}`)
	})
	defer server.Close()
	_, err := newOpenAIChatProvider(chatTestProviderConfig(server.URL)).Stream(context.Background(), nil, nil, nil)
	if err == nil {
		t.Fatal("want an error")
	}
	if got := err.Error(); got != "The AI provider rejected its credentials. Check Settings > AI & automation." {
		t.Fatalf("error=%q, want an actionable credential message", got)
	}
	if strings.Contains(err.Error(), "secret upstream detail") {
		t.Fatalf("provider body leaked into the public error: %q", err)
	}
	if status := chatProviderStatus(err); status != http.StatusUnauthorized {
		t.Fatalf("status=%d", status)
	}
}

func TestChatProviderFallsBackOnRetryableProviderStatuses(t *testing.T) {
	t.Setenv("GO_AUTH_MODE", "development")
	for _, status := range []int{http.StatusTooManyRequests, http.StatusNotFound, http.StatusPaymentRequired} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			primary := chatSSEServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
			})
			defer primary.Close()
			fallback := chatSSEServer(t, func(w http.ResponseWriter, r *http.Request) {
				if got := r.Header.Get("Authorization"); got != "Bearer nim-key" {
					t.Errorf("fallback Authorization=%q", got)
				}
				var body map[string]any
				encoded, _ := io.ReadAll(r.Body)
				_ = json.Unmarshal(encoded, &body)
				if body["model"] != "nim-model" {
					t.Errorf("fallback model=%v", body["model"])
				}
				writeChatSSE(t, w, `{"choices":[{"delta":{"content":"from fallback"}}]}`, `[DONE]`)
			})
			defer fallback.Close()
			t.Setenv("NVIDIA_API_KEY", "nim-key")
			t.Setenv("NIM_BASE_URL", fallback.URL)
			t.Setenv("MODEL_PRIMARY_NIM", "nim-model")
			turn, err := newOpenAIChatProvider(chatTestProviderConfig(primary.URL)).Stream(context.Background(), nil, nil, nil)
			if err != nil {
				t.Fatalf("Stream: %v", err)
			}
			if turn.message != "from fallback" {
				t.Fatalf("message=%q, want the fallback reply", turn.message)
			}
		})
	}
}

func TestChatProviderJoinsMultiLineDataEvents(t *testing.T) {
	t.Setenv("GO_AUTH_MODE", "development")
	server := chatSSEServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, ": ping\n\ndata: {\"choices\":[\ndata: {\"delta\":{\"content\":\"joined\"}}]}\n\ndata: [DONE]\n\n")
	})
	defer server.Close()
	turn, err := newOpenAIChatProvider(chatTestProviderConfig(server.URL)).Stream(context.Background(), nil, nil, nil)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if turn.message != "joined" {
		t.Fatalf("message=%q, want the multi-line data payload joined", turn.message)
	}
}

func TestChatProviderDoesNotFallBackFromNvidiaToItself(t *testing.T) {
	t.Setenv("GO_AUTH_MODE", "development")
	t.Setenv("NVIDIA_API_KEY", "nim-key")
	primary := chatSSEServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	})
	defer primary.Close()
	config := chatTestProviderConfig(primary.URL)
	config.provider = "nvidia"
	_, err := newOpenAIChatProvider(config).Stream(context.Background(), nil, nil, nil)
	if status := chatProviderStatus(err); status != http.StatusTooManyRequests {
		t.Fatalf("err=%v status=%d, want the original 429", err, status)
	}
}

func TestChatProviderRejectsNonPublicEndpointInProduction(t *testing.T) {
	t.Setenv("GO_AUTH_MODE", "production")
	t.Setenv("NODE_ENV", "production")
	server := chatSSEServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("provider reached a non-public endpoint")
	})
	defer server.Close()
	_, err := newOpenAIChatProvider(chatTestProviderConfig(server.URL)).Stream(context.Background(), nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "outside the provider network trust boundary") {
		t.Fatalf("err=%v, want an endpoint trust-boundary error", err)
	}
}

func TestChatProviderOutboundMessageShapes(t *testing.T) {
	outbound := chatOutboundMessages([]chatMessage{
		{Role: "system", Content: "rules"},
		{Role: "assistant", ToolCalls: []chatToolCall{{ID: "call_1", Name: "crm_listCustomers", Arguments: json.RawMessage(`{"query":"a"}`)}}},
		{Role: "tool", Content: `{"ok":true}`, ToolCallID: "call_1"},
	})
	if len(outbound) != 3 {
		t.Fatalf("outbound=%+v", outbound)
	}
	if outbound[1].Content != nil {
		t.Fatalf("assistant tool-call message content=%v, want omitted when empty", *outbound[1].Content)
	}
	if len(outbound[1].ToolCalls) != 1 || outbound[1].ToolCalls[0].Function.Arguments != `{"query":"a"}` {
		t.Fatalf("tool call=%+v", outbound[1].ToolCalls)
	}
	if outbound[2].ToolCallID != "call_1" || outbound[2].Content == nil || *outbound[2].Content != `{"ok":true}` {
		t.Fatalf("tool message=%+v", outbound[2])
	}
}

func TestChatSafeArgumentsRejectsInvalidJSON(t *testing.T) {
	if got := string(chatSafeArguments(`{"unterminated"`)); got != "{}" {
		t.Fatalf("chatSafeArguments=%s, want empty object", got)
	}
	if got := string(chatSafeArguments("")); got != "{}" {
		t.Fatalf("chatSafeArguments=%s, want empty object", got)
	}
	if got := string(chatSafeArguments(`{"a":1}`)); got != `{"a":1}` {
		t.Fatalf("chatSafeArguments=%s, want passthrough", got)
	}
}

func TestChatProviderErrorMessagesAreActionable(t *testing.T) {
	cases := []struct {
		status int
		want   string
	}{
		{http.StatusTooManyRequests, "The AI model is rate limited right now. Try again in a moment."},
		{http.StatusRequestEntityTooLarge, "The request was too large for the configured AI model. Try a shorter request."},
		{http.StatusNotFound, "The configured AI model is unavailable. Try again, or check the model in Settings > AI & automation."},
	}
	for _, test := range cases {
		if got := (chatProviderError{status: test.status}).Error(); got != test.want {
			t.Fatalf("status %d: got %q, want %q", test.status, got, test.want)
		}
	}
}
