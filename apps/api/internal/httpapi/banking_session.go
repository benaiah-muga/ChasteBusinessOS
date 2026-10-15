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
	"sort"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const bankingRequestBodyLimit = 1 << 20

type BankingSessionHandler struct {
	resolver          DirectCapabilitySessionResolver
	executor          CapabilityExecutor
	payments          bankingPaymentReader
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

type bankingPaymentReader interface {
	RecentBankingPayments(context.Context, string) ([]bankingRESTPayment, error)
}

type PGXBankingPaymentReader struct {
	pool *pgxpool.Pool
}

func NewPGXBankingPaymentReader(pool *pgxpool.Pool) *PGXBankingPaymentReader {
	return &PGXBankingPaymentReader{pool: pool}
}

func (reader *PGXBankingPaymentReader) RecentBankingPayments(ctx context.Context, orgID string) ([]bankingRESTPayment, error) {
	if reader == nil || reader.pool == nil || !isUUID(orgID) {
		return nil, errors.New("banking payment reader unavailable")
	}
	return dbx.WithOrgTx(ctx, reader.pool, orgID, func(tx pgx.Tx) ([]bankingRESTPayment, error) {
		rows, err := tx.Query(ctx, `
			SELECT p.id::text, i.number, c.name, p.amount_minor, p.received_at
			FROM payments p
			JOIN invoices i ON i.id = p.invoice_id
			JOIN customers c ON c.id = i.customer_id
			WHERE p.org_id = $1::uuid
			ORDER BY p.received_at DESC
			LIMIT 50`, orgID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		payments := make([]bankingRESTPayment, 0, 50)
		for rows.Next() {
			var payment bankingRESTPayment
			if err := rows.Scan(&payment.ID, &payment.InvoiceNumber, &payment.CustomerName, &payment.AmountMinor, &payment.ReceivedAt); err != nil {
				return nil, err
			}
			payments = append(payments, payment)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return payments, nil
	})
}

func NewBankingSessionHandler(resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, payments bankingPaymentReader, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &BankingSessionHandler{resolver: resolver, executor: executor, payments: payments, logger: logger, trustedProxyCIDRs: trusted}
}

func (handler *BankingSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if handler == nil || handler.resolver == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "banking service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, handler.resolver, selector)
	if err != nil || !validBankingSession(resolved) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if (r.Method == http.MethodGet && handler.payments == nil) || (r.Method == http.MethodPost && handler.executor == nil) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "banking service unavailable"})
		return
	}
	if r.Method == http.MethodGet {
		handler.read(w, r, resolved)
		return
	}
	if r.Header.Get("Authorization") == "" && !sameOriginCapabilityRequest(r, handler.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	handler.write(w, r, resolved)
}

func validBankingSession(resolved *session.ResolvedUser) bool {
	return resolved != nil && resolved.EmailVerified && resolved.OrgID != nil &&
		resolved.AuthSessionID != "" && isUUID(resolved.UserID) && isUUID(*resolved.OrgID)
}

type bankingRESTAccount struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	CurrencyCode string  `json:"currencyCode"`
	Last4        *string `json:"last4"`
	BalanceMinor int64   `json:"balanceMinor"`
}

type bankingRESTTransaction struct {
	ID            string    `json:"id"`
	BankAccountID string    `json:"bankAccountId"`
	CurrencyCode  string    `json:"currencyCode"`
	PostedAt      time.Time `json:"postedAt"`
	AmountMinor   int64     `json:"amountMinor"`
	Description   string    `json:"description"`
}

type bankingRESTPayment struct {
	ID            string    `json:"id"`
	InvoiceNumber *int64    `json:"invoiceNumber"`
	CustomerName  string    `json:"customerName"`
	AmountMinor   int64     `json:"amountMinor"`
	ReceivedAt    time.Time `json:"receivedAt"`
}

type bankingRESTWorkspace struct {
	Accounts  []bankingRESTAccount         `json:"accounts"`
	Unmatched []bankingRESTTransaction     `json:"unmatched"`
	Matched   []bankingRESTTransaction     `json:"matched"`
	Excluded  []bankingRESTTransaction     `json:"excluded"`
	Payments  []bankingRESTPayment         `json:"payments"`
	Summary   capability.BankSummaryOutput `json:"summary"`
}

func (handler *BankingSessionHandler) read(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	input := json.RawMessage(`{}`)
	result, err := handler.execute(r.Context(), resolved, "accounting.listBankingWorkspace", input, "")
	if err != nil {
		handler.writeExecutionError(w, "banking workspace read failed", err)
		return
	}
	if !result.OK {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "banking workspace unavailable"})
		return
	}
	var workspace capability.ListBankingWorkspaceOutput
	if !json.Valid(result.Data) || json.Unmarshal(result.Data, &workspace) != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "banking workspace unavailable"})
		return
	}
	accounts := make([]bankingRESTAccount, 0, len(workspace.Accounts))
	for _, account := range workspace.Accounts {
		accounts = append(accounts, bankingRESTAccount{ID: account.ID, Name: account.Name, CurrencyCode: account.CurrencyCode, Last4: account.Last4, BalanceMinor: account.BalanceMinor})
	}
	projectTransactions := func(rows []capability.BankingWorkspaceTransaction) []bankingRESTTransaction {
		projected := make([]bankingRESTTransaction, 0, len(rows))
		for _, row := range rows {
			projected = append(projected, bankingRESTTransaction{ID: row.ID, BankAccountID: row.BankAccountID, CurrencyCode: row.CurrencyCode, PostedAt: row.PostedAt, AmountMinor: row.AmountMinor, Description: row.Description})
		}
		return projected
	}
	payments, paymentErr := handler.payments.RecentBankingPayments(r.Context(), *resolved.OrgID)
	if paymentErr != nil {
		handler.writeExecutionError(w, "banking payments read failed", paymentErr)
		return
	}
	writeJSON(w, http.StatusOK, bankingRESTWorkspace{
		Accounts: accounts, Unmatched: projectTransactions(workspace.Unmatched),
		Matched: projectTransactions(workspace.Matched), Excluded: projectTransactions(workspace.Excluded),
		Payments: payments, Summary: workspace.Summary,
	})
}

type bankingRESTRequest struct {
	Action        string          `json:"action"`
	IntentID      json.RawMessage `json:"intentId"`
	Name          json.RawMessage `json:"name"`
	CurrencyCode  json.RawMessage `json:"currencyCode"`
	Last4         json.RawMessage `json:"last4"`
	BalanceMinor  json.RawMessage `json:"balanceMinor"`
	BankAccountID json.RawMessage `json:"bankAccountId"`
	Rows          json.RawMessage `json:"rows"`
	TransactionID json.RawMessage `json:"transactionId"`
	PaymentID     json.RawMessage `json:"paymentId"`
	EntryID       json.RawMessage `json:"entryId"`
}

func (handler *BankingSessionHandler) write(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, bankingRequestBodyLimit)
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(bodyBytes))
	var body bankingRESTRequest
	if decoder.Decode(&body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	intentID := bankingJSONString(body.IntentID)
	if intentID == "" || len(intentID) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	capabilityID, input, err := bankingCapabilityRequest(body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	result, err := handler.execute(r.Context(), resolved, capabilityID, input, intentID)
	if err != nil {
		handler.writeExecutionError(w, "banking write failed", err)
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
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": result.Error})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result.Data})
}

func bankingCapabilityRequest(body bankingRESTRequest) (string, json.RawMessage, error) {
	var capabilityID string
	var fields map[string]json.RawMessage
	switch body.Action {
	case "addBankAccount":
		if !bankingJSONTruthy(body.Name) {
			return "", nil, errors.New("name is required")
		}
		fields = map[string]json.RawMessage{"name": body.Name}
		if bankingJSONStringValue(body.CurrencyCode) {
			fields["currencyCode"] = body.CurrencyCode
		}
		if bankingJSONTruthy(body.Last4) {
			fields["last4"] = body.Last4
		}
		if bankingJSONNumber(body.BalanceMinor) {
			fields["balanceMinor"] = body.BalanceMinor
		} else {
			fields["balanceMinor"] = json.RawMessage("0")
		}
		capabilityID = "accounting.addBankAccount"
	case "importBankFeed":
		var rows []json.RawMessage
		if len(body.Rows) == 0 || json.Unmarshal(body.Rows, &rows) != nil || len(rows) == 0 {
			return "", nil, errors.New("rows are required")
		}
		if len(rows) > 500 {
			return "", nil, errors.New("at most 500 rows per import")
		}
		fields = map[string]json.RawMessage{"rows": body.Rows}
		if bankingJSONTruthy(body.BankAccountID) {
			fields["bankAccountId"] = body.BankAccountID
		}
		capabilityID = "accounting.importBankFeed"
	case "matchBankTransaction":
		if !bankingJSONTruthy(body.TransactionID) {
			return "", nil, errors.New("transactionId is required")
		}
		if !bankingJSONTruthy(body.PaymentID) && !bankingJSONTruthy(body.EntryID) {
			return "", nil, errors.New("paymentId or entryId is required")
		}
		fields = map[string]json.RawMessage{"transactionId": body.TransactionID}
		if bankingJSONTruthy(body.PaymentID) {
			fields["paymentId"] = body.PaymentID
		}
		if bankingJSONTruthy(body.EntryID) {
			fields["entryId"] = body.EntryID
		}
		capabilityID = "accounting.matchBankTransaction"
	case "unmatchBankTransaction", "excludeBankTransaction", "unexcludeBankTransaction", "deleteBankTransaction":
		if !bankingJSONTruthy(body.TransactionID) {
			return "", nil, errors.New("transactionId is required")
		}
		fields = map[string]json.RawMessage{"transactionId": body.TransactionID}
		capabilityID = "accounting." + body.Action
	default:
		return "", nil, errors.New("invalid action")
	}
	input, err := json.Marshal(fields)
	if err != nil {
		return "", nil, errors.New("invalid body")
	}
	return capabilityID, input, nil
}

func bankingJSONString(raw json.RawMessage) string {
	var value string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value
}

func bankingJSONStringValue(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var value string
	return json.Unmarshal(raw, &value) == nil
}

func bankingJSONNumber(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	trimmed := bytes.TrimSpace(raw)
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return false
	}
	var value json.Number
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	return decoder.Decode(&value) == nil
}

func bankingJSONTruthy(raw json.RawMessage) bool {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || bytes.Equal(bytes.TrimSpace(raw), []byte("false")) {
		return false
	}
	trimmed := bytes.TrimSpace(raw)
	if trimmed[0] == '"' {
		return len(bankingJSONString(raw)) > 0
	}
	if trimmed[0] == '-' || trimmed[0] >= '0' && trimmed[0] <= '9' {
		var value float64
		return json.Unmarshal(raw, &value) == nil && value != 0
	}
	return true
}

func (handler *BankingSessionHandler) execute(ctx context.Context, resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (capability.Result, error) {
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
	sort.Strings(permissions)
	actorID := resolved.UserID
	now := time.Now().UTC()
	claims := authbridge.CapabilityClaims{
		Audience: authbridge.CapabilityExecuteAudience, Subject: resolved.UserID,
		OrganizationID: *resolved.OrgID, CapabilityID: capabilityID, InputSHA256: inputHash,
		ActorID: &actorID, ActorType: "human", Permissions: permissions,
		AuthSessionID: resolved.AuthSessionID, IntentID: intentID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix(),
	}
	return handler.executor.Execute(ctx, claims, capabilityID, input)
}

func (handler *BankingSessionHandler) writeExecutionError(w http.ResponseWriter, operation string, err error) {
	switch {
	case errors.Is(err, capability.ErrSessionInvalid), errors.Is(err, capability.ErrScopeMismatch):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	case errors.Is(err, capability.ErrNotMember):
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "organization access denied"})
	default:
		var domainError capability.AccountingDomainError
		if errors.As(err, &domainError) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": domainError.Error()})
			return
		}
		if handler.logger != nil {
			handler.logger.Error(operation, "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}
