package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5/pgxpool"
)

const supportAdminMaxBodyBytes = 256 << 10

type supportAdminAction struct {
	capabilityID string
	permission   string
	fields       []string
}

// supportAdminActions mirrors the legacy zod object per action: unknown keys
// were stripped before they ever reached the capability, so the Go port
// whitelists the same fields instead of forwarding arbitrary JSON.
var supportAdminActions = map[string]supportAdminAction{
	"create":               {capabilityID: "support.startConversation", permission: "support.write", fields: []string{"customerId", "subject"}},
	"message":              {capabilityID: "support.postMessage", permission: "support.write", fields: []string{"conversationId", "body", "from"}},
	"send":                 {capabilityID: "support.postMessage", permission: "support.write", fields: []string{"conversationId", "body"}},
	"escalate":             {capabilityID: "support.escalateConversation", permission: "support.write", fields: []string{"conversationId", "reason"}},
	"resolve":              {capabilityID: "support.resolveConversation", permission: "support.write", fields: []string{"conversationId"}},
	"reopen":               {capabilityID: "support.reopenConversation", permission: "support.write", fields: []string{"conversationId"}},
	"updateTicket":         {capabilityID: "support.updateTicket", permission: "support.write", fields: []string{"conversationId", "priority", "category", "assigneeUserId", "slaDueAt"}},
	"suggestCategory":      {capabilityID: "support.suggestCategory", permission: "support.read", fields: []string{"text"}},
	"createCannedResponse": {capabilityID: "support.createCannedResponse", permission: "support.write", fields: []string{"shortcut", "title", "body"}},
	"createKbArticle":      {capabilityID: "support.createKbArticle", permission: "support.write", fields: []string{"title", "body", "category", "isPublic"}},
}

var supportAdminRefusals = map[string]struct{}{
	"conversation not found":                        {},
	"customer not found in this organization":       {},
	"conversation is resolved; reopen it first":     {},
	"conversation already resolved":                 {},
	"conversation is already open":                  {},
	"ticket not found":                              {},
	"assignee is not a member of this organization": {},
}

// SupportAdminHandler serves GET and POST /api/support through the governed
// capability executor: the inbox, conversation transcript and library reads,
// plus the legacy action union. Drafting reuses the same context reader and
// generator implementations as the dedicated draft route; each surface keeps
// its own rate limiter instance.
type SupportAdminHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	draftReader       supportReplyDraftContextReader
	draftGenerator    supportReplyDraftGenerator
	draftLimiter      *supportReplyDraftRateLimiter
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

// NewSupportAdminHandler builds the Go support surface for /api/support.
func NewSupportAdminHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) (http.Handler, error) {
	if pool == nil {
		return nil, errors.New("support admin handler requires a database pool")
	}
	if resolver == nil {
		return nil, errors.New("support admin handler requires a session resolver")
	}
	if executor == nil {
		return nil, errors.New("support admin handler requires a capability executor")
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	for _, cidr := range trusted {
		if cidr == nil || cidr.IP == nil || cidr.Mask == nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &SupportAdminHandler{
		resolver:          resolver,
		executor:          executor,
		draftReader:       postgresSupportReplyDraftContextReader{pool: pool},
		draftGenerator:    goSupportReplyDraftGenerator{pool: pool, config: &myWorkSummaryPostgresReader{pool: pool}},
		draftLimiter:      newSupportReplyDraftRateLimiter(nil),
		logger:            logger,
		trustedProxyCIDRs: trusted,
	}, nil
}

// newSupportAdminHandler is the test seam: it injects the draft reader,
// generator and limiter without opening a PostgreSQL connection.
func newSupportAdminHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, reader supportReplyDraftContextReader, generator supportReplyDraftGenerator, limiter *supportReplyDraftRateLimiter, logger *slog.Logger) *SupportAdminHandler {
	if logger == nil {
		logger = slog.Default()
	}
	if limiter == nil {
		limiter = newSupportReplyDraftRateLimiter(nil)
	}
	return &SupportAdminHandler{
		resolver: resolver, executor: executor, draftReader: reader, draftGenerator: generator, draftLimiter: limiter, logger: logger,
	}
}

func (h *SupportAdminHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	switch r.Method {
	case http.MethodGet, http.MethodPost:
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "support service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, bearer, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		strings.TrimSpace(resolved.AuthSessionID) == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "support") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if r.Method == http.MethodGet {
		h.handleRead(w, r, resolved)
		return
	}
	h.handleAction(w, r, resolved, bearer)
}

func (h *SupportAdminHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, bool, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, true, session.ErrNoSession
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
		return resolved, true, err
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	return resolved, false, err
}

func supportAdminRequirePermission(w http.ResponseWriter, resolved *session.ResolvedUser, permission string) bool {
	if !resolved.HasPermission(permission) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing permission: " + permission})
		return false
	}
	return true
}

func (h *SupportAdminHandler) handleRead(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	if !supportAdminRequirePermission(w, resolved, "support.read") {
		return
	}
	if h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "support service unavailable"})
		return
	}
	query := r.URL.Query()
	if query.Get("library") != "" {
		h.readRaw(w, r, resolved, "support.listLibrary", json.RawMessage(`{}`))
		return
	}
	if conversationID := strings.TrimSpace(query.Get("id")); conversationID != "" {
		if !isUUID(conversationID) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		input, err := json.Marshal(map[string]any{"conversationId": strings.ToLower(conversationID), "limit": 200})
		if err != nil {
			h.fail(w, "encode support conversation read", err)
			return
		}
		data, ok := h.executeRead(w, r, resolved, "support.readConversation", input)
		if !ok {
			return
		}
		var output capability.SupportReadConversationOutput
		if json.Unmarshal(data, &output) != nil || output.Conversation.CustomerID == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		messages := output.Messages
		if messages == nil {
			messages = []capability.SupportTranscriptMessage{}
		}
		writeJSON(w, http.StatusOK, supportAdminConversationDetail{
			Conversation: supportAdminConversationHeader{
				ID: output.Conversation.ID, CustomerID: output.Conversation.CustomerID,
				CustomerName: output.Conversation.CustomerName, Subject: output.Conversation.Subject,
				Status: output.Conversation.Status, Priority: output.Conversation.Priority,
				Category: output.Conversation.Category, AssignedUserID: output.Conversation.AssignedUserID,
				SLADueAt: output.Conversation.SLADueAt,
			},
			Messages: messages,
		})
		return
	}
	h.readRaw(w, r, resolved, "support.listConversations", json.RawMessage(`{"limit":100,"customerBoundOnly":true}`))
}

func (h *SupportAdminHandler) readRaw(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage) {
	data, ok := h.executeRead(w, r, resolved, capabilityID, input)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (h *SupportAdminHandler) executeRead(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage) (json.RawMessage, bool) {
	result, err := h.executor.Execute(r.Context(), supportAdminCapabilityClaims(resolved, capabilityID, "", input), capabilityID, input)
	if err != nil {
		if h.writeExecuteError(w, capabilityID, err) {
			return nil, false
		}
		if err.Error() == "conversation not found" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return nil, false
		}
		if status, ok := capabilityErrorStatus(err); ok {
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return nil, false
		}
		h.fail(w, "read "+capabilityID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return nil, false
	}
	if !supportAdminWriteResultRefusal(w, result) {
		return nil, false
	}
	if !json.Valid(result.Data) {
		h.fail(w, "read "+capabilityID, errors.New("capability returned invalid JSON"))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return nil, false
	}
	return result.Data, true
}

func (h *SupportAdminHandler) handleAction(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, bearer bool) {
	fields, ok := readSupportAdminFields(w, r)
	if !ok {
		return
	}
	rawAction, exists := fields["action"]
	if !exists {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var action string
	if json.Unmarshal(rawAction, &action) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	action = strings.TrimSpace(action)
	if action == "" || utf8.RuneCountInString(action) > 40 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	delete(fields, "action")
	if action == "draft" {
		if !supportAdminRequirePermission(w, resolved, "support.read") {
			return
		}
		if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "same-origin request required"})
			return
		}
		h.handleDraft(w, r, resolved, fields)
		return
	}
	mapped, supported := supportAdminActions[action]
	if !supported {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if !supportAdminRequirePermission(w, resolved, mapped.permission) {
		return
	}
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "same-origin request required"})
		return
	}
	if h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "support service unavailable"})
		return
	}
	intentID, ok := supportAdminIntentField(w, fields)
	if !ok {
		return
	}
	input := filterSupportAdminFields(fields, mapped.fields...)
	result, err := h.executor.Execute(r.Context(), supportAdminCapabilityClaims(resolved, mapped.capabilityID, intentID, input), mapped.capabilityID, input)
	if err != nil {
		if h.writeExecuteError(w, mapped.capabilityID, err) {
			return
		}
		if message, refusal := supportAdminRefusal(err); refusal {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": message})
			return
		}
		if status, ok := capabilityErrorStatus(err); ok {
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return
		}
		h.fail(w, "execute "+mapped.capabilityID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	supportAdminWriteActionResult(w, result)
}

func supportAdminRefusal(err error) (string, bool) {
	message := err.Error()
	if strings.HasPrefix(message, "cannot escalate a ") {
		return message, true
	}
	if _, ok := supportAdminRefusals[message]; ok {
		return message, true
	}
	return "", false
}

func (h *SupportAdminHandler) handleDraft(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, fields map[string]json.RawMessage) {
	if h.draftReader == nil || h.draftGenerator == nil || h.draftLimiter == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "support reply drafting unavailable"})
		return
	}
	raw, ok := fields["conversationId"]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var conversationID string
	if json.Unmarshal(raw, &conversationID) != nil || !isUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	conversationID = strings.ToLower(conversationID)
	allowed, retryAfter := h.draftLimiter.allow(fmt.Sprintf("%s:%s", *resolved.OrgID, resolved.UserID))
	if !allowed {
		w.Header().Set("Retry-After", fmt.Sprintf("%d", max(1, int(retryAfter.Round(time.Second)/time.Second))))
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	draftContext, err := h.draftReader.Load(r.Context(), *resolved.OrgID, conversationID)
	switch {
	case errors.Is(err, errSupportReplyDraftConversationNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "conversation not found"})
		return
	case errors.Is(err, errSupportReplyDraftNoMessages):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	case err != nil:
		h.fail(w, "support draft context read", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "support reply drafting unavailable"})
		return
	}
	draft, err := h.draftGenerator.Draft(r.Context(), *resolved.OrgID, resolved.UserID, conversationID, draftContext)
	if err != nil {
		h.fail(w, "support draft generation", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "support reply drafting unavailable"})
		return
	}
	draft = truncateSupportReplyDraft(strings.TrimSpace(draft), supportReplyDraftMaxUnits)
	if draft == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "support reply drafting unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, supportReplyDraftResponse{Draft: draft})
}

// writeExecuteError reports auth-class executor errors and whether one was
// written; other errors are left to the caller so reads and writes can shape
// their own envelopes.
func (h *SupportAdminHandler) writeExecuteError(w http.ResponseWriter, capabilityID string, err error) bool {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return true
	case errors.Is(err, capability.ErrNotMember):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return true
	}
	return false
}

func supportAdminWriteResultRefusal(w http.ResponseWriter, result capability.Result) bool {
	if result.OK {
		return true
	}
	switch {
	case strings.HasPrefix(result.Error, "forbidden:"):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": result.Error})
	case strings.Contains(result.Error, "is disabled for this organization"):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	default:
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
	}
	return false
}

func supportAdminWriteActionResult(w http.ResponseWriter, result capability.Result) {
	switch {
	case result.PendingApproval:
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason})
	case !result.OK:
		supportAdminWriteResultRefusal(w, result)
	case !json.Valid(result.Data):
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
	}
}

func (h *SupportAdminHandler) fail(w http.ResponseWriter, operation string, err error) {
	if h.logger != nil {
		h.logger.Error("Go support request failed", "operation", operation, "error", err)
	}
}

func readSupportAdminFields(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	if r.Body == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, supportAdminMaxBodyBytes)
	decoder := json.NewDecoder(r.Body)
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	return fields, true
}

func supportAdminIntentField(w http.ResponseWriter, fields map[string]json.RawMessage) (string, bool) {
	raw, exists := fields["intentId"]
	if !exists {
		return "", true
	}
	delete(fields, "intentId")
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", true
	}
	var intentID string
	if json.Unmarshal(raw, &intentID) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	intentID = strings.TrimSpace(intentID)
	if utf8.RuneCountInString(intentID) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", false
	}
	return intentID, true
}

func filterSupportAdminFields(fields map[string]json.RawMessage, allowed ...string) json.RawMessage {
	filtered := make(map[string]json.RawMessage, len(allowed))
	for key, value := range fields {
		if slices.Contains(allowed, key) {
			filtered[key] = value
		}
	}
	encoded, _ := json.Marshal(filtered)
	return encoded
}

func supportAdminCapabilityClaims(resolved *session.ResolvedUser, capabilityID, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	actorID := resolved.UserID
	inputHash, _ := capability.InputHash(input)
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		CapabilityID: capabilityID, InputSHA256: inputHash, ActorID: &actorID, ActorType: "human",
		Permissions: permissions, AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

type supportAdminConversationHeader struct {
	ID             string  `json:"id"`
	CustomerID     *string `json:"customerId"`
	CustomerName   string  `json:"customerName"`
	Subject        string  `json:"subject"`
	Status         string  `json:"status"`
	Priority       string  `json:"priority"`
	Category       *string `json:"category"`
	AssignedUserID *string `json:"assignedUserId"`
	SLADueAt       *string `json:"slaDueAt"`
}

type supportAdminConversationDetail struct {
	Conversation supportAdminConversationHeader        `json:"conversation"`
	Messages     []capability.SupportTranscriptMessage `json:"messages"`
}

// MountGoSupportAdminRoute owns GET and POST /api/support; the channel,
// customer and draft subroutes stay with their existing mounts in the base
// handler.
func MountGoSupportAdminRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/support", route)
	mux.Handle("POST /api/support", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
