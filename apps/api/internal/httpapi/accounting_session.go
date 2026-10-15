package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const accountingSessionBodyLimit = 64 << 10

type accountingSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type AccountingSessionHandler struct {
	resolver          accountingSessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewAccountingSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &AccountingSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func newAccountingSessionHandler(resolver accountingSessionResolver, executor CapabilityExecutor, logger *slog.Logger, trusted []*net.IPNet) http.Handler {
	return &AccountingSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (handler *AccountingSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
	if resolved.ModulesRestricted && !accountingModuleEnabled(resolved.EnabledModules) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Accounting module is disabled"})
		return
	}
	if r.Method == http.MethodGet {
		handler.get(w, r, resolved)
		return
	}
	if r.Header.Get("Authorization") == "" && !sameOriginCapabilityRequest(r, handler.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	handler.post(w, r, resolved)
}

func accountingModuleEnabled(modules []string) bool {
	for _, module := range modules {
		if module == "accounting" {
			return true
		}
	}
	return false
}

func (handler *AccountingSessionHandler) get(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	if !resolved.HasPermission("accounting.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing accounting.read"})
		return
	}
	input := json.RawMessage(`{}`)
	intentID, err := accountingSessionReadIntentID()
	if err != nil {
		handler.logError("accounting read intent generation failed", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	data, status, done := handler.execute(w, r, resolved, "accounting.overview", input, intentID)
	if done {
		return
	}
	var overview capability.AccountingOverviewOutput
	if err := decodeStrictAccountingJSON(*data, &overview); err != nil {
		handler.logError("accounting overview capability returned invalid data", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if status == http.StatusOK {
		writeJSON(w, http.StatusOK, overview)
	}
}

func accountingSessionReadIntentID() (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	return "accounting-read-" + hex.EncodeToString(random[:]), nil
}

type accountingSessionAction struct {
	capabilityID string
	permission   string
	fields       []string
	inputAlias   map[string]string
}

func accountingSessionActionFor(action string) (accountingSessionAction, bool) {
	switch action {
	case "closeYear":
		return accountingSessionAction{"accounting.closeYear", "accounting.admin", []string{"year"}, nil}, true
	case "reopenPeriod":
		return accountingSessionAction{"accounting.reopenPeriod", "accounting.admin", []string{"year", "month"}, nil}, true
	case "recordFxRate":
		return accountingSessionAction{"accounting.recordFxRate", "accounting.post", []string{"quoteCurrency", "rate", "effectiveAt"}, nil}, true
	case "revalueForeignReceivables":
		return accountingSessionAction{"accounting.revalueForeignReceivables", "accounting.post", []string{"year", "month"}, nil}, true
	case "reverse":
		return accountingSessionAction{"accounting.reverseEntry", "accounting.post", []string{"entryId"}, nil}, true
	case "creditNote":
		return accountingSessionAction{"accounting.creditNote", "accounting.post", []string{"invoiceId", "amountMinor", "reason"}, nil}, true
	case "createInvoice":
		return accountingSessionAction{"accounting.createInvoice", "accounting.write", []string{"customerId", "memo", "lines", "currency", "fxRate", "dueAt"}, nil}, true
	case "recordPayment":
		return accountingSessionAction{"accounting.recordPayment", "accounting.post", []string{"invoiceNumber", "amountMinor", "method", "settleFxRate", "fxRate"}, map[string]string{"fxRate": "settleFxRate"}}, true
	case "reversePayment":
		return accountingSessionAction{"accounting.reversePayment", "accounting.post", []string{"paymentId", "reason"}, nil}, true
	default:
		return accountingSessionAction{}, false
	}
}

func (handler *AccountingSessionHandler) post(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, accountingSessionBodyLimit)
	decoder := json.NewDecoder(r.Body)
	var body map[string]json.RawMessage
	if decoder.Decode(&body) != nil || body == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	actionName, ok := accountingSessionString(body["action"])
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	action, supported := accountingSessionActionFor(actionName)
	if !supported {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported accounting action"})
		return
	}
	if !resolved.HasPermission(action.permission) && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing " + action.permission})
		return
	}
	intentID, ok := accountingSessionString(body["intentId"])
	if !ok || strings.TrimSpace(intentID) == "" || len(utf16.Encode([]rune(intentID))) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "intentId is required"})
		return
	}
	allowedFields := make(map[string]struct{}, len(action.fields)+2)
	allowedFields["action"] = struct{}{}
	allowedFields["intentId"] = struct{}{}
	for _, field := range action.fields {
		allowedFields[field] = struct{}{}
	}
	for field := range body {
		if _, allowed := allowedFields[field]; !allowed {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
	}
	inputFields := make(map[string]json.RawMessage, len(action.fields))
	for _, field := range action.fields {
		if raw, exists := body[field]; exists {
			target := field
			if mapped, ok := action.inputAlias[field]; ok {
				target = mapped
			}
			if _, alreadySet := inputFields[target]; alreadySet {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
				return
			}
			inputFields[target] = raw
		}
	}
	input, err := json.Marshal(inputFields)
	if err != nil || !accountingSessionInputValid(action.capabilityID, input) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	data, _, done := handler.execute(w, r, resolved, action.capabilityID, input, intentID)
	if done {
		return
	}
	if err := validateAccountingSessionOutput(action.capabilityID, *data); err != nil {
		handler.logError("accounting capability returned invalid data", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: *data})
}

func accountingSessionInputValid(capabilityID string, raw json.RawMessage) bool {
	switch capabilityID {
	case "accounting.closeYear":
		_, err := capability.ParseCloseYearInput(raw)
		return err == nil
	case "accounting.reopenPeriod":
		_, err := capability.ParseReopenPeriodInput(raw)
		return err == nil
	case "accounting.recordFxRate":
		_, err := capability.ParseRecordFxRateInput(raw)
		return err == nil
	case "accounting.revalueForeignReceivables":
		_, err := capability.ParseRevalueForeignReceivablesInput(raw)
		return err == nil
	case "accounting.reverseEntry":
		parsed, err := capability.ParseReverseEntryInput(raw)
		return err == nil && isUUID(parsed.EntryID)
	case "accounting.creditNote":
		_, err := capability.ParseCreditNoteInput(raw)
		return err == nil
	case "accounting.createInvoice":
		_, err := capability.ParseCreateInvoiceInput(raw)
		return err == nil
	case "accounting.recordPayment":
		_, err := capability.ParseRecordPaymentInput(raw)
		return err == nil
	case "accounting.reversePayment":
		_, err := capability.ParseReversePaymentInput(raw)
		return err == nil
	default:
		return false
	}
}

func validateAccountingSessionOutput(capabilityID string, raw json.RawMessage) error {
	var output any
	switch capabilityID {
	case "accounting.closeYear":
		output = &capability.CloseYearOutput{}
	case "accounting.reopenPeriod":
		output = &capability.ReopenPeriodOutput{}
	case "accounting.recordFxRate":
		output = &capability.RecordFxRateOutput{}
	case "accounting.revalueForeignReceivables":
		output = &capability.RevalueForeignReceivablesOutput{}
	case "accounting.reverseEntry":
		output = &capability.ReverseEntryOutput{}
	case "accounting.creditNote":
		output = &capability.CreditNoteOutput{}
	case "accounting.createInvoice":
		output = &capability.CreateInvoiceOutput{}
	case "accounting.recordPayment":
		output = &capability.RecordPaymentOutput{}
	case "accounting.reversePayment":
		output = &capability.ReversePaymentOutput{}
	default:
		return errors.New("unsupported accounting output")
	}
	return decodeStrictAccountingJSON(raw, output)
}

func decodeStrictAccountingJSON(raw json.RawMessage, target any) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return errors.New("accounting capability output must be a JSON object")
	}
	targetType := reflect.TypeOf(target)
	if targetType == nil || targetType.Kind() != reflect.Ptr || reflect.ValueOf(target).IsNil() {
		return errors.New("accounting output target must be a non-nil pointer")
	}
	if err := validateAccountingJSONShape(trimmed, targetType.Elem()); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func validateAccountingJSONShape(raw []byte, target reflect.Type) error {
	if target.Kind() == reflect.Ptr {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil
		}
		return validateAccountingJSONShape(raw, target.Elem())
	}
	jsonUnmarshaler := reflect.TypeOf((*json.Unmarshaler)(nil)).Elem()
	if target.Implements(jsonUnmarshaler) || reflect.PointerTo(target).Implements(jsonUnmarshaler) {
		return nil
	}
	switch target.Kind() {
	case reflect.Struct:
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
			return errors.New("accounting output field must be an object")
		}
		known := make(map[string]struct{}, target.NumField())
		for index := 0; index < target.NumField(); index++ {
			field := target.Field(index)
			if field.PkgPath != "" {
				continue
			}
			tag := field.Tag.Get("json")
			parts := strings.Split(tag, ",")
			name := parts[0]
			if name == "-" {
				continue
			}
			if name == "" {
				name = field.Name
			}
			known[name] = struct{}{}
			value, exists := fields[name]
			if !exists {
				if len(parts) < 2 || !strings.Contains(parts[1], "omitempty") {
					return errors.New("accounting output is missing a required field")
				}
				continue
			}
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) && field.Type.Kind() != reflect.Ptr && field.Type.Kind() != reflect.Interface {
				return errors.New("accounting output contains null for a non-nullable field")
			}
			if err := validateAccountingJSONShape(value, field.Type); err != nil {
				return err
			}
		}
		for name := range fields {
			if _, exists := known[name]; !exists {
				return errors.New("accounting output contains an unknown field")
			}
		}
	case reflect.Slice, reflect.Array:
		var values []json.RawMessage
		if err := json.Unmarshal(raw, &values); err != nil || values == nil && target.Kind() == reflect.Slice {
			return errors.New("accounting output field must be an array")
		}
		for _, value := range values {
			if err := validateAccountingJSONShape(value, target.Elem()); err != nil {
				return err
			}
		}
	case reflect.Map:
		var values map[string]json.RawMessage
		if err := json.Unmarshal(raw, &values); err != nil || values == nil {
			return errors.New("accounting output field must be an object")
		}
		for _, value := range values {
			if err := validateAccountingJSONShape(value, target.Elem()); err != nil {
				return err
			}
		}
	default:
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return errors.New("accounting output contains null for a non-nullable field")
		}
	}
	return nil
}

func accountingSessionString(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	err := json.Unmarshal([]byte(trimmed), &value)
	return value, err == nil
}

func (handler *AccountingSessionHandler) execute(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (*json.RawMessage, int, bool) {
	claims := accountingSessionClaims(resolved, capabilityID, input, intentID)
	result, err := handler.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		handler.logError("accounting capability execution failed", err)
		if errors.Is(err, capability.ErrSessionInvalid) || errors.Is(err, capability.ErrScopeMismatch) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		} else if errors.Is(err, capability.ErrNotMember) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return nil, 0, true
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason})
		return nil, http.StatusAccepted, true
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": result.Error})
		return nil, http.StatusUnprocessableEntity, true
	}
	if !json.Valid(result.Data) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return nil, 0, true
	}
	data := json.RawMessage(result.Data)
	return &data, http.StatusOK, false
}

func accountingSessionClaims(resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) authbridge.CapabilityClaims {
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	sort.Strings(permissions)
	actorID := resolved.UserID
	inputHash, _ := capability.InputHash(input)
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID, OrganizationID: *resolved.OrgID,
		InputSHA256: inputHash, ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, CapabilityID: capabilityID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
}

func (handler *AccountingSessionHandler) logError(message string, err error) {
	if handler.logger != nil {
		handler.logger.Error(message, "error", err)
	}
}
