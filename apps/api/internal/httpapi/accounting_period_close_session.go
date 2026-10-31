package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const accountingPeriodCloseBodyLimit = 64 << 10

type AccountingPeriodCloseSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewAccountingPeriodCloseSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &AccountingPeriodCloseSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (handler *AccountingPeriodCloseSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if handler == nil || handler.resolver == nil || handler.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounting service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, handler.resolver, selector)
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
	if r.Method == http.MethodPost && r.Header.Get("Authorization") == "" && !sameOriginCapabilityRequest(r, handler.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if r.Method == http.MethodGet {
		handler.get(w, r, resolved)
		return
	}
	handler.post(w, r, resolved)
}

func (handler *AccountingPeriodCloseSessionHandler) get(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	query := r.URL.Query()
	yearValue, monthValue := query.Get("year"), query.Get("month")
	var period capability.ClosePeriodInput
	if yearValue == "" && monthValue == "" {
		now := time.Now().UTC()
		prior := time.Date(now.Year(), now.Month()-1, 1, 0, 0, 0, 0, time.UTC)
		period = capability.ClosePeriodInput{Year: int64(prior.Year()), Month: int64(prior.Month())}
	} else {
		year, yearErr := strconv.ParseInt(yearValue, 10, 64)
		month, monthErr := strconv.ParseInt(monthValue, 10, 64)
		if yearErr != nil || monthErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid close period"})
			return
		}
		period = capability.ClosePeriodInput{Year: year, Month: month}
	}
	input, err := json.Marshal(period)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid close period"})
		return
	}
	if _, err := capability.ParsePeriodCloseWorkbenchInput(input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid close period"})
		return
	}
	result, err := handler.execute(r.Context(), resolved, "accounting.periodCloseWorkbench", input, "")
	if handler.writeExecutionError(w, "accounting.periodCloseWorkbench", result, err) {
		return
	}
	if err := validatePeriodCloseOutput("accounting.periodCloseWorkbench", result.Data, &period); err != nil {
		handler.logInvalidOutput("accounting.periodCloseWorkbench")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result.Data})
}

func (handler *AccountingPeriodCloseSessionHandler) post(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, accountingPeriodCloseBodyLimit)
	decoder := json.NewDecoder(r.Body)
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
	var intentID string
	if raw, exists := fields["intentId"]; !exists || json.Unmarshal(raw, &intentID) != nil || strings.TrimSpace(intentID) == "" || len(utf16.Encode([]rune(intentID))) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "intentId is required"})
		return
	}
	var action string
	if json.Unmarshal(fields["action"], &action) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	selected := func(names ...string) json.RawMessage {
		inputFields := make(map[string]json.RawMessage, len(names))
		for _, name := range names {
			if value, exists := fields[name]; exists {
				inputFields[name] = value
			}
		}
		input, _ := json.Marshal(inputFields)
		return input
	}

	var capabilityID string
	var input json.RawMessage
	var err error
	allowed := []string{"action", "intentId", "year", "month"}
	switch action {
	case "checklist":
		capabilityID = "accounting.updatePeriodCloseCheck"
		allowed = append(allowed, "taskKey", "completed", "note")
		input, err = selectedPeriodCloseInput(selected("year", "month", "taskKey", "completed", "note"))
	case "revalue":
		capabilityID = "accounting.revalueForeignReceivables"
		input, err = selectedAccountingPeriodInput(selected("year", "month"))
	case "close":
		capabilityID = "accounting.closePeriod"
		input, err = selectedAccountingPeriodInput(selected("year", "month"))
	case "reopen":
		capabilityID = "accounting.reopenPeriod"
		input, err = selectedAccountingPeriodInput(selected("year", "month"))
	default:
		err = errors.New("invalid action")
	}
	allowedFields := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedFields[key] = struct{}{}
	}
	for key := range fields {
		if _, exists := allowedFields[key]; !exists {
			err = errors.New("unexpected field")
			break
		}
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	result, err := handler.execute(r.Context(), resolved, capabilityID, input, intentID)
	if handler.writeExecutionError(w, capabilityID, result, err) {
		return
	}
	var period *capability.ClosePeriodInput
	if action != "checklist" {
		parsed, parseErr := capability.ParseClosePeriodInput(input)
		if parseErr != nil {
			handler.logInvalidOutput(capabilityID)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		period = &parsed
	}
	if err := validatePeriodCloseOutput(capabilityID, result.Data, period); err != nil {
		handler.logInvalidOutput(capabilityID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result.Data})
}

var periodCloseCurrencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)
var periodCloseTaskKeys = []string{"review_journal", "review_receivables", "review_payables", "review_tax", "bank_reconciliation", "fx_revaluation"}

const javascriptSafeIntegerMaximum int64 = 1<<53 - 1

func validatePeriodCloseOutput(capabilityID string, data json.RawMessage, requested *capability.ClosePeriodInput) error {
	switch capabilityID {
	case "accounting.periodCloseWorkbench":
		var output capability.PeriodCloseWorkbenchOutput
		if !hasExactJSONKeys(data, "year", "month", "start", "end", "tasks", "blockers", "readyToClose", "unmatchedLineCount", "currenciesWithExposure") || hasNullJSONFields(data, "year", "month", "start", "end", "tasks", "blockers", "readyToClose", "unmatchedLineCount", "currenciesWithExposure") || json.Unmarshal(data, &output) != nil || output.Tasks == nil || output.Blockers == nil || output.CurrenciesWithExposure == nil {
			return errors.New("invalid workbench output")
		}
		if requested == nil || output.Year != requested.Year || output.Month != requested.Month || output.UnmatchedLineCount < 0 || output.UnmatchedLineCount > javascriptSafeIntegerMaximum {
			return errors.New("workbench period does not match request")
		}
		start := time.Date(int(requested.Year), time.Month(requested.Month), 1, 0, 0, 0, 0, time.UTC)
		end := start.AddDate(0, 1, 0).Add(-time.Millisecond)
		if output.Start != start.Format("2006-01-02T15:04:05.000Z") || output.End != end.Format("2006-01-02T15:04:05.000Z") {
			return errors.New("workbench period boundaries do not match request")
		}
		if len(output.Tasks) != len(periodCloseTaskKeys) {
			return errors.New("workbench task set is incomplete")
		}
		blocking := make([]string, 0, len(output.Blockers))
		var taskData []json.RawMessage
		if json.Unmarshal(mustJSONField(data, "tasks"), &taskData) != nil || len(taskData) != len(output.Tasks) {
			return errors.New("invalid workbench tasks")
		}
		for index, task := range output.Tasks {
			if !hasExactJSONKeys(taskData[index], "key", "label", "detail", "completed", "note", "blocking", "status") || hasNullJSONFields(taskData[index], "key", "label", "detail", "completed", "blocking", "status") {
				return errors.New("invalid workbench task fields")
			}
			if task.Key == "" || task.Label == "" || task.Status == "" {
				return errors.New("incomplete workbench task")
			}
			if task.Key != periodCloseTaskKeys[index] {
				return errors.New("unsupported workbench task order")
			}
			status := "needs_review"
			if task.Completed {
				status = "complete"
			} else if task.Key == "bank_reconciliation" {
				status = "blocked"
			} else if task.Key == "fx_revaluation" {
				status = "needs_revaluation"
			}
			if task.Blocking == task.Completed || task.Status != status {
				return errors.New("inconsistent workbench task state")
			}
			if task.Blocking {
				blocking = append(blocking, task.Key)
			}
		}
		if len(blocking) != len(output.Blockers) || output.ReadyToClose != (len(output.Blockers) == 0) || output.Tasks[4].Completed != (output.UnmatchedLineCount == 0) || (len(output.CurrenciesWithExposure) == 0 && !output.Tasks[5].Completed) {
			return errors.New("inconsistent workbench readiness")
		}
		for index, blocker := range output.Blockers {
			if blocker != blocking[index] {
				return errors.New("workbench blockers do not match tasks")
			}
		}
		for _, currency := range output.CurrenciesWithExposure {
			if !periodCloseCurrencyPattern.MatchString(currency) {
				return errors.New("invalid workbench currency")
			}
		}
	case "accounting.updatePeriodCloseCheck":
		var output capability.PeriodCloseCheckOutput
		if !hasExactJSONKeys(data, "updated", "previousCompleted", "previousNote") || hasNullJSONFields(data, "updated", "previousCompleted") || json.Unmarshal(data, &output) != nil || !output.Updated {
			return errors.New("invalid checklist output")
		}
	case "accounting.closePeriod":
		var output capability.ClosePeriodOutput
		if !hasExactJSONKeys(data, "closed") || hasNullJSONFields(data, "closed") || json.Unmarshal(data, &output) != nil || !output.Closed {
			return errors.New("invalid close output")
		}
	case "accounting.reopenPeriod":
		var output capability.ReopenPeriodOutput
		if !hasExactJSONKeys(data, "reopened") || hasNullJSONFields(data, "reopened") || json.Unmarshal(data, &output) != nil || !output.Reopened {
			return errors.New("invalid reopen output")
		}
	case "accounting.revalueForeignReceivables":
		var output capability.RevalueForeignReceivablesOutput
		if !hasExactJSONKeys(data, "revaluationId", "entryId", "totalAdjustmentMinor", "currencies", "alreadyReviewed") || hasNullJSONFields(data, "revaluationId", "totalAdjustmentMinor", "currencies", "alreadyReviewed") || json.Unmarshal(data, &output) != nil || !isUUID(output.RevaluationID) || output.Currencies == nil || output.TotalAdjustmentMinor < -javascriptSafeIntegerMaximum || output.TotalAdjustmentMinor > javascriptSafeIntegerMaximum {
			return errors.New("invalid revaluation output")
		}
		if output.EntryID != nil && !isUUID(*output.EntryID) {
			return errors.New("invalid revaluation entry")
		}
		var currencyData []json.RawMessage
		if json.Unmarshal(mustJSONField(data, "currencies"), &currencyData) != nil || len(currencyData) != len(output.Currencies) {
			return errors.New("invalid revaluation currencies")
		}
		for index, currency := range output.Currencies {
			if !hasExactJSONKeys(currencyData[index], "currency", "foreignMinor", "historicalBaseMinor", "closeBaseMinor", "adjustmentMinor", "rateNum", "rateDen") || hasNullJSONFields(currencyData[index], "currency", "foreignMinor", "historicalBaseMinor", "closeBaseMinor", "adjustmentMinor", "rateNum", "rateDen") ||
				!periodCloseCurrencyPattern.MatchString(currency.Currency) || currency.ForeignMinor < 0 || currency.ForeignMinor > javascriptSafeIntegerMaximum || currency.HistoricalBaseMinor < 0 || currency.HistoricalBaseMinor > javascriptSafeIntegerMaximum || currency.CloseBaseMinor < 0 || currency.CloseBaseMinor > javascriptSafeIntegerMaximum || currency.AdjustmentMinor < -javascriptSafeIntegerMaximum || currency.AdjustmentMinor > javascriptSafeIntegerMaximum || currency.RateNum <= 0 || currency.RateNum > javascriptSafeIntegerMaximum || currency.RateDen <= 0 || currency.RateDen > javascriptSafeIntegerMaximum {
				return errors.New("invalid revaluation currency")
			}
		}
	default:
		return errors.New("unsupported period close output")
	}
	return nil
}

func hasExactJSONKeys(raw json.RawMessage, required ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil || len(fields) != len(required) {
		return false
	}
	for _, key := range required {
		if _, exists := fields[key]; !exists {
			return false
		}
	}
	return true
}

func hasNullJSONFields(raw json.RawMessage, keys ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return true
	}
	for _, key := range keys {
		if strings.TrimSpace(string(fields[key])) == "null" {
			return true
		}
	}
	return false
}

func mustJSONField(raw json.RawMessage, key string) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	return fields[key]
}

func selectedAccountingPeriodInput(raw json.RawMessage) (json.RawMessage, error) {
	if _, err := capability.ParseClosePeriodInput(raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func selectedPeriodCloseInput(raw json.RawMessage) (json.RawMessage, error) {
	if _, err := capability.ParseUpdatePeriodCloseCheckInput(raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func (handler *AccountingPeriodCloseSessionHandler) execute(ctx context.Context, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (capability.Result, error) {
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
	return handler.executor.Execute(ctx, claims, capabilityID, input)
}

func (handler *AccountingPeriodCloseSessionHandler) writeExecutionError(w http.ResponseWriter, capabilityID string, result capability.Result, err error) bool {
	if err != nil {
		handler.logError("period close capability execution failed", err)
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return true
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason})
		return true
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": result.Error})
		return true
	}
	if !json.Valid(result.Data) {
		handler.logInvalidOutput(capabilityID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return true
	}
	return false
}

func (handler *AccountingPeriodCloseSessionHandler) logError(message string, err error) {
	if handler.logger != nil {
		handler.logger.Error(message, "error", err)
	}
}

func (handler *AccountingPeriodCloseSessionHandler) logInvalidOutput(capabilityID string) {
	if handler.logger != nil {
		handler.logger.Error("period close capability returned invalid output", "capabilityId", capabilityID)
	}
}

var _ http.Handler = (*AccountingPeriodCloseSessionHandler)(nil)
