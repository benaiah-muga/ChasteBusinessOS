package httpapi

import (
	"crypto/rand"
	"encoding/hex"
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
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/policy"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const policySessionBodyLimit = 16 << 10

type PolicySessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	reader            PolicyReader
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewPolicySessionHandler(resolver DirectCapabilitySessionResolver, reader PolicyReader, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &PolicySessionHandler{resolver: resolver, reader: reader, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *PolicySessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.reader == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "policy service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		h.unauthorized(w)
		return
	}
	resolved, bearer, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		h.unauthorized(w)
		return
	}
	if r.Method == http.MethodPost && !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if r.Method == http.MethodGet {
		h.read(w, r, resolved)
		return
	}
	h.write(w, r, resolved)
}

func (h *PolicySessionHandler) resolve(r *http.Request, activeOrg string) (*session.ResolvedUser, bool, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, true, session.ErrNoSession
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err
}

func (h *PolicySessionHandler) read(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	value, err := h.reader.ForOrg(r.Context(), *resolved.OrgID)
	if err != nil {
		h.logger.Error("Go session policy read failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"policy": map[string]any{
			"maxRiskAutonomous":   value.MaxRiskAutonomous,
			"moneyThresholdMinor": value.MoneyThresholdMinor,
			"requiresApprovalFor": value.RequiresApprovalFor,
		},
		"canEdit": resolved.Permissions["*"] || resolved.HasPermission("iam.admin"),
	})
}

func (h *PolicySessionHandler) write(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, policySessionBodyLimit)
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
	input, err := json.Marshal(fields)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	parsed, err := capability.ParseIAMSetOrgPolicyInput(input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID := ""
	if raw, ok := fields["intentId"]; ok {
		if intentID, ok = parseProjectIntentID(raw); !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
	} else {
		intentID, err = newPolicyIntentID()
		if err != nil {
			h.logger.Error("Go policy intent generation failed", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
	}
	capabilityInput := map[string]any{
		"maxRiskAutonomous":   parsed.MaxRiskAutonomous,
		"requiresApprovalFor": parsed.RequiresApprovalFor,
	}
	if parsed.MoneyThresholdMinor != nil {
		capabilityInput["moneyThresholdMinor"] = *parsed.MoneyThresholdMinor
	}
	encoded, err := json.Marshal(capabilityInput)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	capabilityBody := json.RawMessage(encoded)
	claims := policySessionClaims(resolved, intentID, capabilityBody)
	result, err := h.executor.Execute(r.Context(), claims, "iam.setOrgPolicy", capabilityBody)
	if err != nil {
		if errors.Is(err, capability.ErrSessionInvalid) || errors.Is(err, capability.ErrScopeMismatch) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		if errors.Is(err, capability.ErrNotMember) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		h.logger.Error("Go session policy write failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if result.PendingApproval {
		writeJSON(w, http.StatusAccepted, map[string]any{
			"pendingApproval": true,
			"hint":            "Policy changes proposed by the workmate wait for approval in the Approvals inbox.",
		})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: result.Data})
}

func policySessionClaims(resolved *session.ResolvedUser, intentID string, input json.RawMessage) authbridge.CapabilityClaims {
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
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID,
		OrganizationID: *resolved.OrgID, CapabilityID: "iam.setOrgPolicy", InputSHA256: inputHash,
		ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func newPolicyIntentID() (string, error) {
	var uuid [16]byte
	if _, err := rand.Read(uuid[:]); err != nil {
		return "", err
	}
	uuid[6] = (uuid[6] & 0x0f) | 0x40
	uuid[8] = (uuid[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(uuid[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func (h *PolicySessionHandler) unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

var _ PolicyReader = (*policy.PostgresReader)(nil)
