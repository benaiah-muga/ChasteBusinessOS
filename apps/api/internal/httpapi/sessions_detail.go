package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	sessionDetailEventLimit      = 10_000
	sessionDetailEventBytesLimit = 256 << 10
	sessionDetailTotalBytesLimit = 8 << 20
)

type sessionsDetailResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type sessionDetailEvent struct {
	Seq     int64           `json:"seq"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	At      string          `json:"at"`
}

type sessionDetailRecord struct {
	ID         string          `json:"id"`
	OrgID      string          `json:"orgId"`
	UserID     *string         `json:"userId"`
	Title      *string         `json:"title"`
	Mode       string          `json:"mode"`
	Status     string          `json:"status"`
	Summary    *string         `json:"summary"`
	ModelRef   *string         `json:"modelRef"`
	TokenUsage json.RawMessage `json:"tokenUsage"`
	CreatedAt  string          `json:"createdAt"`
	UpdatedAt  string          `json:"updatedAt"`
}

type sessionDetailData struct {
	Session sessionDetailRecord
	Events  []sessionDetailEvent
}

type sessionDetailReadResult struct {
	Data  sessionDetailData
	Found bool
}

type sessionDetailReader interface {
	Read(context.Context, string, string, string, bool) (sessionDetailReadResult, error)
}

type SessionsDetailHandler struct {
	resolver sessionsDetailResolver
	reader   sessionDetailReader
	logger   *slog.Logger
}

// NewSessionsDetailHandler serves the legacy session detail and replay routes
// from the verified Go session and the active organization.
func NewSessionsDetailHandler(resolver sessionsDetailResolver, pool *pgxpool.Pool, logger *slog.Logger) http.Handler {
	return &SessionsDetailHandler{resolver: resolver, reader: postgresSessionDetailReader{pool: pool}, logger: logger}
}

func (h *SessionsDetailHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sessions service unavailable"})
		return
	}
	id, replay, ok := parseSessionDetailPath(r.URL.Path)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || resolved.AuthSessionID == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}

	canReadOtherUsers := resolved.HasPermission("iam.admin") || resolved.HasPermission("*")
	readResult, err := h.reader.Read(r.Context(), *resolved.OrgID, id, resolved.UserID, canReadOtherUsers)
	if err != nil {
		if errors.Is(err, errSessionDetailTooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "session trajectory exceeds the response limit"})
			return
		}
		if h.logger != nil {
			h.logger.Error("Go session detail read failed", "organizationId", *resolved.OrgID, "sessionId", id, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !readResult.Found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	data := readResult.Data
	if replay {
		trace, err := replaySessionDetail(data.Events)
		if err != nil {
			if h.logger != nil {
				h.logger.Error("Go session replay failed", "organizationId", *resolved.OrgID, "sessionId", id, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session replay failed"})
			return
		}
		response := map[string]any{"trace": trace}
		if sessionResponseExceedsBounds(response) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "session trajectory exceeds the response limit"})
			return
		}
		writeJSON(w, http.StatusOK, response)
		return
	}
	response := map[string]any{"session": data.Session, "events": data.Events}
	if sessionResponseExceedsBounds(response) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "session trajectory exceeds the response limit"})
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *SessionsDetailHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}

func parseSessionDetailPath(path string) (string, bool, bool) {
	const prefix = "/api/sessions/"
	if !strings.HasPrefix(path, prefix) {
		return "", false, false
	}
	remaining := strings.TrimPrefix(path, prefix)
	replay := strings.HasSuffix(remaining, "/replay")
	if replay {
		remaining = strings.TrimSuffix(remaining, "/replay")
	}
	if strings.Contains(remaining, "/") || !isUUID(remaining) {
		return "", false, false
	}
	return remaining, replay, true
}

type postgresSessionDetailReader struct {
	pool *pgxpool.Pool
}

func (reader postgresSessionDetailReader) Read(ctx context.Context, orgID, sessionID, userID string, admin bool) (sessionDetailReadResult, error) {
	if reader.pool == nil {
		return sessionDetailReadResult{}, errors.New("session detail database is unavailable")
	}
	return dbx.WithOrgTxOptions(ctx, reader.pool, orgID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) (sessionDetailReadResult, error) {
		var data sessionDetailData
		var createdAt, updatedAt time.Time
		var tokenUsage []byte
		err := tx.QueryRow(ctx, `
			SELECT id::text, org_id::text, user_id::text, title, mode, status, summary,
			       model_ref, token_usage, created_at, updated_at
			FROM agent_sessions
			WHERE id = $1::uuid AND org_id = $2::uuid
			  AND ($4::boolean OR user_id = $3::uuid)`, sessionID, orgID, userID, admin).Scan(
			&data.Session.ID, &data.Session.OrgID, &data.Session.UserID, &data.Session.Title,
			&data.Session.Mode, &data.Session.Status, &data.Session.Summary, &data.Session.ModelRef,
			&tokenUsage, &createdAt, &updatedAt,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionDetailReadResult{}, nil
		}
		if err != nil {
			return sessionDetailReadResult{}, err
		}
		data.Session.TokenUsage = append(json.RawMessage(nil), tokenUsage...)
		data.Session.CreatedAt = legacySessionTime(createdAt)
		data.Session.UpdatedAt = legacySessionTime(updatedAt)

		var eventCount, maxEventBytes, totalEventBytes int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*), COALESCE(max(octet_length(content::text)), 0),
			       COALESCE(sum(octet_length(content::text)), 0)
			FROM session_events
			WHERE session_id = $1::uuid`, sessionID).Scan(&eventCount, &maxEventBytes, &totalEventBytes); err != nil {
			return sessionDetailReadResult{}, err
		}
		if eventCount > sessionDetailEventLimit || maxEventBytes > sessionDetailEventBytesLimit || totalEventBytes > sessionDetailTotalBytesLimit {
			return sessionDetailReadResult{}, errSessionDetailTooLarge
		}

		rows, err := tx.Query(ctx, `
			SELECT seq, role, content, created_at
			FROM session_events
			WHERE session_id = $1::uuid
			ORDER BY seq ASC
			LIMIT $2`, sessionID, sessionDetailEventLimit+1)
		if err != nil {
			return sessionDetailReadResult{}, err
		}
		defer rows.Close()
		data.Events = make([]sessionDetailEvent, 0)
		var totalBytes int
		for rows.Next() {
			var event sessionDetailEvent
			var content []byte
			var created time.Time
			if err := rows.Scan(&event.Seq, &event.Role, &content, &created); err != nil {
				return sessionDetailReadResult{}, err
			}
			if len(data.Events) >= sessionDetailEventLimit || len(content) > sessionDetailEventBytesLimit {
				return sessionDetailReadResult{}, errSessionDetailTooLarge
			}
			totalBytes += len(content)
			if totalBytes > sessionDetailTotalBytesLimit {
				return sessionDetailReadResult{}, errSessionDetailTooLarge
			}
			event.Content = append(json.RawMessage(nil), content...)
			event.At = legacySessionTime(created)
			data.Events = append(data.Events, event)
		}
		if err := rows.Err(); err != nil {
			return sessionDetailReadResult{}, err
		}
		return sessionDetailReadResult{Data: data, Found: true}, nil
	})
}

var errSessionDetailTooLarge = errors.New("session trajectory exceeds response limit")

func sessionResponseExceedsBounds(response any) bool {
	encoded, err := json.Marshal(response)
	return err != nil || len(encoded)+1 > sessionDetailTotalBytesLimit
}

func legacySessionTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

type replayDetailToolCall struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Args *any   `json:"args,omitempty"`
}

type replayDetailMessage struct {
	Role       string                 `json:"role"`
	Content    string                 `json:"content"`
	ToolCalls  []replayDetailToolCall `json:"toolCalls,omitempty"`
	ToolCallID *string                `json:"toolCallId,omitempty"`
}

type replayDetailObservation struct {
	Seq    int64  `json:"seq"`
	Name   string `json:"name"`
	Result string `json:"result"`
}

type replayDetailTrace struct {
	Messages     []replayDetailMessage     `json:"messages"`
	Observations []replayDetailObservation `json:"observations"`
	FinalMessage string                    `json:"finalMessage"`
	EventCount   int                       `json:"eventCount"`
}

func replaySessionDetail(events []sessionDetailEvent) (replayDetailTrace, error) {
	trace := replayDetailTrace{
		Messages:     make([]replayDetailMessage, 0, len(events)),
		Observations: make([]replayDetailObservation, 0),
		EventCount:   len(events),
	}
	type pendingCall struct {
		name string
		id   string
	}
	var pending []pendingCall
	var previous int64
	for _, event := range events {
		if event.Seq <= previous {
			return replayDetailTrace{}, errors.New("trajectory replay requires strictly increasing sequence numbers")
		}
		previous = event.Seq
		var content any
		if err := json.Unmarshal(event.Content, &content); err != nil {
			return replayDetailTrace{}, err
		}
		fields, _ := content.(map[string]any)
		switch event.Role {
		case "user", "assistant":
			text, exists := fields["text"].(string)
			if !exists {
				text = string(event.Content)
			}
			trace.Messages = append(trace.Messages, replayDetailMessage{Role: event.Role, Content: text})
			if event.Role == "assistant" {
				trace.FinalMessage = text
			}
		case "tool_call":
			name, ok := fields["name"].(string)
			if !ok {
				return replayDetailTrace{}, errors.New("tool_call observation is missing its name")
			}
			id := "replay-" + strconv.FormatInt(event.Seq, 10)
			call := replayDetailToolCall{ID: id, Name: name}
			if args, exists := fields["args"]; exists {
				call.Args = &args
			}
			pending = append(pending, pendingCall{name: name, id: id})
			trace.Messages = append(trace.Messages, replayDetailMessage{Role: "assistant", Content: "", ToolCalls: []replayDetailToolCall{call}})
		case "tool":
			name, nameOK := fields["name"].(string)
			result, resultOK := fields["result"].(string)
			if !nameOK || !resultOK {
				return replayDetailTrace{}, errors.New("tool observation is missing its name or stored result")
			}
			var callID *string
			for index := len(pending) - 1; index >= 0; index-- {
				if pending[index].name == name {
					id := pending[index].id
					callID = &id
					break
				}
			}
			trace.Observations = append(trace.Observations, replayDetailObservation{Seq: event.Seq, Name: name, Result: result})
			trace.Messages = append(trace.Messages, replayDetailMessage{Role: "tool", Content: result, ToolCallID: callID})
		}
	}
	return trace, nil
}
