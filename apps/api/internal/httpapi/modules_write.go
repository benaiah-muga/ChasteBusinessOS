package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const modulesWriteBodyLimit = 64 << 10

type ModulesWriteHandler struct {
	resolver          modulesSessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

type modulesWriteBody struct {
	Modules  []string        `json:"modules"`
	IntentID json.RawMessage `json:"intentId"`
}

// NewModulesWriteHandler serves governed module switchboard writes for a verified session.
func NewModulesWriteHandler(resolver modulesSessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &ModulesWriteHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *ModulesWriteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setModulesHeaders(w)
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeModulesError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeModulesError(w, http.StatusServiceUnavailable, "module service unavailable")
		return
	}

	selector, ok := modulesOrganizationSelector(r)
	if !ok {
		writeModulesError(w, http.StatusBadRequest, "invalid organization selector")
		return
	}
	resolved, bearer, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		resolved.AuthSessionID == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) ||
		!matchesRequestedOrganization(r, resolved) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeModulesError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !resolved.HasPermission("iam.admin") && !resolved.HasPermission("*") {
		writeModulesError(w, http.StatusForbidden, "forbidden: missing permission: iam.admin")
		return
	}
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeModulesError(w, http.StatusForbidden, "forbidden")
		return
	}

	body, valid := decodeModulesWriteBody(w, r)
	if !valid {
		return
	}
	intentID := ""
	if len(body.IntentID) > 0 && string(body.IntentID) != "null" {
		if err := json.Unmarshal(body.IntentID, &intentID); err != nil {
			intentID = ""
		}
	}
	if len(intentID) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeModulesError(w, http.StatusBadRequest, "invalid body")
		return
	}

	modules := make([]string, 0, len(body.Modules)+len(protectedModuleIDs))
	seen := make(map[string]struct{}, len(body.Modules)+len(protectedModuleIDs))
	for _, id := range append(body.Modules, protectedModuleIDs...) {
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		modules = append(modules, id)
	}
	input, err := json.Marshal(struct {
		Modules []string `json:"modules"`
	}{Modules: modules})
	if err != nil {
		writeModulesError(w, http.StatusInternalServerError, "internal error")
		return
	}
	claims := modulesWriteClaims(resolved, intentID, input)
	const capabilityID = "iam.setModules"
	claims.CapabilityID = capabilityID
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		h.writeExecutionError(w, err)
		return
	}
	if result.PendingApproval {
		writeModulesJSON(w, http.StatusAccepted, map[string]any{
			"pendingApproval": true,
			"hint":            "Module changes proposed by the workmate wait for approval in the Approvals inbox.",
		})
		return
	}
	if !result.OK {
		writeModulesError(w, http.StatusUnprocessableEntity, result.Error)
		return
	}
	if !json.Valid(result.Data) {
		writeModulesError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeModulesJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: result.Data})
}

func (h *ModulesWriteHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, bool, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, true, session.ErrNoSession
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
		return resolved, true, err
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	return resolved, false, err
}

func decodeModulesWriteBody(w http.ResponseWriter, r *http.Request) (modulesWriteBody, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, modulesWriteBodyLimit)
	decoder := json.NewDecoder(r.Body)
	var body modulesWriteBody
	if decoder.Decode(&body) != nil || len(body.Modules) == 0 {
		writeModulesError(w, http.StatusBadRequest, "invalid body")
		return modulesWriteBody{}, false
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeModulesError(w, http.StatusBadRequest, "invalid body")
		return modulesWriteBody{}, false
	}
	known := make(map[string]struct{}, len(moduleCatalog))
	for _, module := range moduleCatalog {
		known[module.ID] = struct{}{}
	}
	for _, id := range body.Modules {
		if _, exists := known[id]; !exists {
			writeModulesError(w, http.StatusBadRequest, "invalid body")
			return modulesWriteBody{}, false
		}
	}
	return body, true
}

func modulesWriteClaims(resolved *session.ResolvedUser, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	sort.Strings(permissions)
	actorID := resolved.UserID
	inputHash, _ := capability.InputHash(input)
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		CapabilityID: "iam.setModules", InputSHA256: inputHash, ActorID: &actorID, ActorType: "human",
		Permissions: permissions, AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func (h *ModulesWriteHandler) writeExecutionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		writeModulesError(w, http.StatusUnauthorized, "unauthorized")
	case errors.Is(err, capability.ErrNotMember):
		writeModulesError(w, http.StatusForbidden, "forbidden")
	default:
		if h.logger != nil {
			h.logger.Error("Go module switchboard write failed", "error", err)
		}
		writeModulesError(w, http.StatusInternalServerError, "internal error")
	}
}
