package httpapi

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

type SalesOrdersWriteSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewSalesOrdersWriteSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &SalesOrdersWriteSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *SalesOrdersWriteSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sales service unavailable"})
		return
	}
	resolved, ok := financeSalesResolveSession(w, r, h.resolver)
	if !ok {
		return
	}
	if status, message := financeSalesAuthorize(resolved, "sales", "sales.write"); status != 0 {
		writeJSON(w, status, map[string]string{"error": message})
		return
	}
	if r.Header.Get("Authorization") == "" && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

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
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "customerId", "note", "lines"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields, "customerId", "note", "lines"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if _, err = capability.ParseSalesCreateOrderInput(input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "sales.createOrder"
	case "confirm":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "orderId", "allowBackorder"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields, "orderId", "allowBackorder"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if _, err = capability.ParseSalesConfirmOrderInput(input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "sales.confirmOrder"
	case "deliver":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "orderId", "lines"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields, "orderId", "lines"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if _, err = capability.ParseSalesDeliverOrderInput(input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "sales.deliverOrder"
	case "cancel":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "orderId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if input, err = financeSalesInput(fields, "orderId"); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if _, err = capability.ParseSalesCancelOrderInput(input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		capabilityID = "sales.cancelOrder"
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
	if !financeSalesValidOrderOutput(action, result.Data) {
		financeSalesInternalError(w, h.logger, "Go sales order capability returned invalid data")
		return
	}
	financeSalesWriteOK(w, result.Data)
}

func financeSalesValidOrderOutput(action string, raw json.RawMessage) bool {
	switch action {
	case "create":
		var output capability.SalesCreateOrderOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.OrderID) && output.OrderNumber >= 1
	case "confirm":
		var output capability.SalesConfirmOrderOutput
		return financeSalesDecodeOutput(raw, &output) == nil && output.Confirmed && financeSalesCount(output.ReservedThousandths)
	case "deliver":
		var output capability.SalesDeliverOrderOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.InvoiceID) &&
			output.InvoiceNumber >= 1 && financeSalesCount(output.InvoiceTotalMinor) &&
			(output.OrderStatus == "confirmed" || output.OrderStatus == "delivered")
	case "cancel":
		var output capability.SalesCancelOrderOutput
		return financeSalesDecodeOutput(raw, &output) == nil && output.Status == "cancelled" &&
			financeSalesCount(output.ReleasedThousandths)
	default:
		return false
	}
}
