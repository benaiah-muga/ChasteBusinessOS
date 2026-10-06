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
	Replayed bool   `json:"replayed,omitempty"`
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
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
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
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, onboardingError("forbidden", "This request could not be verified. Refresh the page and try again."))
		return
	}
	if !resolved.EmailVerified {
		writeJSON(w, http.StatusForbidden, onboardingError("email_not_verified", "Verify your email before creating a workspace."))
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
	mux.Handle("POST /api/onboarding", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
