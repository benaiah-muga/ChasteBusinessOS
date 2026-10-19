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
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	evaluationRunTimeout = 90 * time.Second
	evaluationRunWindow  = time.Minute
	evaluationRunLimit   = 8
)

type evaluationRateWindow struct {
	started time.Time
	count   int
}

type evaluationSessionResolver interface {
	Resolve(ctx context.Context, cookie, activeOrg string) (*session.ResolvedUser, error)
	ResolveBearerToken(ctx context.Context, token, activeOrg string) (*session.ResolvedUser, error)
}

type EvaluationSessionHandler struct {
	resolver          evaluationSessionResolver
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
	runGuard          chan struct{}
	provider          func() (chatProvider, string, error)
	rateMu            sync.Mutex
	rateWindows       map[string]evaluationRateWindow
	rateLimit         int
	store             *evaluationRunStore
}

func NewEvaluationSessionHandler(pool *pgxpool.Pool, resolver evaluationSessionResolver, logger *slog.Logger, trustedProxyCIDRs ...*net.IPNet) *EvaluationSessionHandler {
	return &EvaluationSessionHandler{
		resolver: resolver, logger: logger, trustedProxyCIDRs: trustedProxyCIDRs,
		runGuard: make(chan struct{}, 1), provider: evaluationProviderFromEnv,
		rateWindows: make(map[string]evaluationRateWindow), rateLimit: evaluationRunLimit,
		store: &evaluationRunStore{pool: pool},
	}
}

func (h *EvaluationSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if h == nil || h.resolver == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "evaluation service is unavailable"})
		return
	}
	resolved, ok := h.resolve(w, r)
	if !ok {
		return
	}
	if !resolved.HasPermission("iam.admin") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "evaluation runs require an organization admin"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.list(w, r, resolved)
	case http.MethodPost:
		h.run(w, r, resolved)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *EvaluationSessionHandler) list(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	_, model, err := h.provider()
	live := err == nil
	if !live {
		model = ""
	}
	runs := []EvaluationRunResult{}
	if resolved.OrgID != nil {
		if recent, historyErr := h.store.recent(r.Context(), *resolved.OrgID, evaluationHistoryLimit); historyErr != nil {
			if h.logger != nil {
				h.logger.Error("Go evaluation history read failed", "error", historyErr)
			}
		} else {
			runs = recent
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"live": live, "model": model, "scenarios": evaluationScenarioSummaries(), "recentRuns": runs,
	})
}

func (h *EvaluationSessionHandler) run(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	if strings.TrimSpace(r.Header.Get("Authorization")) == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "same-origin request required"})
		return
	}
	var request struct {
		ScenarioID string `json:"scenarioId"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || strings.TrimSpace(request.ScenarioID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scenarioId is required"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	scenario, found := findEvaluationScenario(request.ScenarioID)
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "evaluation scenario not found"})
		return
	}
	provider, model, err := h.provider()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "the live evaluation model is not configured"})
		return
	}
	if !h.allowRun(*resolved.OrgID, resolved.UserID, time.Now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "evaluation rate limit reached; try again in a minute"})
		return
	}
	select {
	case h.runGuard <- struct{}{}:
		defer func() { <-h.runGuard }()
	default:
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "an evaluation is already running"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), evaluationRunTimeout)
	defer cancel()
	result := runEvaluationScenario(ctx, provider, scenario, model)
	if err := h.store.save(ctx, *resolved.OrgID, resolved.UserID, &result); err != nil {
		if h.logger != nil {
			h.logger.Error("Go evaluation run persistence failed", "error", err)
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *EvaluationSessionHandler) allowRun(orgID, userID string, now time.Time) bool {
	key := orgID + ":" + userID
	h.rateMu.Lock()
	defer h.rateMu.Unlock()
	window, ok := h.rateWindows[key]
	if !ok || now.Sub(window.started) >= evaluationRunWindow {
		h.rateWindows[key] = evaluationRateWindow{started: now, count: 1}
		return true
	}
	if window.count >= h.rateLimit {
		return false
	}
	window.count++
	h.rateWindows[key] = window
	return true
}

func (h *EvaluationSessionHandler) resolve(w http.ResponseWriter, r *http.Request) (*session.ResolvedUser, bool) {
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return nil, false
	}
	var resolved *session.ResolvedUser
	var err error
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return nil, false
		}
		resolved, err = h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	} else {
		resolved, err = h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	}
	if errors.Is(err, session.ErrSecretTooShort) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "evaluation service is unavailable"})
		return nil, false
	}
	if err != nil && !errors.Is(err, session.ErrNoSession) {
		if h.logger != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			h.logger.Error("Go evaluation session resolution failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "evaluation service is unavailable"})
		return nil, false
	}
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || resolved.AuthSessionID == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil, false
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return nil, false
	}
	return resolved, true
}
