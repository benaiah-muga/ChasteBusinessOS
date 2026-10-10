package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
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
	maxOnboardingBodyBytes = 64 << 10
	maxOnboardingAttempts  = 5
	onboardingWindow       = 10 * time.Minute
)

type onboardingSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type onboardingHandler struct {
	pool              *pgxpool.Pool
	executor          *capability.Executor
	resolver          onboardingSessionResolver
	secret            string
	embeddingModel    string
	embedder          capability.SupportKnowledgeEmbedder
	logger            *slog.Logger
	rateLimit         onboardingRateLimiter
	trustedProxyCIDRs []*net.IPNet
}

type onboardingRateLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
}

type onboardingRequest struct {
	orgName             string
	businessDescription string
	baseCurrency        string
	path                string
	deferredSteps       []string
	intentID            *string
}

type onboardingResponse struct {
	OrgID    string `json:"orgId"`
	Replayed bool   `json:"replayed"`
}

type onboardingState struct {
	Path       string            `json:"path"`
	Steps      map[string]string `json:"steps"`
	StartedAt  string            `json:"startedAt"`
	FinishedAt string            `json:"finishedAt,omitempty"`
}

type onboardingChecklistStep struct {
	Key    string `json:"key"`
	Status string `json:"status"`
}

// NewGoOnboardingHandler serves session-owned workspace creation. A nil
// embedder keeps creation available when the optional embedding provider is
// unavailable, matching the legacy best-effort upgrade behavior.
func NewGoOnboardingHandler(
	pool *pgxpool.Pool,
	executor *capability.Executor,
	resolver onboardingSessionResolver,
	secret string,
	embeddingModel string,
	embedder capability.SupportKnowledgeEmbedder,
	logger *slog.Logger,
	trustedProxyCIDRs ...[]*net.IPNet,
) (http.Handler, error) {
	if pool == nil || executor == nil || resolver == nil {
		return nil, errors.New("onboarding handler requires a database pool, capability executor, and session resolver")
	}
	if len([]byte(secret)) < 32 {
		return nil, session.ErrSecretTooShort
	}
	if (strings.TrimSpace(embeddingModel) == "") != (embedder == nil) {
		return nil, errors.New("onboarding embedding model and client must be configured together")
	}
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &onboardingHandler{
		pool: pool, executor: executor, resolver: resolver, secret: secret,
		embeddingModel: strings.TrimSpace(embeddingModel), embedder: embedder, logger: logger,
		trustedProxyCIDRs: trusted,
		rateLimit:         onboardingRateLimiter{attempts: make(map[string][]time.Time)},
	}, nil
}

func (h *onboardingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodPatch {
		w.Header().Set("Allow", "GET, POST, PATCH")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.pool == nil || h.executor == nil || h.resolver == nil {
		writeJSON(w, http.StatusServiceUnavailable, onboardingError("server_error", "Workspace setup is unavailable."))
		return
	}

	token, resolved, bearer, err := h.resolveRequestSession(r)
	if err != nil {
		if errors.Is(err, session.ErrSecretTooShort) {
			writeJSON(w, http.StatusServiceUnavailable, onboardingError("server_error", "Workspace setup is unavailable."))
			return
		}
		writeJSON(w, http.StatusUnauthorized, onboardingError("unauthorized", "Your session has expired. Sign in again to continue."))
		return
	}
	if r.Method != http.MethodGet && !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, onboardingError("forbidden", "This request could not be verified. Refresh the page and try again."))
		return
	}
	if r.Method == http.MethodPost && !resolved.EmailVerified {
		writeJSON(w, http.StatusForbidden, onboardingError("email_not_verified", "Verify your email before creating a workspace."))
		return
	}
	if r.Method != http.MethodPost {
		if resolved.OrgID == nil {
			if r.Method == http.MethodGet {
				writeJSON(w, http.StatusOK, map[string]any{"state": nil, "steps": []onboardingChecklistStep{}})
			} else {
				writeJSON(w, http.StatusConflict, onboardingError("not_found", "Set up your workspace first."))
			}
			return
		}
		if r.Method == http.MethodGet {
			state, err := h.readState(r.Context(), *resolved.OrgID)
			if err != nil {
				h.failState(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"state": state, "steps": onboardingChecklist(state)})
			return
		}
		state, err := h.updateState(w, r, *resolved.OrgID, resolved.UserID)
		if err != nil {
			status, response := onboardingStateFailure(err)
			if status >= http.StatusInternalServerError && h.logger != nil {
				h.logger.Error("Go onboarding state update failed", "error", err)
			}
			writeJSON(w, status, response)
			return
		}
		writeJSON(w, http.StatusOK, map[string]onboardingState{"state": state})
		return
	}

	body, field, detail, err := decodeOnboardingRequest(w, r)
	if err != nil {
		message := "That doesn't look right."
		if field == "orgName" {
			message = "Business name needs at least 2 characters."
		} else if field == "businessDescription" {
			message = "Tell us a little more - at least 20 characters about what you do."
		} else if detail == "Could not read that request." {
			message = detail
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": message, "code": "invalid", "field": field, "detail": detail,
		})
		return
	}
	if resolved.OrgID != nil && body.intentID == nil {
		writeJSON(w, http.StatusConflict, onboardingError("already_onboarded", "This account already has a workspace."))
		return
	}
	if allowed, retryAfter := h.rateLimit.allow(resolved.UserID, time.Now()); !allowed {
		message := fmt.Sprintf("Too many attempts. Try again in %ds.", retryAfter)
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": message, "code": "rate_limited", "retryAfterSec": retryAfter,
		})
		return
	}

	result, err := h.create(r.Context(), token, resolved, body)
	if err != nil {
		status, response := onboardingFailure(err, body.baseCurrency)
		if status >= http.StatusInternalServerError && h.logger != nil {
			h.logger.Error("Go onboarding transaction failed", "error", err)
		}
		writeJSON(w, status, response)
		return
	}
	writeJSON(w, http.StatusOK, result)
	if !result.Replayed && h.embedder != nil {
		orgID, description := result.OrgID, body.businessDescription
		go h.upgradeEmbedding(orgID, description)
	}
}

func (h *onboardingHandler) failState(w http.ResponseWriter, err error) {
	status, response := onboardingStateFailure(err)
	if status >= http.StatusInternalServerError && h.logger != nil {
		h.logger.Error("Go onboarding state read failed", "error", err)
	}
	writeJSON(w, status, response)
}

func onboardingStateFailure(err error) (int, map[string]string) {
	if errors.Is(err, errOnboardingOrgNotFound) {
		return http.StatusConflict, onboardingError("not_found", "Set up your workspace first.")
	}
	if errors.Is(err, errInvalidOnboardingUpdate) {
		return http.StatusBadRequest, onboardingError("invalid", "That doesn't look right.")
	}
	return http.StatusInternalServerError, onboardingError("server_error", "Workspace setup state could not be saved. Try again.")
}

var (
	errOnboardingOrgNotFound   = errors.New("onboarding organization not found")
	errInvalidOnboardingUpdate = errors.New("invalid onboarding update")
)

var onboardingStepKeys = map[string]bool{
	"business_profile": true,
	"import_customers": true,
	"import_products":  true,
	"connect_source":   true,
	"invite_team":      true,
}

type onboardingStepMeta struct {
	title string
	why   string
	href  string
}

var onboardingStepMetadata = map[string]onboardingStepMeta{
	"business_profile": {title: "Describe your business", why: "Your AI workmate reads this once and never asks again. Without it, it guesses.", href: "/settings"},
	"import_customers": {title: "Bring in your customers", why: "Invoices, credit limits and payment reminders all hang off a customer record.", href: "/sales"},
	"import_products":  {title: "Bring in your products", why: "Quotes and invoices price from your catalog instead of retyping every line.", href: "/products"},
	"connect_source":   {title: "Connect where your data lives", why: "Live connectors keep your books current without exporting files by hand.", href: "/settings"},
	"invite_team":      {title: "Invite your team", why: "Everyone works under their own identity, so the audit trail names a person.", href: "/team"},
}

func (h *onboardingHandler) readState(ctx context.Context, orgID string) (*onboardingState, error) {
	return dbx.WithOrgTx(ctx, h.pool, orgID, func(tx pgx.Tx) (*onboardingState, error) {
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT settings FROM organizations WHERE id=$1::uuid`, orgID).Scan(&raw); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, nil
			}
			return nil, err
		}
		var settings map[string]json.RawMessage
		if err := json.Unmarshal(raw, &settings); err != nil || settings == nil || len(settings["onboarding"]) == 0 {
			return nil, nil
		}
		state := parseOnboardingState(raw)
		return &state, nil
	})
}

func onboardingChecklist(state *onboardingState) []onboardingChecklistStep {
	steps := []onboardingChecklistStep{}
	if state == nil || state.FinishedAt != "" {
		return steps
	}
	for _, key := range []string{"business_profile", "import_customers", "import_products", "connect_source", "invite_team"} {
		status := state.Steps[key]
		if status == "pending" || status == "skipped" {
			steps = append(steps, onboardingChecklistStep{Key: key, Status: status})
		}
	}
	return steps
}

func (h *onboardingHandler) updateState(w http.ResponseWriter, r *http.Request, orgID, userID string) (onboardingState, error) {
	var body map[string]json.RawMessage
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxOnboardingBodyBytes))
	if err := decoder.Decode(&body); err != nil || body == nil {
		return onboardingState{}, errInvalidOnboardingUpdate
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return onboardingState{}, errInvalidOnboardingUpdate
	}
	var state onboardingState
	_, err := dbx.WithOrgTx(r.Context(), h.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		var raw []byte
		if err := tx.QueryRow(r.Context(), `SELECT settings FROM organizations WHERE id=$1::uuid FOR UPDATE`, orgID).Scan(&raw); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return struct{}{}, errOnboardingOrgNotFound
			}
			return struct{}{}, err
		}
		state = parseOnboardingState(raw)
		if complete, exists := body["complete"]; exists {
			var value bool
			if len(body) != 1 || json.Unmarshal(complete, &value) != nil || !value {
				return struct{}{}, errInvalidOnboardingUpdate
			}
			now := time.Now().UTC().Format(time.RFC3339Nano)
			state.FinishedAt = now
		} else {
			var step, status string
			if len(body) != 2 || json.Unmarshal(body["step"], &step) != nil || json.Unmarshal(body["status"], &status) != nil || !onboardingStepKeys[step] || (status != "done" && status != "pending" && status != "skipped") {
				return struct{}{}, errInvalidOnboardingUpdate
			}
			previous := state.Steps[step]
			state.Steps[step] = status
			if status != "done" && previous != status {
				meta := onboardingStepMetadata[step]
				note := "left for later"
				if status == "skipped" {
					note = "skipped during setup"
				}
				if _, err := tx.Exec(r.Context(), `
					INSERT INTO public.notifications (org_id, user_id, kind, title, body, href)
					VALUES ($1::uuid, $2::uuid, 'system', $3, $4, $5)`,
					orgID, userID, meta.title+" - "+note, meta.why, meta.href); err != nil {
					return struct{}{}, err
				}
			}
		}
		encoded, err := json.Marshal(state)
		if err != nil {
			return struct{}{}, err
		}
		var settings []byte
		if len(raw) == 0 || string(raw) == "null" {
			settings = []byte(`{}`)
		} else {
			settings = raw
			var valid map[string]json.RawMessage
			if err := json.Unmarshal(settings, &valid); err != nil || valid == nil {
				return struct{}{}, errors.New("stored organization settings are malformed")
			}
		}
		if _, err := tx.Exec(r.Context(), `UPDATE organizations SET settings = jsonb_set($2::jsonb, '{onboarding}', $3::jsonb, true) WHERE id=$1::uuid`, orgID, settings, encoded); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	})
	return state, err
}

func parseOnboardingState(raw []byte) onboardingState {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	state := onboardingState{Path: "fresh", Steps: map[string]string{}, StartedAt: now}
	if len(raw) == 0 {
		return state
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(raw, &settings); err != nil || settings == nil {
		return state
	}
	var stored map[string]json.RawMessage
	if err := json.Unmarshal(settings["onboarding"], &stored); err != nil || stored == nil {
		return state
	}
	var path, startedAt, finishedAt string
	if json.Unmarshal(stored["path"], &path) == nil && (path == "fresh" || path == "import" || path == "connect") {
		state.Path = path
	}
	if json.Unmarshal(stored["startedAt"], &startedAt) == nil && startedAt != "" {
		state.StartedAt = startedAt
	}
	if json.Unmarshal(stored["finishedAt"], &finishedAt) == nil && finishedAt != "" {
		state.FinishedAt = finishedAt
	}
	var steps map[string]string
	if json.Unmarshal(stored["steps"], &steps) == nil {
		for step, status := range steps {
			if onboardingStepKeys[step] && (status == "done" || status == "pending" || status == "skipped") {
				state.Steps[step] = status
			}
		}
	}
	return state
}

func (h *onboardingHandler) resolveRequestSession(r *http.Request) (string, *session.ResolvedUser, bool, error) {
	selector := session.CookieFromRequest(r, session.ActiveOrgCookieName)
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" || len(fields[1]) > 512 {
			return "", nil, true, session.ErrNoSession
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
		return fields[1], resolved, true, err
	}
	signedCookie := session.CookieFromRequest(r, session.SessionCookieName)
	token, err := session.VerifySignedCookie(signedCookie, h.secret)
	if err != nil {
		return "", nil, false, err
	}
	resolved, err := h.resolver.Resolve(r.Context(), signedCookie, selector)
	return token, resolved, false, err
}

func decodeOnboardingRequest(w http.ResponseWriter, r *http.Request) (onboardingRequest, string, string, error) {
	var result onboardingRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxOnboardingBodyBytes))
	var raw map[string]json.RawMessage
	if err := decoder.Decode(&raw); err != nil || raw == nil {
		return result, "", "Could not read that request.", errors.New("invalid onboarding JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return result, "", "Could not read that request.", errors.New("onboarding request has trailing JSON")
	}

	orgName, err := requiredOnboardingString(raw, "orgName")
	if err != nil || utf16Length(orgName) < 2 || utf16Length(orgName) > 80 {
		return result, "orgName", "orgName must contain between 2 and 80 characters", errors.New("invalid orgName")
	}
	description, err := requiredOnboardingString(raw, "businessDescription")
	if err != nil || utf16Length(description) < 20 || utf16Length(description) > 8000 {
		return result, "businessDescription", "businessDescription must contain between 20 and 8000 characters", errors.New("invalid businessDescription")
	}

	currency := "USD"
	if value, exists := raw["baseCurrency"]; exists {
		currency, err = onboardingString(value)
		if err != nil || utf16Length(currency) != 3 {
			return result, "baseCurrency", "baseCurrency must contain exactly 3 characters", errors.New("invalid baseCurrency")
		}
	}
	path := "fresh"
	if value, exists := raw["path"]; exists {
		path, err = onboardingString(value)
		if err != nil || (path != "fresh" && path != "import" && path != "connect") {
			return result, "path", "path must be fresh, import, or connect", errors.New("invalid onboarding path")
		}
	}
	steps := []string{}
	if value, exists := raw["deferredSteps"]; exists {
		if err := json.Unmarshal(value, &steps); err != nil || steps == nil {
			return result, "deferredSteps", "deferredSteps must be an array of strings", errors.New("invalid deferredSteps")
		}
	}
	value, exists := raw["intentId"]
	if !exists {
		return result, "intentId", "intentId is required to safely retry workspace creation", errors.New("missing intentId")
	}
	intent, parseErr := onboardingString(value)
	if parseErr != nil || utf16Length(intent) < 8 || utf16Length(intent) > 100 {
		return result, "intentId", "intentId must contain between 8 and 100 characters", errors.New("invalid intentId")
	}
	result = onboardingRequest{
		orgName: orgName, businessDescription: description,
		baseCurrency: strings.ToUpper(currency), path: path,
		deferredSteps: steps, intentID: &intent,
	}
	return result, "", "", nil
}

func requiredOnboardingString(raw map[string]json.RawMessage, name string) (string, error) {
	value, exists := raw[name]
	if !exists {
		return "", errors.New("required")
	}
	return onboardingString(value)
}

func onboardingString(raw json.RawMessage) (string, error) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", err
	}
	return value, nil
}

func onboardingError(code, message string) map[string]string {
	return map[string]string{"error": message, "code": code}
}

func onboardingFailure(err error, currency string) (int, map[string]string) {
	message := err.Error()
	switch {
	case errors.Is(err, capability.ErrBootstrapIdentityMismatch):
		return http.StatusUnauthorized, onboardingError("unauthorized", "Your session has expired. Sign in again to continue.")
	case strings.Contains(message, "unsupported base currency"):
		return http.StatusUnprocessableEntity, onboardingError("invalid", "We don't support "+currency+" as a base currency yet.")
	case strings.Contains(message, "intent conflict"):
		return http.StatusConflict, onboardingError("intent_conflict", "This setup was already started with different details.")
	case strings.Contains(message, "already belongs"):
		return http.StatusConflict, onboardingError("already_onboarded", "This account already has a workspace.")
	default:
		return http.StatusInternalServerError, onboardingError("server_error", "Workspace setup failed. Try again.")
	}
}

func (h *onboardingHandler) create(ctx context.Context, token string, resolved *session.ResolvedUser, body onboardingRequest) (onboardingResponse, error) {
	if resolved == nil || token == "" || body.intentID == nil {
		return onboardingResponse{}, session.ErrNoSession
	}
	input, err := json.Marshal(capability.OrganizationBootstrapInput{
		OrgName: body.orgName, BusinessDescription: body.businessDescription,
		BaseCurrency: body.baseCurrency, Path: body.path,
		DeferredSteps: body.deferredSteps, IntentID: *body.intentID,
	})
	if err != nil {
		return onboardingResponse{}, err
	}
	result, err := h.executor.ExecuteOrganizationBootstrap(ctx, capability.OrganizationBootstrapIdentity{
		UserID: resolved.UserID, AuthSessionID: resolved.AuthSessionID,
	}, token, input)
	if err != nil {
		return onboardingResponse{}, err
	}
	if !result.OK {
		return onboardingResponse{}, errors.New(result.Error)
	}
	var response onboardingResponse
	if err := json.Unmarshal(result.Data, &response); err != nil {
		return onboardingResponse{}, err
	}
	if response.OrgID == "" || response.Replayed != result.Replayed {
		return onboardingResponse{}, errors.New("organization bootstrap executor returned an invalid result")
	}
	return response, nil
}

func (h *onboardingHandler) upgradeEmbedding(orgID, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	vectors, err := h.embedder.Embed(ctx, h.embeddingModel, "passage", []string{text})
	if err != nil || len(vectors) != 1 {
		if err == nil {
			err = errors.New("embedding provider returned an invalid response")
		}
		h.logEmbeddingFailure(orgID, err)
		return
	}
	literal, ok := onboardingVectorLiteral(vectors[0])
	if !ok {
		h.logEmbeddingFailure(orgID, errors.New("embedding provider returned an invalid vector"))
		return
	}
	_, err = dbx.WithOrgTx(ctx, h.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, updateErr := tx.Exec(ctx, `
			UPDATE public.memories SET embedding = $1::public.vector(1024)
			WHERE org_id = $2::uuid AND kind = 'business_profile' AND source = 'onboarding'`, literal, orgID)
		return struct{}{}, updateErr
	})
	if err != nil {
		h.logEmbeddingFailure(orgID, err)
	}
}

func (h *onboardingHandler) logEmbeddingFailure(orgID string, err error) {
	if h.logger != nil {
		h.logger.Warn("onboarding embedding upgrade failed", "org_id", orgID, "error", err)
	}
}

func onboardingVectorLiteral(vector []float32) (string, bool) {
	if len(vector) != capability.SupportKnowledgeEmbeddingDimension {
		return "", false
	}
	var builder strings.Builder
	builder.WriteByte('[')
	for index, value := range vector {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return "", false
		}
		if index > 0 {
			builder.WriteByte(',')
		}
		builder.WriteString(strconv.FormatFloat(float64(value), 'f', -1, 32))
	}
	builder.WriteByte(']')
	return builder.String(), true
}

func (l *onboardingRateLimiter) allow(userID string, now time.Time) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.attempts == nil {
		l.attempts = make(map[string][]time.Time)
	}
	cutoff := now.Add(-onboardingWindow)
	recent := l.attempts[userID][:0]
	for _, attempt := range l.attempts[userID] {
		if attempt.After(cutoff) {
			recent = append(recent, attempt)
		}
	}
	if len(recent) >= maxOnboardingAttempts {
		retryAfter := int(recent[0].Add(onboardingWindow).Sub(now).Seconds())
		if retryAfter < 1 {
			retryAfter = 1
		}
		l.attempts[userID] = recent
		return false, retryAfter
	}
	l.attempts[userID] = append(recent, now)
	return true, 0
}

// MountGoOnboardingRoute keeps the browser route opt-in until the frontend
// switches from the compatibility server to the Go API.
func MountGoOnboardingRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/onboarding", route)
	mux.Handle("POST /api/onboarding", route)
	mux.Handle("PATCH /api/onboarding", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
