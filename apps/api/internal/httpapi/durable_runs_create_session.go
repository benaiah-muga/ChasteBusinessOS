package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/jobs"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const durableRunCreateBodyLimit = 128 << 10

type durableRunsSessionStarter interface {
	CreateAndDispatch(context.Context, jobs.StartDurableRunInput) (jobs.StartDurableRunResult, error)
}

type durableRunCreateRequest struct {
	RunID                  string                     `json:"runId"`
	Goal                   string                     `json:"goal"`
	SessionID              *string                    `json:"sessionId,omitempty"`
	RegistryVersion        string                     `json:"registryVersion,omitempty"`
	ModelRef               *string                    `json:"modelRef,omitempty"`
	HarnessCompositionID   string                     `json:"harnessCompositionId"`
	HarnessCompositionHash string                     `json:"harnessCompositionDigest"`
	CompositionApprovalID  string                     `json:"compositionApprovalId"`
	Steps                  []jobs.DurableRunStepInput `json:"steps"`
}

func (h *DurableRunsSessionHandler) create(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	w.Header().Set("Cache-Control", "no-store")
	if h.starter == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "durable run dispatch unavailable"})
		return
	}
	if strings.TrimSpace(r.Header.Get("Authorization")) == "" && !sameOriginCapabilityRequest(r, nil) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "same-origin request required"})
		return
	}
	if !resolved.HasPermission("harness.approve") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "harness approval permission required"})
		return
	}
	var request durableRunCreateRequest
	if !decodeDurableRunCreateBody(w, r, &request) {
		return
	}
	for _, step := range request.Steps {
		permission, ok := jobs.GoCapabilityPermissions[step.CapabilityID]
		if !ok {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "run contains a capability that is unavailable in Go"})
			return
		}
		if !resolved.HasPermission(permission) && !resolved.HasPermission("*") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permission for durable run step"})
			return
		}
	}
	version := request.RegistryVersion
	if version == "" {
		version = strings.TrimSpace(os.Getenv("REGISTRY_VERSION"))
	}
	if version == "" {
		version = jobs.DurableRunDefaultVersion
	}
	result, err := h.starter.CreateAndDispatch(r.Context(), jobs.StartDurableRunInput{
		RunID: request.RunID, OrgID: *resolved.OrgID, ActorID: resolved.UserID, SessionID: request.SessionID,
		Goal: request.Goal, RegistryVersion: version, ModelRef: request.ModelRef,
		HarnessCompositionID: request.HarnessCompositionID, HarnessCompositionHash: request.HarnessCompositionHash,
		CompositionApprovalID: request.CompositionApprovalID, Steps: request.Steps,
	})
	if err != nil {
		switch {
		case errors.Is(err, jobs.ErrDurableRunConflict):
			writeJSON(w, http.StatusConflict, map[string]string{"error": "run id was already used for different durable work"})
		case errors.Is(err, jobs.ErrDurableRunInput), errors.Is(err, jobs.ErrDurableRunComposition), errors.Is(err, jobs.ErrDurableRunApproval):
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "durable run could not be validated"})
		case errors.Is(err, jobs.ErrDurableRunSession):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "durable run session is not available"})
		default:
			if h.logger != nil {
				h.logger.Error("Go durable run creation failed", "organizationId", *resolved.OrgID, "error", err.Error())
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	status := result.Status
	if status == "" {
		status = "pending"
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"runId": result.RunID, "status": status, "replayed": result.Replayed})
}

func decodeDurableRunCreateBody(w http.ResponseWriter, r *http.Request, target *durableRunCreateRequest) bool {
	if r.Body == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return false
	}
	defer r.Body.Close()
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, durableRunCreateBodyLimit))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return false
	}
	return true
}
