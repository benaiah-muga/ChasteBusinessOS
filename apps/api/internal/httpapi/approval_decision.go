package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

type ApprovalDecisionDecider interface {
	Decide(context.Context, authbridge.CapabilityClaims, capability.ApprovalDecisionInput) (capability.ApprovalDecisionResult, error)
}

type GoApprovalDecisionHandler struct {
	secret  string
	decider ApprovalDecisionDecider
	logger  *slog.Logger
}

func NewGoApprovalDecisionHandler(secret string, decider ApprovalDecisionDecider, logger *slog.Logger) http.Handler {
	return &GoApprovalDecisionHandler{secret: secret, decider: decider, logger: logger}
}

type approvalDecisionBody struct {
	ApprovalID   string  `json:"approvalId"`
	CapabilityID string  `json:"capabilityId"`
	InputSHA256  string  `json:"inputSha256"`
	Decision     string  `json:"decision"`
	Comment      *string `json:"comment"`
}

func (h *GoApprovalDecisionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if len([]byte(h.secret)) < 32 || h.decider == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "approval decision unavailable"})
		return
	}
	claims, err := authbridge.VerifyApprovalDecision(h.secret, r.Header.Get(sessionAssertionHeader), time.Now())
	if err != nil || !isUUID(claims.Subject) || !isUUID(claims.OrganizationID) || claims.ActorID == nil ||
		!isUUID(*claims.ActorID) || !isUUID(claims.ApprovalID) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body approvalDecisionBody
	if err := decoder.Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.ApprovalID != claims.ApprovalID || body.CapabilityID != claims.CapabilityID ||
		body.InputSHA256 != claims.InputSHA256 || body.Decision != claims.Decision || !sameComment(body.Comment, claims.Comment) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	result, err := h.decider.Decide(r.Context(), claims.CapabilityClaims(), capability.ApprovalDecisionInput{
		ApprovalID: claims.ApprovalID,
		Decision:   claims.Decision,
		Comment:    claims.Comment,
	})
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go approval decision failed", "approvalId", claims.ApprovalID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	status := result.HTTPStatus
	if status < http.StatusOK || status > 599 {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, result)
}

func sameComment(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
