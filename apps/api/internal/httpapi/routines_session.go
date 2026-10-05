package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
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

const routinesSessionBodyLimit = 64 << 10

type routinesWebhookTokenReader interface {
	ForOrganization(context.Context, string) (map[string]string, error)
}

type pgRoutinesWebhookTokenReader struct{ pool *pgxpool.Pool }

func (r pgRoutinesWebhookTokenReader) ForOrganization(ctx context.Context, orgID string) (map[string]string, error) {
	if r.pool == nil {
		return nil, errors.New("routines database unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (map[string]string, error) {
		rows, err := tx.Query(ctx, `SELECT id::text, webhook_token FROM routines WHERE org_id=$1::uuid AND webhook_token IS NOT NULL`, orgID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		tokens := make(map[string]string)
		for rows.Next() {
			var id, token string
			if err := rows.Scan(&id, &token); err != nil {
				return nil, err
			}
			tokens[id] = token
		}
		return tokens, rows.Err()
	})
}

type RoutinesSessionHandler struct {
	pool              *pgxpool.Pool
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	tokenReader       routinesWebhookTokenReader
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewRoutinesSessionHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &RoutinesSessionHandler{
		pool: pool, resolver: resolver, executor: executor,
		tokenReader: pgRoutinesWebhookTokenReader{pool: pool}, logger: logger,
		trustedProxyCIDRs: trusted,
	}
}

func (h *RoutinesSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil || h.tokenReader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "routines service unavailable"})
		return
	}
	resolved, bearer, ok := h.resolve(r)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if r.Method == http.MethodPost && !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if r.Method == http.MethodGet {
		h.list(w, r, resolved)
		return
	}
	h.write(w, r, resolved)
}

func (h *RoutinesSessionHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, bool) {
	activeOrg, valid := activeOrganizationSelector(r)
	if !valid {
		return nil, false, false
	}
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, false
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err == nil
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err == nil
}

func (h *RoutinesSessionHandler) list(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	input := json.RawMessage(`{}`)
	claims := routinesSessionClaims(resolved, "", "routines.list", input)
	result, err := h.executor.Execute(r.Context(), claims, "routines.list", input)
	if err != nil {
		h.writeExecutionError(w, err)
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	var listed capability.RoutinesListOutput
	if err := json.Unmarshal(result.Data, &listed); err != nil {
		h.logger.Error("Go routines list response was invalid", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	tokens, err := h.tokenReader.ForOrganization(r.Context(), *resolved.OrgID)
	if err != nil {
		h.logger.Error("Go routines webhook URL lookup failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	origin := routinesRequestOrigin(r, h.trustedProxyCIDRs)
	rows := make([]map[string]any, 0, len(listed.Routines))
	for _, routine := range listed.Routines {
		var webhookURL *string
		if token, exists := tokens[routine.ID]; exists {
			value := origin + "/api/routines/webhook/" + url.PathEscape(token)
			webhookURL = &value
		}
		rows = append(rows, map[string]any{
			"id": routine.ID, "name": routine.Name, "scheduleLabel": routine.ScheduleLabel,
			"triggerType": routine.TriggerType, "enabled": routine.Enabled, "nextRunAt": routine.NextRunAt,
			"lastRunAt": routine.LastRunAt, "lastStatus": routine.LastStatus, "lastError": routine.LastError,
			"webhookUrl": webhookURL,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"routines": rows})
}

func (h *RoutinesSessionHandler) write(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, routinesSessionBodyLimit)
	decoder := json.NewDecoder(r.Body)
	var fields map[string]json.RawMessage
	if decoder.Decode(&fields) != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	action, ok := routinesAction(fields["action"])
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID, ok := parseProjectIntentID(fields["intentId"])
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	capabilityID, input, parseErr := parseRoutineAction(action, fields)
	if parseErr != nil {
		status := http.StatusBadRequest
		if strings.Contains(parseErr.Error(), "could not parse") {
			status = http.StatusUnprocessableEntity
		}
		writeJSON(w, status, map[string]string{"error": parseErr.Error()})
		return
	}
	claims := routinesSessionClaims(resolved, intentID, capabilityID, input)
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		h.writeExecutionError(w, err)
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
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	var output map[string]json.RawMessage
	if err := json.Unmarshal(result.Data, &output); err != nil {
		h.logger.Error("Go routines action response was invalid", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if action == "create" {
		var token *string
		if rawToken := output["webhookToken"]; len(rawToken) > 0 && string(rawToken) != "null" {
			var value string
			if err := json.Unmarshal(rawToken, &value); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
				return
			}
			token = &value
		}
		var webhookURL *string
		if token != nil {
			value := routinesRequestOrigin(r, h.trustedProxyCIDRs) + "/api/routines/webhook/" + url.PathEscape(*token)
			webhookURL = &value
		}
		encoded, err := json.Marshal(webhookURL)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		output["webhookUrl"] = encoded
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(encoded))
}

func routinesAction(raw json.RawMessage) (string, bool) {
	var action string
	if err := json.Unmarshal(raw, &action); err != nil {
		return "", false
	}
	switch action {
	case "create", "update", "delete", "runNow":
		return action, true
	default:
		return "", false
	}
}

func parseRoutineAction(action string, fields map[string]json.RawMessage) (string, json.RawMessage, error) {
	allowed := map[string][]string{
		"create": {"name", "prompt", "scheduleText", "withWebhook"},
		"update": {"routineId", "name", "prompt", "scheduleText", "enabled"},
		"delete": {"routineId"},
		"runNow": {"routineId"},
	}[action]
	inputFields := make(map[string]json.RawMessage, len(allowed))
	for _, key := range allowed {
		if value, exists := fields[key]; exists {
			inputFields[key] = value
		}
	}
	if action == "create" {
		if raw, exists := inputFields["scheduleText"]; !exists || string(raw) == "null" {
			return "", nil, errors.New("scheduleText is required")
		}
	}
	inputJSON, err := json.Marshal(inputFields)
	if err != nil {
		return "", nil, errors.New("invalid body")
	}
	var input any
	var capabilityID string
	switch action {
	case "create":
		parsed, parseErr := capability.ParseRoutinesCreateInput(inputJSON)
		input, capabilityID, err = parsed, "routines.create", parseErr
	case "update":
		parsed, parseErr := capability.ParseRoutinesUpdateInput(inputJSON)
		input, capabilityID, err = parsed, "routines.update", parseErr
	case "delete":
		parsed, parseErr := capability.ParseRoutinesDeleteInput(inputJSON)
		input, capabilityID, err = parsed, "routines.delete", parseErr
	case "runNow":
		parsed, parseErr := capability.ParseRoutinesRunNowInput(inputJSON)
		input, capabilityID, err = parsed, "routines.runNow", parseErr
	}
	if err != nil {
		return "", nil, err
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return "", nil, errors.New("invalid body")
	}
	return capabilityID, encoded, nil
}

func routinesSessionClaims(resolved *session.ResolvedUser, intentID, capabilityID string, input json.RawMessage) authbridge.CapabilityClaims {
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
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID,
		OrganizationID: *resolved.OrgID, CapabilityID: capabilityID, InputSHA256: inputHash,
		ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func routinesRequestOrigin(r *http.Request, trustedProxyCIDRs []*net.IPNet) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	} else if peerText, _, err := net.SplitHostPort(r.RemoteAddr); err == nil && isTrustedProxy(net.ParseIP(peerText), trustedProxyCIDRs) {
		forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
		if !strings.Contains(forwarded, ",") && (forwarded == "http" || forwarded == "https") {
			scheme = forwarded
		}
	}
	parsed, err := url.Parse(scheme + "://" + r.Host)
	if err != nil || parsed == nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return scheme + "://localhost"
	}
	return scheme + "://" + parsed.Host
}

func (h *RoutinesSessionHandler) writeExecutionError(w http.ResponseWriter, err error) {
	h.logger.Error("Go routines capability execution failed", "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}
