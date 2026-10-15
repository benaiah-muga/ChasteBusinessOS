package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const accountingBudgetsBodyLimit = 64 << 10

type accountingBudgetAccount struct {
	Code string `json:"code"`
	Name string `json:"name"`
	Type string `json:"type"`
}

type accountingBudgetAccountReader interface {
	ListBudgetAccounts(context.Context, string) ([]accountingBudgetAccount, error)
}

type accountingBudgetPoolReader struct{ pool *pgxpool.Pool }

func (reader accountingBudgetPoolReader) ListBudgetAccounts(ctx context.Context, orgID string) ([]accountingBudgetAccount, error) {
	return dbx.WithOrgTx(ctx, reader.pool, orgID, func(tx pgx.Tx) ([]accountingBudgetAccount, error) {
		rows, err := tx.Query(ctx, `SELECT code, name, type FROM accounts WHERE org_id = $1::uuid AND type = ANY($2::text[]) ORDER BY code`, orgID, []string{"income", "expense"})
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		accounts := make([]accountingBudgetAccount, 0)
		for rows.Next() {
			var account accountingBudgetAccount
			if err := rows.Scan(&account.Code, &account.Name, &account.Type); err != nil {
				return nil, err
			}
			accounts = append(accounts, account)
		}
		return accounts, rows.Err()
	})
}

type accountingBudgetsSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type AccountingBudgetsSessionHandler struct {
	resolver          accountingBudgetsSessionResolver
	executor          CapabilityExecutor
	accounts          accountingBudgetAccountReader
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewAccountingBudgetsSessionHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return newAccountingBudgetsSessionHandler(resolver, executor, accountingBudgetPoolReader{pool: pool}, logger, trusted)
}

func newAccountingBudgetsSessionHandler(resolver accountingBudgetsSessionResolver, executor CapabilityExecutor, accounts accountingBudgetAccountReader, logger *slog.Logger, trustedProxyCIDRs []*net.IPNet) http.Handler {
	return &AccountingBudgetsSessionHandler{resolver: resolver, executor: executor, accounts: accounts, logger: logger, trustedProxyCIDRs: trustedProxyCIDRs}
}

func (handler *AccountingBudgetsSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if handler == nil || handler.resolver == nil || handler.executor == nil || handler.accounts == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounting budgets service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, bearer, ok := handler.resolve(r, selector)
	if !ok || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if selector != "" && !strings.EqualFold(selector, *resolved.OrgID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if r.Method == http.MethodGet {
		if !resolved.HasPermission("accounting.read") && !resolved.HasPermission("*") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing accounting.read"})
			return
		}
		handler.serveRead(w, r, resolved)
		return
	}
	if !bearer && !sameOriginCapabilityRequest(r, handler.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if !resolved.HasPermission("accounting.write") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing accounting.write"})
		return
	}
	handler.serveWrite(w, r, resolved)
}

func (handler *AccountingBudgetsSessionHandler) resolve(r *http.Request, selector string) (*session.ResolvedUser, bool, bool) {
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil, true, false
		}
		resolved, err := handler.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
		return resolved, true, err == nil
	}
	resolved, err := handler.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	return resolved, false, err == nil
}

func (handler *AccountingBudgetsSessionHandler) serveRead(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	fiscalYear, scenarioID, valid := accountingBudgetQuery(r.URL.Query())
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid query"})
		return
	}
	listInput := map[string]any{}
	if fiscalYear != nil {
		listInput["fiscalYear"] = *fiscalYear
	}
	listRaw, _ := json.Marshal(listInput)
	listResult, err := handler.executeBudgetCapability(w, r, resolved, "accounting.listBudgetScenarios", listRaw, "")
	if err != nil {
		return
	}
	if listResult == nil {
		return
	}
	var comparison json.RawMessage
	if scenarioID != "" {
		compareRaw, _ := json.Marshal(map[string]string{"scenarioId": scenarioID})
		comparisonResult, err := handler.executeBudgetCapability(w, r, resolved, "accounting.budgetActualVsPlan", compareRaw, "")
		if err != nil {
			return
		}
		if comparisonResult == nil {
			return
		}
		comparison = *comparisonResult
	}
	accounts, err := handler.accounts.ListBudgetAccounts(r.Context(), *resolved.OrgID)
	if err != nil {
		handler.logError("budget account lookup failed", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK         bool                      `json:"ok"`
		Scenarios  json.RawMessage           `json:"scenarios"`
		Comparison json.RawMessage           `json:"comparison"`
		Accounts   []accountingBudgetAccount `json:"accounts"`
	}{OK: true, Scenarios: *listResult, Comparison: comparison, Accounts: accounts})
}

func (handler *AccountingBudgetsSessionHandler) serveWrite(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, accountingBudgetsBodyLimit)
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
	action, ok := accountingBudgetString(body["action"])
	if !ok || (action != "save" && action != "undo") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var intentID string
	if raw, exists := body["intentId"]; !exists || json.Unmarshal(raw, &intentID) != nil || intentID == "" || len(utf16.Encode([]rune(intentID))) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "intentId is required"})
		return
	}
	capabilityID := "accounting.saveBudgetScenario"
	inputFields := []string{"scenarioKey", "name", "fiscalYear", "currency", "assumptions", "lines"}
	if action == "undo" {
		capabilityID = "accounting.undoBudgetScenarioVersion"
		inputFields = []string{"scenarioId", "previousScenarioId"}
		scenarioID, ok := accountingBudgetString(body["scenarioId"])
		if !ok || scenarioID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scenarioId is required"})
			return
		}
		if !isUUID(scenarioID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
	}
	input := make(map[string]json.RawMessage, len(inputFields))
	for _, field := range inputFields {
		if value, exists := body[field]; exists {
			input[field] = value
		}
	}
	if action == "undo" {
		if _, exists := input["previousScenarioId"]; !exists {
			input["previousScenarioId"] = json.RawMessage("null")
		}
	}
	inputRaw, err := json.Marshal(input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	_, _ = handler.executeBudgetCapability(w, r, resolved, capabilityID, inputRaw, intentID)
}

func (handler *AccountingBudgetsSessionHandler) executeBudgetCapability(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (*json.RawMessage, error) {
	claims := accountingBudgetsSessionClaims(resolved, capabilityID, input, intentID)
	result, err := handler.executor.Execute(r.Context(), claims, capabilityID, input)
	if err != nil {
		handler.logError("budget capability execution failed", err)
		if errors.Is(err, capability.ErrSessionInvalid) || errors.Is(err, capability.ErrScopeMismatch) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		} else if errors.Is(err, capability.ErrNotMember) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return nil, err
	}
	if result.PendingApproval {
		reason := result.ApprovalRationale
		if reason == "" {
			reason = result.Error
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": false, "pendingApproval": true, "reason": reason})
		return nil, nil
	}
	if !result.OK {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": result.Error})
		return nil, nil
	}
	if !json.Valid(result.Data) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return nil, errors.New("capability returned invalid JSON")
	}
	data := json.RawMessage(result.Data)
	if capabilityID == "accounting.listBudgetScenarios" || capabilityID == "accounting.budgetActualVsPlan" {
		if r.Method == http.MethodGet {
			return &data, nil
		}
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: data})
	return nil, nil
}

func accountingBudgetQuery(query url.Values) (*int64, string, bool) {
	var fiscalYear *int64
	if values, ok := query["fiscalYear"]; ok {
		if len(values) != 1 {
			return nil, "", false
		}
		parsed, err := strconv.ParseInt(values[0], 10, 64)
		if err != nil || parsed < 2000 || parsed > 2100 {
			return nil, "", false
		}
		fiscalYear = &parsed
	}
	scenarioID := ""
	if values, ok := query["scenarioId"]; ok {
		if len(values) != 1 || !isUUID(values[0]) {
			return nil, "", false
		}
		scenarioID = values[0]
	}
	return fiscalYear, scenarioID, true
}

func accountingBudgetString(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	err := json.Unmarshal([]byte(trimmed), &value)
	return value, err == nil
}

func accountingBudgetsSessionClaims(resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) authbridge.CapabilityClaims {
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

func (handler *AccountingBudgetsSessionHandler) logError(message string, err error) {
	if handler.logger != nil {
		handler.logger.Error(message, "error", err)
	}
}
