package httpapi

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type RecurringSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewRecurringSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &RecurringSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *RecurringSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "recurring template service unavailable"})
		return
	}
	resolved, ok := financeSalesResolveSession(w, r, h.resolver)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		if status, message := financeSalesAuthorize(resolved, "accounting", "accounting.read"); status != 0 {
			writeJSON(w, status, map[string]string{"error": message})
			return
		}
		h.get(w, r, resolved)
		return
	}
	if status, message := financeSalesAuthorize(resolved, "accounting", "accounting.write"); status != 0 {
		writeJSON(w, status, map[string]string{"error": message})
		return
	}
	if r.Header.Get("Authorization") == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	h.post(w, r, resolved)
}

func (h *RecurringSessionHandler) get(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	result, ok := financeSalesRun(w, r, h.executor, h.logger, resolved, "accounting.listRecurringTemplates", json.RawMessage(`{}`), "")
	if !ok {
		return
	}
	if !result.OK {
		writeJSON(w, financeSalesRefusalStatus(result), map[string]string{"error": result.Error})
		return
	}
	var output capability.ListRecurringTemplatesOutput
	if json.Unmarshal(result.Data, &output) != nil || output.Templates == nil {
		financeSalesInternalError(w, h.logger, "Go recurring template list capability returned invalid data")
		return
	}
	writeJSON(w, http.StatusOK, output)
}

func (h *RecurringSessionHandler) post(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	fields, ok := financeSalesDecodeFields(w, r)
	if !ok {
		return
	}
	action, ok := financeSalesAction(fields)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID, err := financeSalesIntentID(fields)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var capabilityID string
	var input json.RawMessage
	switch action {
	case "create":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "customerId", "frequency", "memo", "lines", "firstRunAt"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields, "customerId", "frequency", "memo", "lines", "firstRunAt"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if _, err = capability.ParseCreateRecurringTemplateInput(input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "accounting.createRecurringTemplate"
	case "pause":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "templateId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields, "templateId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if _, err = capability.ParsePauseRecurringTemplateInput(input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "accounting.pauseRecurringTemplate"
	case "resume":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "templateId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields, "templateId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if _, err = capability.ParseResumeRecurringTemplateInput(input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "accounting.resumeRecurringTemplate"
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	result, ok := financeSalesRun(w, r, h.executor, h.logger, resolved, capabilityID, input, intentID)
	if !ok {
		return
	}
	if result.PendingApproval {
		financeSalesPendingApproval(w, result)
		return
	}
	if !result.OK {
		writeJSON(w, financeSalesRefusalStatus(result), map[string]any{"ok": false, "error": result.Error})
		return
	}
	if !financeSalesValidRecurringOutput(action, result.Data) {
		financeSalesInternalError(w, h.logger, "Go recurring template capability returned invalid data")
		return
	}
	financeSalesWriteOK(w, result.Data)
}

func financeSalesValidRecurringOutput(action string, raw json.RawMessage) bool {
	switch action {
	case "create":
		var output capability.CreateRecurringTemplateOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.TemplateID) && output.NextRunAt != ""
	case "pause":
		var output capability.PauseRecurringTemplateOutput
		return financeSalesDecodeOutput(raw, &output) == nil && !output.Active
	case "resume":
		var output capability.ResumeRecurringTemplateOutput
		return financeSalesDecodeOutput(raw, &output) == nil && output.Active
	default:
		return false
	}
}
