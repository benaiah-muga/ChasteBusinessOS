package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type signalsSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type SignalsSessionHandler struct {
	resolver signalsSessionResolver
	executor CapabilityExecutor
	logger   *slog.Logger
}

// NewSignalsSessionHandler serves the legacy signals feed through the governed
// Go capability executor using identity resolved from the incoming session.
func NewSignalsSessionHandler(resolver signalsSessionResolver, executor CapabilityExecutor, logger *slog.Logger) http.Handler {
	return &SignalsSessionHandler{resolver: resolver, executor: executor, logger: logger}
}

func (h *SignalsSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "signals service unavailable"})
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

	query := r.URL.Query()
	inputFields := make(map[string]string, 2)
	if values, ok := query["severity"]; ok && len(values) > 0 {
		inputFields["severity"] = values[0]
	}
	if values, ok := query["module"]; ok && len(values) > 0 {
		inputFields["module"] = values[0]
	}
	input := json.RawMessage(`{}`)
	if len(inputFields) > 0 {
		encoded, marshalErr := json.Marshal(inputFields)
		if marshalErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		input = encoded
	}

	claims := analyticsSessionClaims(resolved, "signals.list", input)
	result, err := h.executor.Execute(r.Context(), claims, "signals.list", input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if h.logger != nil {
				h.logger.Error("Go signals capability failed", "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	if !result.OK {
		message := result.Error
		if message == "" {
			message = "capability execution failed"
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": message})
		return
	}

	var data struct {
		Signals []json.RawMessage `json:"signals"`
	}
	if !json.Valid(result.Data) || json.Unmarshal(result.Data, &data) != nil || data.Signals == nil {
		if h.logger != nil {
			h.logger.Error("Go signals capability returned invalid data")
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (h *SignalsSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
