package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
)

var errUnknownInventoryAction = errors.New("unsupported inventory action")

func inventoryWriteInputMap(input json.RawMessage) (map[string]json.RawMessage, error) {
	var named map[string]json.RawMessage
	if err := json.Unmarshal(input, &named); err != nil {
		return nil, err
	}
	if named == nil {
		named = map[string]json.RawMessage{}
	}
	return named, nil
}

type InventoryWriteSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewInventoryWriteSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &InventoryWriteSessionHandler{resolver: resolver, executor: executor, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *InventoryWriteSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "inventory service unavailable"})
		return
	}
	resolved, ok := financeSalesResolveSession(w, r, h.resolver)
	if !ok {
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
	permission := "inventory.write"
	if action == "lookupByBarcode" || action == "stockHistory" {
		permission = "inventory.read"
	}
	if status, message := financeSalesAuthorize(resolved, "inventory", permission); status != 0 {
		writeJSON(w, status, map[string]string{"error": message})
		return
	}
	intentID, err := financeSalesIntentID(fields)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	capabilityID, input, err := inventoryWriteRequest(action, fields)
	if err != nil {
		message := "invalid body"
		if errors.Is(err, errUnknownInventoryAction) {
			message = "invalid action"
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": message})
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
	if !inventoryWriteValidOutput(action, result.Data) {
		financeSalesInternalError(w, h.logger, "Go inventory capability returned invalid data")
		return
	}
	financeSalesWriteOK(w, result.Data)
}

func inventoryWriteRequest(action string, fields map[string]json.RawMessage) (string, json.RawMessage, error) {
	switch action {
	case "createItem":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "sku", "name", "kind", "unitLabel", "salePriceMinor", "reorderPointThousandths", "imageUrl", "tags", "barcode"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "sku", "name", "kind", "unitLabel", "salePriceMinor", "reorderPointThousandths", "imageUrl", "tags", "barcode")
		if err != nil {
			return "", nil, err
		}
		named, namedErr := inventoryWriteInputMap(input)
		if namedErr != nil {
			return "", nil, namedErr
		}
		if _, exists := named["kind"]; !exists {
			named["kind"] = json.RawMessage(`"goods"`)
		}
		if _, exists := named["unitLabel"]; !exists {
			named["unitLabel"] = json.RawMessage(`"unit"`)
		}
		if _, exists := named["salePriceMinor"]; !exists {
			named["salePriceMinor"] = json.RawMessage(`0`)
		}
		if _, exists := named["reorderPointThousandths"]; !exists {
			named["reorderPointThousandths"] = json.RawMessage(`0`)
		}
		if _, exists := named["tags"]; !exists {
			named["tags"] = json.RawMessage(`[]`)
		}
		if input, err = json.Marshal(named); err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryCreateItemInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.createItem", input, nil
	case "updateItem":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "sku", "name", "unitLabel", "imageUrl", "barcode", "salePriceMinor", "tags"); err != nil {
			return "", nil, err
		}
		named := make(map[string]json.RawMessage, 7)
		for _, key := range []string{"sku", "name", "unitLabel", "imageUrl", "barcode", "salePriceMinor", "tags"} {
			if raw, exists := fields[key]; exists {
				named[key] = raw
			}
		}
		input, err := json.Marshal(named)
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryItemPatchInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.updateItem", input, nil
	case "archiveItem":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "sku", "archive"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "sku")
		if err != nil {
			return "", nil, err
		}
		named, namedErr := inventoryWriteInputMap(input)
		if namedErr != nil {
			return "", nil, namedErr
		}
		named["archive"] = json.RawMessage(`true`)
		if raw, exists := fields["archive"]; exists {
			var archive bool
			if json.Unmarshal(raw, &archive) == nil && !archive {
				named["archive"] = json.RawMessage(`false`)
			}
		}
		if input, err = json.Marshal(named); err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryArchiveItemInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.archiveItem", input, nil
	case "createLocation":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "code", "name"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "code", "name")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryCreateLocationInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.createLocation", input, nil
	case "adjustStock":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "sku", "quantityDelta", "note", "lotCode"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "sku", "quantityDelta", "note", "lotCode")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryAdjustStockInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.adjustStock", input, nil
	case "stockHistory":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "sku", "limit"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "sku", "limit")
		if err != nil {
			return "", nil, err
		}
		named, namedErr := inventoryWriteInputMap(input)
		if namedErr != nil {
			return "", nil, namedErr
		}
		if _, exists := named["limit"]; !exists {
			named["limit"] = json.RawMessage(`50`)
		}
		if input, err = json.Marshal(named); err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryItemHistoryInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.itemHistory", input, nil
	case "reserveStock":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "sku", "quantityThousandths", "reason"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "sku", "quantityThousandths", "reason")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryReserveStockInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.reserveStock", input, nil
	case "releaseReservation":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "reservationId"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "reservationId")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryReleaseReservationInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.releaseReservation", input, nil
	case "startCycleCount", "createCycleCount":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "note", "skus", "locationId"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "note", "skus", "locationId")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryCreateCycleCountInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.createCycleCount", input, nil
	case "recordCycleCounts":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "countId", "entries", "counts"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "countId")
		if err != nil {
			return "", nil, err
		}
		named, namedErr := inventoryWriteInputMap(input)
		if namedErr != nil {
			return "", nil, namedErr
		}
		rawCounts, exists := fields["entries"]
		if !exists || len(rawCounts) == 0 || string(rawCounts) == "null" {
			rawCounts = fields["counts"]
		}
		if len(rawCounts) > 0 && string(rawCounts) != "null" {
			named["counts"] = rawCounts
		}
		if input, err = json.Marshal(named); err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryRecordCycleCountsInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.recordCycleCounts", input, nil
	case "postCycleCount":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "countId"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "countId")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryPostCycleCountInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.postCycleCount", input, nil
	case "cancelCycleCount":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "countId"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "countId")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryCancelCycleCountInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.cancelCycleCount", input, nil
	case "lookupByBarcode":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "barcode"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "barcode")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryLookupByBarcodeInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.lookupByBarcode", input, nil
	case "createTransfer":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "fromLocationCode", "toLocationCode", "lines", "note"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "fromLocationCode", "toLocationCode", "lines", "note")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryCreateTransferInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.createTransfer", input, nil
	case "confirmTransfer":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "transferId", "lines"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "transferId", "lines")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryConfirmTransferInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.confirmTransfer", input, nil
	case "cancelTransfer":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "transferId"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "transferId")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryCancelTransferInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.cancelTransfer", input, nil
	case "reverseTransfer":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "transferId"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "transferId")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryReverseTransferInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.reverseTransfer", input, nil
	case "postValuationSummary":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "memo"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "memo")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryPostValuationSummaryInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.postValuationSummary", input, nil
	case "reverseValuationSummary":
		if err := financeSalesRejectUnknownFields(fields, "action", "intentId", "entryId"); err != nil {
			return "", nil, err
		}
		input, err := financeSalesInput(fields, "entryId")
		if err != nil {
			return "", nil, err
		}
		if _, err := capability.ParseInventoryReverseValuationSummaryInput(input); err != nil {
			return "", nil, err
		}
		return "inventory.reverseValuationSummary", input, nil
	default:
		return "", nil, errUnknownInventoryAction
	}
}

func inventoryWriteValidOutput(action string, raw json.RawMessage) bool {
	switch action {
	case "createItem":
		var output capability.InventoryCreateItemOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.ItemID)
	case "updateItem":
		var output capability.InventoryUpdateItemOutput
		return json.Unmarshal(raw, &output) == nil && output.SKU != ""
	case "archiveItem":
		var output capability.InventoryArchiveItemOutput
		return financeSalesDecodeOutput(raw, &output) == nil && output.SKU != ""
	case "createLocation":
		var output capability.InventoryCreateLocationOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.LocationID)
	case "adjustStock":
		var output capability.InventoryAdjustStockOutput
		return financeSalesDecodeOutput(raw, &output) == nil
	case "stockHistory":
		var output capability.InventoryItemHistoryOutput
		return financeSalesDecodeOutput(raw, &output) == nil && output.Movements != nil
	case "reserveStock":
		var output capability.InventoryReserveStockOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.ReservationID)
	case "releaseReservation":
		var output capability.InventoryReleaseReservationOutput
		return financeSalesDecodeOutput(raw, &output) == nil
	case "startCycleCount", "createCycleCount":
		var output capability.InventoryCreateCycleCountOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.CountID) && output.LineCount >= 0
	case "recordCycleCounts":
		var output capability.InventoryRecordCycleCountsOutput
		return financeSalesDecodeOutput(raw, &output) == nil && output.Recorded >= 0
	case "postCycleCount":
		var output capability.InventoryPostCycleCountOutput
		return financeSalesDecodeOutput(raw, &output) == nil
	case "cancelCycleCount":
		var output capability.InventoryCancelCycleCountOutput
		return financeSalesDecodeOutput(raw, &output) == nil
	case "lookupByBarcode":
		var output capability.InventoryLookupByBarcodeOutput
		return financeSalesDecodeOutput(raw, &output) == nil &&
			(output.Item == nil || isUUID(output.Item.ID) && output.Item.SKU != "")
	case "createTransfer":
		var output capability.InventoryCreateTransferOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.TransferID) && output.Number >= 1
	case "confirmTransfer":
		var output capability.InventoryConfirmTransferOutput
		return financeSalesDecodeOutput(raw, &output) == nil && isUUID(output.TransferID) && financeSalesCount(output.ConfirmedNowThousandths)
	case "cancelTransfer":
		var output capability.InventoryCancelTransferOutput
		return financeSalesDecodeOutput(raw, &output) == nil
	case "reverseTransfer":
		var output capability.InventoryReverseTransferOutput
		return financeSalesDecodeOutput(raw, &output) == nil && output.Reversed && isUUID(output.ReversalTransferID)
	case "postValuationSummary":
		var output capability.InventoryPostValuationSummaryOutput
		return financeSalesDecodeOutput(raw, &output) == nil && (output.EntryID == nil || isUUID(*output.EntryID))
	case "reverseValuationSummary":
		var output capability.InventoryReverseValuationSummaryOutput
		return financeSalesDecodeOutput(raw, &output) == nil && output.Reversed && isUUID(output.ReversalEntryID)
	default:
		return false
	}
}
