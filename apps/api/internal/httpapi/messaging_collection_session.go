package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	// 64 KiB covers an 8000-unit capability body even when every unit is JSON-escaped.
	messagingCollectionBodyLimit          = 64 << 10
	messagingCollectionUploadBodyLimit    = 5*1024*1024 + (64 << 10)
	messagingCollectionAttachmentMaxBytes = 5 * 1024 * 1024
	messagingCollectionTitleMaxUnits      = 80
	messagingCollectionBodyMaxUnits       = 8000
	messagingCollectionSearchMaxUnits     = 100
	messagingCollectionPeopleMaxUnits     = 80
	messagingCollectionThreadDefaultLimit = 60
	messagingCollectionThreadMaxLimit     = 100
	messagingCollectionMentionsMax        = 20
	messagingCollectionAttachmentsMax     = 5
	messagingCollectionIntentMaxUnits     = 200
	messagingCollectionFilenameMaxUnits   = 255
	messagingCollectionMimeMaxUnits       = 120
)

// messagingCollectionHandler owns the legacy Vite messaging collection routes
// (conversations, messages, pins, reactions, search, people, attachments). Reads
// and writes both dispatch through the governed capability executor so human and
// agent traffic share the same rules, audit trail and reversibility.
type messagingCollectionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

type messagingCollectionDataResponse struct {
	OK   bool            `json:"ok"`
	Data json.RawMessage `json:"data"`
}

// NewMessagingCollectionHandler builds the authenticated messaging collection
// endpoint. Mount it with MountGoMessagingCollectionRoute behind the Go API router.
func NewMessagingCollectionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &messagingCollectionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

// MountGoMessagingCollectionRoute owns the exact Vite conversation and message
// collection paths. Every other request continues to the base handler.
func MountGoMessagingCollectionRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/conversations", route)
	mux.Handle("POST /api/conversations", route)
	mux.Handle("PATCH /api/conversations/{id}", route)
	mux.Handle("GET /api/conversations/people", route)
	mux.Handle("GET /api/conversations/{id}/messages", route)
	mux.Handle("POST /api/conversations/{id}/messages", route)
	mux.Handle("POST /api/conversations/{id}/read", route)
	mux.Handle("POST /api/conversations/{id}/attachments", route)
	mux.Handle("DELETE /api/conversations/{id}/attachments", route)
	mux.Handle("PATCH /api/messages/{id}", route)
	mux.Handle("DELETE /api/messages/{id}", route)
	mux.Handle("PATCH /api/messages/{id}/pin", route)
	mux.Handle("POST /api/messages/{id}/reactions", route)
	mux.Handle("GET /api/messages/search", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

func (h *messagingCollectionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "messaging collection unavailable"})
		return
	}
	resolved, bearer, err := h.resolve(r)
	if err != nil || resolved == nil || resolved.OrgID == nil || !resolved.EmailVerified || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		h.unauthorized(w)
		return
	}
	stateChanging := r.Method != http.MethodGet && r.Method != http.MethodHead
	if stateChanging && !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "origin check failed"})
		return
	}
	permission := "messaging.read"
	if stateChanging {
		permission = "messaging.write"
	}
	if !resolved.HasPermission(permission) && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing " + permission})
		return
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "messaging") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: Messaging module is disabled"})
		return
	}
	switch r.Pattern {
	case "GET /api/conversations":
		h.listConversations(w, r, resolved)
	case "POST /api/conversations":
		h.createConversation(w, r, resolved)
	case "PATCH /api/conversations/{id}":
		h.patchConversation(w, r, resolved)
	case "GET /api/conversations/people":
		h.listPeople(w, r, resolved)
	case "GET /api/conversations/{id}/messages":
		h.readMessages(w, r, resolved)
	case "POST /api/conversations/{id}/messages":
		h.sendMessage(w, r, resolved)
	case "POST /api/conversations/{id}/read":
		h.advanceReadCursor(w, r, resolved)
	case "POST /api/conversations/{id}/attachments":
		h.uploadAttachment(w, r, resolved)
	case "DELETE /api/conversations/{id}/attachments":
		h.deleteAttachment(w, r, resolved)
	case "PATCH /api/messages/{id}":
		h.editMessage(w, r, resolved)
	case "DELETE /api/messages/{id}":
		h.deleteMessage(w, r, resolved)
	case "PATCH /api/messages/{id}/pin":
		h.pinMessage(w, r, resolved)
	case "POST /api/messages/{id}/reactions":
		h.reactToMessage(w, r, resolved)
	case "GET /api/messages/search":
		h.searchMessages(w, r, resolved)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

func (h *messagingCollectionHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, error) {
	activeOrg, valid := activeOrganizationSelector(r)
	if !valid {
		return nil, false, session.ErrNoSession
	}
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, session.ErrNoSession
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err
}

func (h *messagingCollectionHandler) unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

func (h *messagingCollectionHandler) fail(w http.ResponseWriter, message string, err error) {
	h.logger.Error(message, "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func (h *messagingCollectionHandler) executeCapability(
	w http.ResponseWriter, r *http.Request, user *session.ResolvedUser, capabilityID, intentID string, input any,
) (capability.Result, bool) {
	payload, err := json.Marshal(input)
	if err != nil {
		h.fail(w, "Go messaging collection input encoding failed", err)
		return capability.Result{}, false
	}
	claims := messagingCollectionClaims(user, capabilityID, intentID, payload)
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, payload)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			h.unauthorized(w)
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		case messagingCollectionInternalError(err):
			h.fail(w, "Go messaging collection capability failed", err)
		default:
			writeJSON(w, messagingCollectionErrorStatus(err.Error()), map[string]string{"error": err.Error()})
		}
		return capability.Result{}, false
	}
	if result.PendingApproval {
		writeJSON(w, http.StatusAccepted, map[string]any{"pendingApproval": true, "approvalId": result.ApprovalID})
		return capability.Result{}, false
	}
	if !result.OK {
		writeJSON(w, messagingCollectionRefusalStatus(result.Error), map[string]string{"error": result.Error})
		return capability.Result{}, false
	}
	return result, true
}

func (h *messagingCollectionHandler) writeData(w http.ResponseWriter, result capability.Result) {
	if !json.Valid(result.Data) {
		h.fail(w, "Go messaging collection capability returned invalid data", errors.New("invalid capability response JSON"))
		return
	}
	writeJSON(w, http.StatusOK, result.Data)
}

func (h *messagingCollectionHandler) writeDataEnvelope(w http.ResponseWriter, result capability.Result) {
	if !json.Valid(result.Data) {
		h.fail(w, "Go messaging collection capability returned invalid data", errors.New("invalid capability response JSON"))
		return
	}
	writeJSON(w, http.StatusOK, messagingCollectionDataResponse{OK: true, Data: result.Data})
}

func messagingCollectionClaims(user *session.ResolvedUser, capabilityID, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
	permissions := make([]string, 0, len(user.Permissions))
	for permission, granted := range user.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	actorID := user.UserID
	inputHash, _ := capability.InputHash(input)
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		Subject:        user.UserID,
		OrganizationID: *user.OrgID,
		CapabilityID:   capabilityID,
		InputSHA256:    inputHash,
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    permissions,
		AuthSessionID:  user.AuthSessionID,
		IntentID:       intentID,
		IssuedAt:       now.Unix(),
		ExpiresAt:      now.Add(30 * time.Second).Unix(),
	}
}

func messagingCollectionInternalError(err error) bool {
	var postgresErr *pgconn.PgError
	if errors.As(err, &postgresErr) {
		return true
	}
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

func messagingCollectionErrorStatus(message string) int {
	lower := strings.ToLower(message)
	if strings.Contains(lower, "module") && strings.Contains(lower, "disabled") {
		return http.StatusForbidden
	}
	if strings.Contains(lower, "not found") || strings.Contains(lower, "not a member") {
		return http.StatusNotFound
	}
	return http.StatusUnprocessableEntity
}

func messagingCollectionRefusalStatus(message string) int {
	lower := strings.ToLower(message)
	if strings.HasPrefix(lower, "forbidden") {
		return http.StatusForbidden
	}
	if strings.Contains(lower, "module") && strings.Contains(lower, "disabled") {
		return http.StatusForbidden
	}
	return http.StatusUnprocessableEntity
}

func messagingCollectionInvalidBody(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
}

func messagingCollectionFields(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	if r.Body == nil {
		messagingCollectionInvalidBody(w)
		return nil, false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, messagingCollectionBodyLimit))
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		messagingCollectionInvalidBody(w)
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		messagingCollectionInvalidBody(w)
		return nil, false
	}
	return fields, true
}

// messagingCollectionOptionalFields accepts an absent body as an empty object,
// matching the legacy read-cursor route which treats a missing body as "now".
func messagingCollectionOptionalFields(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	if r.Body == nil {
		return map[string]json.RawMessage{}, true
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, messagingCollectionBodyLimit))
	var fields map[string]json.RawMessage
	err := decoder.Decode(&fields)
	if errors.Is(err, io.EOF) {
		return map[string]json.RawMessage{}, true
	}
	if err != nil || fields == nil {
		messagingCollectionInvalidBody(w)
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		messagingCollectionInvalidBody(w)
		return nil, false
	}
	return fields, true
}

func messagingCollectionAllowedKeys(fields map[string]json.RawMessage, allowed ...string) bool {
	for key := range fields {
		if !slices.Contains(allowed, key) {
			return false
		}
	}
	return true
}

func messagingCollectionUTF16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func messagingCollectionStringValue(raw json.RawMessage, minUnits, maxUnits int) (string, bool) {
	if string(raw) == "null" {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	units := messagingCollectionUTF16Length(value)
	if units < minUnits || units > maxUnits {
		return "", false
	}
	return value, true
}

func messagingCollectionRequiredString(fields map[string]json.RawMessage, key string, minUnits, maxUnits int) (string, bool) {
	raw, present := fields[key]
	if !present {
		return "", false
	}
	return messagingCollectionStringValue(raw, minUnits, maxUnits)
}

func messagingCollectionBoolValue(raw json.RawMessage) (bool, bool) {
	if string(raw) == "null" {
		return false, false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, false
	}
	return value, true
}

func messagingCollectionIntent(fields map[string]json.RawMessage) (string, bool) {
	raw, present := fields["intentId"]
	if !present {
		return "", true
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return messagingCollectionValidateIntent(value)
}

func messagingCollectionQueryIntent(r *http.Request) (string, bool) {
	return messagingCollectionValidateIntent(strings.TrimSpace(r.URL.Query().Get("intentId")))
}

func messagingCollectionValidateIntent(value string) (string, bool) {
	if value == "" {
		return "", true
	}
	if messagingCollectionUTF16Length(value) > messagingCollectionIntentMaxUnits || strings.ContainsAny(value, "\r\n\x00") {
		return "", false
	}
	return value, true
}

func messagingCollectionParseMentions(raw json.RawMessage) ([]map[string]any, bool) {
	if string(raw) == "null" {
		return nil, false
	}
	var items []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil || len(items) > messagingCollectionMentionsMax {
		return nil, false
	}
	mentions := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if len(item) != 2 {
			return nil, false
		}
		rawType, hasType := item["type"]
		rawID, hasID := item["id"]
		if !hasType || !hasID {
			return nil, false
		}
		var mentionType string
		if err := json.Unmarshal(rawType, &mentionType); err != nil || (mentionType != "user" && mentionType != "agent") {
			return nil, false
		}
		var id string
		if err := json.Unmarshal(rawID, &id); err != nil {
			return nil, false
		}
		if units := messagingCollectionUTF16Length(id); units < 1 || units > 80 {
			return nil, false
		}
		mentions = append(mentions, map[string]any{"type": mentionType, "id": id})
	}
	return mentions, true
}

func messagingCollectionParseUUIDArray(raw json.RawMessage, max int) ([]string, bool) {
	if string(raw) == "null" {
		return nil, false
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil || len(values) > max {
		return nil, false
	}
	for _, value := range values {
		if !isUUID(value) {
			return nil, false
		}
	}
	return values, true
}

var messagingCollectionDateTimePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$`)

func messagingCollectionDateTime(value string) bool {
	if !messagingCollectionDateTimePattern.MatchString(value) {
		return false
	}
	if len(value) == 17 {
		value = value[:len(value)-1] + ":00Z"
	}
	_, err := time.Parse(time.RFC3339, value)
	return err == nil
}

func (h *messagingCollectionHandler) listConversations(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	result, ok := h.executeCapability(w, r, user, "messaging.listConversations", "", struct {
		Limit int `json:"limit"`
	}{Limit: 100})
	if !ok {
		return
	}
	h.writeData(w, result)
}

func (h *messagingCollectionHandler) createConversation(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	fields, ok := messagingCollectionFields(w, r)
	if !ok {
		return
	}
	if !messagingCollectionAllowedKeys(fields, "title", "kind", "agentEnabled", "intentId") {
		messagingCollectionInvalidBody(w)
		return
	}
	title, ok := messagingCollectionRequiredString(fields, "title", 1, messagingCollectionTitleMaxUnits)
	if !ok {
		messagingCollectionInvalidBody(w)
		return
	}
	kind := "channel"
	if raw, present := fields["kind"]; present {
		value, valid := messagingCollectionStringValue(raw, 1, 10)
		if !valid || (value != "channel" && value != "dm") {
			messagingCollectionInvalidBody(w)
			return
		}
		kind = value
	}
	agentEnabled := false
	if raw, present := fields["agentEnabled"]; present {
		value, valid := messagingCollectionBoolValue(raw)
		if !valid {
			messagingCollectionInvalidBody(w)
			return
		}
		agentEnabled = value
	}
	intentID, ok := messagingCollectionIntent(fields)
	if !ok {
		messagingCollectionInvalidBody(w)
		return
	}
	result, ok := h.executeCapability(w, r, user, "messaging.createConversation", intentID, map[string]any{
		"title":        title,
		"kind":         kind,
		"agentEnabled": agentEnabled,
	})
	if !ok {
		return
	}
	if !json.Valid(result.Data) {
		h.fail(w, "Go messaging collection capability returned invalid data", errors.New("invalid capability response JSON"))
		return
	}
	writeJSON(w, http.StatusCreated, result.Data)
}

func (h *messagingCollectionHandler) patchConversation(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	conversationID := r.PathValue("id")
	if !isUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid conversation id"})
		return
	}
	fields, ok := messagingCollectionFields(w, r)
	if !ok {
		return
	}
	action, ok := messagingCollectionRequiredString(fields, "action", 1, 40)
	if !ok {
		messagingCollectionInvalidBody(w)
		return
	}
	intentID, ok := messagingCollectionIntent(fields)
	if !ok {
		messagingCollectionInvalidBody(w)
		return
	}
	input := map[string]any{"conversationId": conversationID}
	var capabilityID string
	switch action {
	case "update":
		capabilityID = "messaging.updateConversation"
		if !messagingCollectionAllowedKeys(fields, "action", "intentId", "title", "agentEnabled") {
			messagingCollectionInvalidBody(w)
			return
		}
		rawTitle, hasTitle := fields["title"]
		rawAgentEnabled, hasAgentEnabled := fields["agentEnabled"]
		if !hasTitle && !hasAgentEnabled {
			messagingCollectionInvalidBody(w)
			return
		}
		if hasTitle {
			title, valid := messagingCollectionStringValue(rawTitle, 1, messagingCollectionTitleMaxUnits)
			if !valid {
				messagingCollectionInvalidBody(w)
				return
			}
			input["title"] = title
		}
		if hasAgentEnabled {
			agentEnabled, valid := messagingCollectionBoolValue(rawAgentEnabled)
			if !valid {
				messagingCollectionInvalidBody(w)
				return
			}
			input["agentEnabled"] = agentEnabled
		}
	case "archive":
		capabilityID = "messaging.archiveConversation"
		if !messagingCollectionAllowedKeys(fields, "action", "intentId", "archived") {
			messagingCollectionInvalidBody(w)
			return
		}
		archived := true
		if raw, present := fields["archived"]; present {
			value, valid := messagingCollectionBoolValue(raw)
			if !valid {
				messagingCollectionInvalidBody(w)
				return
			}
			archived = value
		}
		input["archived"] = archived
	case "leave":
		capabilityID = "messaging.leaveConversation"
		if !messagingCollectionAllowedKeys(fields, "action", "intentId") {
			messagingCollectionInvalidBody(w)
			return
		}
	case "addMember":
		capabilityID = "messaging.addMember"
		if !messagingCollectionAllowedKeys(fields, "action", "intentId", "userId") {
			messagingCollectionInvalidBody(w)
			return
		}
		memberID, valid := messagingCollectionRequiredString(fields, "userId", 36, 36)
		if !valid || !isUUID(memberID) {
			messagingCollectionInvalidBody(w)
			return
		}
		input["userId"] = memberID
	case "delete":
		capabilityID = "messaging.deleteConversation"
		if !messagingCollectionAllowedKeys(fields, "action", "intentId") {
			messagingCollectionInvalidBody(w)
			return
		}
	default:
		messagingCollectionInvalidBody(w)
		return
	}
	result, ok := h.executeCapability(w, r, user, capabilityID, intentID, input)
	if !ok {
		return
	}
	h.writeDataEnvelope(w, result)
}

func (h *messagingCollectionHandler) readMessages(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	conversationID := r.PathValue("id")
	if !isUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid conversation id"})
		return
	}
	limit := int64(messagingCollectionThreadDefaultLimit)
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < 1 || value > messagingCollectionThreadMaxLimit {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid limit"})
			return
		}
		limit = value
	}
	before := strings.TrimSpace(r.URL.Query().Get("before"))
	around := strings.TrimSpace(r.URL.Query().Get("around"))
	if before != "" && around != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid message cursor"})
		return
	}
	if before != "" && !isUUID(before) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid message cursor"})
		return
	}
	if around != "" && !isUUID(around) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid message cursor"})
		return
	}
	input := map[string]any{"conversationId": conversationID, "limit": limit}
	if before != "" {
		input["before"] = before
	}
	if around != "" {
		input["around"] = around
	}
	result, ok := h.executeCapability(w, r, user, "messaging.readMessages", "", input)
	if !ok {
		return
	}
	h.writeData(w, result)
}

func (h *messagingCollectionHandler) sendMessage(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	conversationID := r.PathValue("id")
	if !isUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid conversation id"})
		return
	}
	fields, ok := messagingCollectionFields(w, r)
	if !ok {
		return
	}
	if !messagingCollectionAllowedKeys(fields, "body", "mentions", "parentMessageId", "attachmentIds", "intentId") {
		messagingCollectionInvalidBody(w)
		return
	}
	body, ok := messagingCollectionRequiredString(fields, "body", 0, messagingCollectionBodyMaxUnits)
	if !ok {
		messagingCollectionInvalidBody(w)
		return
	}
	intentID, ok := messagingCollectionIntent(fields)
	if !ok {
		messagingCollectionInvalidBody(w)
		return
	}
	input := map[string]any{"conversationId": conversationID, "body": body}
	if raw, present := fields["mentions"]; present {
		mentions, valid := messagingCollectionParseMentions(raw)
		if !valid {
			messagingCollectionInvalidBody(w)
			return
		}
		input["mentions"] = mentions
	}
	if raw, present := fields["parentMessageId"]; present {
		parentID, valid := messagingCollectionStringValue(raw, 36, 36)
		if !valid || !isUUID(parentID) {
			messagingCollectionInvalidBody(w)
			return
		}
		input["parentMessageId"] = parentID
	}
	if raw, present := fields["attachmentIds"]; present {
		attachmentIDs, valid := messagingCollectionParseUUIDArray(raw, messagingCollectionAttachmentsMax)
		if !valid {
			messagingCollectionInvalidBody(w)
			return
		}
		input["attachmentIds"] = attachmentIDs
	}
	result, ok := h.executeCapability(w, r, user, "messaging.sendMessage", intentID, input)
	if !ok {
		return
	}
	var output struct {
		MessageID string `json:"messageId"`
	}
	if json.Unmarshal(result.Data, &output) != nil || output.MessageID == "" {
		h.fail(w, "Go messaging collection capability returned invalid data", errors.New("invalid sendMessage response"))
		return
	}
	// Agent replies stay on the dedicated agent-reply route so a slow model call
	// never blocks the human send. The Vite caller drives that route itself.
	writeJSON(w, http.StatusOK, struct {
		OK         bool    `json:"ok"`
		AgentReply *string `json:"agentReply"`
	}{OK: true})
}

func (h *messagingCollectionHandler) advanceReadCursor(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	conversationID := r.PathValue("id")
	if !isUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid conversation id"})
		return
	}
	fields, ok := messagingCollectionOptionalFields(w, r)
	if !ok {
		return
	}
	if !messagingCollectionAllowedKeys(fields, "readAt") {
		messagingCollectionInvalidBody(w)
		return
	}
	input := map[string]any{"conversationId": conversationID}
	if raw, present := fields["readAt"]; present {
		if string(raw) == "null" {
			input["readAt"] = nil
		} else {
			value, valid := messagingCollectionStringValue(raw, 1, 40)
			if !valid || !messagingCollectionDateTime(value) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid read position"})
				return
			}
			input["readAt"] = value
		}
	}
	result, ok := h.executeCapability(w, r, user, "messaging.advanceReadCursor", "", input)
	if !ok {
		return
	}
	h.writeDataEnvelope(w, result)
}

func (h *messagingCollectionHandler) listPeople(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if messagingCollectionUTF16Length(query) > messagingCollectionPeopleMaxUnits {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid query"})
		return
	}
	input := map[string]any{"limit": 100}
	if query != "" {
		input["query"] = query
		input["limit"] = 30
	}
	result, ok := h.executeCapability(w, r, user, "messaging.listPeople", "", input)
	if !ok {
		return
	}
	h.writeData(w, result)
}

func (h *messagingCollectionHandler) searchMessages(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if messagingCollectionUTF16Length(query) < 2 {
		writeJSON(w, http.StatusOK, struct {
			Results []any `json:"results"`
		}{Results: []any{}})
		return
	}
	if messagingCollectionUTF16Length(query) > messagingCollectionSearchMaxUnits {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "search text is too long"})
		return
	}
	result, ok := h.executeCapability(w, r, user, "messaging.searchMessages", "", map[string]any{"query": query})
	if !ok {
		return
	}
	h.writeData(w, result)
}

func (h *messagingCollectionHandler) editMessage(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	messageID := r.PathValue("id")
	if !isUUID(messageID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid message id"})
		return
	}
	fields, ok := messagingCollectionFields(w, r)
	if !ok {
		return
	}
	if !messagingCollectionAllowedKeys(fields, "body", "intentId") {
		messagingCollectionInvalidBody(w)
		return
	}
	body, ok := messagingCollectionRequiredString(fields, "body", 1, messagingCollectionBodyMaxUnits)
	if !ok {
		messagingCollectionInvalidBody(w)
		return
	}
	intentID, ok := messagingCollectionIntent(fields)
	if !ok {
		messagingCollectionInvalidBody(w)
		return
	}
	result, ok := h.executeCapability(w, r, user, "messaging.editMessage", intentID, map[string]any{
		"messageId": messageID,
		"body":      body,
	})
	if !ok {
		return
	}
	h.writeDataEnvelope(w, result)
}

func (h *messagingCollectionHandler) deleteMessage(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	messageID := r.PathValue("id")
	if !isUUID(messageID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid message id"})
		return
	}
	intentID, ok := messagingCollectionQueryIntent(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid intent id"})
		return
	}
	result, ok := h.executeCapability(w, r, user, "messaging.deleteMessage", intentID, map[string]any{
		"messageId": messageID,
	})
	if !ok {
		return
	}
	h.writeDataEnvelope(w, result)
}

func (h *messagingCollectionHandler) pinMessage(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	messageID := r.PathValue("id")
	if !isUUID(messageID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid message id"})
		return
	}
	fields, ok := messagingCollectionFields(w, r)
	if !ok {
		return
	}
	if !messagingCollectionAllowedKeys(fields, "pinned") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid pin state"})
		return
	}
	raw, present := fields["pinned"]
	if !present {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid pin state"})
		return
	}
	pinned, valid := messagingCollectionBoolValue(raw)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid pin state"})
		return
	}
	result, ok := h.executeCapability(w, r, user, "messaging.setMessagePin", "", map[string]any{
		"messageId": messageID,
		"pinned":    pinned,
	})
	if !ok {
		return
	}
	if !json.Valid(result.Data) {
		h.fail(w, "Go messaging collection capability returned invalid data", errors.New("invalid capability response JSON"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

var messagingCollectionReactionEmojis = map[string]struct{}{
	"👍": {}, "❤️": {}, "🎉": {}, "✅": {}, "👀": {},
}

func (h *messagingCollectionHandler) reactToMessage(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	messageID := r.PathValue("id")
	if !isUUID(messageID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid message id"})
		return
	}
	fields, ok := messagingCollectionFields(w, r)
	if !ok {
		return
	}
	if !messagingCollectionAllowedKeys(fields, "emoji", "active") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid reaction"})
		return
	}
	emoji, valid := messagingCollectionRequiredString(fields, "emoji", 1, 16)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid reaction"})
		return
	}
	if _, allowed := messagingCollectionReactionEmojis[emoji]; !allowed {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid reaction"})
		return
	}
	rawActive, present := fields["active"]
	if !present {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid reaction"})
		return
	}
	active, valid := messagingCollectionBoolValue(rawActive)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid reaction"})
		return
	}
	result, ok := h.executeCapability(w, r, user, "messaging.setMessageReaction", "", map[string]any{
		"messageId": messageID,
		"emoji":     emoji,
		"active":    active,
	})
	if !ok {
		return
	}
	if !json.Valid(result.Data) {
		h.fail(w, "Go messaging collection capability returned invalid data", errors.New("invalid capability response JSON"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *messagingCollectionHandler) uploadAttachment(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	conversationID := r.PathValue("id")
	if !isUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid conversation id"})
		return
	}
	if h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "messaging collection unavailable"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, messagingCollectionUploadBodyLimit)
	if err := r.ParseMultipartForm(messagingCollectionAttachmentMaxBytes); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "attachments must be between 1 byte and 5 MB"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "choose a file to attach"})
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "choose a file to attach"})
		return
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, messagingCollectionAttachmentMaxBytes+1))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "attachments must be between 1 byte and 5 MB"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "choose a file to attach"})
		return
	}
	if len(content) == 0 || len(content) > messagingCollectionAttachmentMaxBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "attachments must be between 1 byte and 5 MB"})
		return
	}
	filename := header.Filename
	if messagingCollectionUTF16Length(filename) < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "choose a file to attach"})
		return
	}
	if messagingCollectionUTF16Length(filename) > messagingCollectionFilenameMaxUnits {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file name is too long"})
		return
	}
	mimeType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if mimeType == "" || messagingCollectionUTF16Length(mimeType) > messagingCollectionMimeMaxUnits {
		mimeType = "application/octet-stream"
	}
	result, ok := h.executeCapability(w, r, user, "messaging.uploadMessageAttachment", "", map[string]any{
		"conversationId": conversationID,
		"filename":       filename,
		"mimeType":       mimeType,
		"contentBase64":  base64.StdEncoding.EncodeToString(content),
	})
	if !ok {
		return
	}
	var output struct {
		AttachmentID string `json:"attachmentId"`
	}
	if json.Unmarshal(result.Data, &output) != nil || output.AttachmentID == "" {
		h.fail(w, "Go messaging collection capability returned invalid data", errors.New("invalid uploadMessageAttachment response"))
		return
	}
	writeJSON(w, http.StatusOK, struct {
		AttachmentID string `json:"attachmentId"`
		Filename     string `json:"filename"`
		MimeType     string `json:"mimeType"`
		SizeBytes    int    `json:"sizeBytes"`
	}{AttachmentID: output.AttachmentID, Filename: filename, MimeType: mimeType, SizeBytes: len(content)})
}

func (h *messagingCollectionHandler) deleteAttachment(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser) {
	if !isUUID(r.PathValue("id")) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid conversation id"})
		return
	}
	fields, ok := messagingCollectionFields(w, r)
	if !ok {
		return
	}
	if !messagingCollectionAllowedKeys(fields, "attachmentId") {
		messagingCollectionInvalidBody(w)
		return
	}
	attachmentID, ok := messagingCollectionRequiredString(fields, "attachmentId", 36, 36)
	if !ok || !isUUID(attachmentID) {
		messagingCollectionInvalidBody(w)
		return
	}
	result, ok := h.executeCapability(w, r, user, "messaging.deletePendingAttachment", "", map[string]any{
		"attachmentId": attachmentID,
	})
	if !ok {
		return
	}
	if !json.Valid(result.Data) {
		h.fail(w, "Go messaging collection capability returned invalid data", errors.New("invalid capability response JSON"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
