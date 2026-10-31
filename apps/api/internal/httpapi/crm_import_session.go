package httpapi

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const (
	crmImportMaxRows      = 5000
	crmImportMaxBodyBytes = 4 << 20
)

var crmImportAmountPattern = regexp.MustCompile(`^(\d+)(?:\.(\d{1,2}))?$`)

type crmImportRequest struct {
	Entity         string          `json:"entity"`
	Action         string          `json:"action"`
	Rows           json.RawMessage `json:"rows"`
	ImportIDs      json.RawMessage `json:"importIds"`
	CustomerIDs    json.RawMessage `json:"customerIds"`
	ItemIDs        json.RawMessage `json:"itemIds"`
	ImportIntentID *string         `json:"importIntentId"`
	IntentID       *string         `json:"intentId"`
}

type crmImportRowIssue struct {
	Row     int64  `json:"row"`
	Field   string `json:"field,omitempty"`
	Message string `json:"message"`
}

// CRMImportSessionHandler ports the legacy CSV import route for customers
// (crm.importCustomers) and products (inventory.importItems) plus their undo
// actions, executing the same capabilities the Vite client calls directly.
type CRMImportSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
	limit             *inventoryImportRateLimiter
}

func NewCRMImportSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &CRMImportSessionHandler{
		resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted,
		limit: newInventoryImportRateLimiter(nil),
	}
}

func (h *CRMImportSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeImportUnavailable(w, "Import service unavailable.")
		return
	}
	resolved, ok := h.authorize(w, r)
	if !ok {
		return
	}
	request, ok := readCRMImportRequest(w, r)
	if !ok {
		return
	}
	if request.Entity != "customers" && request.Entity != "products" {
		writeImportError(w, http.StatusBadRequest, "invalid", "Unknown import type. Expected customers or products.")
		return
	}
	requiredPermission := "inventory.write"
	crmEntity := request.Entity == "customers"
	if crmEntity {
		requiredPermission = "crm.write"
	}
	if !resolved.HasPermission(requiredPermission) {
		writeImportError(w, http.StatusForbidden, "forbidden", "forbidden: missing "+requiredPermission)
		return
	}
	allowed, retryAfter := h.limit.allow(*resolved.OrgID)
	if !allowed {
		retryAfterSeconds := int64((retryAfter + time.Second - 1) / time.Second)
		if retryAfterSeconds < 1 {
			retryAfterSeconds = 1
		}
		w.Header().Set("Retry-After", strconv.FormatInt(retryAfterSeconds, 10))
		writeImportError(w, http.StatusTooManyRequests, "rate_limited", fmt.Sprintf("Import limit reached. Try again in %ds.", retryAfterSeconds))
		return
	}
	if request.Action == "undo" {
		if crmEntity {
			h.undoCustomerImport(w, r, resolved, request)
			return
		}
		h.undoProductImport(w, r, resolved, request)
		return
	}
	if crmEntity {
		h.importCustomers(w, r, resolved, request)
		return
	}
	h.importProducts(w, r, resolved, request)
}

func (h *CRMImportSessionHandler) authorize(w http.ResponseWriter, r *http.Request) (*session.ResolvedUser, bool) {
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeImportError(w, http.StatusBadRequest, "invalid", "Could not read that request.")
		return nil, false
	}
	resolved, err := h.resolve(r, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		strings.TrimSpace(resolved.AuthSessionID) == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeImportError(w, http.StatusUnauthorized, "unauthorized", "Your session has expired. Sign in again to continue.")
		return nil, false
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeImportError(w, http.StatusForbidden, "forbidden", "organization access denied")
		return nil, false
	}
	if strings.TrimSpace(r.Header.Get("Authorization")) == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeImportError(w, http.StatusForbidden, "forbidden", "forbidden")
		return nil, false
	}
	return resolved, true
}

func (h *CRMImportSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}

func readCRMImportRequest(w http.ResponseWriter, r *http.Request) (crmImportRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, crmImportMaxBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil || !utf8.Valid(body) {
		writeImportError(w, http.StatusBadRequest, "invalid", "Could not read that request.")
		return crmImportRequest{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var request crmImportRequest
	if decoder.Decode(&request) != nil {
		writeImportError(w, http.StatusBadRequest, "invalid", "Could not read that request.")
		return crmImportRequest{}, false
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeImportError(w, http.StatusBadRequest, "invalid", "Could not read that request.")
		return crmImportRequest{}, false
	}
	return request, true
}

func (h *CRMImportSessionHandler) undoCustomerImport(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, request crmImportRequest) {
	ids, ok := crmImportUndoIDs(request.CustomerIDs, request.ImportIDs)
	if !ok {
		writeImportError(w, http.StatusBadRequest, "invalid", "Select a valid recent import to undo.")
		return
	}
	importIntentID := ""
	if request.ImportIntentID != nil {
		importIntentID = strings.TrimSpace(*request.ImportIntentID)
	}
	if !isUUID(importIntentID) {
		writeImportError(w, http.StatusBadRequest, "invalid", "Select a valid recent import to undo.")
		return
	}
	intentID := crmImportIntentID(request.IntentID)
	if intentID == "" {
		generated, err := newCRMCollectionIntentID()
		if err != nil {
			h.writeImportExecuteError(w, "crm.undoCustomerImport", err)
			return
		}
		intentID = generated
	}
	input, err := json.Marshal(map[string]any{"customerIds": ids, "importIntentId": importIntentID})
	if err != nil {
		h.writeImportExecuteError(w, "crm.undoCustomerImport", err)
		return
	}
	result, err := h.execute(r, resolved, "crm.undoCustomerImport", intentID, input)
	if err != nil {
		h.writeImportExecuteError(w, "crm.undoCustomerImport", err)
		return
	}
	if result.PendingApproval {
		writeImportPending(w, result)
		return
	}
	if !result.OK {
		writeImportError(w, http.StatusUnprocessableEntity, "invalid", result.Error)
		return
	}
	var output struct {
		Deactivated    int64  `json:"deactivated"`
		ImportIntentID string `json:"importIntentId"`
	}
	if json.Unmarshal(result.Data, &output) != nil || output.ImportIntentID != importIntentID {
		writeImportUnavailable(w, "CRM service unavailable; check the import status before retrying.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"undone":    output.Deactivated,
		"remaining": maxInt64(0, int64(len(ids))-output.Deactivated),
	})
}

func (h *CRMImportSessionHandler) undoProductImport(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, request crmImportRequest) {
	ids, ok := crmImportUndoIDs(request.ItemIDs, request.ImportIDs)
	if !ok {
		writeImportError(w, http.StatusBadRequest, "invalid", "Select a valid recent import to undo.")
		return
	}
	input, err := json.Marshal(map[string]any{"itemIds": ids})
	if err != nil {
		h.writeImportExecuteError(w, "inventory.undoItemImport", err)
		return
	}
	result, err := h.execute(r, resolved, "inventory.undoItemImport", crmImportIntentID(request.IntentID), input)
	if err != nil {
		h.writeImportExecuteError(w, "inventory.undoItemImport", err)
		return
	}
	if result.PendingApproval {
		writeImportPending(w, result)
		return
	}
	if !result.OK {
		writeImportError(w, http.StatusUnprocessableEntity, "invalid", result.Error)
		return
	}
	var output struct {
		Archived int64 `json:"archived"`
	}
	if json.Unmarshal(result.Data, &output) != nil {
		writeImportUnavailable(w, "Inventory service unavailable; check the import status before retrying.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"undone":    output.Archived,
		"remaining": maxInt64(0, int64(len(ids))-output.Archived),
	})
}

func (h *CRMImportSessionHandler) importCustomers(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, request crmImportRequest) {
	entries, ok := crmImportRows(w, request.Rows)
	if !ok {
		return
	}
	prepared, fatal, issues := prepareCustomerImportRows(entries)
	if len(fatal) > 0 {
		writeImportRowDetail(w, fatal)
		return
	}
	if len(prepared) == 0 {
		writeImportRowsSuccess(w, 0, nil, issues, nil, "")
		return
	}
	intentID := crmImportIntentID(request.IntentID)
	if intentID == "" {
		generated, err := newCRMCollectionIntentID()
		if err != nil {
			h.writeImportExecuteError(w, "crm.importCustomers", err)
			return
		}
		intentID = generated
	}
	input, err := json.Marshal(map[string]any{"rows": json.RawMessage(crmImportRowsArray(prepared))})
	if err != nil {
		h.writeImportExecuteError(w, "crm.importCustomers", err)
		return
	}
	result, err := h.execute(r, resolved, "crm.importCustomers", intentID, input)
	if err != nil {
		h.writeImportExecuteError(w, "crm.importCustomers", err)
		return
	}
	if result.PendingApproval {
		writeImportPending(w, result)
		return
	}
	if !result.OK {
		writeImportError(w, http.StatusUnprocessableEntity, "invalid", result.Error)
		return
	}
	var output struct {
		CreatedIDs           []string `json:"createdIds"`
		Imported             int64    `json:"imported"`
		SkippedDuplicateRows []int64  `json:"skippedDuplicateRows"`
		ImportIntentID       string   `json:"importIntentId"`
	}
	if json.Unmarshal(result.Data, &output) != nil || output.ImportIntentID != intentID {
		writeImportUnavailable(w, "CRM service unavailable; check the import status before retrying.")
		return
	}
	writeImportRowsSuccess(w, output.Imported, output.SkippedDuplicateRows, issues, output.CreatedIDs, output.ImportIntentID)
}

func (h *CRMImportSessionHandler) importProducts(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, request crmImportRequest) {
	entries, ok := crmImportRows(w, request.Rows)
	if !ok {
		return
	}
	prepared, fatal, issues := prepareProductImportRows(entries)
	if len(fatal) > 0 {
		writeImportRowDetail(w, fatal)
		return
	}
	if len(prepared) == 0 {
		writeImportRowsSuccess(w, 0, nil, issues, nil, "")
		return
	}
	input, err := json.Marshal(map[string]any{"rows": json.RawMessage(crmImportRowsArray(prepared))})
	if err != nil {
		h.writeImportExecuteError(w, "inventory.importItems", err)
		return
	}
	result, err := h.execute(r, resolved, "inventory.importItems", crmImportIntentID(request.IntentID), input)
	if err != nil {
		h.writeImportExecuteError(w, "inventory.importItems", err)
		return
	}
	if result.PendingApproval {
		writeImportPending(w, result)
		return
	}
	if !result.OK {
		writeImportError(w, http.StatusUnprocessableEntity, "invalid", result.Error)
		return
	}
	var output struct {
		CreatedIDs           []string `json:"createdIds"`
		Imported             int64    `json:"imported"`
		SkippedDuplicateRows []int64  `json:"skippedDuplicateRows"`
	}
	if json.Unmarshal(result.Data, &output) != nil {
		writeImportUnavailable(w, "Inventory service unavailable; check the import status before retrying.")
		return
	}
	writeImportRowsSuccess(w, output.Imported, output.SkippedDuplicateRows, issues, output.CreatedIDs, "")
}

func (h *CRMImportSessionHandler) execute(r *http.Request, resolved *session.ResolvedUser, capabilityID, intentID string, input json.RawMessage) (capability.Result, error) {
	return h.executor.Execute(r.Context(), crmCollectionClaims(resolved, capabilityID, intentID, input), capabilityID, input)
}

func (h *CRMImportSessionHandler) writeImportExecuteError(w http.ResponseWriter, capabilityID string, err error) {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		writeImportError(w, http.StatusUnauthorized, "unauthorized", "Your session has expired. Sign in again to continue.")
	case errors.Is(err, capability.ErrNotMember):
		writeImportError(w, http.StatusForbidden, "forbidden", "organization access denied")
	default:
		if status, ok := capabilityErrorStatus(err); ok {
			writeImportError(w, status, "refused", err.Error())
			return
		}
		if h.logger != nil {
			h.logger.Error("Go CRM import failed", "capabilityId", capabilityID, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

func crmImportUndoIDs(primary, fallback json.RawMessage) ([]string, bool) {
	raw := primary
	if len(bytes.TrimSpace(raw)) == 0 || crmImportJSONNull(raw) {
		raw = fallback
	}
	if len(bytes.TrimSpace(raw)) == 0 || crmImportJSONNull(raw) {
		return nil, false
	}
	var ids []string
	if json.Unmarshal(raw, &ids) != nil || len(ids) < 1 || len(ids) > crmImportMaxRows {
		return nil, false
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if !isUUID(id) {
			return nil, false
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, false
		}
		seen[id] = struct{}{}
	}
	return ids, true
}

func crmImportIntentID(requested *string) string {
	if requested == nil {
		return ""
	}
	return strings.TrimSpace(*requested)
}

func crmImportRows(w http.ResponseWriter, raw json.RawMessage) ([]json.RawMessage, bool) {
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil || len(entries) < 1 {
		writeImportError(w, http.StatusBadRequest, "invalid", "No rows to import.")
		return nil, false
	}
	if len(entries) > crmImportMaxRows {
		writeImportError(w, http.StatusBadRequest, "invalid", fmt.Sprintf("That file has %d rows; the limit per import is %d. Split it and import again.", len(entries), crmImportMaxRows))
		return nil, false
	}
	return entries, true
}

func crmImportRowsArray(rows []json.RawMessage) []byte {
	encoded, err := json.Marshal(rows)
	if err != nil {
		return []byte("[]")
	}
	return encoded
}

func writeImportRowsSuccess(w http.ResponseWriter, inserted int64, skipped []int64, issues []crmImportRowIssue, created []string, importIntentID string) {
	if skipped == nil {
		skipped = []int64{}
	}
	if created == nil {
		created = []string{}
	}
	if issues == nil {
		issues = []crmImportRowIssue{}
	}
	body := map[string]any{
		"inserted":             inserted,
		"skippedDuplicates":    len(skipped),
		"skippedDuplicateRows": skipped,
		"errors":               issues,
		"createdIds":           created,
	}
	if importIntentID != "" {
		body["importIntentId"] = importIntentID
	}
	writeJSON(w, http.StatusOK, body)
}

func writeImportRowDetail(w http.ResponseWriter, issues []crmImportRowIssue) {
	writeJSON(w, http.StatusBadRequest, map[string]any{
		"error":  "Some rows are invalid. Review the preview and try again.",
		"detail": issues,
		"code":   "invalid",
	})
}

func writeImportPending(w http.ResponseWriter, result capability.Result) {
	reason := result.ApprovalRationale
	if reason == "" {
		reason = result.Error
	}
	if reason == "" {
		reason = "Import is awaiting approval."
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"error": reason, "pendingApproval": true})
}

func writeImportUnavailable(w http.ResponseWriter, message string) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": message, "code": "unavailable"})
}

func writeImportError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": message, "code": code})
}

func crmImportJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func crmImportObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, false
	}
	return fields, true
}

func crmImportString(raw json.RawMessage) (string, bool) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return strings.TrimSpace(value), true
}

func crmImportInteger(raw json.RawMessage) (int64, bool) {
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

func crmImportRowNumber(fields map[string]json.RawMessage, index int) (int64, *crmImportRowIssue) {
	fallback := int64(index + 2)
	raw, exists := fields["rowNumber"]
	if !exists || crmImportJSONNull(raw) {
		return fallback, nil
	}
	value, ok := crmImportInteger(raw)
	if !ok || value < 1 {
		return fallback, &crmImportRowIssue{Row: fallback, Field: "rowNumber", Message: "rowNumber must be a positive integer"}
	}
	return value, nil
}

// crmImportMinorAmount converts a legacy amount (string or JSON number, up to
// two decimals) into integer minor units.
func crmImportMinorAmount(raw json.RawMessage) (int64, bool) {
	if crmImportJSONNull(raw) {
		return 0, false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		value = strings.Trim(string(raw), `"`)
	}
	cleaned := strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(value), ",", ""), " ", "")
	match := crmImportAmountPattern.FindStringSubmatch(cleaned)
	if match == nil {
		return 0, false
	}
	whole, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil || whole > (math.MaxInt64-99)/100 {
		return 0, false
	}
	fraction := match[2]
	if len(fraction) == 1 {
		fraction += "0"
	}
	cents := int64(0)
	if fraction != "" {
		cents, err = strconv.ParseInt(fraction, 10, 64)
		if err != nil {
			return 0, false
		}
	}
	return whole*100 + cents, true
}

func crmImportScalarOrNumber(raw json.RawMessage) (string, bool, bool) {
	if crmImportJSONNull(raw) {
		return "", false, true
	}
	if value, ok := crmImportStringToken(raw); ok {
		return value, true, true
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err == nil {
		return number.String(), true, true
	}
	return "", false, false
}

func crmImportStringToken(raw json.RawMessage) (string, bool) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return strings.TrimSpace(value), true
}

func prepareCustomerImportRows(entries []json.RawMessage) ([]json.RawMessage, []crmImportRowIssue, []crmImportRowIssue) {
	prepared := make([]json.RawMessage, 0, len(entries))
	fatal := []crmImportRowIssue{}
	issues := []crmImportRowIssue{}
	for index, entry := range entries {
		fields, ok := crmImportObject(entry)
		if !ok {
			fatal = append(fatal, crmImportRowIssue{Row: int64(index + 2), Message: "Each import row must be an object."})
			continue
		}
		rowNumber, rowIssue := crmImportRowNumber(fields, index)
		if rowIssue != nil {
			fatal = append(fatal, *rowIssue)
			continue
		}
		nameRaw, exists := fields["name"]
		name := ""
		if !exists || crmImportJSONNull(nameRaw) {
			fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "name", Message: "name must be a non-empty string of at most 120 characters"})
			continue
		}
		if name, ok = crmImportString(nameRaw); !ok {
			fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "name", Message: "name must be a non-empty string of at most 120 characters"})
			continue
		}
		creditLimit, creditIssue, creditSkip := customerImportCreditLimit(fields, rowNumber)
		if creditSkip {
			fatal = append(fatal, creditIssue)
			continue
		}
		if creditIssue.Row != 0 {
			issues = append(issues, creditIssue)
			continue
		}
		paymentTerm, termIssue, termSkip := customerImportPaymentTerms(fields, rowNumber)
		if termSkip {
			fatal = append(fatal, termIssue)
			continue
		}
		if termIssue.Row != 0 {
			issues = append(issues, termIssue)
			continue
		}
		row := map[string]any{
			"rowNumber":        rowNumber,
			"name":             name,
			"creditLimitMinor": creditLimit,
			"paymentTermDays":  paymentTerm,
		}
		if raw, exists := fields["email"]; exists {
			row["email"] = json.RawMessage(raw)
		}
		if raw, exists := fields["phone"]; exists {
			row["phone"] = json.RawMessage(raw)
		}
		if raw, exists := fields["allowDuplicate"]; exists {
			row["allowDuplicate"] = json.RawMessage(raw)
		}
		encoded, err := json.Marshal(row)
		if err != nil {
			fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Message: "Each import row must be an object."})
			continue
		}
		if err := validatePreparedCustomerRow(encoded); err != nil {
			fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Message: err.Error()})
			continue
		}
		prepared = append(prepared, encoded)
	}
	return prepared, fatal, issues
}

func validatePreparedCustomerRow(row json.RawMessage) error {
	wrapped, err := json.Marshal(map[string]any{"rows": []json.RawMessage{row}})
	if err != nil {
		return err
	}
	_, err = capability.ParseCustomerImportInput(wrapped)
	return err
}

func customerImportCreditLimit(fields map[string]json.RawMessage, rowNumber int64) (any, crmImportRowIssue, bool) {
	raw, exists := fields["creditLimitMinor"]
	if exists {
		return json.RawMessage(raw), crmImportRowIssue{}, false
	}
	raw, exists = fields["creditLimit"]
	if !exists {
		return nil, crmImportRowIssue{}, false
	}
	value, present, valid := crmImportScalarOrNumber(raw)
	if !valid {
		return nil, crmImportRowIssue{Row: rowNumber, Field: "creditLimitMinor", Message: "creditLimitMinor must be a non-negative integer or null"}, true
	}
	if !present {
		return nil, crmImportRowIssue{Row: rowNumber, Field: "creditLimit", Message: "creditLimit must be a string or number"}, true
	}
	amount, ok := crmImportMinorAmount(json.RawMessage(strconv.Quote(value)))
	if !ok {
		return nil, crmImportRowIssue{Row: rowNumber, Field: "creditLimit", Message: fmt.Sprintf("%q is not a valid non-negative amount with at most two decimals.", value)}, false
	}
	return amount, crmImportRowIssue{}, false
}

func customerImportPaymentTerms(fields map[string]json.RawMessage, rowNumber int64) (any, crmImportRowIssue, bool) {
	raw, exists := fields["paymentTermDays"]
	if !exists {
		return nil, crmImportRowIssue{}, false
	}
	if crmImportJSONNull(raw) {
		return nil, crmImportRowIssue{Row: rowNumber, Field: "paymentTermDays", Message: "paymentTermDays must be a non-negative number of days"}, true
	}
	value, present, valid := crmImportScalarOrNumber(raw)
	if !valid || !present {
		return nil, crmImportRowIssue{Row: rowNumber, Field: "paymentTermDays", Message: "paymentTermDays must be a non-negative number of days"}, true
	}
	cleaned := strings.NewReplacer(",", "", " ", "").Replace(value)
	number, err := strconv.ParseFloat(cleaned, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return nil, crmImportRowIssue{Row: rowNumber, Field: "paymentTermDays", Message: "Payment terms must be a non-negative number of days."}, false
	}
	return int64(math.Trunc(number)), crmImportRowIssue{}, false
}

func prepareProductImportRows(entries []json.RawMessage) ([]json.RawMessage, []crmImportRowIssue, []crmImportRowIssue) {
	prepared := make([]json.RawMessage, 0, len(entries))
	fatal := []crmImportRowIssue{}
	issues := []crmImportRowIssue{}
	for index, entry := range entries {
		fields, ok := crmImportObject(entry)
		if !ok {
			fatal = append(fatal, crmImportRowIssue{Row: int64(index + 2), Message: "Each import row must be an object."})
			continue
		}
		rowNumber, rowIssue := crmImportRowNumber(fields, index)
		if rowIssue != nil {
			fatal = append(fatal, *rowIssue)
			continue
		}
		nameRaw, exists := fields["name"]
		if !exists || crmImportJSONNull(nameRaw) {
			fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "name", Message: "name is required"})
			continue
		}
		name, nameOK := crmImportString(nameRaw)
		if !nameOK {
			fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "name", Message: "name is required"})
			continue
		}
		kind := "goods"
		if raw, exists := fields["kind"]; exists {
			value, ok := crmImportStringToken(raw)
			if !ok || (value != "goods" && value != "service") {
				fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "kind", Message: "kind must be goods or service"})
				continue
			}
			kind = value
		}
		requested := kind
		if raw, exists := fields["type"]; exists {
			value, ok := crmImportStringToken(raw)
			if !ok {
				fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "type", Message: "type must be a string"})
				continue
			}
			requested = strings.ToLower(value)
		}
		if requested != "goods" && requested != "product" && requested != "service" && requested != "services" {
			issues = append(issues, crmImportRowIssue{Row: rowNumber, Field: "type", Message: fmt.Sprintf("Use product or service, not %q.", requested)})
			continue
		}
		productKind := "goods"
		if requested == "service" || requested == "services" {
			productKind = "service"
		}
		sku := ""
		if raw, exists := fields["sku"]; exists {
			value, ok := crmImportString(raw)
			if !ok {
				fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "sku", Message: "sku must be a string"})
				continue
			}
			sku = value
		}
		if sku == "" && productKind == "service" {
			suffix, err := crmImportServiceSKUSuffix()
			if err != nil {
				fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "sku", Message: "sku could not be generated"})
				continue
			}
			sku = "SVC-IMPORT-" + suffix
		}
		if sku == "" {
			issues = append(issues, crmImportRowIssue{Row: rowNumber, Field: "sku", Message: "Products need a SKU."})
			continue
		}
		price, priceIssue, priceSkip := productImportPrice(fields, rowNumber)
		if priceSkip {
			fatal = append(fatal, priceIssue)
			continue
		}
		if priceIssue.Row != 0 {
			issues = append(issues, priceIssue)
			continue
		}
		unitLabel := "unit"
		if productKind == "service" {
			unitLabel = "hour"
		}
		if raw, exists := fields["unitLabel"]; exists {
			value, ok := crmImportString(raw)
			if !ok {
				fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "unitLabel", Message: "unitLabel must be a string"})
				continue
			}
			unitLabel = value
		} else if raw, exists := fields["unit"]; exists {
			value, ok := crmImportString(raw)
			if !ok {
				fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "unit", Message: "unit must be a string"})
				continue
			}
			unitLabel = value
		}
		reorderPoint := any(int64(0))
		if raw, exists := fields["reorderPointThousandths"]; exists {
			if crmImportJSONNull(raw) {
				fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "reorderPointThousandths", Message: "reorderPointThousandths must be a non-negative integer"})
				continue
			}
			reorderPoint = json.RawMessage(raw)
		}
		row := map[string]any{
			"rowNumber":               rowNumber,
			"name":                    name,
			"sku":                     sku,
			"kind":                    productKind,
			"unitLabel":               unitLabel,
			"salePriceMinor":          price,
			"reorderPointThousandths": reorderPoint,
			"tags":                    []string{},
		}
		if raw, exists := fields["barcode"]; exists {
			if crmImportJSONNull(raw) {
				row["barcode"] = nil
			} else {
				if _, ok := crmImportStringToken(raw); !ok {
					fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "barcode", Message: "barcode must be a string or null"})
					continue
				}
				row["barcode"] = json.RawMessage(raw)
			}
		} else {
			row["barcode"] = nil
		}
		if raw, exists := fields["tags"]; exists {
			if crmImportJSONNull(raw) {
				fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Field: "tags", Message: "tags must be an array"})
				continue
			}
			row["tags"] = json.RawMessage(raw)
		}
		encoded, err := json.Marshal(row)
		if err != nil {
			fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Message: "Each import row must be an object."})
			continue
		}
		if err := validatePreparedProductRow(encoded); err != nil {
			fatal = append(fatal, crmImportRowIssue{Row: rowNumber, Message: err.Error()})
			continue
		}
		prepared = append(prepared, encoded)
	}
	return prepared, fatal, issues
}

func validatePreparedProductRow(row json.RawMessage) error {
	wrapped, err := json.Marshal(map[string]any{"rows": []json.RawMessage{row}})
	if err != nil {
		return err
	}
	_, err = capability.ParseInventoryImportItemsInput(wrapped)
	return err
}

func productImportPrice(fields map[string]json.RawMessage, rowNumber int64) (any, crmImportRowIssue, bool) {
	if raw, exists := fields["salePriceMinor"]; exists {
		if crmImportJSONNull(raw) {
			return nil, crmImportRowIssue{Row: rowNumber, Field: "salePriceMinor", Message: "salePriceMinor must be a non-negative integer"}, true
		}
		return json.RawMessage(raw), crmImportRowIssue{}, false
	}
	raw, exists := fields["salePrice"]
	if !exists {
		raw, exists = fields["price"]
	}
	if !exists {
		return int64(0), crmImportRowIssue{}, false
	}
	if crmImportJSONNull(raw) {
		return nil, crmImportRowIssue{Row: rowNumber, Field: "salePrice", Message: "salePrice must be a string or number"}, true
	}
	if value, ok := crmImportStringToken(raw); ok {
		amount, converted := crmImportMinorAmount(json.RawMessage(strconv.Quote(value)))
		if !converted {
			return nil, crmImportRowIssue{Row: rowNumber, Field: "salePrice", Message: "Enter a non-negative amount with at most two decimals."}, false
		}
		return amount, crmImportRowIssue{}, false
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err == nil {
		parsed, err := number.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 || parsed > math.MaxInt64 || math.Trunc(parsed) != parsed {
			return nil, crmImportRowIssue{Row: rowNumber, Field: "salePrice", Message: "Enter a non-negative amount with at most two decimals."}, false
		}
		return int64(parsed), crmImportRowIssue{}, false
	}
	return nil, crmImportRowIssue{Row: rowNumber, Field: "salePrice", Message: "salePrice must be a string or number"}, true
}

func crmImportServiceSKUSuffix() (string, error) {
	var raw [4]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return strings.ToUpper(hex.EncodeToString(raw[:])), nil
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// MountGoCRMImportRoute owns the legacy CSV import collection.
func MountGoCRMImportRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/import", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
