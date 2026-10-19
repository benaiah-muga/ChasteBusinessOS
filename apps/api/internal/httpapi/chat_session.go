package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	chatMessageMaxUnits   = 8000
	chatSessionTitleUnits = 80
	chatBodyMaxBytes      = 64 << 10
	chatSoulMaxUnits      = 8000
	chatRateLimitWindow   = time.Minute
	chatRateLimitMaxKeys  = 50_000
)

const chatSystemPromptTemplate = `You are the ChasteBusinessOS assistant for "%s".
You operate an ERP through registered capabilities. Rules:
- Prefer tools over prose when the user wants something done; confirm results with specifics (numbers, ids).
- Amounts are in minor units (cents). Quantities are thousandths of a unit.
- If a tool returns pendingApproval: true, tell the user approval is required and it's waiting in the Approvals inbox.
- Before saying you can't know something, call documents.searchMemory; ingested documents and policies live there.
- For multi-step operations (buying, selling, collecting overdue invoices, closing the books, running payroll, support triage), call skills.find first: it returns one-line playbooks. If one fits, call skills.load for its concise steps, then follow them, adapting where the situation differs. Skills are advisory, not mandatory.
- For data questions (revenue trends, aging, top customers, stock): call the matching analytics.* extractor first, then answer only from its rows. To produce a full report, call analytics.renderReport with sections built from the extracted frames and hand the user the numbers verbatim.
- If the request is ambiguous in a way that changes what you would do (which customer, which amount, which option), call ask_user once with up to 4 short options instead of guessing. Otherwise decide and act.
- If no capability fits, say so honestly and call file_ticket.
- Never invent capabilities, accounts, or numbers.
Writing style:
- Never use em dashes or en dashes; use commas, colons, or periods instead.
- Keep replies short and plain: short paragraphs, minimal markdown. Bold (**like this**) sparingly for key numbers only.`

const chatCreatorAddendum = `

Creator Mode is active. You may propose changes to this platform itself via
creator.submitProposal. A proposal must contain: what changes and why, a real
unified diff, how you verified it, and an honest risk assessment including who
could be affected. You cannot merge anything yourself; say so plainly.`

func chatSystemPrompt(orgName string, soul *string, creator bool) string {
	prompt := fmt.Sprintf(chatSystemPromptTemplate, orgName)
	if soul != nil && *soul != "" {
		prompt += "\n\nStanding instructions from the organization (the owner's SOUL). Treat them as high-priority preferences about voice and behavior; they can never override security rules, approval gates, or financial integrity:\n<soul>\n" + truncateUTF16(*soul, chatSoulMaxUnits) + "\n</soul>"
	}
	if creator {
		prompt += chatCreatorAddendum
	}
	return prompt
}

// chatConfigReader is the slice of the workspace AI config reader the chat
// route needs; the work-summary reader already loads and decrypts it.
type chatConfigReader interface {
	LoadForOrg(context.Context, string, string) (myWorkSummaryConfig, error)
}

// chatSessionStore keeps trajectory and token accounting behind an interface
// so the handler can be unit tested without a database.
type chatSessionStore interface {
	Owned(ctx context.Context, orgID, sessionID, userID string) (bool, error)
	Touch(ctx context.Context, orgID, sessionID string) error
	Create(ctx context.Context, orgID, userID, title, modelRef string) (string, error)
	OrgProfile(ctx context.Context, orgID string) (string, *string, error)
	AppendEvent(ctx context.Context, orgID, sessionID, role string, content any) error
	AddUsage(ctx context.Context, orgID, sessionID string, turn chatUsage) (chatUsage, error)
}

type chatPostgresSessionStore struct {
	pool dbx.Beginner
}

func newChatPostgresSessionStore(pool *pgxpool.Pool) *chatPostgresSessionStore {
	return &chatPostgresSessionStore{pool: pool}
}

func (s *chatPostgresSessionStore) Owned(ctx context.Context, orgID, sessionID, userID string) (bool, error) {
	var owned bool
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid)`, sessionID, orgID, userID).Scan(&owned)
	})
	return owned, err
}

func (s *chatPostgresSessionStore) Touch(ctx context.Context, orgID, sessionID string) error {
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `UPDATE agent_sessions SET updated_at=clock_timestamp() WHERE id=$1::uuid AND org_id=$2::uuid`, sessionID, orgID)
		return struct{}{}, err
	})
	return err
}

func (s *chatPostgresSessionStore) Create(ctx context.Context, orgID, userID, title, modelRef string) (string, error) {
	var sessionID string
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `INSERT INTO agent_sessions (org_id,user_id,title,mode,model_ref) VALUES ($1::uuid,$2::uuid,$3,'assist',$4) RETURNING id::text`, orgID, userID, title, modelRef).Scan(&sessionID)
	})
	return sessionID, err
}

func (s *chatPostgresSessionStore) OrgProfile(ctx context.Context, orgID string) (string, *string, error) {
	var name string
	var soul *string
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `SELECT name, agent_soul FROM organizations WHERE id=$1::uuid`, orgID).Scan(&name, &soul)
	})
	return name, soul, err
}

// AppendEvent serializes sequence allocation by locking the parent session
// row, mirroring the TypeScript appends so mixed writers cannot collide.
func (s *chatPostgresSessionStore) AppendEvent(ctx context.Context, orgID, sessionID, role string, content any) error {
	encoded, err := json.Marshal(content)
	if err != nil {
		return err
	}
	_, err = dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM agent_sessions WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE`, sessionID, orgID).Scan(&locked); err != nil {
			return struct{}{}, err
		}
		_, err := tx.Exec(ctx, `INSERT INTO session_events (session_id,seq,role,content) SELECT $1::uuid,COALESCE(MAX(seq),0)+1,$2,$3::jsonb FROM session_events WHERE session_id=$1::uuid`, sessionID, role, string(encoded))
		return struct{}{}, err
	})
	return err
}

// AddUsage accumulates input, output, and cached prompt tokens atomically and
// returns the fresh cumulative row, matching the route's done payload.
func (s *chatPostgresSessionStore) AddUsage(ctx context.Context, orgID, sessionID string, turn chatUsage) (chatUsage, error) {
	cumulative := turn
	cumulative.CachedInput = 0
	_, err := dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		if _, err := tx.Exec(ctx, `UPDATE agent_sessions SET token_usage=jsonb_build_object('input',COALESCE((token_usage->>'input')::bigint,0)+$2,'output',COALESCE((token_usage->>'output')::bigint,0)+$3,'cachedInput',COALESCE((token_usage->>'cachedInput')::bigint,0)+$4),updated_at=clock_timestamp() WHERE id=$1::uuid AND org_id=$5::uuid`, sessionID, turn.Input, turn.Output, turn.CachedInput, orgID); err != nil {
			return struct{}{}, err
		}
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT token_usage FROM agent_sessions WHERE id=$1::uuid AND org_id=$2::uuid`, sessionID, orgID).Scan(&raw); err != nil {
			return struct{}{}, err
		}
		var stored chatUsage
		if err := json.Unmarshal(raw, &stored); err == nil {
			cumulative = stored
		}
		return struct{}{}, nil
	})
	return cumulative, err
}

type chatRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]chatRateBucket
	max     int
	window  time.Duration
	now     func() time.Time
}

type chatRateBucket struct {
	count   int
	resetAt time.Time
}

func newChatRateLimiter(max int) *chatRateLimiter {
	return &chatRateLimiter{buckets: make(map[string]chatRateBucket), max: max, window: chatRateLimitWindow, now: time.Now}
}

// allow records one hit and reports whether the caller may proceed. Fixed
// windows trade a small burst factor at boundaries for O(1) memory.
func (l *chatRateLimiter) allow(key string) (bool, int) {
	if l == nil {
		return true, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	bucket, exists := l.buckets[key]
	if !exists || !bucket.resetAt.After(now) {
		if len(l.buckets) > chatRateLimitMaxKeys {
			for tracked, state := range l.buckets {
				if !state.resetAt.After(now) {
					delete(l.buckets, tracked)
				}
				if len(l.buckets) <= chatRateLimitMaxKeys/2 {
					break
				}
			}
		}
		bucket = chatRateBucket{resetAt: now.Add(l.window)}
	}
	bucket.count++
	l.buckets[key] = bucket
	if bucket.count > l.max {
		retryAfter := int((bucket.resetAt.Sub(now) + time.Second - 1) / time.Second)
		if retryAfter < 1 {
			retryAfter = 1
		}
		return false, retryAfter
	}
	return true, 0
}

type chatSessionRequestBody struct {
	Message   string          `json:"message"`
	SessionID json.RawMessage `json:"sessionId"`
	Mode      json.RawMessage `json:"mode"`
}

type chatSessionRequest struct {
	message   string
	sessionID *string
	mode      string
}

// decodeChatSessionRequest mirrors the zod schema: strict object, message of
// 1 to 8000 UTF-16 units, optional uuid sessionId, optional assist|creator.
func decodeChatSessionRequest(response http.ResponseWriter, request *http.Request) (chatSessionRequest, bool) {
	request.Body = http.MaxBytesReader(response, request.Body, chatBodyMaxBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var body chatSessionRequestBody
	if err := decoder.Decode(&body); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return chatSessionRequest{}, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return chatSessionRequest{}, false
	}
	if utf16Length(body.Message) < 1 || utf16Length(body.Message) > chatMessageMaxUnits {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return chatSessionRequest{}, false
	}
	var parsed chatSessionRequest
	parsed.message = body.Message
	if len(body.SessionID) > 0 {
		var value string
		if json.Unmarshal(body.SessionID, &value) != nil || !isUUID(value) {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return chatSessionRequest{}, false
		}
		value = strings.ToLower(value)
		parsed.sessionID = &value
	}
	parsed.mode = "assist"
	if len(body.Mode) > 0 {
		var value string
		if json.Unmarshal(body.Mode, &value) != nil || (value != "assist" && value != "creator") {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return chatSessionRequest{}, false
		}
		parsed.mode = value
	}
	return parsed, true
}

type chatSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	config            chatConfigReader
	store             chatSessionStore
	steering          *chatSteeringStore
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
	limiter           *chatRateLimiter
	providerFor       func(myWorkSummaryConfig) chatProvider
	contextWindow     int
	reserveTokens     int
}

func newChatSessionHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, config chatConfigReader, steering *chatSteeringStore, logger *slog.Logger, trustedProxyCIDRs []*net.IPNet) *chatSessionHandler {
	if config == nil {
		config = NewMyWorkSummaryPostgresReader(pool)
	}
	if steering == nil {
		steering = newChatSteeringStore()
	}
	limitMax := 12
	// Zero is a valid configured value (deny every request), matching the
	// legacy Number() semantics; only unparseable values fall back to 12.
	if configured, err := strconv.Atoi(envOr("CHAT_RATE_LIMIT_MAX", "12")); err == nil && configured >= 0 {
		limitMax = configured
	}
	return &chatSessionHandler{
		resolver:          resolver,
		executor:          executor,
		config:            config,
		store:             newChatPostgresSessionStore(pool),
		steering:          steering,
		logger:            logger,
		trustedProxyCIDRs: trustedProxyCIDRs,
		limiter:           newChatRateLimiter(limitMax),
		providerFor: func(config myWorkSummaryConfig) chatProvider {
			return newOpenAIChatProvider(config)
		},
		contextWindow: chatContextWindowFromEnv(),
		reserveTokens: chatDefaultReserveTokens,
	}
}

// NewGoChatHandlers builds the chat and steer handlers that share one
// steering queue, ready for MountGoChatRoute.
func NewGoChatHandlers(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...*net.IPNet) (http.Handler, http.Handler) {
	steering := newChatSteeringStore()
	chat := newChatSessionHandler(pool, resolver, executor, nil, steering, logger, trustedProxyCIDRs)
	steer := newChatSteerHandler(pool, resolver, steering, logger, trustedProxyCIDRs)
	return chat, steer
}

func chatContextWindowFromEnv() int {
	if configured, err := strconv.Atoi(envOr("MODEL_CONTEXT_WINDOW", "")); err == nil && configured > 0 {
		return configured
	}
	return chatDefaultContextWindow
}

func newChatTurnID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

func (h *chatSessionHandler) logError(message, sessionID string, err error) {
	if h.logger == nil {
		return
	}
	h.logger.Error(message, "sessionId", sessionID, "error", err)
}

func (h *chatSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil || h.config == nil || h.store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "chat service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, h.resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.AuthSessionID == "" || !isUUID(resolved.UserID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if resolved.OrgID == nil {
		writeJSON(w, http.StatusPreconditionRequired, map[string]string{"error": "onboarding required"})
		return
	}
	if !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if r.Header.Get("Authorization") == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if allowed, retryAfter := h.limiter.allow("chat:" + resolved.UserID); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	body, ok := decodeChatSessionRequest(w, r)
	if !ok {
		return
	}
	config, err := h.config.LoadForOrg(r.Context(), *resolved.OrgID, resolved.UserID)
	if err != nil {
		h.logError("Go chat could not load the workspace AI configuration", "", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	provider := h.providerFor(config)

	modelRef := strings.TrimSpace(config.primaryModel)
	if config.codingAgent != nil {
		modelRef = config.codingAgent.provider + ":plan-default"
		if config.codingAgent.modelID != "" {
			modelRef = config.codingAgent.provider + ":" + config.codingAgent.modelID
		}
	}

	sessionID := ""
	if body.sessionID != nil {
		sessionID = *body.sessionID
		owned, ownErr := h.store.Owned(r.Context(), *resolved.OrgID, sessionID, resolved.UserID)
		if ownErr != nil {
			h.logError("Go chat could not verify session ownership", sessionID, ownErr)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		if !owned {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
			return
		}
		if err := h.store.Touch(r.Context(), *resolved.OrgID, sessionID); err != nil {
			h.logError("Go chat could not update the session timestamp", sessionID, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
	} else {
		created, createErr := h.store.Create(r.Context(), *resolved.OrgID, resolved.UserID, truncateUTF16(body.message, chatSessionTitleUnits), modelRef)
		if createErr != nil {
			h.logError("Go chat could not create an agent session", "", createErr)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		sessionID = created
	}

	orgName, soul, err := h.store.OrgProfile(r.Context(), *resolved.OrgID)
	if err != nil {
		h.logError("Go chat could not load the organization profile", sessionID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	tools, capabilityByToolName, err := buildChatTools(capability.AgentTools(resolved.Permissions), chatAllowedModules(resolved))
	if err != nil {
		h.logError("Go chat could not present capability tools", sessionID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if err := h.store.AppendEvent(r.Context(), *resolved.OrgID, sessionID, "user", map[string]any{"text": body.message}); err != nil {
		h.logError("Go chat failed to persist the user event", sessionID, err)
	}

	writer := newChatNDJSONWriter(w, sessionID)
	wantsCreator := body.mode == "creator"
	if wantsCreator && !resolved.HasPermission("platform.creator") {
		writer.write(map[string]any{"type": "error", "error": "your role does not include platform.creator"})
		return
	}
	// The coding-agent bridge (OpenCode/Codex connections) is not ported yet;
	// failing honestly beats billing a coding plan through the API-key path.
	if config.codingAgent != nil {
		writer.write(map[string]any{"type": "error", "error": "the selected coding-agent connection is not supported on the Go chat route yet"})
		return
	}

	turnID, turnIDErr := newChatTurnID()
	if turnIDErr != nil {
		// Never reuse an empty turn id: it would make this turn's tool intents
		// collide with a previous turn's receipts.
		turnID = fmt.Sprintf("t%d", time.Now().UnixNano())
		h.logError("Go chat failed to generate a turn id", sessionID, turnIDErr)
	}
	result, err := runChatSessionLoop(r.Context(), chatLoopDeps{
		provider:             provider,
		executor:             h.executor,
		user:                 resolved,
		orgID:                *resolved.OrgID,
		sessionID:            sessionID,
		turnID:               turnID,
		systemPrompt:         chatSystemPrompt(orgName, soul, wantsCreator),
		userGoal:             body.message,
		maxSteps:             chatDefaultMaxSteps,
		contextWindow:        h.contextWindow,
		reserveTokens:        h.reserveTokens,
		tools:                tools,
		capabilityByToolName: capabilityByToolName,
		enableTickets:        true,
		enableAsk:            true,
		drainSteering: func(ctx context.Context) []string {
			queued := h.steering.drain(sessionID)
			for _, text := range queued {
				trimmed := strings.TrimSpace(text)
				if trimmed == "" {
					continue
				}
				if err := h.store.AppendEvent(ctx, *resolved.OrgID, sessionID, "user", map[string]any{"text": trimmed, "steering": true}); err != nil {
					h.logError("Go chat failed to persist a steering event", sessionID, err)
				}
			}
			return queued
		},
		onDelta: func(text string) {
			writer.write(map[string]any{"type": "delta", "text": text})
		},
		onEvent: func(role string, content map[string]any) {
			h.handleChatLoopEvent(writer, *resolved.OrgID, sessionID, role, content)
		},
	})
	if err != nil {
		if r.Context().Err() != nil {
			stopCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			if stopErr := h.store.AppendEvent(stopCtx, *resolved.OrgID, sessionID, "assistant", map[string]any{"text": "", "stopped": true}); stopErr != nil {
				h.logError("Go chat failed to persist the stop marker", sessionID, stopErr)
			}
			cancel()
			writer.write(map[string]any{"type": "stopped", "sessionId": sessionID})
			return
		}
		h.logError("Go chat agent loop failed", sessionID, err)
		writer.write(map[string]any{"type": "error", "error": chatLoopErrorMessage(err)})
		return
	}
	if err := h.store.AppendEvent(r.Context(), *resolved.OrgID, sessionID, "assistant", map[string]any{"text": result.finalMessage}); err != nil {
		h.logError("Go chat failed to persist the assistant event", sessionID, err)
	}
	cumulative, err := h.store.AddUsage(r.Context(), *resolved.OrgID, sessionID, result.usage)
	if err != nil {
		h.logError("Go chat failed to record token usage", sessionID, err)
		writer.write(map[string]any{"type": "error", "error": "chat request failed"})
		return
	}
	writer.write(map[string]any{
		"type": "done", "sessionId": sessionID, "reply": result.finalMessage,
		"usage": map[string]any{"turn": result.usage, "session": cumulative},
	})
}

// handleChatLoopEvent maps kernel loop events onto the NDJSON protocol and the
// trajectory. Persistence is detached so a client disconnect cannot drop the
// audit trail; failures are logged, never silently swallowed.
func (h *chatSessionHandler) handleChatLoopEvent(writer *chatNDJSONWriter, orgID, sessionID, role string, content map[string]any) {
	switch role {
	case "step":
		writer.write(map[string]any{"type": "step", "step": content["step"], "maxSteps": content["maxSteps"]})
	case "compaction":
		writer.write(map[string]any{"type": "compaction", "compactedToMessages": content["compactedToMessages"]})
	case "tool_call":
		writer.write(map[string]any{"type": "tool", "name": content["name"]})
		h.persistChatEventDetached(orgID, sessionID, role, content)
	case "tool_result":
		frame := map[string]any{"type": "tool_result", "name": content["name"], "ok": content["ok"]}
		for _, key := range []string{"capabilityId", "pendingApproval", "approvalId", "approvalRationale", "error"} {
			if value, exists := content[key]; exists {
				frame[key] = value
			}
		}
		writer.write(frame)
		h.persistChatEventDetached(orgID, sessionID, role, content)
	case "ask":
		event := map[string]any{"type": "ask"}
		for key, value := range content {
			event[key] = value
		}
		writer.write(event)
		h.persistChatEventDetached(orgID, sessionID, role, content)
	}
}

func (h *chatSessionHandler) persistChatEventDetached(orgID, sessionID, role string, content map[string]any) {
	if h.store == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := h.store.AppendEvent(ctx, orgID, sessionID, role, content); err != nil {
			h.logError("Go chat failed to persist a trajectory event", sessionID, err)
		}
	}()
}

func chatLoopErrorMessage(err error) string {
	var providerErr chatProviderError
	if errors.As(err, &providerErr) {
		return providerErr.Error()
	}
	return "chat request failed"
}

var chatAlwaysEnabledModules = map[string]bool{"settings": true, "iam": true, "signals": true, "routines": true}

// chatAllowedModules mirrors the executor's module gate: no saved list means
// every module is enabled; a saved list narrows to it plus the never-off spine.
func chatAllowedModules(user *session.ResolvedUser) map[string]bool {
	if user == nil || !user.ModulesRestricted {
		return nil
	}
	allowed := make(map[string]bool, len(user.EnabledModules)+len(chatAlwaysEnabledModules))
	for _, module := range user.EnabledModules {
		allowed[module] = true
	}
	for module := range chatAlwaysEnabledModules {
		allowed[module] = true
	}
	return allowed
}

// chatToolName mirrors the kernel's OpenAI function-name sanitization; some
// providers reject dots in function names.
func chatToolName(capabilityID string) string {
	var builder strings.Builder
	builder.Grow(len(capabilityID))
	for _, char := range capabilityID {
		switch {
		case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z', char >= '0' && char <= '9', char == '_', char == '-':
			builder.WriteRune(char)
		default:
			builder.WriteByte('_')
		}
	}
	return builder.String()
}

func buildChatTools(agentTools []capability.AgentToolSpec, allowedModules map[string]bool) ([]chatToolSpec, map[string]capability.AgentToolSpec, error) {
	tools := make([]chatToolSpec, 0, len(agentTools)+2)
	byName := make(map[string]capability.AgentToolSpec, len(agentTools))
	for _, tool := range agentTools {
		module, _, _ := strings.Cut(tool.ID, ".")
		if allowedModules != nil && !allowedModules[module] {
			continue
		}
		name := chatToolName(tool.ID)
		if name == "file_ticket" || name == "ask_user" {
			return nil, nil, fmt.Errorf("capability %q collides with a built-in chat tool after name sanitization", tool.ID)
		}
		if _, exists := byName[name]; exists {
			return nil, nil, fmt.Errorf("tool name collision after sanitization: %q", tool.ID)
		}
		byName[name] = tool
		tools = append(tools, chatToolSpec{Name: name, Description: tool.Description, Parameters: chatToolParameters(tool.InputSchema)})
	}
	tools = append(tools, chatFileTicketToolSpec(), chatAskUserToolSpec())
	return tools, byName, nil
}

func chatToolParameters(schema json.RawMessage) json.RawMessage {
	if len(schema) == 0 {
		return json.RawMessage(`{"type":"object","properties":{}}`)
	}
	return schema
}

func chatFileTicketToolSpec() chatToolSpec {
	return chatToolSpec{
		Name:        "file_ticket",
		Description: "File a ticket for a missing capability or blocked goal. Use when no available capability fits.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"}},"required":["title","description"]}`),
	}
}

func chatAskUserToolSpec() chatToolSpec {
	return chatToolSpec{
		Name:        "ask_user",
		Description: "Ask the user one clarifying question with short answer options. Use only when the ambiguity changes what you would do; otherwise decide and act. Ends your turn; the answer arrives as the user's next message.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"question":{"type":"string","description":"One concrete question."},"options":{"type":"array","items":{"type":"string"},"description":"Up to 5 short, distinct answer options."},"allowOther":{"type":"boolean","description":"Whether free text is also accepted."}},"required":["question"]}`),
	}
}
