package httpapi

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type QuotesSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewQuotesSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &QuotesSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *QuotesSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "quotes service unavailable"})
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

func (h *QuotesSessionHandler) get(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	input := json.RawMessage(`{}`)
	switch status := r.URL.Query().Get("status"); status {
	case "draft", "sent", "accepted", "declined", "expired":
		encoded, _ := json.Marshal(map[string]string{"status": status})
		input = encoded
	}
	result, ok := financeSalesRun(w, r, h.executor, h.logger, resolved, "accounting.listQuotes", input, "")
	if !ok {
		return
	}
	if !result.OK {
		writeJSON(w, financeSalesRefusalStatus(result), map[string]string{"error": result.Error})
		return
	}
	var output capability.ListQuotesOutput
	if json.Unmarshal(result.Data, &output) != nil || output.Quotes == nil {
		financeSalesInternalError(w, h.logger, "Go quotes list capability returned invalid data")
		return
	}
	writeJSON(w, http.StatusOK, output)
}

func (h *QuotesSessionHandler) post(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
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
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "customerId", "memo", "expiresAt", "lines"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields, "customerId", "memo", "expiresAt", "lines"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if _, err = capability.ParseCreateQuoteInput(input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "accounting.createQuote"
	case "accept":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "quoteId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields, "quoteId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if _, err = capability.ParseAcceptQuoteInput(input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "accounting.acceptQuote"
	case "decline":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "quoteId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields, "quoteId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if _, err = capability.ParseDeclineQuoteInput(input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "accounting.declineQuote"
	case "expire":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "accounting.expireQuote"
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
	if !financeSalesValidQuoteOutput(action, result.Data) {
		financeSalesInternalError(w, h.logger, "Go quotes capability returned invalid data")
		return
	}
	financeSalesWriteOK(w, result.Data)
}

func financeSalesValidQuoteOutput(action string, raw json.RawMessage) bool {
	switch action {
	case "create":
		var output capability.CreateQuoteOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.QuoteID) &&
			output.QuoteNumber >= 1 && financeSalesCount(output.TotalMinor)
	case "accept":
		var output capability.AcceptQuoteOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.InvoiceID) &&
			output.InvoiceNumber >= 1 && financeSalesCount(output.TotalMinor)
	case "decline":
		var output capability.DeclineQuoteOutput
		return financeSalesDecodeOutput(raw, &output) == nil && output.Status != ""
	case "expire":
		var output capability.ExpireQuoteOutput
		return financeSalesDecodeOutput(raw, &output) == nil && output.ExpiredCount >= 0
	default:
		return false
	}
}
