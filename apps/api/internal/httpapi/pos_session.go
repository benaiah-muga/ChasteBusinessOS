package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const posSessionBodyLimit = 64 << 10

const posMaxSafeInteger int64 = 9_007_199_254_740_991

type PosSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewPosSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &PosSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (handler *PosSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if handler == nil || handler.resolver == nil || handler.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "POS service unavailable"})
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
	if r.Header.Get("Authorization") == "" && !sameOriginCapabilityRequest(r, handler.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	handler.post(w, r, resolved)
}

func (handler *PosSessionHandler) post(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, posSessionBodyLimit)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
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
	if raw := fields["action"]; len(raw) == 0 || json.Unmarshal(raw, &action) != nil || action == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	capabilityID, input, intentID, err := posRequest(action, fields)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	claims, err := posSessionClaims(resolved, capabilityID, input, intentID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	result, err := handler.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if handler.logger != nil {
				handler.logger.Error("Go POS capability execution failed", "capabilityId", capabilityID, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason})
		return
	}
	if !result.OK {
		status := http.StatusUnprocessableEntity
		if strings.HasPrefix(result.Error, "forbidden: missing permission:") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]any{"ok": false, "error": result.Error})
		return
	}
	if !validPosOutput(action, result.Data) {
		if handler.logger != nil {
			handler.logger.Error("Go POS capability returned invalid data", "capabilityId", capabilityID)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
}

func posRequest(action string, fields map[string]json.RawMessage) (string, json.RawMessage, string, error) {
	var capabilityID string
	var allowed []string
	var stateChange bool
	switch action {
	case "open":
		capabilityID, allowed, stateChange = "pos.openSession", []string{"action", "intentId", "openingFloatMinor"}, true
	case "sale":
		capabilityID, allowed, stateChange = "pos.completeSale", []string{"action", "intentId", "sessionId", "method", "customerId", "cashReceivedMinor", "tenders", "lines"}, true
	case "close":
		capabilityID, allowed, stateChange = "pos.closeSession", []string{"action", "intentId", "sessionId", "countedCashMinor", "varianceReason"}, true
	case "returnSale":
		capabilityID, allowed, stateChange = "pos.returnSale", []string{"action", "intentId", "invoiceId", "reason", "refundMethod", "lines"}, true
	case "shiftSummary":
		capabilityID, allowed = "pos.shiftSummary", []string{"action", "intentId", "sessionId"}
	default:
		return "", nil, "", errors.New("unsupported POS action")
	}
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = struct{}{}
	}
	for key := range fields {
		if _, ok := allowedSet[key]; !ok {
			return "", nil, "", errors.New("unexpected POS request field")
		}
	}
	intentID := ""
	if raw, exists := fields["intentId"]; exists {
		if json.Unmarshal(raw, &intentID) != nil || strings.TrimSpace(intentID) == "" || len(utf16.Encode([]rune(intentID))) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
			return "", nil, "", errors.New("invalid POS intent")
		}
	} else if stateChange {
		return "", nil, "", errors.New("POS writes require an intentId")
	}
	inputFields := make(map[string]json.RawMessage)
	switch action {
	case "open":
		inputFields["register"] = json.RawMessage(`"main"`)
		inputFields["openingFloatMinor"] = json.RawMessage(`0`)
		if raw, exists := fields["openingFloatMinor"]; exists {
			inputFields["openingFloatMinor"] = raw
		}
	case "sale":
		for _, key := range []string{"sessionId", "customerId", "cashReceivedMinor", "tenders"} {
			if raw, exists := fields[key]; exists {
				inputFields[key] = raw
			}
		}
		inputFields["method"] = json.RawMessage(`"cash"`)
		if raw, exists := fields["method"]; exists {
			inputFields["method"] = raw
		}
		var lines []json.RawMessage
		if raw, exists := fields["lines"]; !exists || json.Unmarshal(raw, &lines) != nil || len(lines) == 0 || len(lines) > 100 {
			return "", nil, "", errors.New("sale lines are required")
		}
		mappedLines := make([]map[string]json.RawMessage, 0, len(lines))
		for _, rawLine := range lines {
			var line map[string]json.RawMessage
			if json.Unmarshal(rawLine, &line) != nil || line == nil {
				return "", nil, "", errors.New("invalid sale line")
			}
			for key := range line {
				if key != "description" && key != "quantity" && key != "unitPriceMinor" && key != "sku" {
					return "", nil, "", errors.New("unexpected sale line field")
				}
			}
			if rawSKU, exists := line["sku"]; exists {
				var sku string
				if json.Unmarshal(rawSKU, &sku) != nil || sku == "" || len(utf16.Encode([]rune(sku))) > 80 {
					return "", nil, "", errors.New("invalid sale line SKU")
				}
			}
			line["taxMinor"] = json.RawMessage(`0`)
			mappedLines = append(mappedLines, line)
		}
		linesJSON, err := json.Marshal(mappedLines)
		if err != nil {
			return "", nil, "", err
		}
		inputFields["lines"] = linesJSON
		if raw, exists := fields["tenders"]; exists {
			var tenders []json.RawMessage
			if json.Unmarshal(raw, &tenders) != nil || tenders == nil {
				return "", nil, "", errors.New("invalid sale tenders")
			}
			for _, rawTender := range tenders {
				var tender map[string]json.RawMessage
				if json.Unmarshal(rawTender, &tender) != nil || tender == nil {
					return "", nil, "", errors.New("invalid sale tender")
				}
				for key := range tender {
					if key != "method" && key != "amountMinor" {
						return "", nil, "", errors.New("unexpected sale tender field")
					}
				}
			}
		}
	case "close":
		for _, key := range []string{"sessionId", "countedCashMinor", "varianceReason"} {
			if raw, exists := fields[key]; exists {
				inputFields[key] = raw
			}
		}
	case "returnSale":
		for _, key := range []string{"invoiceId", "reason", "refundMethod", "lines"} {
			if raw, exists := fields[key]; exists {
				inputFields[key] = raw
			}
		}
		if _, exists := fields["refundMethod"]; !exists {
			return "", nil, "", errors.New("refundMethod is required")
		}
		if raw, exists := fields["lines"]; exists {
			var lines []json.RawMessage
			if json.Unmarshal(raw, &lines) != nil || len(lines) == 0 || len(lines) > 100 {
				return "", nil, "", errors.New("invalid return lines")
			}
			for _, rawLine := range lines {
				var line map[string]json.RawMessage
				if json.Unmarshal(rawLine, &line) != nil || line == nil {
					return "", nil, "", errors.New("invalid return line")
				}
				for key := range line {
					if key != "invoiceLineId" && key != "quantity" {
						return "", nil, "", errors.New("unexpected return line field")
					}
				}
			}
		}
	case "shiftSummary":
		if raw, exists := fields["sessionId"]; exists {
			inputFields["sessionId"] = raw
		}
	}
	input, err := json.Marshal(inputFields)
	if err != nil {
		return "", nil, "", errors.New("invalid POS input")
	}
	if err := validatePosInput(capabilityID, input); err != nil {
		return "", nil, "", errors.New("invalid POS input")
	}
	if action == "sale" {
		var sessionID string
		if json.Unmarshal(inputFields["sessionId"], &sessionID) != nil || !isUUID(sessionID) {
			return "", nil, "", errors.New("invalid POS session")
		}
	}
	if action == "close" {
		var sessionID string
		if json.Unmarshal(inputFields["sessionId"], &sessionID) != nil || !isUUID(sessionID) {
			return "", nil, "", errors.New("invalid POS session")
		}
	}
	return capabilityID, input, intentID, nil
}

func validatePosInput(capabilityID string, input json.RawMessage) error {
	switch capabilityID {
	case "pos.openSession":
		_, err := capability.ParsePosOpenSessionInput(input)
		return err
	case "pos.completeSale":
		_, err := capability.ParsePosCompleteSaleInput(input)
		return err
	case "pos.closeSession":
		_, err := capability.ParsePosCloseSessionInput(input)
		return err
	case "pos.returnSale":
		_, err := capability.ParsePosReturnSaleInput(input)
		return err
	case "pos.shiftSummary":
		_, err := capability.ParsePosShiftSummaryInput(input)
		return err
	default:
		return errors.New("unsupported POS capability")
	}
}

func posSessionClaims(resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (authbridge.CapabilityClaims, error) {
	inputHash, err := capability.InputHash(input)
	if err != nil {
		return authbridge.CapabilityClaims{}, err
	}
	permissions := make([]string, 0, len(resolved.Permissions))
	for permission, granted := range resolved.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	sort.Strings(permissions)
	actorID := resolved.UserID
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID,
		OrganizationID: *resolved.OrgID, CapabilityID: capabilityID, InputSHA256: inputHash,
		ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}, nil
}

func validPosOutput(action string, raw json.RawMessage) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return false
	}
	required := map[string][]string{
		"open":         {"sessionId"},
		"sale":         {"invoiceId", "invoiceNumber", "totalMinor", "tenderedMinor", "changeGivenMinor", "tenders"},
		"close":        {"expectedCashMinor", "varianceMinor", "flagged"},
		"returnSale":   {"refundEntryId", "refundMinor", "creditedMinor", "restockedLines", "refundMethod"},
		"shiftSummary": {"register", "status", "salesCount", "takingsMinor", "tenderTotals", "refundTotals", "expectedCashMinor", "countedCashMinor", "varianceMinor"},
	}
	for _, key := range required[action] {
		if _, exists := fields[key]; !exists {
			return false
		}
	}
	switch action {
	case "open":
		var output capability.PosOpenSessionOutput
		return decodeStrictPOSOutput(raw, &output) == nil && isUUID(output.SessionID)
	case "sale":
		var output capability.PosCompleteSaleOutput
		if decodeStrictPOSOutput(raw, &output) != nil || !isUUID(output.InvoiceID) || output.InvoiceNumber < 1 ||
			output.TotalMinor < 0 || output.TotalMinor > posMaxSafeInteger || output.TenderedMinor < 0 || output.TenderedMinor > posMaxSafeInteger ||
			output.ChangeGivenMinor < 0 || output.ChangeGivenMinor > posMaxSafeInteger || output.Tenders == nil {
			return false
		}
		for _, tender := range output.Tenders {
			if tender.Method != "cash" && tender.Method != "card" && tender.Method != "mobile_money" || tender.AmountMinor < 0 || tender.AmountMinor > posMaxSafeInteger {
				return false
			}
		}
		return true
	case "close":
		var output capability.PosCloseSessionOutput
		return decodeStrictPOSOutput(raw, &output) == nil && output.ExpectedCashMinor >= 0 && output.ExpectedCashMinor <= posMaxSafeInteger &&
			output.VarianceMinor >= -posMaxSafeInteger && output.VarianceMinor <= posMaxSafeInteger
	case "returnSale":
		var output capability.PosReturnSaleOutput
		if decodeStrictPOSOutput(raw, &output) != nil || !isUUID(output.RefundEntryID) || output.RefundMinor < 0 || output.RefundMinor > posMaxSafeInteger ||
			output.CreditedMinor < 0 || output.CreditedMinor > posMaxSafeInteger || output.RestockedLines < 0 {
			return false
		}
		return output.RefundMethod == "cash" || output.RefundMethod == "card" || output.RefundMethod == "mobile_money"
	case "shiftSummary":
		var output capability.PosShiftSummaryOutput
		if decodeStrictPOSOutput(raw, &output) != nil || output.Register == "" || output.Status == "" || output.SalesCount < 0 ||
			output.TakingsMinor < 0 || output.TakingsMinor > posMaxSafeInteger || output.TenderTotals == nil || output.RefundTotals == nil ||
			output.ExpectedCashMinor < 0 || output.ExpectedCashMinor > posMaxSafeInteger {
			return false
		}
		return true
	default:
		return false
	}
}

func decodeStrictPOSOutput(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("trailing POS output")
	}
	return nil
}

var _ DirectCapabilitySessionResolver = (*session.Resolver)(nil)
