package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	businesscontract "github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/apicontract/business"
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
	if err != nil {
		if errors.Is(err, session.ErrNoSession) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		if errors.Is(err, session.ErrSecretTooShort) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "signals service unavailable"})
			return
		}
		if h.logger != nil {
			h.logger.Error("Go signals session resolution failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || resolved.AuthSessionID == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if !resolved.HasPermission("signals.read") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	query, queryErr := url.ParseQuery(r.URL.RawQuery)
	if queryErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid query parameters"})
		return
	}
	params := businesscontract.GetSignalsParams{}
	if values, ok := query["severity"]; ok && len(values) > 0 {
		severity := businesscontract.GetSignalsParamsSeverity(values[0])
		params.Severity = &severity
	}
	if values, ok := query["module"]; ok && len(values) > 0 {
		module := values[0]
		params.Module = &module
	}
	input := json.RawMessage(`{}`)
	if params.Severity != nil || params.Module != nil {
		inputFields := make(map[string]string, 2)
		if params.Severity != nil {
			inputFields["severity"] = string(*params.Severity)
		}
		if params.Module != nil {
			inputFields["module"] = *params.Module
		}
		encoded, marshalErr := json.Marshal(inputFields)
		if marshalErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		input = encoded
	}
	if _, err := capability.ParseSignalsListInput(input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid query parameters"})
		return
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
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	var data businesscontract.SignalResponse
	decoder := json.NewDecoder(bytes.NewReader(result.Data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&data) != nil || data.Signals == nil || validateSignals(result.Data, data.Signals) != nil {
		if h.logger != nil {
			h.logger.Error("Go signals capability returned invalid data")
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func validateSignals(raw json.RawMessage, signals []businesscontract.Signal) error {
	var response struct {
		Signals []map[string]json.RawMessage `json:"signals"`
	}
	if err := json.Unmarshal(raw, &response); err != nil || len(response.Signals) != len(signals) {
		return errors.New("invalid signal response")
	}
	for index, signal := range signals {
		if signal.Id == "" || !signal.Severity.Valid() || signal.Module == "" {
			return errors.New("invalid signal")
		}
		fields := response.Signals[index]
		for _, required := range []string{"id", "severity", "module", "subject", "detail"} {
			if _, exists := fields[required]; !exists {
				return errors.New("missing signal field")
			}
		}
		if rawEvidence, exists := fields["evidence"]; exists && string(rawEvidence) != "null" {
			var evidence map[string]json.RawMessage
			if json.Unmarshal(rawEvidence, &evidence) != nil {
				return errors.New("invalid signal evidence")
			}
			if _, exists := evidence["refType"]; !exists {
				return errors.New("missing signal evidence field")
			}
		}
		if rawAction, exists := fields["suggestedAction"]; exists && string(rawAction) != "null" {
			var action map[string]json.RawMessage
			if json.Unmarshal(rawAction, &action) != nil {
				return errors.New("invalid signal suggested action")
			}
			if _, exists := action["capabilityId"]; !exists || signal.SuggestedAction == nil || signal.SuggestedAction.CapabilityId == "" {
				return errors.New("missing signal suggested action field")
			}
			if signal.SuggestedAction.InputDraft != nil {
				var draft map[string]json.RawMessage
				if json.Unmarshal(*signal.SuggestedAction.InputDraft, &draft) != nil || draft == nil {
					return errors.New("invalid signal input draft")
				}
			}
		}
	}
	return nil
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
