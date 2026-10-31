package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const purchasingRouteBodyLimit = 64 << 10

// purchasingRouteAction maps a legacy purchasing body action to its governed
// capability, the body fields it accepts, and whether it is a state change
// that must carry a durable action intent.
type purchasingRouteAction struct {
	capabilityID string
	fields       []string
	optional     []string
	write        bool
}

var purchasingCollectionActions = map[string]purchasingRouteAction{
	"receiptDetail":      {capabilityID: "purchasing.listReceipts", fields: []string{"poNumber"}},
	"priceHistory":       {capabilityID: "purchasing.priceHistory", fields: []string{"sku"}, optional: []string{"sku"}},
	"supplierStatement":  {capabilityID: "purchasing.supplierStatement", fields: []string{"vendorId"}},
	"closePurchaseOrder": {capabilityID: "purchasing.closePurchaseOrder", fields: []string{"poNumber"}, write: true},
	"billCreditNote":     {capabilityID: "purchasing.billCreditNote", fields: []string{"billId", "amountMinor", "reason"}, write: true},
	"reverseVendorPayment": {
		capabilityID: "purchasing.reverseVendorPayment",
		fields:       []string{"vendorPaymentId", "reason"},
		write:        true,
	},
	"createVendor": {capabilityID: "purchasing.createVendor", fields: []string{"name", "email"}, optional: []string{"email"}, write: true},
	"createBill": {
		capabilityID: "purchasing.createBill",
		fields:       []string{"vendorId", "vendorRef", "memo", "poNumber", "lines"},
		optional:     []string{"vendorRef", "memo", "poNumber"},
		write:        true,
	},
	"payBill": {
		capabilityID: "purchasing.payBill",
		fields:       []string{"billNumber", "amountMinor", "method"},
		optional:     []string{"method"},
		write:        true,
	},
	"createPurchaseRequest": {
		capabilityID: "purchasing.createPurchaseRequest",
		fields:       []string{"title", "justification", "estimatedAmountMinor"},
		optional:     []string{"estimatedAmountMinor"},
		write:        true,
	},
	"decidePurchaseRequest": {
		capabilityID: "purchasing.decidePurchaseRequest",
		fields:       []string{"requestId", "decision", "reason"},
		optional:     []string{"reason"},
		write:        true,
	},
	"createRfq":          {capabilityID: "purchasing.createRfq", fields: []string{"requestId", "vendorIds"}, write: true},
	"recordQuote":        {capabilityID: "purchasing.recordQuote", fields: []string{"rfqId", "amountMinor", "leadTimeDays", "notes"}, optional: []string{"leadTimeDays", "notes"}, write: true},
	"selectWinningQuote": {capabilityID: "purchasing.selectWinningQuote", fields: []string{"rfqId"}, write: true},
	"createPurchaseOrder": {
		capabilityID: "purchasing.createPurchaseOrder",
		fields:       []string{"vendorId", "lines", "memo"},
		optional:     []string{"memo"},
		write:        true,
	},
	"receiveGoods": {
		capabilityID: "purchasing.receiveGoods",
		fields:       []string{"poNumber", "lines", "overreceiptTolerancePct", "authorityReason", "note"},
		optional:     []string{"overreceiptTolerancePct", "authorityReason", "note"},
		write:        true,
	},
	"returnGoods": {
		capabilityID: "purchasing.returnGoods",
		fields:       []string{"poNumber", "receiptNumber", "lines"},
		optional:     []string{"receiptNumber"},
		write:        true,
	},
}

type PurchasingCollectionSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

// NewPurchasingCollectionSessionHandler exposes the purchasing workspace read
// and every purchasing body action through the governed capability executor.
// Identity, permissions and approvals are resolved on every request.
func NewPurchasingCollectionSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &PurchasingCollectionSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *PurchasingCollectionSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "purchasing service unavailable"})
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
	if r.Method == http.MethodPost && strings.TrimSpace(r.Header.Get("Authorization")) == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if r.Method == http.MethodGet {
		h.read(w, r, resolved)
		return
	}
	h.write(w, r, resolved)
}

func (h *PurchasingCollectionSessionHandler) read(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	result, err := purchasingRouteExecute(r.Context(), h.executor, resolved, "purchasing.listWorkspace", json.RawMessage(`{}`), "")
	if purchasingRouteWriteError(w, h.logger, "purchasing.listWorkspace", result, err) {
		return
	}
	var output capability.PurchasingListWorkspaceOutput
	if !json.Valid(result.Data) || json.Unmarshal(result.Data, &output) != nil ||
		output.Vendors == nil || output.Orders == nil || output.Bills == nil || output.Requests == nil {
		purchasingRouteLogInvalidOutput(h.logger, "purchasing.listWorkspace")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, output)
}

func (h *PurchasingCollectionSessionHandler) write(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	fields, ok := purchasingRouteDecodeBody(w, r)
	if !ok {
		return
	}
	action, actionOK := purchasingJSONString(fields["action"])
	if !actionOK {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	definition, found := purchasingCollectionActions[action]
	if !found {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID, intentOK := purchasingRouteIntentID(fields, definition.write)
	if !intentOK {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if !purchasingRouteFieldsAllowed(fields, definition) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	input, err := purchasingRouteBuildInput(fields, definition)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if _, err := purchasingRouteParse(definition.capabilityID, input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	result, err := purchasingRouteExecute(r.Context(), h.executor, resolved, definition.capabilityID, input, intentID)
	if purchasingRouteWriteError(w, h.logger, definition.capabilityID, result, err) {
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": json.RawMessage(result.Data)})
}

func purchasingRouteParse(capabilityID string, input json.RawMessage) (any, error) {
	switch capabilityID {
	case "purchasing.listReceipts":
		return capability.ParseListReceiptsInput(input)
	case "purchasing.closePurchaseOrder":
		return capability.ParseClosePurchaseOrderInput(input)
	case "purchasing.billCreditNote":
		return capability.ParseBillCreditNoteInput(input)
	case "purchasing.reverseVendorPayment":
		return capability.ParseReverseVendorPaymentInput(input)
	case "purchasing.createVendor":
		return capability.ParseCreateVendorInput(input)
	case "purchasing.createBill":
		return capability.ParseCreateBillInput(input)
	case "purchasing.payBill":
		return capability.ParsePayBillInput(input)
	case "purchasing.createPurchaseRequest":
		return capability.ParseCreatePurchaseRequestInput(input)
	case "purchasing.decidePurchaseRequest":
		return capability.ParseDecidePurchaseRequestInput(input)
	case "purchasing.createRfq":
		return capability.ParseCreateRfqInput(input)
	case "purchasing.recordQuote":
		return capability.ParseRecordQuoteInput(input)
	case "purchasing.selectWinningQuote":
		return capability.ParseSelectWinningQuoteInput(input)
	case "purchasing.createPurchaseOrder":
		return capability.ParseCreatePurchaseOrderInput(input)
	case "purchasing.receiveGoods":
		return capability.ParseReceiveGoodsInput(input)
	case "purchasing.returnGoods":
		return capability.ParseReturnGoodsInput(input)
	case "purchasing.priceHistory":
		return capability.ParsePurchasingPriceHistoryInput(input)
	case "purchasing.supplierStatement":
		return capability.ParsePurchasingSupplierStatementInput(input)
	case "purchasing.createPaymentRun":
		return capability.ParseCreatePaymentRunInput(input)
	case "purchasing.cancelPaymentRunDraft":
		return capability.ParseCancelPaymentRunDraftInput(input)
	case "purchasing.restorePaymentRunDraft":
		return capability.ParseRestorePaymentRunDraftInput(input)
	case "purchasing.instructPaymentRun":
		return capability.ParseInstructPaymentRunInput(input)
	case "purchasing.reversePaymentRun":
		return capability.ParseReversePaymentRunInput(input)
	default:
		return nil, errors.New("unsupported purchasing action")
	}
}

func purchasingRouteDecodeBody(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, purchasingRouteBodyLimit))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	var fields map[string]json.RawMessage
	if decoder.Decode(&fields) != nil || fields == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return nil, false
	}
	return fields, true
}

// purchasingRouteIntentID mirrors the legacy action-intent contract: state
// changes carry a durable intent, reads may omit one.
func purchasingRouteIntentID(fields map[string]json.RawMessage, required bool) (string, bool) {
	raw, present := fields["intentId"]
	if !present || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", !required
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", !required
	}
	if len(value) > 160 || strings.ContainsAny(value, "\r\n\x00") {
		return "", false
	}
	return value, true
}

func purchasingRouteFieldsAllowed(fields map[string]json.RawMessage, definition purchasingRouteAction) bool {
	allowed := make(map[string]struct{}, len(definition.fields)+2)
	allowed["action"] = struct{}{}
	allowed["intentId"] = struct{}{}
	for _, key := range definition.fields {
		allowed[key] = struct{}{}
	}
	for key := range fields {
		if _, ok := allowed[key]; !ok {
			return false
		}
	}
	return true
}

// purchasingRouteBuildInput copies the action fields into the capability input,
// dropping optional values that the legacy body guard treated as absent.
func purchasingRouteBuildInput(fields map[string]json.RawMessage, definition purchasingRouteAction) (json.RawMessage, error) {
	optional := make(map[string]struct{}, len(definition.optional))
	for _, key := range definition.optional {
		optional[key] = struct{}{}
	}
	input := make(map[string]json.RawMessage, len(definition.fields))
	for _, key := range definition.fields {
		raw, present := fields[key]
		if !present {
			continue
		}
		if _, drop := optional[key]; drop && purchasingRouteOmitOptionalValue(raw) {
			continue
		}
		input[key] = raw
	}
	return json.Marshal(input)
}

func purchasingRouteOmitOptionalValue(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte(`""`)) {
		return true
	}
	var number float64
	if json.Unmarshal(trimmed, &number) == nil && number == 0 {
		return true
	}
	return false
}

func purchasingJSONString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func purchasingRouteExecute(ctx context.Context, executor CapabilityExecutor, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (capability.Result, error) {
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
	return executor.Execute(ctx, claims, capabilityID, input)
}

func purchasingRouteWriteError(w http.ResponseWriter, logger *slog.Logger, capabilityID string, result capability.Result, err error) bool {
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		case errors.Is(err, capability.ErrNotMember):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		default:
			if status, ok := capabilityErrorStatus(err); ok {
				writeJSON(w, status, map[string]any{"ok": false, "error": err.Error()})
				return true
			}
			if logger != nil {
				logger.Error("Go purchasing capability failed", "capabilityId", capabilityID, "error", err)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return true
	}
	if result.PendingApproval || result.OK {
		return false
	}
	message := result.Error
	if message == "" {
		message = "capability execution failed"
	}
	switch {
	case strings.HasPrefix(message, "forbidden:"):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": message})
	case strings.Contains(message, `module "purchasing" is disabled`):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	default:
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": message})
	}
	return true
}

func purchasingRouteLogInvalidOutput(logger *slog.Logger, capabilityID string) {
	if logger != nil {
		logger.Error("Go purchasing capability returned invalid data", "capabilityId", capabilityID)
	}
}

// MountGoPurchasingCollectionRoute owns GET/POST /api/purchasing. The base
// handler keeps every other method and path, so the legacy proxy still serves
// what has not migrated.
func MountGoPurchasingCollectionRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/purchasing", route)
	mux.Handle("POST /api/purchasing", route)
	if base != nil {
		mux.Handle("HEAD /api/purchasing", base)
		mux.Handle("/", base)
	}
	return mux
}
