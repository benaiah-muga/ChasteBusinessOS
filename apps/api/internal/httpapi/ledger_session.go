package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type ledgerSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type LedgerSessionHandler struct {
	resolver ledgerSessionResolver
	reader   LedgerReader
	logger   *slog.Logger
}

func NewLedgerSessionHandler(resolver ledgerSessionResolver, reader LedgerReader, logger *slog.Logger) http.Handler {
	return &LedgerSessionHandler{resolver: resolver, reader: reader, logger: logger}
}

func (h *LedgerSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ledger service unavailable"})
		return
	}

	selector, valid := modulesOrganizationSelector(r)
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
	if !resolved.HasPermission("accounting.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing accounting.read"})
		return
	}

	limit := parseLedgerLimit(r.URL.Query().Get("limit"), r.URL.Query().Has("limit"))
	events, err := h.reader.RecentForOrg(r.Context(), *resolved.OrgID, limit)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("ledger read failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if events == nil {
		events = []ledger.Event{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (h *LedgerSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
