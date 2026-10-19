package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"
)

const (
	chatProviderTemperature = 0.2
	chatProviderMaxTokens   = 4096
	chatProviderMaxLine     = 1 << 20
)

// chatUsage mirrors the kernel's token accounting; cachedInput is the prompt
// prefix served from the provider's KV cache.
type chatUsage struct {
	Input       int64 `json:"input"`
	Output      int64 `json:"output"`
	CachedInput int64 `json:"cachedInput"`
}

type chatToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type chatMessage struct {
	Role       string         `json:"role"`
	Content    string         `json:"content"`
	ToolCalls  []chatToolCall `json:"toolCalls,omitempty"`
	ToolCallID string         `json:"toolCallId,omitempty"`
}

type chatToolSpec struct {
	Name        string
	Description string
	Parameters  json.RawMessage
}

type chatTurn struct {
	message   string
	toolCalls []chatToolCall
	usage     chatUsage
}

// chatProvider is the model transport the loop depends on; tests inject fakes
// while production uses the OpenAI-compatible streaming client below.
type chatProvider interface {
	Stream(ctx context.Context, messages []chatMessage, tools []chatToolSpec, onDelta func(string)) (chatTurn, error)
}

// chatProviderError carries the upstream HTTP status for pre-stream refusals;
// the message is deliberately generic because provider bodies can echo
// credentials or prompt content.
type chatProviderError struct {
	status int
}

func (e chatProviderError) Error() string {
	if e.status != 0 {
		return fmt.Sprintf("model request failed (HTTP %d)", e.status)
	}
	return "model request failed"
}

func (e chatProviderError) StatusCode() int { return e.status }

type openAIChatProvider struct {
	baseURL string
	apiKey  string
	model   string

	// NIM fallback for API-key workspaces whose primary provider is rate
	// limited or has retired the model. A selected coding plan never falls
	// back because that would silently change the billing source.
	fallbackBaseURL string
	fallbackAPIKey  string
	fallbackModel   string
}

// newOpenAIChatProvider builds the streaming client from the workspace AI
// configuration. Transports are pinned per request so a mutable DNS answer
// cannot redirect a workspace credential to another host.
func newOpenAIChatProvider(config myWorkSummaryConfig) *openAIChatProvider {
	provider := &openAIChatProvider{
		baseURL: strings.TrimRight(strings.TrimSpace(config.baseURL), "/"),
		apiKey:  strings.TrimSpace(config.apiKey),
		model:   strings.TrimSpace(config.primaryModel),
	}
	if !strings.EqualFold(strings.TrimSpace(config.provider), "nvidia") && !strings.EqualFold(strings.TrimSpace(config.provider), "deepseek") {
		if key := strings.TrimSpace(os.Getenv("NVIDIA_API_KEY")); key != "" {
			provider.fallbackBaseURL = strings.TrimRight(envOr("NIM_BASE_URL", "https://integrate.api.nvidia.com/v1"), "/")
			provider.fallbackAPIKey = key
			provider.fallbackModel = envOr("MODEL_PRIMARY_NIM", "moonshotai/kimi-k2.6")
		}
	}
	return provider
}

func (p *openAIChatProvider) Stream(ctx context.Context, messages []chatMessage, tools []chatToolSpec, onDelta func(string)) (chatTurn, error) {
	turn, err := p.stream(ctx, p.baseURL, p.apiKey, p.model, messages, tools, onDelta)
	if err != nil && p.fallbackModel != "" {
		switch chatProviderStatus(err) {
		// 402 means this model cannot serve the request at the current credit
		// balance, not that the turn is doomed; a fallback may accept it. The
		// body is never surfaced, so message-pattern matching is unavailable.
		case http.StatusTooManyRequests, http.StatusNotFound, http.StatusPaymentRequired:
			return p.stream(ctx, p.fallbackBaseURL, p.fallbackAPIKey, p.fallbackModel, messages, tools, onDelta)
		}
	}
	return turn, err
}

func chatProviderStatus(err error) int {
	var providerErr chatProviderError
	if errors.As(err, &providerErr) {
		return providerErr.status
	}
	return 0
}

type chatOutboundToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type chatOutboundMessage struct {
	Role       string                 `json:"role"`
	Content    *string                `json:"content"`
	ToolCalls  []chatOutboundToolCall `json:"tool_calls,omitempty"`
	ToolCallID string                 `json:"tool_call_id,omitempty"`
}

func chatOutboundMessages(messages []chatMessage) []chatOutboundMessage {
	mapped := make([]chatOutboundMessage, 0, len(messages))
	for _, message := range messages {
		outbound := chatOutboundMessage{Role: message.Role, ToolCallID: message.ToolCallID}
		if message.Content != "" {
			content := message.Content
			outbound.Content = &content
		} else if message.Role != "assistant" || len(message.ToolCalls) == 0 {
			empty := ""
			outbound.Content = &empty
		}
		for _, call := range message.ToolCalls {
			outboundCall := chatOutboundToolCall{ID: call.ID, Type: "function"}
			outboundCall.Function.Name = call.Name
			arguments := string(call.Arguments)
			if strings.TrimSpace(arguments) == "" {
				arguments = "{}"
			}
			outboundCall.Function.Arguments = arguments
			outbound.ToolCalls = append(outbound.ToolCalls, outboundCall)
		}
		mapped = append(mapped, outbound)
	}
	return mapped
}

func chatOutboundTools(tools []chatToolSpec) []map[string]any {
	outbound := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		parameters := json.RawMessage(tool.Parameters)
		if len(parameters) == 0 {
			parameters = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		outbound = append(outbound, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        tool.Name,
				"description": tool.Description,
				"parameters":  parameters,
			},
		})
	}
	return outbound
}

func (p *openAIChatProvider) stream(ctx context.Context, baseURL, apiKey, model string, messages []chatMessage, tools []chatToolSpec, onDelta func(string)) (chatTurn, error) {
	endpoint, address, err := resolveWorkSummaryEndpoint(baseURL)
	if err != nil {
		return chatTurn{}, errors.New("configured model endpoint is invalid or outside the provider network trust boundary")
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/chat/completions"
	body, err := json.Marshal(map[string]any{
		"model":          strings.TrimSpace(model),
		"messages":       chatOutboundMessages(messages),
		"tools":          chatOutboundTools(tools),
		"temperature":    chatProviderTemperature,
		"max_tokens":     chatProviderMaxTokens,
		"stream":         true,
		"stream_options": map[string]any{"include_usage": true},
	})
	if err != nil {
		return chatTurn{}, errors.New("could not encode model request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return chatTurn{}, errors.New("could not create model request")
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("X-Title", "ChasteBusinessOS")
	client := newSupportPinnedHTTPClient(address, 300*time.Second)
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return chatTurn{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// Drain a bounded amount so the connection can be reused; the body is
		// never surfaced because it can contain prompt or credential echoes.
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return chatTurn{}, chatProviderError{status: response.StatusCode}
	}
	return readChatCompletionStream(response.Body, onDelta)
}

type chatCompletionChunk struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			Reasoning        string `json:"reasoning"`
			ReasoningContent string `json:"reasoning_content"`
			ToolCalls        []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens        int64 `json:"prompt_tokens"`
		CompletionTokens    int64 `json:"completion_tokens"`
		PromptTokensDetails *struct {
			CachedTokens int64 `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		CacheReadInputTokens *int64 `json:"cache_read_input_tokens"`
	} `json:"usage"`
}

type chatPendingToolCall struct {
	id        string
	name      string
	arguments string
}

// readChatCompletionStream parses OpenAI-compatible SSE chunks. Reasoning
// deltas from NIM (reasoning_content) and OpenRouter (reasoning) accumulate
// separately and only become the visible reply when no content arrives.
func readChatCompletionStream(body io.Reader, onDelta func(string)) (chatTurn, error) {
	var turn chatTurn
	var content, reasoning strings.Builder
	pending := make(map[int]*chatPendingToolCall)
	ingest := func(payload string) bool {
		if payload == "" {
			return false
		}
		if payload == "[DONE]" {
			return true
		}
		var chunk chatCompletionChunk
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			// A malformed heartbeat or comment frame must not poison the turn.
			return false
		}
		if chunk.Usage != nil {
			turn.usage = chatUsage{
				Input:  chunk.Usage.PromptTokens,
				Output: chunk.Usage.CompletionTokens,
			}
			if chunk.Usage.PromptTokensDetails != nil {
				turn.usage.CachedInput = chunk.Usage.PromptTokensDetails.CachedTokens
			} else if chunk.Usage.CacheReadInputTokens != nil {
				turn.usage.CachedInput = *chunk.Usage.CacheReadInputTokens
			}
		}
		for _, choice := range chunk.Choices {
			delta := choice.Delta
			reasoning.WriteString(delta.ReasoningContent)
			reasoning.WriteString(delta.Reasoning)
			if delta.Content != "" {
				content.WriteString(delta.Content)
				if onDelta != nil {
					onDelta(delta.Content)
				}
			}
			for _, fragment := range delta.ToolCalls {
				slot := pending[fragment.Index]
				if slot == nil {
					slot = &chatPendingToolCall{}
					pending[fragment.Index] = slot
				}
				slot.id += fragment.ID
				slot.name += fragment.Function.Name
				slot.arguments += fragment.Function.Arguments
			}
		}
		return false
	}
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64<<10), chatProviderMaxLine)
	// An SSE event may spread its data over consecutive data: lines; join them
	// at the blank-line boundary the way the spec (and the legacy SDK) does.
	var dataLines []string
	flush := func() bool {
		if len(dataLines) == 0 {
			return false
		}
		payload := strings.TrimSpace(strings.Join(dataLines, "\n"))
		dataLines = dataLines[:0]
		return ingest(payload)
	}
	done := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			if flush() {
				done = true
				break
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		payload, ok := strings.CutPrefix(line, "data:")
		if !ok {
			continue
		}
		dataLines = append(dataLines, payload)
	}
	if !done {
		flush()
	}
	if err := scanner.Err(); err != nil {
		return chatTurn{}, err
	}
	// Providers may emit tool-call fragments out of order; index order is the
	// only stable ordering the model's request carries.
	indices := make([]int, 0, len(pending))
	for index := range pending {
		indices = append(indices, index)
	}
	slices.Sort(indices)
	for position, index := range indices {
		slot := pending[index]
		id := slot.id
		if id == "" {
			id = fmt.Sprintf("call_%d", position)
		}
		turn.toolCalls = append(turn.toolCalls, chatToolCall{ID: id, Name: slot.name, Arguments: chatSafeArguments(slot.arguments)})
	}
	turn.message = content.String()
	if turn.message == "" {
		turn.message = reasoning.String()
	}
	return turn, nil
}

// chatSafeArguments keeps the transcript parseable even when a model streams
// invalid JSON; the executor still validates the arguments before execution.
func chatSafeArguments(raw string) json.RawMessage {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || !json.Valid([]byte(trimmed)) {
		return json.RawMessage(`{}`)
	}
	return json.RawMessage(trimmed)
}
