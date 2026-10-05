package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type analyticsDataset struct {
	ID          string                  `json:"id"`
	Label       string                  `json:"label"`
	Description string                  `json:"description"`
	Permission  string                  `json:"-"`
	Params      []analyticsDatasetParam `json:"params,omitempty"`
}

type analyticsDatasetParam struct {
	Key     string `json:"key"`
	Type    string `json:"type"`
	Default int    `json:"default"`
}

var analyticsDatasets = []analyticsDataset{
	{ID: "analytics.pipelineByStage", Label: "Pipeline by stage", Description: "Deal counts and values per stage with weighted forecast", Permission: "crm.read"},
	{ID: "analytics.revenueByMonth", Label: "Revenue by month", Description: "Invoiced totals per month over a lookback window", Permission: "accounting.read", Params: []analyticsDatasetParam{{Key: "monthsBack", Type: "number", Default: 12}}},
	{ID: "analytics.invoiceAging", Label: "Invoice aging", Description: "Open invoice balances bucketed by days outstanding", Permission: "accounting.read"},
	{ID: "analytics.salesByCustomer", Label: "Top customers", Description: "Customers ranked by invoiced value", Permission: "accounting.read", Params: []analyticsDatasetParam{{Key: "limit", Type: "number", Default: 10}}},
	{ID: "analytics.stockLevels", Label: "Stock levels & valuation", Description: "On-hand quantities with unit cost and value per item", Permission: "inventory.read"},
}

const (
	analyticsReportRequestMaxBytes = 1 << 20
	analyticsReportInputMaxBytes   = 2 << 20
	analyticsReportOutputMaxBytes  = 4 << 20
)

type analyticsReportRequest struct {
	Title     string                          `json:"title"`
	Narrative *string                         `json:"narrative,omitempty"`
	Sections  []analyticsReportRequestSection `json:"sections"`
}

type analyticsReportRequestSection struct {
	Heading   string          `json:"heading"`
	DatasetID string          `json:"datasetId"`
	Params    json.RawMessage `json:"params"`
	Ops       json.RawMessage `json:"ops,omitempty"`
	Chart     json.RawMessage `json:"chart,omitempty"`
}

type analyticsSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type AnalyticsSessionHandler struct {
	resolver analyticsSessionResolver
	executor CapabilityExecutor
	logger   *slog.Logger
}

// NewAnalyticsSessionHandler exposes authenticated analytics discovery, preview,
// and report generation directly through the governed Go capability executor.
func NewAnalyticsSessionHandler(resolver analyticsSessionResolver, executor CapabilityExecutor, logger *slog.Logger) http.Handler {
	return &AnalyticsSessionHandler{resolver: resolver, executor: executor, logger: logger}
}

func (h *AnalyticsSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "analytics service unavailable"})
		return
	}

	selector, valid := modulesOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || resolved.AuthSessionID == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if selector != "" && !strings.EqualFold(selector, *resolved.OrgID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if r.Method == http.MethodPost {
		h.serveReport(w, r, resolved)
		return
	}

	requested := r.URL.Query().Get("dataset")
	if requested == "" {
		datasets := make([]analyticsDataset, 0, len(analyticsDatasets))
		for _, dataset := range analyticsDatasets {
			if resolved.HasPermission(dataset.Permission) || resolved.HasPermission("*") {
				datasets = append(datasets, dataset)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"datasets": datasets})
		return
	}
	if !knownAnalyticsDataset(requested) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown dataset"})
		return
	}

	input := json.RawMessage(`{}`)
	claims := analyticsSessionClaims(resolved, requested, input)
	result, err := h.executor.Execute(r.Context(), claims, requested, input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if h.logger != nil {
				h.logger.Error("Go direct analytics read failed", "datasetId", requested, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	if !result.OK {
		message := result.Error
		if message == "" {
			message = "forbidden"
		}
		writeJSON(w, http.StatusForbidden, map[string]string{"error": message})
		return
	}
	if !json.Valid(result.Data) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Data))
}

func (h *AnalyticsSessionHandler) serveReport(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	var request analyticsReportRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, analyticsReportRequestMaxBytes))
	var rawRequest json.RawMessage
	if err := decoder.Decode(&rawRequest); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body", "detail": err.Error()})
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body", "detail": "contains trailing JSON data"})
		return
	}
	if err := rejectNullAnalyticsReportOptionals(rawRequest); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body", "detail": err.Error()})
		return
	}
	if err := json.Unmarshal(rawRequest, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body", "detail": err.Error()})
		return
	}
	if request.Sections == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body", "detail": "sections is required"})
		return
	}

	for _, section := range request.Sections {
		if !knownAnalyticsDataset(section.DatasetID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown dataset " + section.DatasetID})
			return
		}
		params := section.Params
		if len(params) == 0 {
			params = json.RawMessage(`{}`)
		}
		if err := capability.ValidateAnalyticsDatasetInput(section.DatasetID, params); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body", "detail": err.Error()})
			return
		}
	}

	// Use the renderer's own parser before reading any datasets so malformed
	// chart or frame operations cannot trigger partial report reads.
	validationSections := make([]map[string]any, 0, len(request.Sections))
	for _, section := range request.Sections {
		validation := map[string]any{"heading": section.Heading, "columns": []string{"_"}, "rows": []map[string]any{}}
		if len(section.Ops) != 0 {
			validation["ops"] = section.Ops
		}
		if len(section.Chart) != 0 {
			validation["chart"] = section.Chart
		}
		validationSections = append(validationSections, validation)
	}
	validationBody, err := json.Marshal(map[string]any{"title": request.Title, "narrative": request.Narrative, "sections": validationSections})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body", "detail": "could not encode report"})
		return
	}
	if _, err := capability.ParseAnalyticsRenderReportInput(validationBody); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body", "detail": err.Error()})
		return
	}

	sections := make([]map[string]any, 0, len(request.Sections))
	datasetPayloadBytes := 0
	for _, section := range request.Sections {
		params := section.Params
		if len(params) == 0 {
			params = json.RawMessage(`{}`)
		}
		result, err := h.executeAnalyticsCapability(r, resolved, section.DatasetID, params)
		if err != nil {
			h.writeAnalyticsError(w, section.DatasetID, err)
			return
		}
		if !result.OK {
			message := result.Error
			if message == "" {
				message = "dataset " + section.DatasetID + " failed"
			}
			writeJSON(w, http.StatusForbidden, map[string]string{"error": message})
			return
		}
		datasetPayloadBytes += len(result.Data)
		if datasetPayloadBytes > analyticsReportInputMaxBytes || len(result.Data) > analyticsReportInputMaxBytes {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		var dataset capability.AnalyticsDatasetOutput
		if !json.Valid(result.Data) || json.Unmarshal(result.Data, &dataset) != nil || len(dataset.Columns) == 0 || len(dataset.Rows) > 5000 {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		entry := map[string]any{"heading": section.Heading, "columns": dataset.Columns, "rows": dataset.Rows}
		if len(section.Ops) != 0 && string(section.Ops) != "null" {
			entry["ops"] = section.Ops
		}
		if len(section.Chart) != 0 && string(section.Chart) != "null" {
			entry["chart"] = section.Chart
		}
		sections = append(sections, entry)
	}

	renderInput, err := json.Marshal(map[string]any{"title": request.Title, "narrative": request.Narrative, "sections": sections})
	if err != nil || len(renderInput) > analyticsReportInputMaxBytes {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body", "detail": "report data exceeds the supported size"})
		return
	}
	result, err := h.executeAnalyticsCapability(r, resolved, capability.AnalyticsRenderReportCapabilityID, renderInput)
	if err != nil {
		h.writeAnalyticsError(w, capability.AnalyticsRenderReportCapabilityID, err)
		return
	}
	if !result.OK {
		message := result.Error
		if message == "" {
			message = "report failed"
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": message})
		return
	}
	if !json.Valid(result.Data) || len(result.Data) > analyticsReportOutputMaxBytes {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(result.Data)
}

func rejectNullAnalyticsReportOptionals(raw json.RawMessage) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil
	}
	if value, ok := fields["narrative"]; ok && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return errors.New("narrative must be a string")
	}
	sectionsRaw, ok := fields["sections"]
	if !ok {
		return nil
	}
	var sections []json.RawMessage
	if err := json.Unmarshal(sectionsRaw, &sections); err != nil {
		return nil
	}
	for _, rawSection := range sections {
		var section map[string]json.RawMessage
		if err := json.Unmarshal(rawSection, &section); err != nil || section == nil {
			continue
		}
		if value, ok := section["ops"]; ok && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("ops must be an array")
		}
		if value, ok := section["chart"]; ok && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("chart must be an object")
		}
	}
	return nil
}

func (h *AnalyticsSessionHandler) executeAnalyticsCapability(r *http.Request, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage) (capability.Result, error) {
	return h.executor.Execute(r.Context(), analyticsSessionClaims(resolved, capabilityID, input), capabilityID, input)
}

func (h *AnalyticsSessionHandler) writeAnalyticsError(w http.ResponseWriter, capabilityID string, err error) {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	case errors.Is(err, capability.ErrNotMember):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
	default:
		if h.logger != nil {
			h.logger.Error("Go analytics capability failed", "capabilityId", capabilityID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

func (h *AnalyticsSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}

func knownAnalyticsDataset(id string) bool {
	for _, dataset := range analyticsDatasets {
		if dataset.ID == id {
			return true
		}
	}
	return false
}

func analyticsSessionClaims(resolved *session.ResolvedUser, capabilityID string, input json.RawMessage) authbridge.CapabilityClaims {
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
