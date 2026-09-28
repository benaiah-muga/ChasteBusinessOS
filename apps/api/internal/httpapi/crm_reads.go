package httpapi

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const CRMReadAudience = "go.crm.read"

type goCRMReadAssertionClaims struct {
	Audience       string   `json:"aud"`
	Subject        string   `json:"sub"`
	OrganizationID string   `json:"org_id"`
	CapabilityID   string   `json:"capability_id"`
	InputSHA256    string   `json:"input_sha256"`
	ActorID        *string  `json:"actor_id"`
	ActorType      string   `json:"actor_type"`
	Permissions    []string `json:"permissions"`
	AuthSessionID  string   `json:"auth_session_id"`
	IssuedAt       int64    `json:"iat"`
	ExpiresAt      int64    `json:"exp"`
}

type GoCRMReadHandler struct {
	secret   string
	executor CapabilityExecutor
	logger   *slog.Logger
}

func NewGoCRMReadHandler(secret string, executor CapabilityExecutor, logger *slog.Logger) http.Handler {
	return &GoCRMReadHandler{secret: secret, executor: executor, logger: logger}
}

func (h *GoCRMReadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if len([]byte(h.secret)) < 32 || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CRM service unavailable"})
		return
	}

	capabilityID, input, err := crmReadRequest(r.URL.Query())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "nothing requested"})
		return
	}

	claims, err := verifyCRMReadAssertion(h.secret, r.Header.Get(sessionAssertionHeader), time.Now())
	if err != nil || claims.CapabilityID != capabilityID {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	inputHash, err := capability.InputHash(input)
	if err != nil || inputHash != claims.InputSHA256 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	capabilityClaims := authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		Subject:        claims.Subject,
		OrganizationID: claims.OrganizationID,
		CapabilityID:   claims.CapabilityID,
		InputSHA256:    claims.InputSHA256,
		ActorID:        claims.ActorID,
		ActorType:      claims.ActorType,
		Permissions:    claims.Permissions,
		AuthSessionID:  claims.AuthSessionID,
		IssuedAt:       claims.IssuedAt,
		ExpiresAt:      claims.ExpiresAt,
	}
	result, err := h.executor.Execute(r.Context(), capabilityClaims, capabilityID, input)
	if err != nil {
		if errors.Is(err, capability.ErrSessionInvalid) || errors.Is(err, capability.ErrScopeMismatch) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		if errors.Is(err, capability.ErrNotMember) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		if h.logger != nil {
			h.logger.Error("Go CRM read failed", "capabilityId", capabilityID, "error", err)
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	if !json.Valid(result.Data) {
		if h.logger != nil {
			h.logger.Error("Go CRM read returned invalid JSON", "capabilityId", capabilityID)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

func crmReadRequest(query url.Values) (string, json.RawMessage, error) {
	if timelineID := query.Get("timeline"); timelineID != "" {
		input, err := json.Marshal(struct {
			CustomerID string `json:"customerId"`
		}{CustomerID: timelineID})
		return "crm.customerTimeline", input, err
	}
	if query.Get("tasks") != "" {
		var openOnly *bool
		if query.Get("open") == "1" {
			open := true
			openOnly = &open
		}
		input, err := json.Marshal(struct {
			OpenOnly *bool `json:"openOnly,omitempty"`
		}{OpenOnly: openOnly})
		return "crm.listTasks", input, err
	}
	if query.Get("deals") != "" {
		return "crm.listDeals", json.RawMessage(`{}`), nil
	}
	return "", nil, errors.New("nothing requested")
}

func verifyCRMReadAssertion(secret, token string, now time.Time) (goCRMReadAssertionClaims, error) {
	var claims goCRMReadAssertionClaims
	verified, err := authbridge.Verify(secret, token, CRMReadAudience, now)
	if err != nil {
		return claims, err
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return claims, authbridge.ErrInvalidAssertion
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return goCRMReadAssertionClaims{}, authbridge.ErrInvalidAssertion
	}
	if claims.Audience != verified.Audience || claims.Subject != verified.Subject || claims.OrganizationID != verified.OrganizationID ||
		!isUUID(claims.Subject) || !isUUID(claims.OrganizationID) || claims.ActorID == nil ||
		!isUUID(*claims.ActorID) || *claims.ActorID != claims.Subject || claims.ActorType != "human" ||
		strings.TrimSpace(claims.AuthSessionID) == "" || claims.ExpiresAt-claims.IssuedAt > 30 ||
		(claims.CapabilityID != "crm.customerTimeline" && claims.CapabilityID != "crm.listTasks" && claims.CapabilityID != "crm.listDeals") {
		return goCRMReadAssertionClaims{}, authbridge.ErrInvalidAssertion
	}
	if claims.Permissions == nil || !sort.StringsAreSorted(claims.Permissions) {
		return goCRMReadAssertionClaims{}, authbridge.ErrInvalidAssertion
	}
	for i, permission := range claims.Permissions {
		if strings.TrimSpace(permission) == "" || (i > 0 && claims.Permissions[i-1] == permission) {
			return goCRMReadAssertionClaims{}, authbridge.ErrInvalidAssertion
		}
	}
	digest, err := hex.DecodeString(claims.InputSHA256)
	if err != nil || len(digest) != 32 || strings.ToLower(claims.InputSHA256) != claims.InputSHA256 {
		return goCRMReadAssertionClaims{}, authbridge.ErrInvalidAssertion
	}
	return claims, nil
}
