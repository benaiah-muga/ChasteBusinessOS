package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const timeRouteBodyLimit = 64 << 10

type TimeSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewTimeSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var proxies []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		proxies = trustedProxyCIDRs[0]
	}
	return &TimeSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: proxies}
}

func (h *TimeSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "time service unavailable"})
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
	if r.Method == http.MethodPost && r.Header.Get("Authorization") == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if r.Method == http.MethodGet {
		h.get(w, r, resolved)
		return
	}
	h.post(w, r, resolved)
}

func (h *TimeSessionHandler) get(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "hr") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "People module is disabled"})
		return
	}
	var capabilityID string
	var input json.RawMessage
	if r.URL.Query().Get("pending") != "" {
		capabilityID = "hr.pendingTimeEntries"
		input = json.RawMessage(`{}`)
	} else {
		from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
		if from == "" || to == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "from and to are required"})
			return
		}
		fromDate, fromErr := normalizeTimeDate(from)
		toDate, toErr := normalizeTimeDate(to)
		if fromErr != nil || toErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid dates"})
			return
		}
		fields := map[string]any{"from": fromDate, "to": toDate}
		if employeeID, present := r.URL.Query()["employeeId"]; present && len(employeeID) > 0 {
			fields["employeeId"] = employeeID[0]
		}
		var err error
		input, err = json.Marshal(fields)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		if _, err := capability.ParseHRTimeReportInput(input); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
			return
		}
		capabilityID = "hr.timeReport"
	}
	result, err := h.execute(r, resolved, capabilityID, input, "")
	if h.writeExecutionError(w, capabilityID, result, err) {
		return
	}
	if capabilityID == "hr.pendingTimeEntries" {
		var output capability.HRPendingTimeEntriesOutput
		if json.Unmarshal(result.Data, &output) != nil || output.Entries == nil {
			h.logInvalidOutput(capabilityID)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		writeJSON(w, http.StatusOK, output)
		return
	}
	var output capability.HRTimeReportOutput
	if json.Unmarshal(result.Data, &output) != nil || output.Rows == nil {
		h.logInvalidOutput(capabilityID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, output)
}

func (h *TimeSessionHandler) post(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, timeRouteBodyLimit))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
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
	var action string
	if json.Unmarshal(fields["action"], &action) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var intentID string
	if rawIntent, exists := fields["intentId"]; !exists || json.Unmarshal(rawIntent, &intentID) != nil || intentID == "" || len(intentID) > 160 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}

	var capabilityID string
	var input json.RawMessage
	switch action {
	case "log":
		capabilityID = "hr.logTime"
		input, err = selectedTimeInput(fields, "employeeId", "workDate", "minutes", "note")
		if err == nil {
			var normalized map[string]json.RawMessage
			if json.Unmarshal(input, &normalized) != nil {
				err = errors.New("invalid body")
			} else {
				var date string
				date, err = normalizeTimeDateRaw(normalized["workDate"])
				if err == nil {
					normalized["workDate"], _ = json.Marshal(date)
					input, err = json.Marshal(normalized)
				}
			}
		}
		if err == nil {
			_, err = capability.ParseHRLogTimeInput(input)
		}
	case "decide":
		capabilityID = "hr.decideTimeEntry"
		input, err = selectedTimeInput(fields, "entryId", "decision")
		if err == nil {
			_, err = capability.ParseHRDecideTimeEntryInput(input)
		}
	default:
		err = errors.New("invalid action")
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	result, err := h.execute(r, resolved, capabilityID, input, intentID)
	if h.writeExecutionError(w, capabilityID, result, err) {
		return
	}
	switch capabilityID {
	case "hr.logTime":
		var output capability.HRLogTimeOutput
		if json.Unmarshal(result.Data, &output) != nil || !isUUID(output.EntryID) || output.Status != "submitted" {
			h.logInvalidOutput(capabilityID)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": output})
	case "hr.decideTimeEntry":
		var output capability.HRDecideTimeEntryOutput
		if json.Unmarshal(result.Data, &output) != nil || !isUUID(output.EntryID) || (output.Status != "approved" && output.Status != "rejected") {
			h.logInvalidOutput(capabilityID)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": output})
	}
}

func selectedTimeInput(fields map[string]json.RawMessage, names ...string) (json.RawMessage, error) {
	selected := make(map[string]json.RawMessage, len(names))
	for _, name := range names {
		if raw, exists := fields[name]; exists {
			selected[name] = raw
		}
	}
	input, err := json.Marshal(selected)
	if err != nil {
		return nil, err
	}
	return input, nil
}

func normalizeTimeDate(value string) (string, error) {
	if parsed, err := time.Parse(time.DateOnly, value); err == nil {
		return parsed.Format(time.DateOnly), nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return "", err
	}
	return parsed.UTC().Format(time.DateOnly), nil
}

func normalizeTimeDateRaw(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", errors.New("workDate is required")
	}
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return normalizeTimeDate(value)
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" || trimmed == "false" {
		return time.UnixMilli(0).UTC().Format(time.DateOnly), nil
	}
	if trimmed == "true" {
		return time.UnixMilli(1).UTC().Format(time.DateOnly), nil
	}
	var number json.Number
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&number) != nil {
		return "", errors.New("workDate must be a date")
	}
	millis, err := strconv.ParseFloat(number.String(), 64)
	if err != nil || math.IsNaN(millis) || math.IsInf(millis, 0) || math.Abs(millis) > 8.64e15 {
		return "", errors.New("workDate must be a valid date")
	}
	return time.UnixMilli(int64(math.Trunc(millis))).UTC().Format(time.DateOnly), nil
}

func (h *TimeSessionHandler) execute(r *http.Request, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (capability.Result, error) {
	inputHash, err := capability.InputHash(input)
	if err != nil {
		return capability.Result{}, err
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
		CapabilityID: capabilityID, InputSHA256: inputHash, ActorID: &actorID,
		ActorType: "human", Permissions: permissions, AuthSessionID: resolved.AuthSessionID,
		IntentID: intentID, IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
	return h.executor.Execute(r.Context(), claims, capabilityID, input)
}

func (h *TimeSessionHandler) writeExecutionError(w http.ResponseWriter, capabilityID string, result capability.Result, err error) bool {
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if h.logger != nil {
				h.logger.Error("Go time capability failed", "capabilityId", capabilityID, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return true
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": result.Error})
		return true
	}
	return false
}

func (h *TimeSessionHandler) logInvalidOutput(capabilityID string) {
	if h.logger != nil {
		h.logger.Error("Go time capability returned invalid data", "capabilityId", capabilityID)
	}
}
