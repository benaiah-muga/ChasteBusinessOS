package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const posShiftSummaryCapabilityID = "pos.shiftSummary"

type PosShiftSummarySessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewPosShiftSummarySessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &PosShiftSummarySessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *PosShiftSummarySessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "POS shift summary service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, h.resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if r.Header.Get("Authorization") == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body struct {
		CapabilityID string `json:"capabilityId"`
		Input        struct {
			SessionID string `json:"sessionId"`
		} `json:"input"`
		IntentID string `json:"intentId"`
	}
	if decoder.Decode(&body) != nil || body.CapabilityID != posShiftSummaryCapabilityID || !isUUID(body.Input.SessionID) ||
		len(body.IntentID) > 200 || strings.ContainsAny(body.IntentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	input, _ := json.Marshal(capability.PosShiftSummaryInput{SessionID: body.Input.SessionID})
	inputHash, err := capability.InputHash(input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	actorID := resolved.UserID
	now := time.Now().UTC()
	claims := authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		CapabilityID: posShiftSummaryCapabilityID, InputSHA256: inputHash, ActorID: &actorID,
		ActorType: "human", Permissions: permissions, AuthSessionID: resolved.AuthSessionID,
		IntentID: body.IntentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
	result, err := h.executor.Execute(r.Context(), claims, posShiftSummaryCapabilityID, input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if h.logger != nil {
				h.logger.Error("Go POS shift summary capability failed", "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return
	}
	var output capability.PosShiftSummaryOutput
	if json.Unmarshal(result.Data, &output) != nil {
		if h.logger != nil {
			h.logger.Error("Go POS shift summary capability returned invalid data")
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if output.TenderTotals == nil {
		output.TenderTotals = []capability.PosMethodTotal{}
	}
	if output.RefundTotals == nil {
		output.RefundTotals = []capability.PosMethodTotal{}
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool                             `json:"ok"`
		Data capability.PosShiftSummaryOutput `json:"data"`
	}{OK: true, Data: output})
}

var _ DirectCapabilitySessionResolver = (*session.Resolver)(nil)
