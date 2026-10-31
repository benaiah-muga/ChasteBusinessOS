package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const messagingPresenceBodyLimit = 8 << 10

type messagingPresenceHandler struct {
	pool              *pgxpool.Pool
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

type messagingPresencePerson struct {
	UserID string `json:"userId"`
	Name   string `json:"name"`
	Typing bool   `json:"typing"`
}

type messagingPresenceResponse struct {
	People []messagingPresencePerson `json:"people"`
}

type messagingPresenceBody struct {
	Typing   *bool  `json:"typing"`
	IntentID string `json:"intentId"`
}

func NewMessagingPresenceHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &messagingPresenceHandler{pool: pool, resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *messagingPresenceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.pool == nil || h.resolver == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "messaging presence unavailable"})
		return
	}
	conversationID := r.PathValue("id")
	if conversationID == "" {
		conversationID = strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/conversations/"), "/")
		conversationID = strings.TrimSuffix(conversationID, "/presence")
	}
	if !isUUID(conversationID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid conversation id"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		h.unauthorized(w)
		return
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		h.unauthorized(w)
		return
	}
	if r.Method != http.MethodGet && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	permission := "messaging.read"
	if r.Method == http.MethodPost {
		permission = "messaging.write"
	}
	if !resolved.HasPermission(permission) && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "messaging") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: Messaging module is disabled"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.list(w, r, resolved, conversationID)
	case http.MethodPost:
		var body messagingPresenceBody
		if err := decodeMessagingPresenceBody(w, r, &body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		h.update(w, r, resolved, conversationID, *body.Typing, body.IntentID)
	}
}

func decodeMessagingPresenceBody(w http.ResponseWriter, r *http.Request, body *messagingPresenceBody) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, messagingPresenceBodyLimit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(body); err != nil || body.Typing == nil {
		return errors.New("invalid body")
	}
	if body.IntentID == "" || len(body.IntentID) > 160 || strings.ContainsAny(body.IntentID, "\r\n\x00") {
		return errors.New("invalid intent id")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("invalid trailing body")
	}
	return nil
}

func (h *messagingPresenceHandler) list(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser, conversationID string) {
	now := time.Now().UTC()
	result, err := dbx.WithOrgTx(r.Context(), h.pool, *user.OrgID, func(tx pgx.Tx) (messagingPresenceResponse, error) {
		member, err := messagingPresenceMember(r.Context(), tx, *user.OrgID, conversationID, user.UserID)
		if err != nil {
			return messagingPresenceResponse{}, err
		}
		if !member {
			return messagingPresenceResponse{}, errMessagingPresenceNotFound
		}
		rows, err := tx.Query(r.Context(), `
			SELECT p.user_id::text, COALESCE(u.name, u.email), p.typing_until
			FROM conversation_presence p
			JOIN users u ON u.id = p.user_id
			JOIN conversation_members cm ON cm.conversation_id = p.conversation_id AND cm.user_id = p.user_id
			WHERE p.org_id = $1::uuid AND p.conversation_id = $2::uuid
			  AND p.user_id <> $3::uuid AND p.last_seen_at > $4
			ORDER BY u.name NULLS LAST, u.email`, *user.OrgID, conversationID, user.UserID, now.Add(-45*time.Second))
		if err != nil {
			return messagingPresenceResponse{}, err
		}
		defer rows.Close()
		response := messagingPresenceResponse{People: []messagingPresencePerson{}}
		for rows.Next() {
			var person messagingPresencePerson
			var typingUntil *time.Time
			if err := rows.Scan(&person.UserID, &person.Name, &typingUntil); err != nil {
				return messagingPresenceResponse{}, err
			}
			person.Typing = typingUntil != nil && typingUntil.After(now)
			response.People = append(response.People, person)
		}
		if err := rows.Err(); err != nil {
			return messagingPresenceResponse{}, err
		}
		return response, nil
	})
	if errors.Is(err, errMessagingPresenceNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		h.fail(w, "Go conversation presence read failed", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *messagingPresenceHandler) update(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser, conversationID string, typing bool, intentID string) {
	if h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "capability execution unavailable"})
		return
	}
	input, err := json.Marshal(struct {
		ConversationID string `json:"conversationId"`
		Typing         bool   `json:"typing"`
	}{ConversationID: conversationID, Typing: typing})
	if err != nil {
		h.fail(w, "Go conversation presence input encoding failed", err)
		return
	}
	inputHash, err := capability.InputHash(input)
	if err != nil {
		h.fail(w, "Go conversation presence input hashing failed", err)
		return
	}
	permissions := make([]string, 0, len(user.Permissions))
	for permission, granted := range user.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	actorID := user.UserID
	now := time.Now().UTC()
	claims := authbridge.CapabilityClaims{
		Audience:       "go.capability.execute",
		Subject:        user.UserID,
		OrganizationID: *user.OrgID,
		CapabilityID:   messagingPresenceCapabilityID,
		InputSHA256:    inputHash,
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    permissions,
		AuthSessionID:  user.AuthSessionID,
		IntentID:       intentID,
		IssuedAt:       now.Unix(),
		ExpiresAt:      now.Add(30 * time.Second).Unix(),
	}
	result, err := h.executor.Execute(r.Context(), claims, messagingPresenceCapabilityID, input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			h.fail(w, "Go conversation presence capability failed", err)
		}
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason, "approvalId": result.ApprovalID})
		return
	}
	if !result.OK {
		status := http.StatusUnprocessableEntity
		if strings.HasPrefix(strings.ToLower(result.Error), "forbidden") || strings.Contains(strings.ToLower(result.Error), "module") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]string{"error": result.Error})
		return
	}
	if !json.Valid(result.Data) {
		h.fail(w, "Go conversation presence capability returned invalid data", errors.New("invalid capability response JSON"))
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: result.Data})
}

var errMessagingPresenceNotFound = errors.New("conversation presence target not found")

const messagingPresenceCapabilityID = "messaging.updateConversationPresence"

func messagingPresenceMember(ctx context.Context, tx pgx.Tx, orgID, conversationID, userID string) (bool, error) {
	var member bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversations c
			JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $3::uuid
			WHERE c.id = $2::uuid AND c.org_id = $1::uuid AND c.deleted_at IS NULL
		)`, orgID, conversationID, userID).Scan(&member)
	return member, err
}

func (h *messagingPresenceHandler) unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

func (h *messagingPresenceHandler) fail(w http.ResponseWriter, message string, err error) {
	h.logger.Error(message, "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}
