package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type crmReadSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type CRMReadSessionHandler struct {
	resolver crmReadSessionResolver
	executor CapabilityExecutor
	logger   *slog.Logger
}

func NewCRMReadSessionHandler(resolver crmReadSessionResolver, executor CapabilityExecutor, logger *slog.Logger) http.Handler {
	return &CRMReadSessionHandler{resolver: resolver, executor: executor, logger: logger}
}

func (h *CRMReadSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CRM service unavailable"})
		return
	}

	capabilityID, input, err := crmReadRequest(r.URL.Query())
	if err != nil || !validCRMReadSelector(r) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid CRM read selector"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || strings.TrimSpace(resolved.AuthSessionID) == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if !resolved.HasPermission("crm.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing crm.read"})
		return
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "crm") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "CRM module is disabled"})
		return
	}

	claims := crmReadSessionClaims(resolved, capabilityID, input)
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if h.logger != nil {
				h.logger.Error("Go CRM session read failed", "capabilityId", capabilityID, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	if !result.OK {
		status := http.StatusUnprocessableEntity
		if strings.HasPrefix(strings.ToLower(result.Error), "forbidden") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]string{"error": result.Error})
		return
	}
	if !json.Valid(result.Data) {
		if h.logger != nil {
			h.logger.Error("Go CRM session read returned invalid JSON", "capabilityId", capabilityID)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

func validCRMReadSelector(r *http.Request) bool {
	query := r.URL.Query()
	selectors := []string{"timeline", "tasks", "deals", "customers", "views"}
	selected := ""
	for _, name := range selectors {
		values, exists := query[name]
		if !exists {
			continue
		}
		if len(values) != 1 || values[0] == "" || selected != "" {
			return false
		}
		selected = name
	}
	if selected == "" {
		return false
	}
	for name, values := range query {
		if name == selected || name == "open" && selected == "tasks" {
			if len(values) != 1 {
				return false
			}
			continue
		}
		return false
	}
	if selected == "timeline" {
		return strings.TrimSpace(query.Get("timeline")) != ""
	}
	if selected == "tasks" {
		if query.Get("tasks") != "1" {
			return false
		}
		if values, exists := query["open"]; exists && (len(values) != 1 || (values[0] != "1" && values[0] != "0")) {
			return false
		}
		return true
	}
	return query.Get(selected) == "1"
}

func crmReadSessionClaims(resolved *session.ResolvedUser, capabilityID string, input json.RawMessage) authbridge.CapabilityClaims {
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
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		CapabilityID: capabilityID, InputSHA256: inputHash, ActorID: &actorID, ActorType: "human",
		Permissions: permissions, AuthSessionID: resolved.AuthSessionID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func (h *CRMReadSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
