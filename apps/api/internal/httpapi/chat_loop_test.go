package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type scriptedChatProvider struct {
	mu       sync.Mutex
	turns    []chatTurn
	errs     []error
	calls    int
	messages [][]chatMessage
	tools    [][]chatToolSpec
}

func (p *scriptedChatProvider) Stream(_ context.Context, messages []chatMessage, tools []chatToolSpec, onDelta func(string)) (chatTurn, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.messages = append(p.messages, append([]chatMessage(nil), messages...))
	p.tools = append(p.tools, append([]chatToolSpec(nil), tools...))
	index := p.calls
	p.calls++
	if index < len(p.errs) && p.errs[index] != nil {
		return chatTurn{}, p.errs[index]
	}
	if index >= len(p.turns) {
		return chatTurn{message: "stop"}, nil
	}
	turn := p.turns[index]
	if turn.message != "" && onDelta != nil {
		onDelta(turn.message)
	}
	return turn, nil
}

func (p *scriptedChatProvider) callCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

func (p *scriptedChatProvider) callMessages(index int) []chatMessage {
	p.mu.Lock()
	defer p.mu.Unlock()
	if index >= len(p.messages) {
		return nil
	}
	return p.messages[index]
}

type scriptedChatExecutor struct {
	mu      sync.Mutex
	results []capability.Result
	errs    []error
	calls   []scriptedChatExecutorCall
}

type scriptedChatExecutorCall struct {
	claims       authbridge.CapabilityClaims
	capabilityID string
	input        json.RawMessage
}

func (e *scriptedChatExecutor) Execute(_ context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, scriptedChatExecutorCall{claims: claims, capabilityID: capabilityID, input: append(json.RawMessage(nil), input...)})
	index := len(e.calls) - 1
	if index < len(e.errs) && e.errs[index] != nil {
		return capability.Result{}, e.errs[index]
	}
	if index < len(e.results) {
		return e.results[index], nil
	}
	return capability.Result{OK: true, Data: json.RawMessage(`{}`)}, nil
}

func (e *scriptedChatExecutor) recorded() []scriptedChatExecutorCall {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]scriptedChatExecutorCall(nil), e.calls...)
}

type chatLoopTestEvent struct {
	role    string
	content map[string]any
}

func chatLoopTestDeps(provider chatProvider, executor CapabilityExecutor) (chatLoopDeps, *[]chatLoopTestEvent) {
	orgID := "11111111-1111-4111-8111-111111111111"
	user := &session.ResolvedUser{
		UserID: "22222222-2222-4222-8222-222222222222", OrgID: &orgID,
		Permissions: map[string]bool{"crm.read": true, "crm.write": false}, EmailVerified: true,
		AuthSessionID: "33333333-3333-4333-8333-333333333333",
	}
	events := &[]chatLoopTestEvent{}
	deps := chatLoopDeps{
		provider:      provider,
		executor:      executor,
		user:          user,
		orgID:         orgID,
		sessionID:     "44444444-4444-4444-8444-444444444444",
		turnID:        "turn-1",
		systemPrompt:  "system",
		userGoal:      "do the thing",
		contextWindow: chatDefaultContextWindow,
		reserveTokens: chatDefaultReserveTokens,
		enableTickets: true,
		enableAsk:     true,
		capabilityByToolName: map[string]capability.AgentToolSpec{
			"crm_listCustomers": {ID: "crm.listCustomers", Permission: "crm.read"},
		},
		onEvent: func(role string, content map[string]any) {
			*events = append(*events, chatLoopTestEvent{role: role, content: content})
		},
	}
	return deps, events
}

func TestChatLoopExecutesToolThenReplies(t *testing.T) {
	executor := &scriptedChatExecutor{results: []capability.Result{{OK: true, Data: json.RawMessage(`{"customers":[]}`)}}}
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call_1", Name: "crm_listCustomers", Arguments: json.RawMessage(`{"query":"a"}`)}}, usage: chatUsage{Input: 4}},
		{message: "Zero customers.", usage: chatUsage{Input: 5, Output: 3, CachedInput: 2}},
	}}
	deps, events := chatLoopTestDeps(provider, executor)
	result, err := runChatSessionLoop(context.Background(), deps)
	if err != nil {
		t.Fatalf("runChatSessionLoop: %v", err)
	}
	if result.finalMessage != "Zero customers." {
		t.Fatalf("finalMessage=%q", result.finalMessage)
	}
	if result.usage != (chatUsage{Input: 9, Output: 3, CachedInput: 2}) {
		t.Fatalf("usage=%+v", result.usage)
	}
	calls := executor.recorded()
	if len(calls) != 1 || calls[0].capabilityID != "crm.listCustomers" {
		t.Fatalf("executor calls=%+v", calls)
	}
	wantIntent := deterministicMessagingUUID(fmt.Sprintf("chat-tool:%s:%s:1:0", deps.sessionID, deps.turnID))
	if calls[0].claims.IntentID != wantIntent {
		t.Fatalf("intent=%q, want %q", calls[0].claims.IntentID, wantIntent)
	}
	if calls[0].claims.ActorType != "agent" || calls[0].claims.AgentSessionID != deps.sessionID || calls[0].claims.Subject != deps.user.UserID {
		t.Fatalf("claims=%+v", calls[0].claims)
	}
	if len(calls[0].claims.Permissions) != 1 || calls[0].claims.Permissions[0] != "crm.read" {
		t.Fatalf("permissions=%v, want sorted granted set", calls[0].claims.Permissions)
	}
	var roles []string
	for _, event := range *events {
		roles = append(roles, event.role)
	}
	joined := strings.Join(roles, ",")
	if joined != "step,tool_call,tool_result,step" {
		t.Fatalf("events=%s", joined)
	}
	second := provider.callMessages(1)
	if len(second) != 4 {
		t.Fatalf("second call messages=%d, want system+user+assistant+tool", len(second))
	}
	if second[2].Role != "assistant" || len(second[2].ToolCalls) != 1 {
		t.Fatalf("assistant message=%+v", second[2])
	}
	if second[3].Role != "tool" || second[3].ToolCallID != "call_1" || second[3].Content != `{"customers":[]}` {
		t.Fatalf("tool message=%+v", second[3])
	}
	if !strings.HasSuffix(second[0].Content, chatUntrustedContentRule) {
		t.Fatalf("system prompt missing untrusted-content rule: %q", second[0].Content)
	}
	if second[1].Content != "do the thing" {
		t.Fatalf("user goal should pass through unmodified: %q", second[1].Content)
	}
}

func TestChatLoopInjectsSteeringMessages(t *testing.T) {
	provider := &scriptedChatProvider{turns: []chatTurn{{message: "ok"}}}
	deps, events := chatLoopTestDeps(provider, &scriptedChatExecutor{})
	drains := 0
	deps.drainSteering = func(context.Context) []string {
		drains++
		if drains == 1 {
			return []string{"focus on invoices", "   "}
		}
		return nil
	}
	if _, err := runChatSessionLoop(context.Background(), deps); err != nil {
		t.Fatalf("runChatSessionLoop: %v", err)
	}
	messages := provider.callMessages(0)
	if len(messages) != 3 || messages[2].Content != "[steering] focus on invoices" {
		t.Fatalf("messages=%+v", messages)
	}
	found := false
	for _, event := range *events {
		if event.role == "user" && event.content["steering"] == true && event.content["text"] == "focus on invoices" {
			found = true
		}
		if event.role == "user" && event.content["text"] == "" {
			t.Fatalf("blank steering message emitted: %+v", event)
		}
	}
	if !found {
		t.Fatalf("steering user event missing: %+v", *events)
	}
}

func TestChatLoopClarificationEndsTheRun(t *testing.T) {
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call_7", Name: "ask_user", Arguments: json.RawMessage(`{"question":"Which account?","options":["A","B"],"allowOther":false}`)}}},
		{message: "should not run"},
	}}
	deps, events := chatLoopTestDeps(provider, &scriptedChatExecutor{})
	result, err := runChatSessionLoop(context.Background(), deps)
	if err != nil {
		t.Fatalf("runChatSessionLoop: %v", err)
	}
	if provider.callCount() != 1 {
		t.Fatalf("provider calls=%d, want one; the answer arrives as the next user message", provider.callCount())
	}
	if result.finalMessage != "" {
		t.Fatalf("finalMessage=%q", result.finalMessage)
	}
	var ask *chatLoopTestEvent
	for index := range *events {
		if (*events)[index].role == "ask" {
			ask = &(*events)[index]
		}
	}
	if ask == nil {
		t.Fatalf("ask event missing: %+v", *events)
	}
	if ask.content["id"] != "call_7" || ask.content["question"] != "Which account?" || ask.content["allowOther"] != false {
		t.Fatalf("ask content=%+v", ask.content)
	}
	options, _ := ask.content["options"].([]string)
	if len(options) != 2 || options[0] != "A" {
		t.Fatalf("ask options=%v", ask.content["options"])
	}
}

func TestChatLoopFilesTicketThroughExecutor(t *testing.T) {
	longTitle := strings.Repeat("t", 260)
	executor := &scriptedChatExecutor{results: []capability.Result{{OK: true, Data: json.RawMessage(`{"ticketId":"t1"}`)}}}
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call_1", Name: "file_ticket", Arguments: json.RawMessage(`{"title":"` + longTitle + `","description":"blocked"}`)}}},
		{message: "Filed."},
	}}
	deps, events := chatLoopTestDeps(provider, executor)
	if _, err := runChatSessionLoop(context.Background(), deps); err != nil {
		t.Fatalf("runChatSessionLoop: %v", err)
	}
	calls := executor.recorded()
	if len(calls) != 1 || calls[0].capabilityID != "support.createTicket" {
		t.Fatalf("executor calls=%+v", calls)
	}
	var input struct {
		Title       string `json:"title"`
		Description string `json:"description"`
		Origin      string `json:"origin"`
		SessionID   string `json:"sessionId"`
	}
	if err := json.Unmarshal(calls[0].input, &input); err != nil {
		t.Fatalf("input=%s", calls[0].input)
	}
	if utf16Length(input.Title) != chatTicketTitleMax || input.Origin != "capability_gap" || input.SessionID != deps.sessionID {
		t.Fatalf("ticket input=%+v", input)
	}
	toolContent := provider.callMessages(1)[3].Content
	if toolContent != `{"ok":true,"note":"ticket filed","ticketId":"t1"}` {
		t.Fatalf("ticket tool result=%s", toolContent)
	}
	for _, event := range *events {
		if event.role == "tool_result" {
			t.Fatalf("ticket path must not emit tool_result; got %+v", event)
		}
	}
}

func TestChatLoopTicketRefusalIsReported(t *testing.T) {
	executor := &scriptedChatExecutor{results: []capability.Result{{OK: false, Error: "capability module is disabled"}}}
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call_1", Name: "file_ticket", Arguments: json.RawMessage(`{"title":"x","description":"y"}`)}}},
		{message: "Could not file."},
	}}
	deps, _ := chatLoopTestDeps(provider, executor)
	if _, err := runChatSessionLoop(context.Background(), deps); err != nil {
		t.Fatalf("runChatSessionLoop: %v", err)
	}
	toolContent := provider.callMessages(1)[3].Content
	if toolContent != `{"ok":false,"note":"ticket filing refused","error":"capability module is disabled"}` {
		t.Fatalf("ticket refusal result=%s", toolContent)
	}
}

func TestChatLoopCompactsLongTrajectory(t *testing.T) {
	huge := strings.Repeat("x", 6000)
	executor := &scriptedChatExecutor{}
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{
			{ID: "c1", Name: "crm_listCustomers", Arguments: json.RawMessage(`{}`)},
			{ID: "c2", Name: "crm_listCustomers", Arguments: json.RawMessage(`{}`)},
			{ID: "c3", Name: "crm_listCustomers", Arguments: json.RawMessage(`{}`)},
			{ID: "c4", Name: "crm_listCustomers", Arguments: json.RawMessage(`{}`)},
			{ID: "c5", Name: "crm_listCustomers", Arguments: json.RawMessage(`{}`)},
		}},
		{message: "done"},
	}}
	for index := 0; index < 5; index++ {
		executor.results = append(executor.results, capability.Result{OK: true, Data: json.RawMessage(`{"blob":"` + huge + `"}`)})
	}
	deps, events := chatLoopTestDeps(provider, executor)
	deps.contextWindow = 20000
	deps.reserveTokens = 24576
	if _, err := runChatSessionLoop(context.Background(), deps); err != nil {
		t.Fatalf("runChatSessionLoop: %v", err)
	}
	compacted := false
	for _, event := range *events {
		if event.role == "compaction" {
			compacted = true
		}
	}
	if !compacted {
		t.Fatalf("compaction event missing: %+v", *events)
	}
	second := provider.callMessages(1)
	if second[0].Role != "system" {
		t.Fatalf("compaction must keep the system prefix intact, got %q", second[0].Content)
	}
	if !strings.Contains(second[1].Content, chatCompactionStub) {
		t.Fatalf("second call message[1]=%q, want a compacted stub", second[1].Content)
	}
}

func TestChatLoopStopsOnCancelledContextBeforeModelCall(t *testing.T) {
	provider := &scriptedChatProvider{turns: []chatTurn{{message: "never"}}}
	deps, _ := chatLoopTestDeps(provider, &scriptedChatExecutor{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := runChatSessionLoop(ctx, deps)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v, want context.Canceled", err)
	}
	if provider.callCount() != 0 {
		t.Fatalf("provider calls=%d, want none", provider.callCount())
	}
}

func TestChatLoopHonorsMaxSteps(t *testing.T) {
	provider := &scriptedChatProvider{turns: make([]chatTurn, 10)}
	for index := range provider.turns {
		provider.turns[index] = chatTurn{toolCalls: []chatToolCall{{ID: "c", Name: "crm_listCustomers", Arguments: json.RawMessage(`{}`)}}}
	}
	deps, events := chatLoopTestDeps(provider, &scriptedChatExecutor{})
	deps.maxSteps = 3
	result, err := runChatSessionLoop(context.Background(), deps)
	if err != nil {
		t.Fatalf("runChatSessionLoop: %v", err)
	}
	if provider.callCount() != 3 {
		t.Fatalf("provider calls=%d, want maxSteps", provider.callCount())
	}
	steps := 0
	for _, event := range *events {
		if event.role == "step" {
			steps++
		}
	}
	if steps != 3 || result.finalMessage != "" {
		t.Fatalf("steps=%d finalMessage=%q", steps, result.finalMessage)
	}
}

func TestChatLoopSurfacesProviderErrors(t *testing.T) {
	provider := &scriptedChatProvider{errs: []error{chatProviderError{status: http.StatusBadGateway}}}
	deps, _ := chatLoopTestDeps(provider, &scriptedChatExecutor{})
	_, err := runChatSessionLoop(context.Background(), deps)
	var providerErr chatProviderError
	if !errors.As(err, &providerErr) || providerErr.status != http.StatusBadGateway {
		t.Fatalf("err=%v", err)
	}
}

func TestChatLoopUnknownToolFailsThroughExecutor(t *testing.T) {
	executor := &scriptedChatExecutor{results: []capability.Result{{OK: false, Error: "unknown capability"}}}
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call_1", Name: "not_a_tool", Arguments: json.RawMessage(`{}`)}}},
		{message: "recovered"},
	}}
	deps, events := chatLoopTestDeps(provider, executor)
	result, err := runChatSessionLoop(context.Background(), deps)
	if err != nil {
		t.Fatalf("runChatSessionLoop: %v", err)
	}
	calls := executor.recorded()
	if len(calls) != 1 || calls[0].capabilityID != "not_a_tool" {
		t.Fatalf("executor calls=%+v", calls)
	}
	if result.finalMessage != "recovered" {
		t.Fatalf("finalMessage=%q", result.finalMessage)
	}
	failed := false
	for _, event := range *events {
		if event.role == "tool_result" && event.content["ok"] == false && event.content["error"] == "unknown capability" {
			failed = true
		}
	}
	if !failed {
		t.Fatalf("tool_result failure missing: %+v", *events)
	}
}

func TestChatCompactionHelpers(t *testing.T) {
	messages := []chatMessage{
		{Role: "system", Content: "rules"},
		{Role: "assistant", Content: "one"},
		{Role: "tool", Content: "big", ToolCallID: "call_9"},
		{Role: "user", Content: strings.Repeat("y", 16000)},
		{Role: "assistant", Content: "two"},
		{Role: "user", Content: "three"},
		{Role: "assistant", Content: "four"},
		{Role: "tool", Content: "five", ToolCallID: "call_10"},
		{Role: "assistant", Content: "six"},
	}
	if !chatShouldCompact(messages, 20000, 24576) {
		t.Fatal("chatShouldCompact=false, want true once the floor budget of 4000 tokens is exceeded")
	}
	if chatShouldCompact([]chatMessage{{Role: "user", Content: "short"}}, 131072, 24576) {
		t.Fatal("chatShouldCompact=true for a short transcript")
	}
	compacted := chatCompactTrajectory(messages)
	if len(compacted) != len(messages) {
		t.Fatalf("len(compacted)=%d", len(compacted))
	}
	if compacted[0].Role != "system" || compacted[0].Content != "rules" {
		t.Fatalf("system message was rewritten: %+v", compacted[0])
	}
	if compacted[1].Role != "assistant" || compacted[1].Content != chatCompactionStub {
		t.Fatalf("compacted[1]=%+v", compacted[1])
	}
	if compacted[2].Content != chatCompactionStub+" (call_9)" {
		t.Fatalf("tool stub=%q", compacted[2].Content)
	}
	if compacted[7].Content != "five" || compacted[7].ToolCallID != "call_10" || compacted[8].Content != "six" {
		t.Fatalf("recent window was mutated: %+v", compacted[7:])
	}
	tiny := []chatMessage{{Role: "user", Content: "a"}, {Role: "assistant", Content: "b"}}
	if got := chatCompactTrajectory(tiny); len(got) != 2 || got[0].Content != "a" {
		t.Fatalf("short transcript was compacted: %+v", got)
	}
	if chatEstimateTokens([]chatMessage{{Role: "user", Content: strings.Repeat("z", 9)}}) != 3 {
		t.Fatal("token estimate must be ceil(chars/4)")
	}
}

func TestChatLoopIncludesRecentConversationHistory(t *testing.T) {
	provider := &scriptedChatProvider{turns: []chatTurn{{message: "ok"}}}
	deps, _ := chatLoopTestDeps(provider, &scriptedChatExecutor{})
	deps.history = []chatMessage{
		{Role: "user", Content: "Earlier question"},
		{Role: "assistant", Content: "Earlier answer"},
	}
	if _, err := runChatSessionLoop(context.Background(), deps); err != nil {
		t.Fatalf("run loop: %v", err)
	}
	messages := provider.callMessages(0)
	if len(messages) != 4 || messages[1].Content != "Earlier question" || messages[2].Content != "Earlier answer" {
		t.Fatalf("messages=%+v", messages)
	}
}

func TestChatLoopConfirmsExecutedToolWhenProviderFails(t *testing.T) {
	executor := &scriptedChatExecutor{results: []capability.Result{{OK: true, Data: json.RawMessage(`{"customers":[]}`)}}}
	provider := &scriptedChatProvider{
		turns: []chatTurn{{toolCalls: []chatToolCall{{ID: "call_1", Name: "crm_listCustomers", Arguments: json.RawMessage(`{}`)}}}},
		errs:  []error{nil, chatProviderError{status: 429}},
	}
	deps, _ := chatLoopTestDeps(provider, executor)
	result, err := runChatSessionLoop(context.Background(), deps)
	if err != nil {
		t.Fatalf("runChatSessionLoop: %v", err)
	}
	if !strings.Contains(result.finalMessage, "crm · listCustomers") || !strings.Contains(result.finalMessage, "completed") {
		t.Fatalf("finalMessage=%q", result.finalMessage)
	}
}

func TestChatToolFallbackMessageExplainsPendingApproval(t *testing.T) {
	got := chatToolFallbackMessage("accounting.createInvoice", `{"error":"approval required","pendingApproval":true,"approvalId":"a-1"}`, false)
	if !strings.Contains(got, "waiting for approval") || !strings.Contains(got, "a-1") {
		t.Fatalf("message=%q", got)
	}
}

func TestDailyBriefComposesCrossModuleSections(t *testing.T) {
	executor := &scriptedChatExecutor{results: []capability.Result{
		{OK: true, Data: json.RawMessage(`{"signals":[]}`)},
		{OK: true, Data: json.RawMessage(`{"aging":{}}`)},
		{OK: true, Data: json.RawMessage(`{"aging":{}}`)},
		{OK: true, Data: json.RawMessage(`{"items":[]}`)},
		{OK: true, Data: json.RawMessage(`{"tasks":[]}`)},
		{OK: true, Data: json.RawMessage(`{"leave":[]}`)},
		{OK: true, Data: json.RawMessage(`{"conversations":[]}`)},
		{OK: true, Data: json.RawMessage(`{"tickets":[]}`)},
		{OK: true, Data: json.RawMessage(`{"entries":[]}`)},
	}}
	deps, _ := chatLoopTestDeps(&scriptedChatProvider{}, executor)
	deps.user.Permissions = map[string]bool{"*": true}
	deps.recentChanges = func(context.Context, *session.ResolvedUser, chatToolCall) (string, bool, string) {
		return `{"total":0,"recent":[]}`, true, ""
	}
	deps.approvalsInbox = func(context.Context, *session.ResolvedUser) (string, bool, string) {
		return `{"count":0,"approvals":[]}`, true, ""
	}
	deps.notificationsInbox = func(context.Context, *session.ResolvedUser) (string, bool, string) {
		return `{"unreadCount":0,"notifications":[]}`, true, ""
	}
	payload, ok, message := deps.dailyBrief(context.Background())
	if !ok {
		t.Fatalf("dailyBrief failed: %s", message)
	}
	var brief struct {
		Sections map[string]struct {
			OK    bool            `json:"ok"`
			Data  json.RawMessage `json:"data"`
			Error string          `json:"error"`
		} `json:"sections"`
	}
	if err := json.Unmarshal([]byte(payload), &brief); err != nil {
		t.Fatalf("brief payload: %v", err)
	}
	for _, section := range []string{"signals", "overview", "receivables", "payables", "stock", "tasks", "leave", "support", "tickets", "approvals", "notifications", "changes"} {
		got, exists := brief.Sections[section]
		if !exists || !got.OK {
			t.Fatalf("section %s missing or failed: %+v", section, got)
		}
	}
}

func TestCapabilityDiscoveryHonorsTheModuleSwitchboard(t *testing.T) {
	deps, _ := chatLoopTestDeps(&scriptedChatProvider{}, &scriptedChatExecutor{})
	deps.user.Permissions = map[string]bool{"*": true}
	deps.allowedModules = map[string]bool{"crm": true}
	result, ok, message := deps.searchCapabilities(chatToolCall{Name: "capability_search", Arguments: json.RawMessage(`{"query":"invoice"}`)})
	if !ok {
		t.Fatalf("search failed: %s", message)
	}
	var payload struct {
		Capabilities []struct {
			ID string `json:"id"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal([]byte(result), &payload); err != nil {
		t.Fatalf("search payload: %v", err)
	}
	for _, capability := range payload.Capabilities {
		if strings.HasPrefix(capability.ID, "accounting.") {
			t.Fatalf("disabled accounting module leaked into search: %+v", capability)
		}
	}
	invoke, _, _ := deps.invokeCapability(context.Background(), deps.user, chatToolCall{
		Name: "capability_invoke", Arguments: json.RawMessage(`{"capabilityId":"accounting.createInvoice","input":{}}`),
	}, 1, 0)
	if !strings.Contains(invoke, "module is disabled") {
		t.Fatalf("invoke=%s", invoke)
	}
}

func TestChatLoopInvokesDiscoveredCapabilityThroughTheExecutor(t *testing.T) {
	executor := &scriptedChatExecutor{results: []capability.Result{{OK: true, Data: json.RawMessage(`{"created":true}`)}}}
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call_1", Name: "capability_invoke", Arguments: json.RawMessage(`{"capabilityId":"accounting.createInvoice","input":{"customerId":"c","lines":[]}}`)}}},
		{message: "Invoice created."},
	}}
	deps, _ := chatLoopTestDeps(provider, executor)
	deps.user.Permissions = map[string]bool{"*": true}
	result, err := runChatSessionLoop(context.Background(), deps)
	if err != nil {
		t.Fatalf("run loop: %v", err)
	}
	if result.finalMessage != "Invoice created." {
		t.Fatalf("finalMessage=%q", result.finalMessage)
	}
	calls := executor.recorded()
	if len(calls) != 1 || calls[0].capabilityID != "accounting.createInvoice" {
		t.Fatalf("calls=%+v", calls)
	}
}

func TestChatToolFallbackMessageExplainsAnEmptyApprovalsInbox(t *testing.T) {
	got := chatToolFallbackMessage("approvals_inbox", `{"count":0,"approvals":[]}`, true)
	if !strings.Contains(got, "Nothing is waiting") {
		t.Fatalf("message=%q", got)
	}
}

func TestChatLoopRoutesApprovalsToTheInboxReader(t *testing.T) {
	executor := &scriptedChatExecutor{}
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call_1", Name: "approvals_inbox", Arguments: json.RawMessage(`{}`)}}},
		{message: "Nothing is waiting."},
	}}
	deps, events := chatLoopTestDeps(provider, executor)
	called := false
	deps.approvalsInbox = func(context.Context, *session.ResolvedUser) (string, bool, string) {
		called = true
		return `{"count":0,"approvals":[]}`, true, ""
	}
	result, err := runChatSessionLoop(context.Background(), deps)
	if err != nil {
		t.Fatalf("run loop: %v", err)
	}
	if !called || result.finalMessage != "Nothing is waiting." {
		t.Fatalf("called=%t finalMessage=%q", called, result.finalMessage)
	}
	if len(executor.recorded()) != 0 {
		t.Fatalf("approvals_inbox should not reach the capability executor: %+v", executor.recorded())
	}
	if len(*events) < 2 || (*events)[1].content["name"] != "approvals_inbox" {
		t.Fatalf("events=%+v", *events)
	}
}

func TestChatLoopRoutesNotificationsToTheInboxReader(t *testing.T) {
	executor := &scriptedChatExecutor{}
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call_1", Name: "notifications_inbox", Arguments: json.RawMessage(`{}`)}}},
		{message: "Two unread notifications."},
	}}
	deps, _ := chatLoopTestDeps(provider, executor)
	called := false
	deps.notificationsInbox = func(context.Context, *session.ResolvedUser) (string, bool, string) {
		called = true
		return `{"unreadCount":2,"notifications":[]}`, true, ""
	}
	result, err := runChatSessionLoop(context.Background(), deps)
	if err != nil {
		t.Fatalf("run loop: %v", err)
	}
	if !called || result.finalMessage != "Two unread notifications." {
		t.Fatalf("called=%t finalMessage=%q", called, result.finalMessage)
	}
	if len(executor.recorded()) != 0 {
		t.Fatalf("notifications_inbox should not reach the executor: %+v", executor.recorded())
	}
}

func TestChatLoopRoutesEntityResolutionBeforeAWrit(t *testing.T) {
	executor := &scriptedChatExecutor{}
	provider := &scriptedChatProvider{turns: []chatTurn{
		{toolCalls: []chatToolCall{{ID: "call_1", Name: "resolve_entity", Arguments: json.RawMessage(`{"type":"customer","query":"Acme"}`)}}},
		{message: "Found Acme."},
	}}
	deps, _ := chatLoopTestDeps(provider, executor)
	called := false
	deps.resolveEntity = func(context.Context, *session.ResolvedUser, chatToolCall) (string, bool, string) {
		called = true
		return `{"matches":[{"id":"c-1","name":"Acme"}]}`, true, ""
	}
	result, err := runChatSessionLoop(context.Background(), deps)
	if err != nil || !called || result.finalMessage != "Found Acme." {
		t.Fatalf("err=%v called=%t final=%q", err, called, result.finalMessage)
	}
	if len(executor.recorded()) != 0 {
		t.Fatalf("resolve_entity should not reach the capability executor: %+v", executor.recorded())
	}
}
