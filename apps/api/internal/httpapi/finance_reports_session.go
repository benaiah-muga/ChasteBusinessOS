package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type ReportsSessionHandler struct {
	resolver DirectCapabilitySessionResolver
	executor CapabilityExecutor
	logger   *slog.Logger
}

func NewReportsSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger) http.Handler {
	return &ReportsSessionHandler{resolver: resolver, executor: executor, logger: logger}
}

func (h *ReportsSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.executor == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Accounting reports service unavailable"})
		return
	}
	resolved, ok := financeSalesResolveSession(w, r, h.resolver)
	if !ok {
		return
	}
	if status, message := financeSalesAuthorize(resolved, "accounting", "accounting.read"); status != 0 {
		writeJSON(w, status, map[string]string{"error": message})
		return
	}

	metadataResult, ok := financeSalesRun(w, r, h.executor, h.logger, resolved, "accounting.reportCurrencyMetadata", json.RawMessage(`{}`), "")
	if !ok {
		return
	}
	if !metadataResult.OK {
		if strings.HasPrefix(metadataResult.Error, "forbidden: missing permission:") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": metadataResult.Error})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": metadataResult.Error})
		return
	}
	var metadata capability.ReportCurrencyMetadataOutput
	if json.Unmarshal(metadataResult.Data, &metadata) != nil || !financeSalesValidCurrencyMetadata(metadata) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Accounting report currency metadata is invalid"})
		return
	}

	pnlData, ok := h.requiredReport(w, r, resolved, "accounting.incomeStatement")
	if !ok {
		return
	}
	var pnl capability.IncomeStatementOutput
	if json.Unmarshal(pnlData, &pnl) != nil {
		financeSalesInternalError(w, h.logger, "Go income statement capability returned invalid data")
		return
	}

	balanceSheetData, ok := h.requiredReport(w, r, resolved, "accounting.balanceSheet")
	if !ok {
		return
	}
	var balanceSheet capability.BalanceSheetOutput
	if json.Unmarshal(balanceSheetData, &balanceSheet) != nil {
		financeSalesInternalError(w, h.logger, "Go balance sheet capability returned invalid data")
		return
	}

	response := reportsResponse{
		BaseCurrency:          metadata.BaseCurrency,
		UnsupportedCurrencies: metadata.UnsupportedCurrencies,
		PnL:                   pnlData,
		BalanceSheet:          balanceSheetData,
	}
	response.CashFlow = h.optionalReport(w, r, resolved, "accounting.cashFlow", func(raw json.RawMessage) bool {
		var output capability.CashFlowOutput
		return json.Unmarshal(raw, &output) == nil
	})
	response.FxExposure = h.optionalReport(w, r, resolved, "accounting.unrealizedFxExposure", func(raw json.RawMessage) bool {
		var output capability.UnrealizedFxExposureOutput
		return json.Unmarshal(raw, &output) == nil
	})
	if response.UnsupportedCurrencies == nil {
		response.UnsupportedCurrencies = []string{}
	}
	writeJSON(w, http.StatusOK, response)
}

type reportsResponse struct {
	BaseCurrency          string          `json:"baseCurrency"`
	UnsupportedCurrencies []string        `json:"unsupportedCurrencies"`
	PnL                   json.RawMessage `json:"pnl"`
	BalanceSheet          json.RawMessage `json:"balanceSheet"`
	CashFlow              json.RawMessage `json:"cashFlow"`
	FxExposure            json.RawMessage `json:"fxExposure"`
}

func (h *ReportsSessionHandler) requiredReport(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, capabilityID string) (json.RawMessage, bool) {
	result, ok := financeSalesRun(w, r, h.executor, h.logger, resolved, capabilityID, json.RawMessage(`{}`), "")
	if !ok {
		return nil, false
	}
	if !result.OK {
		if strings.HasPrefix(result.Error, "forbidden: missing permission:") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": result.Error})
			return nil, false
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": result.Error})
		return nil, false
	}
	return result.Data, true
}

// optionalReport mirrors the legacy tolerance where cash flow and FX exposure
// degrade to null instead of failing the whole report page.
func (h *ReportsSessionHandler) optionalReport(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, capabilityID string, valid func(json.RawMessage) bool) json.RawMessage {
	result, ok := financeSalesRun(w, r, h.executor, h.logger, resolved, capabilityID, json.RawMessage(`{}`), "")
	if !ok || !result.OK || !valid(result.Data) {
		return nil
	}
	return result.Data
}

func financeSalesValidCurrencyMetadata(metadata capability.ReportCurrencyMetadataOutput) bool {
	if !financeSalesCurrencyCode(metadata.BaseCurrency) {
		return false
	}
	if !sort.StringsAreSorted(metadata.UnsupportedCurrencies) {
		return false
	}
	seen := make(map[string]struct{}, len(metadata.UnsupportedCurrencies))
	for _, currency := range metadata.UnsupportedCurrencies {
		if currency == metadata.BaseCurrency || !financeSalesCurrencyCode(currency) {
			return false
		}
		if _, duplicate := seen[currency]; duplicate {
			return false
		}
		seen[currency] = struct{}{}
	}
	return true
}

func financeSalesCurrencyCode(currency string) bool {
	if len(currency) != 3 {
		return false
	}
	for _, r := range currency {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}
