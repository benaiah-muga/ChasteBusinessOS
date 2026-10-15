package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"unicode/utf16"

	businesscontract "github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/apicontract/business"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type approvalDecisionSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type approvalSessionDecisionDecider interface {
	DecideForSession(context.Context, string, string, string, []string, capability.ApprovalDecisionInput) (capability.ApprovalDecisionResult, error)
}

type ApprovalDecisionSessionHandler struct {
	resolver          approvalDecisionSessionResolver
	decider           approvalSessionDecisionDecider
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

type approvalDecisionSessionBody struct {
	Decision businesscontract.ApprovalDecisionRequestDecision `json:"decision"`
	Comment  json.RawMessage                                  `json:"comment"`
}

func NewApprovalDecisionSessionHandler(resolver approvalDecisionSessionResolver, decider approvalSessionDecisionDecider, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &ApprovalDecisionSessionHandler{resolver: resolver, decider: decider, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *ApprovalDecisionSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.decider == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "approval decision unavailable"})
		return
	}
	ids := r.URL.Query()["id"]
	if len(ids) != 1 || strings.TrimSpace(ids[0]) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	resolved, bearer, ok := h.resolve(r)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body approvalDecisionSessionBody
	if err := decoder.Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF || !body.Decision.Valid() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	var comment *string
	if len(body.Comment) > 0 {
		if bytes.Equal(bytes.TrimSpace(body.Comment), []byte("null")) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
		var value string
		if err := json.Unmarshal(body.Comment, &value); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
		comment = &value
		if len(utf16.Encode([]rune(value))) > 2000 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
	}

	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	result, err := h.decider.DecideForSession(r.Context(), resolved.UserID, *resolved.OrgID, resolved.AuthSessionID, permissions, capability.ApprovalDecisionInput{
		ApprovalID: ids[0],
		Decision:   string(body.Decision),
		Comment:    comment,
	})
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go approval decision failed", "approvalId", ids[0], "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	status := result.HTTPStatus
	if status < http.StatusOK || status > 599 {
		status = http.StatusInternalServerError
	}
	contract, err := approvalDecisionContractResult(result)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go approval decision response did not match its generated API contract", "approvalId", ids[0], "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, status, contract)
}

func approvalDecisionContractResult(result capability.ApprovalDecisionResult) (any, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if result.OK {
		var contract businesscontract.ApprovalDecisionSuccess
		if err := json.Unmarshal(encoded, &contract); err != nil {
			return nil, err
		}
		if !contract.Ok.Valid() || !contract.Status.Valid() {
			return nil, errors.New("approval decision success is outside the generated API contract")
		}
		return contract, nil
	}
	var contract businesscontract.ApprovalDecisionFailure
	if err := json.Unmarshal(encoded, &contract); err != nil {
		return nil, err
	}
	if contract.Ok != businesscontract.ApprovalDecisionFailureOkFalse || contract.Error == "" {
		return nil, errors.New("approval decision failure is outside the generated API contract")
	}
	return contract, nil
}

func (h *ApprovalDecisionSessionHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, bool) {
	activeOrg, valid := activeOrganizationSelector(r)
	if !valid {
		return nil, false, false
	}
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, false
		}
		resolved, err := h.resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return resolved, true, err == nil
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return resolved, false, err == nil
}
