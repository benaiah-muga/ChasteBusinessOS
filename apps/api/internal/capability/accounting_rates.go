package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

type RecordFxRateInput struct {
	QuoteCurrency string  `json:"quoteCurrency"`
	Rate          string  `json:"rate"`
	EffectiveAt   *string `json:"effectiveAt,omitempty"`
}

type RecordFxRateOutput struct {
	RateID string `json:"rateId"`
	Num    int64  `json:"num"`
	Den    int64  `json:"den"`
}

func ParseRecordFxRateInput(raw json.RawMessage) (RecordFxRateInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RecordFxRateInput{}, err
	}
	var input RecordFxRateInput
	input.QuoteCurrency, err = requiredString(fields, "quoteCurrency")
	if err != nil {
		return RecordFxRateInput{}, err
	}
	if utf16Length(input.QuoteCurrency) < 3 || utf16Length(input.QuoteCurrency) > 3 {
		return RecordFxRateInput{}, errors.New("quoteCurrency must contain exactly 3 characters")
	}
	input.Rate, err = requiredString(fields, "rate")
	if err != nil {
		return RecordFxRateInput{}, err
	}
	if input.EffectiveAt, err = optionalString(fields, "effectiveAt"); err != nil {
		return RecordFxRateInput{}, err
	}
	if input.EffectiveAt != nil {
		if _, err := parseLegacyDateTime(*input.EffectiveAt); err != nil {
			return RecordFxRateInput{}, errors.New("effectiveAt must be a UTC ISO datetime")
		}
	}
	return input, nil
}

func recordFxRate(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input RecordFxRateInput, now time.Time) (RecordFxRateOutput, error) {
	var output RecordFxRateOutput
	if tx == nil {
		return output, errors.New("FX rate transaction is required")
	}
	if claims.OrganizationID == "" {
		return output, errors.New("organization id is required")
	}
	if _, valid := currencyMinorUnits(input.QuoteCurrency); !valid {
		return output, fmt.Errorf("unknown currency code: %s", input.QuoteCurrency)
	}
	rate, err := parseFXRateDecimal(input.Rate)
	if err != nil {
		return output, errors.New("invalid rate; use a positive decimal like 1.0875")
	}
	if rate.Den > maxDatabaseInteger {
		return output, errors.New("FX rate denominator exceeds the database integer range")
	}
	var baseCurrency string
	if err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, claims.OrganizationID).Scan(&baseCurrency); err != nil {
		return output, err
	}
	effectiveAt := now
	if input.EffectiveAt != nil {
		effectiveAt, err = parseLegacyDateTime(*input.EffectiveAt)
		if err != nil {
			return output, errors.New("effectiveAt must be a UTC ISO datetime")
		}
		// The legacy path parses ISO strings into a JavaScript Date before SQL.
		effectiveAt = effectiveAt.Truncate(time.Millisecond)
	}
	var rateID string
	err = tx.QueryRow(ctx, `
		INSERT INTO fx_rates (org_id, base, quote, rate_num, rate_den, effective_at, source, recorded_by_actor_type, recorded_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, 'manual', $7, $8::uuid)
		RETURNING id::text`, claims.OrganizationID, baseCurrency, strings.ToUpper(input.QuoteCurrency), rate.Num, rate.Den, effectiveAt, claims.ActorType, claims.ActorID).Scan(&rateID)
	if err != nil {
		return output, err
	}
	return RecordFxRateOutput{RateID: rateID, Num: rate.Num, Den: rate.Den}, nil
}
