package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

// chatSteeringMaxPerSession bounds one session's queue. The process-local
// store is a conversational affordance, and a bound keeps a client that
// hammers steer from growing the API process heap without limit.
const chatSteeringMaxPerSession = 64

// chatSteeringStore holds messages typed while a session's agent loop is
// running; the loop drains them between model steps and the handler persists
// them into the trajectory at injection time.
type chatSteeringStore struct {
	mu     sync.Mutex
	queues map[string][]string
}

func newChatSteeringStore() *chatSteeringStore {
	return &chatSteeringStore{queues: make(map[string][]string)}
}

func (s *chatSteeringStore) push(sessionID, text string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := append(s.queues[sessionID], text)
	if len(queue) > chatSteeringMaxPerSession {
		queue = queue[len(queue)-chatSteeringMaxPerSession:]
	}
	s.queues[sessionID] = queue
}

func (s *chatSteeringStore) drain(sessionID string) []string {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.queues[sessionID]
	delete(s.queues, sessionID)
	return queue
}

type chatSteerSessionStore interface {
	Owned(ctx context.Context, orgID, sessionID, userID string) (bool, error)
}

type chatSteerSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	store             chatSteerSessionStore
	steering          *chatSteeringStore
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func newChatSteerHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, steering *chatSteeringStore, logger *slog.Logger, trustedProxyCIDRs []*net.IPNet) *chatSteerSessionHandler {
	if steering == nil {
		steering = newChatSteeringStore()
	}
	return &chatSteerSessionHandler{
		resolver:          resolver,
		store:             newChatPostgresSessionStore(pool),
		steering:          steering,
		logger:            logger,
		trustedProxyCIDRs: trustedProxyCIDRs,
	}
}

type chatSteerSessionBody struct {
	SessionID json.RawMessage `json:"sessionId"`
	Message   string          `json:"message"`
}

func decodeChatSteerSessionRequest(response http.ResponseWriter, request *http.Request) (sessionID, message string, ok bool) {
	request.Body = http.MaxBytesReader(response, request.Body, chatBodyMaxBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var body chatSteerSessionBody
	if err := decoder.Decode(&body); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", "", false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", "", false
	}
	if err := json.Unmarshal(body.SessionID, &sessionID); err != nil || !isUUID(sessionID) {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", "", false
	}
	if utf16Length(body.Message) < 1 || utf16Length(body.Message) > chatMessageMaxUnits {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return "", "", false
	}
	return strings.ToLower(sessionID), body.Message, true
}

func (h *chatSteerSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "chat service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, h.resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.AuthSessionID == "" ||
		resolved.OrgID == nil || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
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
	sessionID, message, ok := decodeChatSteerSessionRequest(w, r)
	if !ok {
		return
	}
	owned, err := h.store.Owned(r.Context(), *resolved.OrgID, sessionID, resolved.UserID)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go chat steer could not verify session ownership", "sessionId", sessionID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !owned {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	h.steering.push(sessionID, message)
	writeJSON(w, http.StatusOK, map[string]bool{"queued": true})
}
