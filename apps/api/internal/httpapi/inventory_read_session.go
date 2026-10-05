package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type inventoryReadSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type InventoryReadSessionHandler struct {
	resolver inventoryReadSessionResolver
	executor CapabilityExecutor
	logger   *slog.Logger
}

func NewInventoryReadSessionHandler(resolver inventoryReadSessionResolver, executor CapabilityExecutor, logger *slog.Logger) http.Handler {
	return &InventoryReadSessionHandler{resolver: resolver, executor: executor, logger: logger}
}

func (h *InventoryReadSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "inventory service unavailable"})
		return
	}

	selector, valid := activeOrganizationSelector(r)
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
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if !resolved.HasPermission("inventory.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing inventory.read"})
		return
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "inventory") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "inventory module is disabled"})
		return
	}

	values, hasSKU := r.URL.Query()["sku"]
	if hasSKU && len(values) != 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sku must be provided once"})
		return
	}
	if hasSKU && values[0] != "" {
		if strings.ContainsAny(values[0], "\x00\r\n") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sku"})
			return
		}
		history, status, message := h.executeRead(r, resolved, "inventory.itemHistory", map[string]any{"sku": values[0], "limit": 100})
		if status != http.StatusOK {
			writeJSON(w, status, map[string]string{"error": message})
			return
		}
		var output struct {
			Movements json.RawMessage `json:"movements"`
		}
		if json.Unmarshal(history, &output) != nil || len(output.Movements) == 0 || !json.Valid(output.Movements) {
			if h.logger != nil {
				h.logger.Error("Go inventory history returned invalid data")
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]json.RawMessage{"movements": output.Movements})
		return
	}

	response, status, message := h.catalog(r, resolved)
	if status != http.StatusOK {
		writeJSON(w, status, map[string]string{"error": message})
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *InventoryReadSessionHandler) catalog(r *http.Request, resolved *session.ResolvedUser) (map[string]any, int, string) {
	stockRaw, status, message := h.executeRead(r, resolved, "inventory.stockReport", map[string]any{"belowReorderOnly": false})
	if status != http.StatusOK {
		return nil, status, message
	}
	var stock struct {
		Items []struct {
			SKU                     string   `json:"sku"`
			Name                    string   `json:"name"`
			Kind                    string   `json:"kind"`
			UnitLabel               string   `json:"unitLabel"`
			SalePriceMinor          int64    `json:"salePriceMinor"`
			ImageURL                *string  `json:"imageUrl"`
			Tags                    []string `json:"tags"`
			Barcode                 *string  `json:"barcode"`
			OnHandThousandths       int64    `json:"onHandThousandths"`
			ValueMinor              int64    `json:"valueMinor"`
			AvgUnitCostMinor        int64    `json:"avgUnitCostMinor"`
			ReservedThousandths     int64    `json:"reservedThousandths"`
			AvailableThousandths    int64    `json:"availableThousandths"`
			ReorderPointThousandths int64    `json:"reorderPointThousandths"`
			ReorderNeeded           bool     `json:"reorderNeeded"`
		} `json:"items"`
		TotalValueMinor int64 `json:"totalValueMinor"`
	}
	if err := json.Unmarshal(stockRaw, &stock); err != nil || stock.Items == nil {
		return nil, http.StatusInternalServerError, "internal error"
	}

	metadataRaw, status, message := h.executeRead(r, resolved, "inventory.listItemMetadata", map[string]any{})
	if status != http.StatusOK {
		return nil, status, message
	}
	var metadata struct {
		Items []struct {
			ID  string `json:"id"`
			SKU string `json:"sku"`
		} `json:"items"`
	}
	if err := json.Unmarshal(metadataRaw, &metadata); err != nil || metadata.Items == nil {
		return nil, http.StatusInternalServerError, "internal error"
	}
	idsBySKU := make(map[string]string, len(metadata.Items))
	for _, item := range metadata.Items {
		idsBySKU[item.SKU] = item.ID
	}
	items := make([]map[string]any, 0, len(stock.Items))
	reorderAlerts := make([]map[string]any, 0)
	for _, item := range stock.Items {
		itemID, ok := idsBySKU[item.SKU]
		if !ok {
			return nil, http.StatusInternalServerError, "internal error"
		}
		items = append(items, map[string]any{
			"id": itemID, "sku": item.SKU, "name": item.Name, "kind": item.Kind,
			"unitLabel": item.UnitLabel, "salePriceMinor": item.SalePriceMinor,
			"imageUrl": item.ImageURL, "tags": item.Tags, "barcode": item.Barcode,
			"onHandThousandths": item.OnHandThousandths, "valueMinor": item.ValueMinor,
			"totalValueMinor": item.ValueMinor, "avgUnitCostMinor": item.AvgUnitCostMinor,
			"reservedThousandths": item.ReservedThousandths, "availableThousandths": item.AvailableThousandths,
			"reorderPointThousandths": item.ReorderPointThousandths, "reorderNeeded": item.ReorderNeeded,
		})
		if item.ReorderNeeded {
			reorderAlerts = append(reorderAlerts, map[string]any{
				"sku": item.SKU, "name": item.Name, "onHandThousandths": item.OnHandThousandths,
				"reorderPointThousandths": item.ReorderPointThousandths,
				"shortfallThousandths":    max(int64(0), item.ReorderPointThousandths-item.OnHandThousandths),
				"avgUnitCostMinor":        item.AvgUnitCostMinor,
			})
		}
	}

	locations, status, message := h.readField(r, resolved, "inventory.listLocationRecords", map[string]any{}, "locations")
	if status != http.StatusOK {
		return nil, status, message
	}
	reservations, status, message := h.readField(r, resolved, "inventory.listReservations", map[string]any{"openOnly": false}, "reservations")
	if status != http.StatusOK {
		return nil, status, message
	}
	cycleCounts, status, message := h.readField(r, resolved, "inventory.listCycleCounts", map[string]any{}, "cycleCounts")
	if status != http.StatusOK {
		return nil, status, message
	}
	lots, status, message := h.readField(r, resolved, "inventory.listLots", map[string]any{}, "lots")
	if status != http.StatusOK {
		return nil, status, message
	}
	transfers, status, message := h.readField(r, resolved, "inventory.listTransfers", map[string]any{"openOnly": false}, "transfers")
	if status != http.StatusOK {
		return nil, status, message
	}

	return map[string]any{
		"items": items, "totalValueMinor": stock.TotalValueMinor, "reorderAlerts": reorderAlerts,
		"locations": locations, "reservations": reservations, "cycleCounts": cycleCounts,
		"lots": lots, "transfers": transfers,
	}, http.StatusOK, ""
}

func (h *InventoryReadSessionHandler) readField(r *http.Request, resolved *session.ResolvedUser, capabilityID string, input map[string]any, field string) (json.RawMessage, int, string) {
	raw, status, message := h.executeRead(r, resolved, capabilityID, input)
	if status != http.StatusOK {
		return nil, status, message
	}
	var output map[string]json.RawMessage
	if err := json.Unmarshal(raw, &output); err != nil || output[field] == nil || !json.Valid(output[field]) {
		return nil, http.StatusInternalServerError, "internal error"
	}
	switch capabilityID {
	case "inventory.listLots":
		var rows []struct {
			ID        string  `json:"id"`
			SKU       string  `json:"sku"`
			LotCode   string  `json:"lotCode"`
			ExpiresAt *string `json:"expiresAt"`
		}
		if err := json.Unmarshal(output[field], &rows); err != nil {
			return nil, http.StatusInternalServerError, "internal error"
		}
		if len(rows) > 200 {
			rows = rows[:200]
		}
		projected := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			projected = append(projected, map[string]any{"id": row.ID, "sku": row.SKU, "lotCode": row.LotCode, "expiresAt": row.ExpiresAt})
		}
		output[field], _ = json.Marshal(projected)
	case "inventory.listTransfers":
		var rows []struct {
			ID     string          `json:"id"`
			Number int64           `json:"number"`
			Status string          `json:"status"`
			Note   *string         `json:"note"`
			From   string          `json:"from"`
			To     string          `json:"to"`
			Lines  json.RawMessage `json:"lines"`
		}
		if err := json.Unmarshal(output[field], &rows); err != nil {
			return nil, http.StatusInternalServerError, "internal error"
		}
		if len(rows) > 50 {
			rows = rows[:50]
		}
		projected := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			projected = append(projected, map[string]any{"id": row.ID, "number": row.Number, "status": row.Status, "note": row.Note, "from": row.From, "to": row.To, "lines": row.Lines})
		}
		output[field], _ = json.Marshal(projected)
	}
	return output[field], http.StatusOK, ""
}

func (h *InventoryReadSessionHandler) executeRead(r *http.Request, resolved *session.ResolvedUser, capabilityID string, input any) (json.RawMessage, int, string) {
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil, http.StatusInternalServerError, "internal error"
	}
	claims := inventoryReadSessionClaims(resolved, capabilityID, encoded)
	result, err := h.executor.Execute(r.Context(), claims, capabilityID, encoded)
	if err != nil {
		switch {
		case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
			return nil, http.StatusUnauthorized, "unauthorized"
		case errors.Is(err, capability.ErrNotMember):
			return nil, http.StatusForbidden, "forbidden"
		default:
			if h.logger != nil {
				h.logger.Error("Go inventory read capability failed", "capabilityId", capabilityID, "error", err)
			}
			return nil, http.StatusInternalServerError, "internal error"
		}
	}
	if !result.OK {
		if capabilityID == "inventory.itemHistory" && strings.HasPrefix(result.Error, "no item with SKU ") {
			return nil, http.StatusNotFound, result.Error
		}
		return nil, http.StatusForbidden, "forbidden"
	}
	if !json.Valid(result.Data) {
		if h.logger != nil {
			h.logger.Error("Go inventory read capability returned invalid data", "capabilityId", capabilityID)
		}
		return nil, http.StatusInternalServerError, "internal error"
	}
	return result.Data, http.StatusOK, ""
}

func inventoryReadSessionClaims(resolved *session.ResolvedUser, capabilityID string, input json.RawMessage) authbridge.CapabilityClaims {
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

func (h *InventoryReadSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, error) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			return nil, session.ErrNoSession
		}
		return h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	}
	return h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
}
