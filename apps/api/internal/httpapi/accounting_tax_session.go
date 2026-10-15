package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const accountingTaxBodyLimit = 64 << 10

type accountingTaxProfile struct {
	JurisdictionCode   string  `json:"jurisdictionCode"`
	RegistrationNumber *string `json:"registrationNumber"`
	FilingFrequency    string  `json:"filingFrequency"`
	ProviderMode       string  `json:"providerMode"`
}

type accountingTaxCode struct {
	ID               string `json:"id"`
	Code             string `json:"code"`
	Name             string `json:"name"`
	JurisdictionCode string `json:"jurisdictionCode"`
	Direction        string `json:"direction"`
	RateBasisPoints  int64  `json:"rateBasisPoints"`
	PriceIncludesTax bool   `json:"priceIncludesTax"`
	Recoverable      bool   `json:"recoverable"`
	Active           bool   `json:"active"`
}

type accountingTaxSettlement struct {
	ID          string  `json:"id"`
	TaxReturnID *string `json:"taxReturnId"`
	PeriodFrom  string  `json:"periodFrom"`
	PeriodTo    string  `json:"periodTo"`
	TaxMinor    int64   `json:"taxMinor"`
	SettledAt   string  `json:"settledAt"`
}

type accountingTaxReturn struct {
	ID                  string                        `json:"id"`
	JurisdictionCode    string                        `json:"jurisdictionCode"`
	PeriodFrom          string                        `json:"periodFrom"`
	PeriodTo            string                        `json:"periodTo"`
	Currency            string                        `json:"currency"`
	OutputTaxMinor      int64                         `json:"outputTaxMinor"`
	InputTaxMinor       int64                         `json:"inputTaxMinor"`
	TaxMinor            int64                         `json:"taxMinor"`
	TaxBreakdown        json.RawMessage               `json:"taxBreakdown"`
	Status              string                        `json:"status"`
	SubmissionReference *string                       `json:"submissionReference"`
	Acknowledgment      json.RawMessage               `json:"acknowledgment"`
	EvidenceReference   *string                       `json:"evidenceReference"`
	AmendsReturnID      *string                       `json:"amendsReturnId"`
	SubmittedAt         *string                       `json:"submittedAt"`
	AcknowledgedAt      *string                       `json:"acknowledgedAt"`
	SettledAt           *string                       `json:"settledAt"`
	SettlementEntryID   *string                       `json:"settlementEntryId"`
	SettlementDelta     *accountingTaxSettlementDelta `json:"settlementDelta"`
	HasActiveAmendment  bool                          `json:"hasActiveAmendment"`
}

type accountingTaxSettlementDelta struct {
	OutputMinor int64 `json:"outputMinor"`
	InputMinor  int64 `json:"inputMinor"`
	NetMinor    int64 `json:"netMinor"`
}

type accountingTaxSnapshot struct {
	Profile     *accountingTaxProfile     `json:"profile"`
	Codes       []accountingTaxCode       `json:"codes"`
	Returns     []accountingTaxReturn     `json:"returns"`
	Settlements []accountingTaxSettlement `json:"settlements"`
}

type accountingTaxReader interface {
	ReadAccountingTax(context.Context, string) (accountingTaxSnapshot, error)
}

type accountingTaxPoolReader struct{ pool *pgxpool.Pool }

func (reader accountingTaxPoolReader) ReadAccountingTax(ctx context.Context, orgID string) (accountingTaxSnapshot, error) {
	return dbx.WithOrgTx(ctx, reader.pool, orgID, func(tx pgx.Tx) (accountingTaxSnapshot, error) {
		var result accountingTaxSnapshot
		var profile accountingTaxProfile
		err := tx.QueryRow(ctx, `SELECT jurisdiction_code, registration_number, filing_frequency, provider_mode
			FROM tax_profiles WHERE org_id = $1::uuid LIMIT 1`, orgID).Scan(&profile.JurisdictionCode, &profile.RegistrationNumber, &profile.FilingFrequency, &profile.ProviderMode)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return result, err
		}
		if err == nil {
			result.Profile = &profile
		}

		codeRows, err := tx.Query(ctx, `SELECT id::text, code, name, jurisdiction_code, direction, rate_basis_points, price_includes_tax, recoverable, active
			FROM tax_codes WHERE org_id = $1::uuid ORDER BY active DESC, created_at DESC`, orgID)
		if err != nil {
			return result, err
		}
		result.Codes = make([]accountingTaxCode, 0)
		for codeRows.Next() {
			var code accountingTaxCode
			if err := codeRows.Scan(&code.ID, &code.Code, &code.Name, &code.JurisdictionCode, &code.Direction, &code.RateBasisPoints, &code.PriceIncludesTax, &code.Recoverable, &code.Active); err != nil {
				codeRows.Close()
				return result, err
			}
			result.Codes = append(result.Codes, code)
		}
		if err := codeRows.Err(); err != nil {
			codeRows.Close()
			return result, err
		}
		codeRows.Close()

		type storedReturn struct {
			accountingTaxReturn
			amendsID *string
		}
		returnRows, err := tx.Query(ctx, `SELECT id::text, jurisdiction_code, period_from, period_to, currency,
			output_tax_minor, input_tax_minor, tax_minor, tax_breakdown, status, submission_reference, acknowledgment,
			evidence_reference, amends_return_id::text, submitted_at, acknowledged_at, settled_at,
			settlement_entry_id::text, created_at
			FROM tax_returns WHERE org_id = $1::uuid ORDER BY created_at DESC LIMIT 500`, orgID)
		if err != nil {
			return result, err
		}
		stored := make([]storedReturn, 0)
		for returnRows.Next() {
			var row storedReturn
			var from, to, createdAt time.Time
			var submittedAt, acknowledgedAt, settledAt *time.Time
			if err := returnRows.Scan(&row.ID, &row.JurisdictionCode, &from, &to, &row.Currency,
				&row.OutputTaxMinor, &row.InputTaxMinor, &row.TaxMinor, &row.TaxBreakdown, &row.Status,
				&row.SubmissionReference, &row.Acknowledgment, &row.EvidenceReference, &row.amendsID,
				&submittedAt, &acknowledgedAt, &settledAt, &row.SettlementEntryID, &createdAt); err != nil {
				returnRows.Close()
				return result, err
			}
			row.PeriodFrom, row.PeriodTo = from.UTC().Format("2006-01-02"), to.AddDate(0, 0, -1).UTC().Format("2006-01-02")
			row.AmendsReturnID = row.amendsID
			row.TaxBreakdown = nonNullJSON(row.TaxBreakdown, `[]`)
			row.Acknowledgment = nonNullJSON(row.Acknowledgment, `null`)
			row.SubmittedAt = nullableTaxTime(submittedAt)
			row.AcknowledgedAt = nullableTaxTime(acknowledgedAt)
			row.SettledAt = nullableTaxTime(settledAt)
			stored = append(stored, row)
		}
		if err := returnRows.Err(); err != nil {
			returnRows.Close()
			return result, err
		}
		returnRows.Close()

		byID := make(map[string]storedReturn, len(stored))
		activeAmendments := make(map[string]bool)
		for _, row := range stored {
			byID[row.ID] = row
			if row.Status != "cancelled" && row.amendsID != nil {
				activeAmendments[*row.amendsID] = true
			}
		}
		for i := range stored {
			row := &stored[i]
			row.HasActiveAmendment = activeAmendments[row.ID]
			parentID := ""
			if row.amendsID != nil {
				parentID = *row.amendsID
			}
			visited := make(map[string]bool)
			var baselineOutput, baselineInput int64
			for parentID != "" {
				if visited[parentID] {
					break
				}
				visited[parentID] = true
				parent, exists := byID[parentID]
				if !exists {
					break
				}
				if parent.SettlementEntryID != nil {
					baselineOutput, baselineInput = parent.OutputTaxMinor, parent.InputTaxMinor
					break
				}
				parentID = ""
				if parent.amendsID != nil {
					parentID = *parent.amendsID
				}
			}
			outputDelta, inputDelta := row.OutputTaxMinor-baselineOutput, row.InputTaxMinor-baselineInput
			row.SettlementDelta = &accountingTaxSettlementDelta{OutputMinor: outputDelta, InputMinor: inputDelta, NetMinor: outputDelta - inputDelta}
		}
		result.Returns = make([]accountingTaxReturn, 0, min(len(stored), 50))
		for _, row := range stored {
			if len(result.Returns) == 50 {
				break
			}
			result.Returns = append(result.Returns, row.accountingTaxReturn)
		}

		settlementRows, err := tx.Query(ctx, `SELECT id::text, tax_return_id::text, period_from, period_to, tax_minor, created_at
			FROM sales_tax_filings WHERE org_id = $1::uuid ORDER BY created_at DESC LIMIT 20`, orgID)
		if err != nil {
			return result, err
		}
		result.Settlements = make([]accountingTaxSettlement, 0)
		for settlementRows.Next() {
			var row accountingTaxSettlement
			var taxReturnID *string
			var from, to, createdAt time.Time
			if err := settlementRows.Scan(&row.ID, &taxReturnID, &from, &to, &row.TaxMinor, &createdAt); err != nil {
				settlementRows.Close()
				return result, err
			}
			row.TaxReturnID = taxReturnID
			row.PeriodFrom, row.PeriodTo = from.UTC().Format("2006-01-02"), to.Add(-time.Millisecond).UTC().Format("2006-01-02")
			row.SettledAt = createdAt.UTC().Format(time.RFC3339Nano)
			result.Settlements = append(result.Settlements, row)
		}
		if err := settlementRows.Err(); err != nil {
			settlementRows.Close()
			return result, err
		}
		settlementRows.Close()
		return result, nil
	})
}

func nullableTaxTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}

func nonNullJSON(value json.RawMessage, fallback string) json.RawMessage {
	if len(value) == 0 || !json.Valid(value) {
		return json.RawMessage(fallback)
	}
	return value
}

type accountingTaxSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type AccountingTaxSessionHandler struct {
	resolver          accountingTaxSessionResolver
	executor          CapabilityExecutor
	reader            accountingTaxReader
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewAccountingTaxSessionHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, executor CapabilityExecutor, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &AccountingTaxSessionHandler{resolver: resolver, executor: executor, reader: accountingTaxPoolReader{pool: pool}, logger: logger, trustedProxyCIDRs: trusted}
}

func newAccountingTaxSessionHandler(resolver accountingTaxSessionResolver, executor CapabilityExecutor, reader accountingTaxReader, logger *slog.Logger, trusted []*net.IPNet) http.Handler {
	return &AccountingTaxSessionHandler{resolver: resolver, executor: executor, reader: reader, logger: logger, trustedProxyCIDRs: trusted}
}

func (handler *AccountingTaxSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if handler == nil || handler.resolver == nil || handler.executor == nil || handler.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounting tax service unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, handler.resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" || !isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if r.Method == http.MethodGet {
		if !resolved.HasPermission("accounting.read") && !resolved.HasPermission("*") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing accounting.read"})
			return
		}
		snapshot, err := handler.reader.ReadAccountingTax(r.Context(), *resolved.OrgID)
		if err != nil {
			handler.logError("accounting tax lookup failed", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
		return
	}
	if r.Header.Get("Authorization") == "" && !sameOriginCapabilityRequest(r, handler.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	handler.post(w, r, resolved)
}

func (handler *AccountingTaxSessionHandler) post(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser) {
	r.Body = http.MaxBytesReader(w, r.Body, accountingTaxBodyLimit)
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
	action, ok := accountingTaxString(body["action"])
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	capabilityID, inputFields, permission, stateChange, supported := accountingTaxAction(action)
	if !supported {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if !resolved.HasPermission(permission) && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing " + permission})
		return
	}
	intentID := ""
	if stateChange {
		var exists bool
		intentID, exists = accountingTaxString(body["intentId"])
		if !exists || intentID == "" || len(utf16.Encode([]rune(intentID))) > 200 || strings.ContainsAny(intentID, "\r\n\x00") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "intentId is required"})
			return
		}
	} else if raw, exists := body["intentId"]; exists {
		if parsed, valid := accountingTaxString(raw); !valid || len(utf16.Encode([]rune(parsed))) > 200 || strings.ContainsAny(parsed, "\r\n\x00") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid intentId"})
			return
		} else if parsed == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid intentId"})
			return
		}
	}
	if !stateChange {
		readIntent, err := accountingTaxReadIntentID()
		if err != nil {
			handler.logError("accounting tax read intent generation failed", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		intentID = readIntent
	}
	input := make(map[string]json.RawMessage, len(inputFields))
	for _, field := range inputFields {
		if value, exists := body[field]; exists {
			input[field] = value
		}
	}
	if action == "report" {
		input["from"], input["to"] = body["from"], body["to"]
	}
	inputRaw, err := json.Marshal(input)
	if err != nil || !accountingTaxInputValid(action, inputRaw) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	claims := accountingTaxSessionClaims(resolved, capabilityID, inputRaw, intentID)
	result, err := handler.executor.Execute(r.Context(), claims, capabilityID, inputRaw)
	if err != nil {
		handler.logError("accounting tax capability execution failed", err)
		if errors.Is(err, capability.ErrSessionInvalid) || errors.Is(err, capability.ErrScopeMismatch) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		} else if errors.Is(err, capability.ErrNotMember) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		} else {
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
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": result.Error})
		return
	}
	if !json.Valid(result.Data) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}{OK: true, Data: result.Data})
}

func accountingTaxReadIntentID() (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	return "tax-read-" + hex.EncodeToString(random[:]), nil
}

func accountingTaxAction(action string) (string, []string, string, bool, bool) {
	switch action {
	case "report":
		return "accounting.salesTaxReport", []string{"from", "to"}, "accounting.read", false, true
	case "profile":
		return "accounting.createTaxProfile", []string{"jurisdictionCode", "registrationNumber", "filingFrequency"}, "accounting.admin", true, true
	case "removeProfile":
		return "accounting.removeTaxProfile", []string{"profileId"}, "accounting.admin", true, true
	case "createCode":
		return "accounting.createTaxCode", []string{"code", "name", "direction", "rateBasisPoints", "priceIncludesTax", "recoverable"}, "accounting.admin", true, true
	case "archiveCode":
		return "accounting.archiveTaxCode", []string{"taxCodeId"}, "accounting.admin", true, true
	case "activateCode":
		return "accounting.activateTaxCode", []string{"taxCodeId"}, "accounting.admin", true, true
	case "prepare":
		return "accounting.createTaxReturn", []string{"periodFrom", "periodTo", "amendsReturnId"}, "accounting.write", true, true
	case "submit":
		return "accounting.recordTaxReturnSubmission", []string{"taxReturnId", "submissionReference", "evidenceReference"}, "accounting.post", true, true
	case "acknowledge":
		return "accounting.recordTaxReturnAcknowledgment", []string{"taxReturnId", "status", "acknowledgmentReference", "details", "evidenceReference"}, "accounting.admin", true, true
	case "amend":
		return "accounting.createTaxReturnAmendment", []string{"taxReturnId"}, "accounting.write", true, true
	case "cancelDraft":
		return "accounting.cancelTaxReturnDraft", []string{"taxReturnId"}, "accounting.write", true, true
	case "settle":
		return "accounting.fileSalesTaxReturn", []string{"taxReturnId"}, "accounting.post", true, true
	default:
		return "", nil, "", false, false
	}
}

func accountingTaxInputValid(action string, raw json.RawMessage) bool {
	switch action {
	case "report":
		_, err := capability.ParseSalesTaxReportInput(raw)
		return err == nil
	case "profile":
		_, err := capability.ParseCreateTaxProfileInput(raw)
		return err == nil
	case "removeProfile":
		_, err := capability.ParseRemoveTaxProfileInput(raw)
		return err == nil
	case "createCode":
		_, err := capability.ParseCreateTaxCodeInput(raw)
		return err == nil
	case "archiveCode":
		_, err := capability.ParseArchiveTaxCodeInput(raw)
		return err == nil
	case "activateCode":
		_, err := capability.ParseActivateTaxCodeInput(raw)
		return err == nil
	case "prepare":
		_, err := capability.ParseCreateTaxReturnInput(raw)
		return err == nil
	case "submit":
		_, err := capability.ParseRecordTaxReturnSubmissionInput(raw)
		return err == nil
	case "acknowledge":
		_, err := capability.ParseRecordTaxReturnAcknowledgmentInput(raw)
		return err == nil
	case "amend":
		_, err := capability.ParseCreateTaxReturnAmendmentInput(raw)
		return err == nil
	case "cancelDraft":
		_, err := capability.ParseCancelTaxReturnDraftInput(raw)
		return err == nil
	case "settle":
		_, err := capability.ParseFileSalesTaxReturnInput(raw)
		return err == nil
	default:
		return false
	}
}

func accountingTaxString(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	err := json.Unmarshal([]byte(trimmed), &value)
	return value, err == nil
}

func accountingTaxSessionClaims(resolved *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) authbridge.CapabilityClaims {
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

func (handler *AccountingTaxSessionHandler) logError(message string, err error) {
	if handler.logger != nil {
		handler.logger.Error(message, "error", err)
	}
}
