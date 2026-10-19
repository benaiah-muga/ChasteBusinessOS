package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestGoChatSessionIntegration proves the Go chat and steer routes against a
// migrated database: NDJSON framing, trajectories, token accounting (with
// cached input), governed tool receipts, steering injection, and org scoping.
func TestGoChatSessionIntegration(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for the Go chat integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for the Go chat integration proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := orgParityEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}
	fixture := seedOrgParityFixture(t, owner, secret)
	if _, err := owner.Exec(ctx, `
		INSERT INTO user_roles (user_id, role_id, org_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid)`,
		fixture.userID, seedRole(t, owner, fixture.orgA, "chat-integration-tools", "crm.read"), fixture.orgA); err != nil {
		t.Fatalf("grant crm.read in org A: %v", err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO user_roles (user_id, role_id, org_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid)`,
		fixture.userID, seedRole(t, owner, fixture.orgA, "chat-integration-support", "support.write"), fixture.orgA); err != nil {
		t.Fatalf("grant support.write in org A: %v", err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	executor := capability.NewExecutor(runtime, "", "", "")
	steering := newChatSteeringStore()
	config := &fakeChatConfigReader{config: myWorkSummaryConfig{provider: "openai-compat", baseURL: "https://provider.example.test/v1", apiKey: "key", primaryModel: "primary-model"}}
	handlerFor := func(provider chatProvider) (*chatSessionHandler, *chatSteerSessionHandler) {
		chat := &chatSessionHandler{
			resolver: resolver, executor: executor, config: config,
			store: newChatPostgresSessionStore(runtime), steering: steering,
			logger: logger, limiter: newChatRateLimiter(100),
			providerFor:   func(myWorkSummaryConfig) chatProvider { return provider },
			contextWindow: chatDefaultContextWindow,
			reserveTokens: chatDefaultReserveTokens,
		}
		steer := newChatSteerHandler(runtime, resolver, steering, logger, nil)
		return chat, steer
	}
	post := func(handler http.Handler, path, body, organizationID, sessionID string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "https://app.example.test"+path, strings.NewReader(body))
		request.TLS = &tls.ConnectionState{}
		request.Host = "app.example.test"
		request.Header.Set("Origin", "https://app.example.test")
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
		request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: organizationID})
		if sessionID != "" {
			request.Header.Set("X-Session-Id", sessionID)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}

	t.Run("tools, trajectory, usage, and receipt", func(t *testing.T) {
		provider := &scriptedChatProvider{turns: []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call_1", Name: "crm_listCustomers", Arguments: json.RawMessage(`{"query":"acme"}`)}}, usage: chatUsage{Input: 3, Output: 1, CachedInput: 2}},
			{message: "No customers match.", usage: chatUsage{Input: 9, Output: 4, CachedInput: 3}},
		}}
		chat, _ := handlerFor(provider)
		recorder := post(chat, "/api/chat", `{"message":"list customers"}`, fixture.orgA, "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		if got := recorder.Header().Get("Content-Type"); got != "application/x-ndjson; charset=utf-8" {
			t.Fatalf("Content-Type=%q", got)
		}
		sessionID := recorder.Header().Get("X-Session-Id")
		if !isUUID(sessionID) {
			t.Fatalf("X-Session-Id=%q", sessionID)
		}
		events := decodeChatNDJSON(t, recorder)
		if types := strings.Join(chatEventTypes(events), ","); types != "step,tool,tool_result,step,delta,done" {
			t.Fatalf("NDJSON types=%s", types)
		}
		done := events[len(events)-1]
		usage := done["usage"].(map[string]any)
		sessionUsage := usage["session"].(map[string]any)
		if sessionUsage["input"] != float64(12) || sessionUsage["output"] != float64(5) || sessionUsage["cachedInput"] != float64(5) {
			t.Fatalf("session usage=%v, want the cumulative row incl. cachedInput", sessionUsage)
		}
		if done["reply"] != "No customers match." {
			t.Fatalf("reply=%v", done["reply"])
		}
		var mode, modelRef, storedUserID string
		var rawUsage []byte
		if err := owner.QueryRow(ctx, `SELECT mode, model_ref, user_id::text, token_usage FROM agent_sessions WHERE id=$1::uuid`, sessionID).
			Scan(&mode, &modelRef, &storedUserID, &rawUsage); err != nil {
			t.Fatal(err)
		}
		if mode != "assist" || modelRef != "primary-model" || storedUserID != fixture.userID {
			t.Fatalf("session mode=%q modelRef=%q user=%q", mode, modelRef, storedUserID)
		}
		var storedUsage map[string]int64
		if err := json.Unmarshal(rawUsage, &storedUsage); err != nil || storedUsage["cachedInput"] != 5 {
			t.Fatalf("stored usage=%s err=%v", rawUsage, err)
		}
		// tool_call/tool_result/ask persist detached, so they can trail the
		// response by a few milliseconds; poll like the ask subtest does.
		eventsByRole := map[string]int{}
		trajectoryDeadline := time.Now().Add(2 * time.Second)
		for {
			eventsByRole = map[string]int{}
			rows, err := owner.Query(ctx, `SELECT role, count(*) FROM session_events WHERE session_id=$1::uuid GROUP BY role`, sessionID)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				var role string
				var count int
				if err := rows.Scan(&role, &count); err != nil {
					t.Fatal(err)
				}
				eventsByRole[role] = count
			}
			rows.Close()
			if eventsByRole["user"] == 1 && eventsByRole["tool_call"] == 1 && eventsByRole["tool_result"] == 1 && eventsByRole["assistant"] == 1 {
				break
			}
			if time.Now().After(trajectoryDeadline) {
				t.Fatalf("trajectory roles=%v", eventsByRole)
			}
			time.Sleep(10 * time.Millisecond)
		}
		var capabilityID string
		var receiptOK bool
		if err := owner.QueryRow(ctx, `SELECT capability_id, ok FROM action_receipts WHERE org_id=$1::uuid AND capability_id='crm.listCustomers' ORDER BY recorded_at DESC LIMIT 1`, fixture.orgA).
			Scan(&capabilityID, &receiptOK); err != nil {
			t.Fatalf("governed receipt: %v", err)
		}
		if capabilityID != "crm.listCustomers" || !receiptOK {
			t.Fatalf("receipt capability=%q ok=%t", capabilityID, receiptOK)
		}

		t.Run("steering drains into the next turn and the trajectory", func(t *testing.T) {
			steer := newChatSteerHandler(runtime, resolver, steering, logger, nil)
			queued := post(steer, "/api/chat/steer", `{"sessionId":"`+sessionID+`","message":"focus on overdue invoices"}`, fixture.orgA, "")
			if queued.Code != http.StatusOK || !strings.Contains(queued.Body.String(), `"queued":true`) {
				t.Fatalf("steer status=%d body=%s", queued.Code, queued.Body.String())
			}
			provider := &scriptedChatProvider{turns: []chatTurn{{message: "Steered."}}}
			chat, _ := handlerFor(provider)
			response := post(chat, "/api/chat", `{"message":"continue","sessionId":"`+sessionID+`"}`, fixture.orgA, "")
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			steered := false
			for _, message := range provider.callMessages(0) {
				if message.Content == "[steering] focus on overdue invoices" {
					steered = true
				}
			}
			if !steered {
				t.Fatalf("steering message not injected: %+v", provider.callMessages(0))
			}
			var steeringEvents int
			if err := owner.QueryRow(ctx, `SELECT count(*) FROM session_events WHERE session_id=$1::uuid AND role='user' AND content->>'steering'='true' AND content->>'text'='focus on overdue invoices'`, sessionID).Scan(&steeringEvents); err != nil {
				t.Fatal(err)
			}
			if steeringEvents != 1 {
				t.Fatalf("persisted steering events=%d", steeringEvents)
			}
			if drained := steering.drain(sessionID); len(drained) != 0 {
				t.Fatalf("steering queue not drained: %v", drained)
			}
		})

		t.Run("a second tool turn in the same session neither replays nor conflicts", func(t *testing.T) {
			provider := &scriptedChatProvider{turns: []chatTurn{
				{toolCalls: []chatToolCall{{ID: "call_2", Name: "crm_listCustomers", Arguments: json.RawMessage(`{"query":"beta"}`)}}, usage: chatUsage{Input: 2, Output: 1}},
				{message: "Beta has no customers either.", usage: chatUsage{Input: 4, Output: 2}},
			}}
			chat, _ := handlerFor(provider)
			response := post(chat, "/api/chat", `{"message":"now beta","sessionId":"`+sessionID+`"}`, fixture.orgA, "")
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			events := decodeChatNDJSON(t, response)
			if types := strings.Join(chatEventTypes(events), ","); types != "step,tool,tool_result,step,delta,done" {
				t.Fatalf("NDJSON types=%s", types)
			}
			if strings.Contains(response.Body.String(), "intent conflict") {
				t.Fatalf("second turn reused the first turn's intent: %s", response.Body.String())
			}
			var receipts int
			if err := owner.QueryRow(ctx, `SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND capability_id='crm.listCustomers' AND ok`, fixture.orgA).Scan(&receipts); err != nil {
				t.Fatal(err)
			}
			if receipts != 2 {
				t.Fatalf("crm.listCustomers receipts=%d, want 2 independent executions", receipts)
			}
		})

		t.Run("cross-organization session ids are not found", func(t *testing.T) {
			provider := &scriptedChatProvider{turns: []chatTurn{{message: "never"}}}
			chat, _ := handlerFor(provider)
			response := post(chat, "/api/chat", `{"message":"hijack","sessionId":"`+sessionID+`"}`, fixture.orgB, "")
			if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "session not found") {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if provider.callCount() != 0 {
				t.Fatal("foreign-org session request reached the provider")
			}
		})
	})

	t.Run("honesty path files a governed ticket", func(t *testing.T) {
		provider := &scriptedChatProvider{turns: []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call_1", Name: "file_ticket", Arguments: json.RawMessage(`{"title":"Missing export","description":"No capability exports ledgers."}`)}}},
			{message: "I filed a ticket."},
		}}
		chat, _ := handlerFor(provider)
		recorder := post(chat, "/api/chat", `{"message":"export the ledger"}`, fixture.orgA, "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		events := decodeChatNDJSON(t, recorder)
		if types := strings.Join(chatEventTypes(events), ","); types != "step,tool,step,delta,done" {
			t.Fatalf("NDJSON types=%s", types)
		}
		sessionID := recorder.Header().Get("X-Session-Id")
		var title, origin, storedSession string
		if err := owner.QueryRow(ctx, `SELECT title, origin, session_id::text FROM tickets WHERE org_id=$1::uuid ORDER BY created_at DESC LIMIT 1`, fixture.orgA).
			Scan(&title, &origin, &storedSession); err != nil {
			t.Fatalf("ticket row: %v", err)
		}
		if title != "Missing export" || origin != "capability_gap" || storedSession != sessionID {
			t.Fatalf("ticket title=%q origin=%q session=%q", title, origin, storedSession)
		}
		var capabilityID string
		if err := owner.QueryRow(ctx, `SELECT capability_id FROM action_receipts WHERE org_id=$1::uuid AND capability_id='support.createTicket' ORDER BY recorded_at DESC LIMIT 1`, fixture.orgA).Scan(&capabilityID); err != nil {
			t.Fatalf("ticket receipt: %v", err)
		}
		if capabilityID != "support.createTicket" {
			t.Fatalf("ticket receipt capability=%q", capabilityID)
		}
	})

	t.Run("clarification frames and persists once", func(t *testing.T) {
		provider := &scriptedChatProvider{turns: []chatTurn{
			{toolCalls: []chatToolCall{{ID: "call_9", Name: "ask_user", Arguments: json.RawMessage(`{"question":"Which account?","options":["Operating","Payroll"]}`)}}},
		}}
		chat, _ := handlerFor(provider)
		recorder := post(chat, "/api/chat", `{"message":"reconcile the account"}`, fixture.orgA, "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		events := decodeChatNDJSON(t, recorder)
		// The kernel treats a clarification as a terminal step (no further
		// model calls) but the route still closes with a done frame carrying
		// the (empty) final message, exactly like the legacy route.
		if types := strings.Join(chatEventTypes(events), ","); types != "step,tool,ask,done" {
			t.Fatalf("NDJSON types=%s", types)
		}
		ask := events[2]
		if ask["id"] != "call_9" || ask["question"] != "Which account?" || ask["allowOther"] != true {
			t.Fatalf("ask=%v", ask)
		}
		if reply, _ := events[3]["reply"].(string); reply != "" {
			t.Fatalf("done reply=%v, want empty after a clarification", events[3]["reply"])
		}
		if provider.callCount() != 1 {
			t.Fatalf("provider calls=%d, want one", provider.callCount())
		}
		sessionID := recorder.Header().Get("X-Session-Id")
		deadline := time.Now().Add(2 * time.Second)
		for {
			var asks int
			if err := owner.QueryRow(ctx, `SELECT count(*) FROM session_events WHERE session_id=$1::uuid AND role='ask'`, sessionID).Scan(&asks); err != nil {
				t.Fatal(err)
			}
			if asks == 1 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("ask event not persisted, count=%d", asks)
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
}
