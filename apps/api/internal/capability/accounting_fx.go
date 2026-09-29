package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	unrealizedFxExposureCapabilityID       = "accounting.unrealizedFxExposure"
	revalueForeignReceivablesCapabilityID  = "accounting.revalueForeignReceivables"
	reversePeriodFxRevaluationCapabilityID = "accounting.reversePeriodFxRevaluation"
)

type UnrealizedFxExposureInput struct{}

type UnrealizedFxExposureRow struct {
	Currency                string `json:"currency"`
	OutstandingForeignMinor int64  `json:"outstandingForeignMinor"`
	LatestRateNum           *int64 `json:"latestRateNum"`
	LatestRateDen           *int64 `json:"latestRateDen"`
	OutstandingBaseMinor    *int64 `json:"outstandingBaseMinor"`
}

type UnrealizedFxExposureOutput struct {
	Exposures []UnrealizedFxExposureRow `json:"exposures"`
}

type FxRevaluationCurrencyLine struct {
	Currency            string `json:"currency"`
	ForeignMinor        int64  `json:"foreignMinor"`
	HistoricalBaseMinor int64  `json:"historicalBaseMinor"`
	CloseBaseMinor      int64  `json:"closeBaseMinor"`
	AdjustmentMinor     int64  `json:"adjustmentMinor"`
	RateNum             int64  `json:"rateNum"`
	RateDen             int64  `json:"rateDen"`
}

// FxRevaluationRateSnapshot is one currency's row of the period_fx_revaluations
// rate_snapshot JSONB column, mirroring the TypeScript snapshot object.
type FxRevaluationRateSnapshot struct {
	Currency            string `json:"currency"`
	RateNum             int64  `json:"rateNum"`
	RateDen             int64  `json:"rateDen"`
	ForeignMinor        int64  `json:"foreignMinor"`
	HistoricalBaseMinor int64  `json:"historicalBaseMinor"`
	CloseBaseMinor      int64  `json:"closeBaseMinor"`
}

type RevalueForeignReceivablesOutput struct {
	RevaluationID        string                      `json:"revaluationId"`
	EntryID              *string                     `json:"entryId"`
	TotalAdjustmentMinor int64                       `json:"totalAdjustmentMinor"`
	Currencies           []FxRevaluationCurrencyLine `json:"currencies"`
	AlreadyReviewed      bool                        `json:"alreadyReviewed"`
}

type ReversePeriodFxRevaluationInput struct {
	RevaluationID string `json:"revaluationId"`
	Reason        string `json:"reason"`
}

type ReversePeriodFxRevaluationOutput struct {
	EntryID *string `json:"entryId"`
	Year    int64   `json:"year"`
	Month   int64   `json:"month"`
}

func parseAccountingFxInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case unrealizedFxExposureCapabilityID:
		return ParseUnrealizedFxExposureInput(raw)
	case revalueForeignReceivablesCapabilityID:
		return ParseRevalueForeignReceivablesInput(raw)
	case reversePeriodFxRevaluationCapabilityID:
		return ParseReversePeriodFxRevaluationInput(raw)
	default:
		return nil, errors.New("unsupported accounting fx capability")
	}
}

func ParseUnrealizedFxExposureInput(raw json.RawMessage) (UnrealizedFxExposureInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return UnrealizedFxExposureInput{}, err
	}
	return UnrealizedFxExposureInput{}, nil
}

func ParseRevalueForeignReceivablesInput(raw json.RawMessage) (ClosePeriodInput, error) {
	return parseClosePeriodInput(raw)
}

func ParseReversePeriodFxRevaluationInput(raw json.RawMessage) (ReversePeriodFxRevaluationInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ReversePeriodFxRevaluationInput{}, err
	}
	var input ReversePeriodFxRevaluationInput
	if input.RevaluationID, err = requiredString(fields, "revaluationId"); err != nil {
		return ReversePeriodFxRevaluationInput{}, err
	}
	if !isZodUUID(input.RevaluationID) {
		return ReversePeriodFxRevaluationInput{}, errors.New("revaluationId must be a UUID")
	}
	if input.Reason, err = requiredString(fields, "reason"); err != nil {
		return ReversePeriodFxRevaluationInput{}, err
	}
	if length := utf16Length(input.Reason); length < 3 || length > 500 {
		return ReversePeriodFxRevaluationInput{}, errors.New("reason must contain between 3 and 500 characters")
	}
	return input, nil
}

// fxRevaluationDeltaMinor mirrors erp-core fxRevaluationDeltaMinor: the
// unrealized gain or loss in base minor units is the close valuation minus the
// historical carrying amount, and every input must be a non-negative safe
// integer. Positive means an asset gain.
func fxRevaluationDeltaMinor(outstandingForeignMinor, historicalBaseMinor, closeBaseMinor int64) (int64, error) {
	for _, check := range []struct {
		value int64
		name  string
	}{
		{outstandingForeignMinor, "foreign outstanding"},
		{historicalBaseMinor, "historical carrying amount"},
		{closeBaseMinor, "close valuation"},
	} {
		if check.value < 0 || check.value > maxSafeInteger {
			return 0, fmt.Errorf("%s must be a non-negative safe integer", check.name)
		}
	}
	return closeBaseMinor - historicalBaseMinor, nil
}

func fxRevaluationSafeAmount(value *big.Int, name string) (int64, error) {
	if value.Sign() < 0 || value.Cmp(big.NewInt(maxSafeInteger)) > 0 {
		return 0, fmt.Errorf("%s must be a non-negative safe integer", name)
	}
	return value.Int64(), nil
}

// ensureAccountID mirrors the TypeScript ensureAccount: lazily create chart of
// accounts rows (the FX gain and loss accounts) so orgs onboarded before
// multi-currency keep posting. The shared posting door resolves codes itself.
func ensureAccountID(ctx context.Context, tx pgx.Tx, orgID, code, name, accountType string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM accounts WHERE org_id = $1::uuid AND code = $2 LIMIT 1`, orgID, code).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO accounts (org_id, code, name, type)
		VALUES ($1::uuid, $2, $3, $4)
		RETURNING id::text`, orgID, code, name, accountType).Scan(&id); err != nil {
		return "", err
	}
	return id, nil
}

type fxRevaluationCurrencyTotals struct {
	foreign    big.Int
	historical big.Int
}

func executeUnrealizedFxExposure(ctx context.Context, tx pgx.Tx, orgID string, input UnrealizedFxExposureInput, now time.Time) (UnrealizedFxExposureOutput, error) {
	_ = input
	var output UnrealizedFxExposureOutput
	if tx == nil {
		return output, errors.New("FX exposure transaction is required")
	}
	if orgID == "" {
		return output, errors.New("organization id is required")
	}
	base, err := periodCloseBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return output, err
	}
	rows, err := tx.Query(ctx, `
		SELECT currency, coalesce(sum(greatest(total_minor - credited_minor - paid_minor, 0)), 0)::bigint
		FROM invoices
		WHERE org_id = $1::uuid AND currency <> $2 AND status <> 'void'
		GROUP BY currency
		ORDER BY currency`, orgID, base)
	if err != nil {
		return output, err
	}
	type exposureRow struct {
		currency    string
		outstanding int64
	}
	aggregated := make([]exposureRow, 0)
	for rows.Next() {
		var row exposureRow
		if err := rows.Scan(&row.currency, &row.outstanding); err != nil {
			rows.Close()
			return output, err
		}
		aggregated = append(aggregated, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return output, err
	}
	rows.Close()
	at := now.Truncate(time.Millisecond)
	output.Exposures = make([]UnrealizedFxExposureRow, 0, len(aggregated))
	for _, row := range aggregated {
		rate, err := latestFXRate(ctx, tx, orgID, base, row.currency, at)
		if err != nil {
			return output, err
		}
		exposure := UnrealizedFxExposureRow{
			Currency:                row.currency,
			OutstandingForeignMinor: row.outstanding,
		}
		if rate != nil {
			rateNum := rate.Num
			rateDen := rate.Den
			baseMinor, err := toBaseMinorExact(row.outstanding, *rate, row.currency, base)
			if err != nil {
				return output, err
			}
			exposure.LatestRateNum = &rateNum
			exposure.LatestRateDen = &rateDen
			exposure.OutstandingBaseMinor = &baseMinor
		}
		output.Exposures = append(output.Exposures, exposure)
	}
	return output, nil
}

func executeRevalueForeignReceivables(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ClosePeriodInput, now time.Time) (RevalueForeignReceivablesOutput, error) {
	var output RevalueForeignReceivablesOutput
	if tx == nil {
		return output, errors.New("FX revaluation transaction is required")
	}
	orgID := claims.OrganizationID
	if orgID == "" {
		return output, errors.New("organization id is required")
	}
	base, err := periodCloseBaseCurrency(ctx, tx, orgID)
	if err != nil {
		return output, err
	}
	// The TypeScript builds Date.UTC(year, month, 1) with the 1-based month in
	// the 0-based slot, so nextMonth is the first instant after the period and
	// periodEnd is its last millisecond.
	nextMonthStart := time.Date(int(input.Year), time.Month(input.Month)+1, 1, 0, 0, 0, 0, time.UTC)
	periodEnd := nextMonthStart.Add(-time.Millisecond)
	rows, err := tx.Query(ctx, `
		SELECT currency, total_minor, paid_minor, credited_minor, fx_rate_num, fx_rate_den
		FROM invoices
		WHERE org_id = $1::uuid AND currency <> $2 AND issued_at < $3
		  AND status <> 'void' AND voided_at IS NULL`, orgID, base, nextMonthStart)
	if err != nil {
		return output, err
	}
	totals := make(map[string]*fxRevaluationCurrencyTotals)
	order := make([]string, 0)
	for rows.Next() {
		var currency string
		var totalMinor, paidMinor, creditedMinor int64
		var fxRateNum, fxRateDen *int64
		if err := rows.Scan(&currency, &totalMinor, &paidMinor, &creditedMinor, &fxRateNum, &fxRateDen); err != nil {
			rows.Close()
			return output, err
		}
		outstanding := totalMinor - paidMinor - creditedMinor
		if outstanding < 0 {
			outstanding = 0
		}
		if outstanding <= 0 {
			continue
		}
		if fxRateNum == nil || fxRateDen == nil {
			rows.Close()
			return output, fmt.Errorf("invoice in %s has no historical FX snapshot", currency)
		}
		historical, err := toBaseMinorExact(outstanding, fxRateSnapshot{Num: *fxRateNum, Den: *fxRateDen}, currency, base)
		if err != nil {
			rows.Close()
			return output, err
		}
		total, exists := totals[currency]
		if !exists {
			total = &fxRevaluationCurrencyTotals{}
			totals[currency] = total
			order = append(order, currency)
		}
		total.foreign.Add(&total.foreign, big.NewInt(outstanding))
		total.historical.Add(&total.historical, big.NewInt(historical))
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return output, err
	}
	rows.Close()

	sort.Strings(order)
	currencies := make([]FxRevaluationCurrencyLine, 0, len(order))
	snapshot := make([]FxRevaluationRateSnapshot, 0, len(order))
	var totalAdjustment big.Int
	for _, currency := range order {
		values := totals[currency]
		foreignMinor, err := fxRevaluationSafeAmount(&values.foreign, "foreign outstanding")
		if err != nil {
			return output, err
		}
		historicalBaseMinor, err := fxRevaluationSafeAmount(&values.historical, "historical carrying amount")
		if err != nil {
			return output, err
		}
		rate, err := latestFXRate(ctx, tx, orgID, base, currency, periodEnd)
		if err != nil {
			return output, err
		}
		if rate == nil {
			return output, fmt.Errorf("no %s/%s rate effective at period end; record a close rate before revaluation", base, currency)
		}
		closeBaseMinor, err := toBaseMinorExact(foreignMinor, *rate, currency, base)
		if err != nil {
			return output, err
		}
		adjustmentMinor, err := fxRevaluationDeltaMinor(foreignMinor, historicalBaseMinor, closeBaseMinor)
		if err != nil {
			return output, err
		}
		currencies = append(currencies, FxRevaluationCurrencyLine{
			Currency: currency, ForeignMinor: foreignMinor, HistoricalBaseMinor: historicalBaseMinor,
			CloseBaseMinor: closeBaseMinor, AdjustmentMinor: adjustmentMinor, RateNum: rate.Num, RateDen: rate.Den,
		})
		snapshot = append(snapshot, FxRevaluationRateSnapshot{
			Currency: currency, RateNum: rate.Num, RateDen: rate.Den, ForeignMinor: foreignMinor,
			HistoricalBaseMinor: historicalBaseMinor, CloseBaseMinor: closeBaseMinor,
		})
		totalAdjustment.Add(&totalAdjustment, big.NewInt(adjustmentMinor))
	}
	if !totalAdjustment.IsInt64() || absInt64(totalAdjustment.Int64()) > maxSafeInteger {
		return output, errors.New("FX adjustment exceeds the supported amount range")
	}
	totalAdjustmentMinor := totalAdjustment.Int64()

	var existingID string
	var existingReversedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT id::text, reversed_at FROM period_fx_revaluations
		WHERE org_id = $1::uuid AND year = $2 AND month = $3
		LIMIT 1
		FOR UPDATE`, orgID, input.Year, input.Month).Scan(&existingID, &existingReversedAt)
	exists := true
	if errors.Is(err, pgx.ErrNoRows) {
		exists = false
	} else if err != nil {
		return output, err
	}
	if exists && existingReversedAt == nil {
		return output, errors.New("this period already has an FX revaluation; reverse it before recalculating")
	}

	var entryID *string
	if totalAdjustmentMinor != 0 {
		if _, err := ensureAccountID(ctx, tx, orgID, "7910", "Unrealized FX gain", "income"); err != nil {
			return output, err
		}
		if _, err := ensureAccountID(ctx, tx, orgID, "7911", "Unrealized FX loss", "expense"); err != nil {
			return output, err
		}
		lines := make([]JournalEntryLineInput, 0, 2)
		if totalAdjustmentMinor > 0 {
			lines = append(lines,
				JournalEntryLineInput{AccountCode: "1100", DebitMinor: totalAdjustmentMinor},
				JournalEntryLineInput{AccountCode: "7910", CreditMinor: totalAdjustmentMinor})
		} else {
			lines = append(lines,
				JournalEntryLineInput{AccountCode: "7911", DebitMinor: -totalAdjustmentMinor},
				JournalEntryLineInput{AccountCode: "1100", CreditMinor: -totalAdjustmentMinor})
		}
		posted, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
			OrgID:      orgID,
			Memo:       fmt.Sprintf("FX revaluation %d-%02d", input.Year, input.Month),
			SourceType: "fx_revaluation",
			Currency:   base,
			PostedAt:   periodEnd,
			ActorType:  claims.ActorType,
			ActorID:    claims.ActorID,
			Lines:      lines,
		})
		if err != nil {
			return output, err
		}
		entryID = &posted
	}

	snapshotJSON, err := json.Marshal(snapshot)
	if err != nil {
		return output, err
	}
	var revaluationID string
	if exists {
		err = tx.QueryRow(ctx, `
			UPDATE period_fx_revaluations
			SET entry_id = $2::uuid, reversal_entry_id = NULL, reversed_at = NULL,
			    total_adjustment_minor = $3, rate_snapshot = $4::jsonb, reviewed_at = $5
			WHERE id = $1::uuid
			RETURNING id::text`, existingID, entryID, totalAdjustmentMinor, snapshotJSON, now).Scan(&revaluationID)
	} else {
		err = tx.QueryRow(ctx, `
			INSERT INTO period_fx_revaluations (org_id, year, month, entry_id, total_adjustment_minor, rate_snapshot, reviewed_at)
			VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::jsonb, $7)
			RETURNING id::text`, orgID, input.Year, input.Month, entryID, totalAdjustmentMinor, snapshotJSON, now).Scan(&revaluationID)
	}
	if err != nil {
		return output, err
	}
	return RevalueForeignReceivablesOutput{
		RevaluationID:        revaluationID,
		EntryID:              entryID,
		TotalAdjustmentMinor: totalAdjustmentMinor,
		Currencies:           currencies,
		AlreadyReviewed:      exists && existingReversedAt == nil,
	}, nil
}

func executeReversePeriodFxRevaluation(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input ReversePeriodFxRevaluationInput, now time.Time) (ReversePeriodFxRevaluationOutput, error) {
	var output ReversePeriodFxRevaluationOutput
	if tx == nil {
		return output, errors.New("FX revaluation reversal transaction is required")
	}
	orgID := claims.OrganizationID
	if orgID == "" {
		return output, errors.New("organization id is required")
	}
	var row struct {
		ID         string
		Year       int64
		Month      int64
		EntryID    *string
		ReversedAt *time.Time
	}
	err := tx.QueryRow(ctx, `
		SELECT id::text, year, month, entry_id::text, reversed_at
		FROM period_fx_revaluations
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1
		FOR UPDATE`, input.RevaluationID, orgID).
		Scan(&row.ID, &row.Year, &row.Month, &row.EntryID, &row.ReversedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return output, errors.New("FX revaluation not found or already reversed")
	}
	if err != nil {
		return output, err
	}
	if row.ReversedAt != nil {
		return output, errors.New("FX revaluation not found or already reversed")
	}
	var entryID *string
	if row.EntryID != nil {
		var originalID string
		var originalCurrency string
		err := tx.QueryRow(ctx, `
			SELECT id::text, currency FROM journal_entries
			WHERE id = $1::uuid AND org_id = $2::uuid
			LIMIT 1`, *row.EntryID, orgID).Scan(&originalID, &originalCurrency)
		if errors.Is(err, pgx.ErrNoRows) {
			return output, errors.New("FX revaluation journal entry not found")
		}
		if err != nil {
			return output, err
		}
		lines, err := tx.Query(ctx, `
			SELECT a.code, jl.debit_minor, jl.credit_minor
			FROM journal_lines jl
			JOIN accounts a ON a.id = jl.account_id AND a.org_id = $2::uuid
			WHERE jl.entry_id = $1::uuid
			ORDER BY jl.id`, *row.EntryID, orgID)
		if err != nil {
			return output, err
		}
		mirror := make([]JournalEntryLineInput, 0, 2)
		for lines.Next() {
			var code string
			var debit, credit int64
			if err := lines.Scan(&code, &debit, &credit); err != nil {
				lines.Close()
				return output, err
			}
			mirror = append(mirror, JournalEntryLineInput{AccountCode: code, DebitMinor: credit, CreditMinor: debit})
		}
		if err := lines.Err(); err != nil {
			lines.Close()
			return output, err
		}
		lines.Close()
		posted, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
			OrgID:        orgID,
			Memo:         fmt.Sprintf("Reverse FX revaluation %d-%02d: %s", row.Year, row.Month, input.Reason),
			SourceType:   "fx_revaluation_reversal",
			SourceID:     &row.ID,
			ReversalOfID: &originalID,
			Currency:     originalCurrency,
			PostedAt:     now,
			ActorType:    claims.ActorType,
			ActorID:      claims.ActorID,
			Lines:        mirror,
		})
		if err != nil {
			return output, err
		}
		entryID = &posted
	}
	if _, err := tx.Exec(ctx, `
		UPDATE period_fx_revaluations SET reversed_at = $2, reversal_entry_id = $3::uuid
		WHERE id = $1::uuid`, row.ID, now, entryID); err != nil {
		return output, err
	}
	return ReversePeriodFxRevaluationOutput{EntryID: entryID, Year: row.Year, Month: row.Month}, nil
}
