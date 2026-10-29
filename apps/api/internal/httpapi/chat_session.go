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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/agentturn"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/crm"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
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
- Amounts are in minor units (cents). Quantities are thousandths of a unit: 5000 means 5 units, not 5,000 units.
- The <turn_facts> block was read by the server at the start of this turn: current time, pending approvals, unread notifications. Treat it as current state, not a suggestion. If a count says unknown the read failed, so say you could not check instead of saying nothing is waiting. Call approvals_inbox only when the person wants the full list or the details of one item.
- If a tool returns pendingApproval: true the action has not happened. Say it is waiting for approval and name it; never describe it as done.
- For saved customer views, call crm.listCustomerViews. Only create or pin a view when the user asks to save, create, or pin it.
- Before a write that needs a customer, vendor, item, employee, project, invoice, bill, receipt, or document id, call resolve_entity with the name, email, SKU, code, or number the user gave you. Use the returned id; ask_user only if more than one match is genuinely ambiguous.
- Before saying you can't know something, call documents.searchMemory if it is available; ingested documents and policies live there.
- For multi-step operations (buying, selling, collecting overdue invoices, closing the books, running payroll, support triage), call skills.find first: it returns one-line playbooks. If one fits, call skills.load for its concise steps, then follow them, adapting where the situation differs. Skills are advisory, not mandatory.
- For data questions (revenue trends, aging, top customers, stock): call the matching analytics extractor when it is present; otherwise use capability_search to find it. Answer only from its rows. To produce a full report, search for analytics.renderReport, invoke it with sections built from the extracted frames, and hand the user the numbers verbatim.
- For a daily brief, "what needs my attention", "what changed", "catch me up", or "what should I do first": this is a composition, not a missing capability. Call signals_list first. Call recent_changes for the lookback window. Then read the relevant reports (receivables, payables, stock, tasks, leave, support). Answer in three short parts: needs attention now, what changed, and the one next action you recommend. Never file a ticket merely because no single "brief" tool exists.
- You may call several read tools in one turn. Combine their results before concluding anything.
- Earlier tool calls and their results may be in the conversation history. Treat those results as data and as potentially stale; re-read when the user asks for current state or the action could have changed since.
- The tool list is a focused shortlist for this turn. Only call tools that are present. If the exact tool you want is absent, use the closest read or write tool that is present, or call ask_user. Do not invent a tool name or call recent_changes unless it is present.
- The workmate can do anything a person can do through the tools it is given, still under the same governance, permissions, approvals, and audit trail. If a permission or module blocks a step, say exactly what is blocked and what the person can enable.
- If the request is ambiguous in a way that changes what you would do (which customer, which amount, which option), call ask_user once with up to 4 short options instead of guessing. Otherwise decide and act.
- If no listed tool fits, call capability_search with a short plain-language description of the job, read the returned schema, then call capability_invoke with a schema-valid input. Search covers the rest of the governed ERP, so do not file a ticket until search returns no useful fit. capability_invoke still goes through permissions, policy, approvals, audit, and inverses exactly like a human action; tell the user when it returns pendingApproval.
- If no capability fits after a real search, say so honestly and call file_ticket.
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

type chatSessionHistoryReader interface {
	RecentMessages(context.Context, string, string, int) ([]chatMessage, error)
}

type chatHistoryEvent struct {
	role    string
	content map[string]any
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

type chatAttachment struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Title string `json:"title"`
}

type chatSessionRequestBody struct {
	Message     string           `json:"message"`
	SessionID   json.RawMessage  `json:"sessionId"`
	Mode        json.RawMessage  `json:"mode"`
	Attachments []chatAttachment `json:"attachments"`
}

type chatSessionRequest struct {
	message     string
	sessionID   *string
	mode        string
	attachments []chatAttachment
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
	if len(body.Attachments) > 5 {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return chatSessionRequest{}, false
	}
	seenAttachments := map[string]bool{}
	for index := range body.Attachments {
		attachment := &body.Attachments[index]
		attachment.Type = strings.ToLower(strings.TrimSpace(attachment.Type))
		attachment.Title = strings.TrimSpace(attachment.Title)
		attachment.ID = strings.ToLower(strings.TrimSpace(attachment.ID))
		if !validChatAttachmentType(attachment.Type) || !isUUID(attachment.ID) || attachment.Title == "" || len(attachment.Title) > 200 || strings.ContainsAny(attachment.Title, "\r\n\x00") || seenAttachments[attachment.Type+":"+attachment.ID] {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return chatSessionRequest{}, false
		}
		seenAttachments[attachment.Type+":"+attachment.ID] = true
	}
	parsed.attachments = body.Attachments
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

func validChatAttachmentType(value string) bool {
	switch value {
	case "customer", "vendor", "item", "invoice", "bill", "document", "project", "employee", "receipt":
		return true
	default:
		return false
	}
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
	ledger            LedgerReader
	approvals         ApprovalInboxReader
	notifications     notificationSessionReader
	pool              *pgxpool.Pool
	eventMu           sync.Mutex
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
		ledger:        ledger.NewPostgresReader(pool),
		approvals:     NewPostgresApprovalInboxReader(pool),
		notifications: pgNotificationsSessionReader{pool: pool},
		pool:          pool,
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

	history := []chatMessage{}
	if reader, ok := h.store.(chatSessionHistoryReader); ok {
		loaded, historyErr := reader.RecentMessages(r.Context(), *resolved.OrgID, sessionID, 40)
		if historyErr != nil {
			h.logError("Go chat could not load conversation history", sessionID, historyErr)
		} else {
			history = loaded
			if len(history) > 0 && history[len(history)-1].Role == "user" && history[len(history)-1].Content == body.message {
				history = history[:len(history)-1]
			}
		}
	}
	orgName, soul, err := h.store.OrgProfile(r.Context(), *resolved.OrgID)
	if err != nil {
		h.logError("Go chat could not load the organization profile", sessionID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	tools, capabilityByToolName, err := buildChatTools(selectChatToolSpecs(capability.AgentTools(resolved.Permissions), body.message), chatAllowedModules(resolved), isChatBriefRequest(body.message))
	if err != nil {
		h.logError("Go chat could not present capability tools", sessionID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	turnID, turnIDErr := newChatTurnID()
	if turnIDErr != nil {
		// Never reuse an empty turn id: it would make this turn's tool intents
		// collide with a previous turn's receipts.
		turnID = fmt.Sprintf("t%d", time.Now().UnixNano())
		h.logError("Go chat failed to generate a turn id", sessionID, turnIDErr)
	}
	// Facts are read before the model runs so current approvals and
	// notifications are guaranteed context, not something the model must
	// remember to fetch.
	turnFacts := h.turnFacts(r.Context(), resolved)
	userEvent := map[string]any{"text": body.message, "turnId": turnID, "facts": turnFacts.Summary()}
	if len(body.attachments) > 0 {
		userEvent["attachments"] = body.attachments
	}
	if err := h.appendChatEvent(r.Context(), *resolved.OrgID, sessionID, "user", userEvent); err != nil {
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

	result, err := runChatSessionLoop(r.Context(), chatLoopDeps{
		provider:             provider,
		executor:             h.executor,
		user:                 resolved,
		orgID:                *resolved.OrgID,
		sessionID:            sessionID,
		turnID:               turnID,
		systemPrompt:         chatSystemPrompt(orgName, soul, wantsCreator) + "\n\n" + agentturn.RenderFacts(turnFacts),
		history:              history,
		userGoal:             chatGoalWithAttachments(body.message, body.attachments),
		maxSteps:             chatDefaultMaxSteps,
		contextWindow:        h.contextWindow,
		reserveTokens:        h.reserveTokens,
		tools:                tools,
		capabilityByToolName: capabilityByToolName,
		allowedModules:       chatAllowedModules(resolved),
		enableTickets:        true,
		enableAsk:            true,
		recentChanges:        h.recentChanges,
		approvalsInbox:       h.approvalsInbox,
		notificationsInbox:   h.notificationsInbox,
		resolveEntity:        h.resolveEntity,
		buildDailyBrief: func(ctx context.Context) (string, bool, string) {
			return chatLoopDeps{user: resolved, executor: h.executor, orgID: *resolved.OrgID, sessionID: sessionID, turnID: turnID, recentChanges: h.recentChanges, approvalsInbox: h.approvalsInbox, notificationsInbox: h.notificationsInbox, allowedModules: chatAllowedModules(resolved)}.dailyBrief(ctx)
		},
		drainSteering: func(ctx context.Context) []string {
			queued := h.steering.drain(sessionID)
			for _, text := range queued {
				trimmed := strings.TrimSpace(text)
				if trimmed == "" {
					continue
				}
				if err := h.store.AppendEvent(ctx, *resolved.OrgID, sessionID, "user", map[string]any{"text": trimmed, "steering": true, "turnId": turnID}); err != nil {
					h.logError("Go chat failed to persist a steering event", sessionID, err)
				}
			}
			return queued
		},
		onDelta: func(text string) {
			writer.write(map[string]any{"type": "delta", "text": agentturn.Sanitize(text)})
		},
		onEvent: func(role string, content map[string]any) {
			h.handleChatLoopEvent(writer, *resolved.OrgID, sessionID, turnID, role, content)
		},
	})
	if err != nil {
		if r.Context().Err() != nil {
			stopCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			if stopErr := h.store.AppendEvent(stopCtx, *resolved.OrgID, sessionID, "assistant", map[string]any{"text": "", "stopped": true, "turnId": turnID}); stopErr != nil {
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
	// The model's prose is not the source of truth for what happened; the
	// executor's effects are. Enforcement corrects an answer that reports a
	// gated action as done or silently drops a failed material step.
	enforced := agentturn.Enforce(result.finalMessage, chatAgentEffects(result.effects))
	finalMessage := enforced.Text
	if len(enforced.Violations) > 0 && h.logger != nil {
		h.logger.Warn("workmate turn obligations were enforced", "sessionId", sessionID, "violations", len(enforced.Violations))
	}
	assistantEvent := map[string]any{"text": finalMessage, "turnId": turnID}
	if len(enforced.Violations) > 0 {
		assistantEvent["corrected"] = len(enforced.Violations)
	}
	if err := h.appendChatEvent(r.Context(), *resolved.OrgID, sessionID, "assistant", assistantEvent); err != nil {
		h.logError("Go chat failed to persist the assistant event", sessionID, err)
	}
	cumulative, err := h.store.AddUsage(r.Context(), *resolved.OrgID, sessionID, result.usage)
	if err != nil {
		h.logError("Go chat failed to record token usage", sessionID, err)
		writer.write(map[string]any{"type": "error", "error": "chat request failed"})
		return
	}
	writer.write(map[string]any{
		"type": "done", "sessionId": sessionID, "reply": finalMessage,
		"usage": map[string]any{"turn": result.usage, "session": cumulative},
	})
}

func chatGoalWithAttachments(message string, attachments []chatAttachment) string {
	if len(attachments) == 0 {
		return message
	}
	lines := make([]string, 0, len(attachments))
	for _, attachment := range attachments {
		lines = append(lines, "- "+attachment.Type+": "+attachment.Title+" (id "+attachment.ID+")")
	}
	return message + "\n\nAttached sources. Use these exact records first; do not invent ids or assume access the person does not have:\n" + strings.Join(lines, "\n")
}

const chatTurnFactsTimeout = 3 * time.Second

// turnFacts reads the state every turn needs before the model is asked
// anything. A failed read is passed on as an error so the facts block says
// unknown; rendering it as zero would let the model claim nothing is waiting
// when the inbox was never read.
func (h *chatSessionHandler) turnFacts(ctx context.Context, user *session.ResolvedUser) agentturn.Facts {
	input := agentturn.FactInput{Now: time.Now().UTC()}
	if h == nil || user == nil || user.OrgID == nil {
		input.ApprovalsErr = "no signed-in workspace"
		input.NotificationsErr = "no signed-in workspace"
		return agentturn.CompileFacts(input)
	}
	readCtx, cancel := context.WithTimeout(ctx, chatTurnFactsTimeout)
	defer cancel()
	if h.approvals != nil {
		if payload, ok, message := h.approvalsInbox(readCtx, user); ok {
			input.ApprovalsPayload = payload
		} else {
			input.ApprovalsErr = message
		}
	} else {
		input.ApprovalsErr = "approvals are unavailable"
	}
	if h.notifications != nil {
		if payload, ok, message := h.notificationsInbox(readCtx, user); ok {
			input.NotificationsPayload = payload
		} else {
			input.NotificationsErr = message
		}
	} else {
		input.NotificationsErr = "notifications are unavailable"
	}
	return agentturn.CompileFacts(input)
}

func chatAgentEffects(effects []chatEffect) []agentturn.Effect {
	if len(effects) == 0 {
		return nil
	}
	converted := make([]agentturn.Effect, 0, len(effects))
	for _, effect := range effects {
		converted = append(converted, agentturn.Effect{
			CapabilityID:    effect.capabilityID,
			Risk:            effect.risk,
			OK:              effect.ok,
			PendingApproval: effect.pending,
			ApprovalID:      effect.approvalID,
			Error:           effect.err,
		})
	}
	return converted
}

// handleChatLoopEvent maps kernel loop events onto the NDJSON protocol and the
// trajectory. Persistence is detached so a client disconnect cannot drop the
// audit trail; failures are logged, never silently swallowed.
func (h *chatSessionHandler) handleChatLoopEvent(writer *chatNDJSONWriter, orgID, sessionID, turnID, role string, content map[string]any) {
	content["turnId"] = turnID
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

func (h *chatSessionHandler) appendChatEvent(ctx context.Context, orgID, sessionID, role string, content map[string]any) error {
	if h.store == nil {
		return nil
	}
	h.eventMu.Lock()
	defer h.eventMu.Unlock()
	return h.store.AppendEvent(ctx, orgID, sessionID, role, content)
}

func (h *chatSessionHandler) persistChatEventDetached(orgID, sessionID, role string, content map[string]any) {
	if h.store == nil {
		return
	}
	// Use a detached context so a client disconnect cannot drop the audited
	// event, but keep the write ordered so tool calls and results reconstruct
	// as a valid model transcript later.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.appendChatEvent(ctx, orgID, sessionID, role, content); err != nil {
		h.logError("Go chat failed to persist a trajectory event", sessionID, err)
	}
}

func chatLoopErrorMessage(err error) string {
	var providerErr chatProviderError
	if errors.As(err, &providerErr) {
		return providerErr.Error()
	}
	return "chat request failed"
}

var chatAlwaysEnabledModules = map[string]bool{"settings": true, "iam": true, "signals": true, "routines": true, "skills": true}

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

var chatBuiltinToolNames = map[string]bool{
	"file_ticket": true, "ask_user": true, "recent_changes": true, "daily_brief": true,
	"capability_search": true, "capability_invoke": true, "approvals_inbox": true, "notifications_inbox": true, "resolve_entity": true,
}

func buildChatTools(agentTools []capability.AgentToolSpec, allowedModules map[string]bool, includeBriefTools bool) ([]chatToolSpec, map[string]capability.AgentToolSpec, error) {
	tools := make([]chatToolSpec, 0, len(agentTools)+2)
	byName := make(map[string]capability.AgentToolSpec, len(agentTools))
	for _, tool := range agentTools {
		module, _, _ := strings.Cut(tool.ID, ".")
		if allowedModules != nil && !allowedModules[module] {
			continue
		}
		name := chatToolName(tool.ID)
		if chatBuiltinToolNames[name] {
			return nil, nil, fmt.Errorf("capability %q collides with a built-in chat tool after name sanitization", tool.ID)
		}
		if _, exists := byName[name]; exists {
			return nil, nil, fmt.Errorf("tool name collision after sanitization: %q", tool.ID)
		}
		byName[name] = tool
		tools = append(tools, chatToolSpec{Name: name, Description: tool.Description, Parameters: chatToolParameters(tool.InputSchema)})
	}
	tools = append(tools,
		chatFileTicketToolSpec(), chatAskUserToolSpec(),
		chatCapabilitySearchToolSpec(), chatCapabilityInvokeToolSpec(), chatResolveEntityToolSpec(),
	)
	if includeBriefTools {
		tools = append(tools, chatRecentChangesToolSpec(), chatDailyBriefToolSpec())
	} else {
		tools = append(tools, chatNotificationsInboxToolSpec(), chatApprovalsInboxToolSpec())
	}
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
		Description: "File a ticket only after capability_search returns no useful fit and the goal is genuinely blocked. Never use this as the first response to a hard request.",
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

func chatRecentChangesToolSpec() chatToolSpec {
	return chatToolSpec{
		Name:        "recent_changes",
		Description: "Read what changed in this workspace over the last N hours from the append-only ledger: state-changing capabilities by module and actor, plus the latest events. Reads are excluded. Use this for 'what changed since yesterday', 'what happened today', and the changes section of a daily brief. Requires accounting.read.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"hours":{"type":"integer","minimum":1,"maximum":168,"description":"Lookback window in hours. Defaults to 24."}},"additionalProperties":false}`),
	}
}

func (h *chatSessionHandler) recentChanges(ctx context.Context, user *session.ResolvedUser, call chatToolCall) (string, bool, string) {
	if h == nil || h.ledger == nil {
		return chatMustEncode(chatToolRefusal{Error: "recent activity is unavailable"}), false, "recent activity is unavailable"
	}
	if user == nil || (!user.HasPermission("accounting.read") && !user.HasPermission("*")) {
		return chatMustEncode(chatToolRefusal{Error: "missing permission: accounting.read"}), false, "missing permission: accounting.read"
	}
	hours := 24
	var input struct {
		Hours *int `json:"hours"`
	}
	if len(call.Arguments) > 0 && string(call.Arguments) != "{}" {
		if err := json.Unmarshal(call.Arguments, &input); err != nil {
			return chatMustEncode(chatToolRefusal{Error: "invalid recent_changes arguments"}), false, "invalid recent_changes arguments"
		}
	}
	if input.Hours != nil {
		hours = *input.Hours
	}
	if hours < 1 || hours > 168 {
		return chatMustEncode(chatToolRefusal{Error: "hours must be between 1 and 168"}), false, "hours must be between 1 and 168"
	}
	events, err := h.ledger.RecentForOrg(ctx, *user.OrgID, 500)
	if err != nil {
		return chatMustEncode(chatToolRefusal{Error: "could not read recent activity"}), false, "could not read recent activity"
	}
	since := time.Now().UTC().Add(-time.Duration(hours) * time.Hour)
	type changeEvent struct {
		Seq          int64  `json:"seq"`
		Kind         string `json:"kind"`
		CapabilityID string `json:"capabilityId,omitempty"`
		ActorType    string `json:"actorType"`
		OccurredAt   string `json:"occurredAt"`
	}
	type capCount struct {
		CapabilityID string `json:"capabilityId"`
		Count        int    `json:"count"`
	}
	type actorCount struct {
		ActorType string `json:"actorType"`
		Count     int    `json:"count"`
	}
	counts := map[string]int{}
	actors := map[string]int{}
	recent := make([]changeEvent, 0, 20)
	total := 0
	for _, event := range events {
		occurred, parseErr := time.Parse(time.RFC3339Nano, event.OccurredAt)
		if parseErr != nil || occurred.Before(since) {
			continue
		}
		capabilityID := "unknown"
		if event.CapabilityID != nil && *event.CapabilityID != "" {
			capabilityID = *event.CapabilityID
		}
		if risk, known := capability.CapabilityRisk(capabilityID); known && risk == "read" {
			continue
		}
		total++
		counts[capabilityID]++
		actors[event.ActorType]++
		if len(recent) < 20 {
			recent = append(recent, changeEvent{Seq: event.Seq, Kind: event.Kind, CapabilityID: capabilityID, ActorType: event.ActorType, OccurredAt: event.OccurredAt})
		}
	}
	byCapability := make([]capCount, 0, len(counts))
	for id, count := range counts {
		byCapability = append(byCapability, capCount{CapabilityID: id, Count: count})
	}
	sort.Slice(byCapability, func(i, j int) bool {
		if byCapability[i].Count != byCapability[j].Count {
			return byCapability[i].Count > byCapability[j].Count
		}
		return byCapability[i].CapabilityID < byCapability[j].CapabilityID
	})
	byActor := make([]actorCount, 0, len(actors))
	for actor, count := range actors {
		byActor = append(byActor, actorCount{ActorType: actor, Count: count})
	}
	sort.Slice(byActor, func(i, j int) bool {
		if byActor[i].Count != byActor[j].Count {
			return byActor[i].Count > byActor[j].Count
		}
		return byActor[i].ActorType < byActor[j].ActorType
	})
	payload := map[string]any{
		"since": since.Format(time.RFC3339), "hours": hours, "total": total,
		"byCapability": byCapability, "byActor": byActor, "recent": recent,
	}
	if total == 0 {
		payload["note"] = "No ledger events were recorded in this window."
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return chatMustEncode(chatToolRefusal{Error: "could not encode recent activity"}), false, "could not encode recent activity"
	}
	return string(encoded), true, ""
}

func chatDailyBriefToolSpec() chatToolSpec {
	return chatToolSpec{
		Name:        "daily_brief",
		Description: "Build a trusted daily brief in one deterministic read: attention signals, financial position, receivables, payables, low stock, open tasks, leave this month, open support, and recent ledger changes. Use this for a daily brief, what needs my attention, what changed, catch me up, or what should I do first. This tool takes no input.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
	}
}

func chatCapabilitySearchToolSpec() chatToolSpec {
	return chatToolSpec{
		Name:        "capability_search",
		Description: "Search every governed capability available to this user by plain-language job. Returns capability ids, intent, risk, permission, and input schema. Use this when no listed tool fits, then call capability_invoke.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","minLength":2,"maxLength":120},"limit":{"type":"integer","minimum":1,"maximum":10,"default":6}},"required":["query"],"additionalProperties":false}`),
	}
}

func chatCapabilityInvokeToolSpec() chatToolSpec {
	return chatToolSpec{
		Name:        "capability_invoke",
		Description: "Invoke a capability returned by capability_search with schema-valid input. It runs through the same permissions, policy, approvals, audit, and inverses as a human action. Never invent a capability id.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"capabilityId":{"type":"string","minLength":3,"maxLength":120},"input":{"type":"object"}},"required":["capabilityId","input"],"additionalProperties":false}`),
	}
}

func chatApprovalsInboxToolSpec() chatToolSpec {
	return chatToolSpec{
		Name:        "approvals_inbox",
		Description: "List the approvals waiting on a decision, including the capability, risk class, requester, amount or payload, and age. Use for 'what approvals are waiting', 'what needs my sign-off', and the approvals part of a daily brief.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
	}
}

func (h *chatSessionHandler) approvalsInbox(ctx context.Context, user *session.ResolvedUser) (string, bool, string) {
	if h == nil || h.approvals == nil || user == nil || user.OrgID == nil {
		return chatMustEncode(chatToolRefusal{Error: "approvals are unavailable"}), false, "approvals are unavailable"
	}
	permissions := make([]string, 0, len(user.Permissions))
	for permission, granted := range user.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	sort.Strings(permissions)
	response, err := h.approvals.ReadApprovalInbox(ctx, authbridge.ApprovalInboxClaims{
		Subject: user.UserID, OrganizationID: *user.OrgID, ActorType: "agent",
		Permissions: permissions, AuthSessionID: user.AuthSessionID,
	}, nil)
	if err != nil {
		return chatMustEncode(chatToolRefusal{Error: "could not read approvals"}), false, "could not read approvals"
	}
	pending := response.Approvals
	if len(pending) > 10 {
		pending = pending[:10]
	}
	payload := map[string]any{"count": len(response.Approvals), "approvals": pending}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return chatMustEncode(chatToolRefusal{Error: "could not encode approvals"}), false, "could not encode approvals"
	}
	return string(encoded), true, ""
}

func (s *chatPostgresSessionStore) RecentMessages(ctx context.Context, orgID, sessionID string, limit int) ([]chatMessage, error) {
	if s == nil || s.pool == nil || limit < 1 {
		return nil, nil
	}
	if limit > 60 {
		limit = 60
	}
	return dbx.WithOrgTx(ctx, s.pool, orgID, func(tx pgx.Tx) ([]chatMessage, error) {
		rows, err := tx.Query(ctx, `
			SELECT role, content
			FROM session_events
			WHERE session_id=$1::uuid AND role IN ('user','assistant','tool_call','tool_result')
			ORDER BY seq DESC
			LIMIT $2`, sessionID, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		events := make([]chatHistoryEvent, 0, limit)
		for rows.Next() {
			var role string
			var raw []byte
			if err := rows.Scan(&role, &raw); err != nil {
				return nil, err
			}
			content := map[string]any{}
			if json.Unmarshal(raw, &content) != nil {
				continue
			}
			events = append(events, chatHistoryEvent{role: role, content: content})
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		for left, right := 0, len(events)-1; left < right; left, right = left+1, right-1 {
			events[left], events[right] = events[right], events[left]
		}
		return chatHistoryMessages(events), nil
	})
}

func chatHistoryMessages(events []chatHistoryEvent) []chatMessage {
	resultByCall := make(map[string]map[string]any)
	for _, event := range events {
		if event.role == "tool_result" {
			if callID := chatHistoryString(event.content["callId"]); callID != "" {
				resultByCall[callID] = event.content
			}
		}
	}
	messages := make([]chatMessage, 0, len(events))
	knownCalls := make(map[string]bool)
	for _, event := range events {
		switch event.role {
		case "user", "assistant":
			text := chatHistoryString(event.content["text"])
			if event.role == "user" {
				text = chatHistoryTextWithSources(text, event.content["attachments"])
			}
			if strings.TrimSpace(text) != "" {
				messages = append(messages, chatMessage{Role: event.role, Content: text})
			}
		case "tool_call":
			callID := chatHistoryString(event.content["callId"])
			name := chatHistoryString(event.content["name"])
			if callID == "" || name == "" {
				continue
			}
			if _, hasResult := resultByCall[callID]; !hasResult {
				continue
			}
			arguments := json.RawMessage(`{}`)
			switch value := event.content["args"].(type) {
			case string:
				if json.Valid([]byte(value)) {
					arguments = json.RawMessage(value)
				}
			case map[string]any:
				if encoded, err := json.Marshal(value); err == nil {
					arguments = encoded
				}
			}
			messages = append(messages, chatMessage{Role: "assistant", ToolCalls: []chatToolCall{{ID: callID, Name: name, Arguments: arguments}}})
			knownCalls[callID] = true
		case "tool_result":
			callID := chatHistoryString(event.content["callId"])
			if callID == "" || !knownCalls[callID] {
				continue
			}
			result := chatHistoryString(event.content["result"])
			if result == "" {
				fallback := map[string]any{"ok": event.content["ok"] == true}
				if message := chatHistoryString(event.content["error"]); message != "" {
					fallback["error"] = message
				}
				if encoded, err := json.Marshal(fallback); err == nil {
					result = string(encoded)
				}
			}
			messages = append(messages, chatMessage{Role: "tool", ToolCallID: callID, Content: result})
			delete(knownCalls, callID)
		}
	}
	if len(messages) > 24 {
		messages = messages[len(messages)-24:]
	}
	for len(messages) > 0 && messages[0].Role != "user" {
		messages = messages[1:]
	}
	return messages
}

func chatHistoryTextWithSources(text string, raw any) string {
	if raw == nil {
		return text
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return text
	}
	var attachments []chatAttachment
	if json.Unmarshal(encoded, &attachments) != nil || len(attachments) == 0 {
		return text
	}
	if len(attachments) > 5 {
		attachments = attachments[:5]
	}
	lines := make([]string, 0, len(attachments))
	for _, attachment := range attachments {
		title := strings.TrimSpace(attachment.Title)
		if attachment.Type == "" || !isUUID(attachment.ID) || title == "" {
			continue
		}
		if len(title) > 200 {
			title = title[:200]
		}
		lines = append(lines, "- "+attachment.Type+": "+title+" (id "+attachment.ID+")")
	}
	if len(lines) == 0 {
		return text
	}
	return text + "\n\nAttached sources from the earlier turn:\n" + strings.Join(lines, "\n")
}

func chatHistoryString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func chatNotificationsInboxToolSpec() chatToolSpec {
	return chatToolSpec{
		Name:        "notifications_inbox",
		Description: "List the signed-in person's recent in-app notifications with unread count, newest first. Use for 'what notifications do I have', 'did anything happen', and the notifications part of a brief. Read-only.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
	}
}

func (h *chatSessionHandler) notificationsInbox(ctx context.Context, user *session.ResolvedUser) (string, bool, string) {
	if h == nil || h.notifications == nil || user == nil || user.OrgID == nil {
		return chatMustEncode(chatToolRefusal{Error: "notifications are unavailable"}), false, "notifications are unavailable"
	}
	rows, unread, err := h.notifications.ForUser(ctx, *user.OrgID, user.UserID, 10)
	if err != nil {
		return chatMustEncode(chatToolRefusal{Error: "could not read notifications"}), false, "could not read notifications"
	}
	notifications := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		item := map[string]any{
			"id": row.ID, "kind": row.Kind, "title": row.Title,
			"createdAt": row.CreatedAt.UTC().Format(time.RFC3339),
		}
		if row.Href != nil {
			item["href"] = *row.Href
		}
		if row.ReadAt != nil {
			item["readAt"] = row.ReadAt.UTC().Format(time.RFC3339)
		}
		notifications = append(notifications, item)
	}
	payload := map[string]any{
		"unreadCount": unread, "notifications": notifications,
		"note": "A notification describes an event. It is not proof that an approval is still pending.",
	}
	if approvalsJSON, ok, _ := h.approvalsInbox(ctx, user); ok {
		var approvals struct {
			Count int `json:"count"`
		}
		if json.Unmarshal([]byte(approvalsJSON), &approvals) == nil {
			payload["pendingApprovals"] = approvals.Count
			payload["approvalsChecked"] = true
		}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return chatMustEncode(chatToolRefusal{Error: "could not encode notifications"}), false, "could not encode notifications"
	}
	return string(encoded), true, ""
}

func chatResolveEntityToolSpec() chatToolSpec {
	return chatToolSpec{
		Name:        "resolve_entity",
		Description: "Find the canonical id for a customer, vendor, item, employee, project, invoice, bill, receipt, or document by name, email, SKU, code, or number. Customer duplicates that were merged resolve to the surviving record and report the old name in mergedFrom. Use before a write that needs an id; returns up to 10 matches with ids and the fields that identify them.",
		Parameters: json.RawMessage(`{"type":"object","properties":{
			"type":{"type":"string","enum":["customer","vendor","item","employee","project","invoice","bill","receipt","document"]},
			"query":{"type":"string","minLength":1,"maxLength":120},
			"limit":{"type":"integer","minimum":1,"maximum":10,"default":5}
		},"required":["type","query"],"additionalProperties":false}`),
	}
}

type chatEntityMatch struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Detail      string `json:"detail,omitempty"`
	MatchedOn   string `json:"matchedOn,omitempty"`
	MergedFrom  string `json:"mergedFrom,omitempty"`
	Deactivated bool   `json:"deactivated,omitempty"`
}

func (h *chatSessionHandler) resolveEntity(ctx context.Context, user *session.ResolvedUser, call chatToolCall) (string, bool, string) {
	if h == nil || h.pool == nil || user == nil || user.OrgID == nil {
		return chatMustEncode(chatToolRefusal{Error: "entity lookup is unavailable"}), false, "entity lookup is unavailable"
	}
	var input struct {
		Type  string `json:"type"`
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal(call.Arguments, &input); err != nil {
		return chatMustEncode(chatToolRefusal{Error: "invalid entity lookup arguments"}), false, "invalid entity lookup arguments"
	}
	input.Type = strings.ToLower(strings.TrimSpace(input.Type))
	input.Query = strings.TrimSpace(input.Query)
	if input.Query == "" || len(input.Query) > 120 {
		return chatMustEncode(chatToolRefusal{Error: "query must be between 1 and 120 characters"}), false, "query must be between 1 and 120 characters"
	}
	if input.Limit < 1 {
		input.Limit = 5
	}
	if input.Limit > 10 {
		input.Limit = 10
	}
	permission := map[string]string{
		"customer": "crm.read", "vendor": "purchasing.read", "item": "inventory.read",
		"employee": "hr.read", "project": "projects.read", "invoice": "accounting.read",
		"bill": "purchasing.read", "receipt": "purchasing.read", "document": "documents.read",
	}[input.Type]
	if permission == "" {
		return chatMustEncode(chatToolRefusal{Error: "unsupported entity type"}), false, "unsupported entity type"
	}
	if !user.HasPermission(permission) && !user.HasPermission("*") {
		return chatMustEncode(chatToolRefusal{Error: "missing permission: " + permission}), false, "missing permission: " + permission
	}
	query := "%" + input.Query + "%"
	matches := make([]chatEntityMatch, 0, input.Limit)
	_, err := dbx.WithOrgTx(ctx, h.pool, *user.OrgID, func(tx pgx.Tx) (struct{}, error) {
		if input.Type == "customer" {
			found, err := resolveCustomerEntityMatches(ctx, tx, *user.OrgID, input.Query, input.Limit)
			if err != nil {
				return struct{}{}, err
			}
			matches = append(matches, found...)
			return struct{}{}, nil
		}
		var rows pgx.Rows
		var err error
		switch input.Type {
		case "vendor":
			rows, err = tx.Query(ctx, `SELECT id::text, name, COALESCE(email,'') FROM vendors WHERE org_id=$1::uuid AND (name ILIKE $2 OR email ILIKE $2) ORDER BY name LIMIT $3`, *user.OrgID, query, input.Limit)
		case "item":
			rows, err = tx.Query(ctx, `SELECT id::text, name, sku FROM items WHERE org_id=$1::uuid AND (name ILIKE $2 OR sku ILIKE $2) ORDER BY name LIMIT $3`, *user.OrgID, query, input.Limit)
		case "employee":
			rows, err = tx.Query(ctx, `SELECT id::text, name, COALESCE(email,'') || CASE WHEN COALESCE(title,'') = '' THEN '' ELSE ' · ' || title END FROM employees WHERE org_id=$1::uuid AND (name ILIKE $2 OR email ILIKE $2) ORDER BY name LIMIT $3`, *user.OrgID, query, input.Limit)
		case "project":
			rows, err = tx.Query(ctx, `SELECT id::text, name, status FROM projects WHERE org_id=$1::uuid AND name ILIKE $2 ORDER BY name LIMIT $3`, *user.OrgID, query, input.Limit)
		case "invoice":
			rows, err = tx.Query(ctx, `SELECT i.id::text, 'Invoice #' || i.number, COALESCE(c.name,'') || CASE WHEN i.status = '' THEN '' ELSE ' · ' || i.status END FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id WHERE i.org_id=$1::uuid AND (i.number::text ILIKE $2 OR c.name ILIKE $2) ORDER BY i.number DESC LIMIT $3`, *user.OrgID, query, input.Limit)
		case "bill":
			rows, err = tx.Query(ctx, `SELECT b.id::text, 'Bill #' || b.number, COALESCE(v.name,'') || CASE WHEN b.status = '' THEN '' ELSE ' · ' || b.status END FROM vendor_bills b LEFT JOIN vendors v ON v.id = b.vendor_id AND v.org_id = b.org_id WHERE b.org_id=$1::uuid AND (b.number::text ILIKE $2 OR v.name ILIKE $2) ORDER BY b.number DESC LIMIT $3`, *user.OrgID, query, input.Limit)
		case "receipt":
			rows, err = tx.Query(ctx, `SELECT id::text, 'Receipt #' || number, COALESCE(note,'') FROM goods_receipts WHERE org_id=$1::uuid AND number::text ILIKE $2 ORDER BY number DESC LIMIT $3`, *user.OrgID, query, input.Limit)
		case "document":
			rows, err = tx.Query(ctx, `SELECT id::text, title, status FROM documents WHERE org_id=$1::uuid AND title ILIKE $2 ORDER BY updated_at DESC LIMIT $3`, *user.OrgID, query, input.Limit)
		}
		if err != nil {
			return struct{}{}, err
		}
		defer rows.Close()
		for rows.Next() {
			var item chatEntityMatch
			if err := rows.Scan(&item.ID, &item.Name, &item.Detail); err != nil {
				return struct{}{}, err
			}
			matches = append(matches, item)
		}
		return struct{}{}, rows.Err()
	})
	if err != nil {
		return chatMustEncode(chatToolRefusal{Error: "could not search entities"}), false, "could not search entities"
	}
	encoded, err := json.Marshal(map[string]any{"type": input.Type, "query": input.Query, "matches": matches, "count": len(matches)})
	if err != nil {
		return chatMustEncode(chatToolRefusal{Error: "could not encode entity matches"}), false, "could not encode entity matches"
	}
	return string(encoded), true, ""
}

// resolveCustomerMatchesSQL offers a wider candidate set than one substring
// match: the full text, the subscriber digits of a phone, and every name token
// in any order. It also resolves each candidate to its merge root, so a
// tombstoned duplicate can never come back as the id to act on.
const resolveCustomerMatchesSQL = `
WITH RECURSIVE customer_roots AS (
    SELECT c.id, c.id AS root_id, 0 AS depth
    FROM customers c
    WHERE c.org_id = $1::uuid AND c.merged_into_customer_id IS NULL
    UNION ALL
    SELECT c.id, r.root_id, r.depth + 1
    FROM customers c
    JOIN customer_roots r ON c.merged_into_customer_id = r.id
    WHERE c.org_id = $1::uuid AND r.depth < 8
)
SELECT c.id::text, c.name, COALESCE(c.email, ''), COALESCE(c.phone, ''),
       (c.deactivated_at IS NOT NULL), canon.id::text, canon.name, (canon.deactivated_at IS NOT NULL)
FROM customers c
JOIN customer_roots r ON r.id = c.id
JOIN customers canon ON canon.org_id = c.org_id AND canon.id = r.root_id
WHERE c.org_id = $1::uuid
  AND (
    c.name ILIKE $2
    OR c.email ILIKE $2
    OR ($3 <> '' AND right(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 9) = $3)
    OR (cardinality($4::text[]) > 0 AND c.name ILIKE ALL ($4::text[]))
  )
ORDER BY c.name, c.id
LIMIT $5`

func resolveCustomerEntityMatches(ctx context.Context, tx pgx.Tx, orgID, query string, limit int) ([]chatEntityMatch, error) {
	parsed := crm.ParseCustomerQuery(query)
	tokens := make([]string, 0, len(parsed.Tokens))
	for _, token := range parsed.Tokens {
		tokens = append(tokens, "%"+token+"%")
	}
	rows, err := tx.Query(ctx, resolveCustomerMatchesSQL, orgID, "%"+query+"%", parsed.Phone, tokens, limit*4)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := make([]crm.CustomerMatchCandidate, 0, limit*4)
	for rows.Next() {
		var candidate crm.CustomerMatchCandidate
		if err := rows.Scan(
			&candidate.ID, &candidate.Name, &candidate.Email, &candidate.Phone,
			&candidate.Deactivated, &candidate.CanonicalID, &candidate.CanonicalName, &candidate.CanonicalDeactivated,
		); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	ranked := crm.RankCustomerMatches(query, candidates, limit)
	matches := make([]chatEntityMatch, 0, len(ranked))
	for _, match := range ranked {
		matches = append(matches, chatEntityMatch{
			ID:          match.ID,
			Name:        match.Name,
			Detail:      match.Detail,
			MatchedOn:   match.MatchedOn,
			MergedFrom:  match.MatchedRecordName,
			Deactivated: match.Deactivated,
		})
	}
	return matches, nil
}
