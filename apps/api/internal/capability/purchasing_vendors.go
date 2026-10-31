package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

const purchasingListVendorsCapabilityID = "purchasing.listVendors"

type PurchasingListVendorsInput struct {
	IncludeInactive bool `json:"includeInactive,omitempty"`
}

type PurchasingVendorSummary struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Email           *string `json:"email"`
	PaymentTermDays *int64  `json:"paymentTermDays"`
	Active          bool    `json:"active"`
}

type PurchasingListVendorsOutput struct {
	Vendors []PurchasingVendorSummary `json:"vendors"`
}

func ParsePurchasingListVendorsInput(raw json.RawMessage) (PurchasingListVendorsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PurchasingListVendorsInput{}, err
	}
	for key := range fields {
		if key != "includeInactive" {
			return PurchasingListVendorsInput{}, fmt.Errorf("unsupported purchasing.listVendors argument %q", key)
		}
	}
	input := PurchasingListVendorsInput{}
	if rawValue, ok := fields["includeInactive"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawValue), []byte("null")) {
			return PurchasingListVendorsInput{}, errors.New("includeInactive must be a boolean")
		}
		if err := json.Unmarshal(rawValue, &input.IncludeInactive); err != nil {
			return PurchasingListVendorsInput{}, errors.New("includeInactive must be a boolean")
		}
	}
	return input, nil
}

func purchasingListVendors(ctx context.Context, tx pgx.Tx, orgID string, input PurchasingListVendorsInput) (PurchasingListVendorsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, email, payment_term_days, (deactivated_at IS NULL)
		FROM vendors
		WHERE org_id=$1::uuid AND ($2::boolean OR deactivated_at IS NULL)
		ORDER BY name ASC
		LIMIT 200`, orgID, input.IncludeInactive)
	if err != nil {
		return PurchasingListVendorsOutput{}, err
	}
	defer rows.Close()
	vendors := make([]PurchasingVendorSummary, 0)
	for rows.Next() {
		var vendor PurchasingVendorSummary
		if err := rows.Scan(&vendor.ID, &vendor.Name, &vendor.Email, &vendor.PaymentTermDays, &vendor.Active); err != nil {
			return PurchasingListVendorsOutput{}, err
		}
		vendors = append(vendors, vendor)
	}
	if err := rows.Err(); err != nil {
		return PurchasingListVendorsOutput{}, err
	}
	return PurchasingListVendorsOutput{Vendors: vendors}, nil
}
