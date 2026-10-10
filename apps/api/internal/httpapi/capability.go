package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

const capabilityBodyLimit = 64 << 10
const messagingUploadBodyLimit = 7_000_000 + capabilityBodyLimit
const messagingUploadCapabilityID = "messaging.uploadMessageAttachment"

func capabilityBodyLimitFor(capabilityID string) int64 {
	if capabilityID == messagingUploadCapabilityID {
		return messagingUploadBodyLimit
	}
	return capabilityBodyLimit
}

type CapabilityExecutor interface {
	Execute(context.Context, authbridge.CapabilityClaims, string, json.RawMessage) (capability.Result, error)
}

type GoCapabilityHandler struct {
	secret   string
	executor CapabilityExecutor
	logger   *slog.Logger
}

func NewGoCapabilityHandler(secret string, executor CapabilityExecutor, logger *slog.Logger) http.Handler {
	return &GoCapabilityHandler{secret: secret, executor: executor, logger: logger}
}

func (h *GoCapabilityHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if len([]byte(h.secret)) < 32 || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "capability execution unavailable"})
		return
	}
	claims, err := authbridge.VerifyCapability(h.secret, r.Header.Get(sessionAssertionHeader), time.Now())
	if err != nil || !isUUID(claims.Subject) || !isUUID(claims.OrganizationID) || claims.ActorID == nil || !isUUID(*claims.ActorID) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	bodyBytes, err := io.ReadAll(http.MaxBytesReader(w, r.Body, capabilityBodyLimitFor(claims.CapabilityID)))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(bodyBytes))
	decoder.DisallowUnknownFields()
	var body struct {
		CapabilityID string          `json:"capabilityId"`
		Input        json.RawMessage `json:"input"`
	}
	if err := decoder.Decode(&body); err != nil || body.CapabilityID == "" || len(body.Input) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	inputHash, err := capability.InputHash(body.Input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.CapabilityID != claims.CapabilityID || inputHash != claims.InputSHA256 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	result, err := h.executor.Execute(r.Context(), claims, body.CapabilityID, body.Input)
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
			h.logger.Error("Go capability execution failed", "capabilityId", body.CapabilityID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, struct {
			OK              bool   `json:"ok"`
			PendingApproval bool   `json:"pendingApproval"`
			Reason          string `json:"reason"`
			ApprovalID      string `json:"approvalId,omitempty"`
		}{OK: false, PendingApproval: true, Reason: reason, ApprovalID: result.ApprovalID})
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, result)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: result.Data})
}
