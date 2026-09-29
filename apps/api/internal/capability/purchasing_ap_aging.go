package capability

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

const apAgingCapabilityID = "purchasing.apAging"

type APAgingInput struct{}

type APAgingBuckets struct {
	Current          int64 `json:"current"`
	D30              int64 `json:"d30"`
	D60              int64 `json:"d60"`
	D90Plus          int64 `json:"d90plus"`
	TotalOutstanding int64 `json:"totalOutstanding"`
}

type APAgingOutput struct {
	Buckets APAgingBuckets `json:"buckets"`
}

func parseAPAgingInput(raw json.RawMessage) (APAgingInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return APAgingInput{}, err
	}
	return APAgingInput{}, nil
}

func purchasingAPAging(ctx context.Context, tx pgx.Tx, orgID string, _ APAgingInput, now time.Time) (APAgingOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT total_minor, paid_minor, bill_date
		FROM vendor_bills
		WHERE org_id = $1::uuid AND total_minor > paid_minor`, orgID)
	if err != nil {
		return APAgingOutput{}, err
	}
	defer rows.Close()

	var output APAgingOutput
	for rows.Next() {
		var totalMinor, paidMinor int64
		var billDate *time.Time
		if err := rows.Scan(&totalMinor, &paidMinor, &billDate); err != nil {
			return APAgingOutput{}, err
		}
		if billDate == nil || totalMinor-paidMinor <= 0 {
			continue
		}
		outstanding := totalMinor - paidMinor
		// JavaScript Date values retain millisecond precision, and the executor's
		// as-of clock is truncated to the same precision before dispatch.
		ageDays := math.Floor(float64(now.Sub(billDate.Truncate(time.Millisecond)).Milliseconds()) / float64((24 * time.Hour).Milliseconds()))
		switch {
		case ageDays <= 30:
			output.Buckets.Current += outstanding
		case ageDays <= 60:
			output.Buckets.D30 += outstanding
		case ageDays <= 90:
			output.Buckets.D60 += outstanding
		default:
			output.Buckets.D90Plus += outstanding
		}
		output.Buckets.TotalOutstanding += outstanding
	}
	if err := rows.Err(); err != nil {
		return APAgingOutput{}, err
	}
	return output, nil
}

func parsePurchasingAPAgingInput(raw json.RawMessage) (APAgingInput, error) {
	input, err := parseAPAgingInput(raw)
	if err != nil {
		return APAgingInput{}, errors.New("invalid AP aging input: " + err.Error())
	}
	return input, nil
}
