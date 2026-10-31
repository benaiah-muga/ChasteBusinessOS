package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
)

type ListCustomerViewsInput struct {
	UserID *string `json:"-"`
}

type CustomerViewSnapshot struct {
	ID              string             `json:"id"`
	Name            string             `json:"name"`
	Filters         CustomerViewFilter `json:"filters"`
	IsShared        bool               `json:"isShared"`
	IsPinned        bool               `json:"isPinned"`
	CreatedByUserID string             `json:"createdByUserId"`
	UpdatedAt       string             `json:"updatedAt"`
}

type CustomerViewFilter struct {
	Status        string `json:"status"`
	Owner         string `json:"owner"`
	StaleOnly     bool   `json:"staleOnly"`
	DuplicateOnly bool   `json:"duplicateOnly"`
	Tag           string `json:"tag"`
}

type ListCustomerViewsOutput struct {
	Views []CustomerViewSnapshot `json:"views"`
}

func parseListCustomerViewsInput(raw json.RawMessage) (ListCustomerViewsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ListCustomerViewsInput{}, err
	}
	return ListCustomerViewsInput{}, nil
}

func listCustomerViews(ctx context.Context, tx pgx.Tx, orgID string, userID *string) (ListCustomerViewsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, filters, is_shared, is_pinned, created_by_user_id::text, updated_at
		FROM crm_customer_views
		WHERE org_id = $1::uuid
		  AND (is_shared = true OR ($2::uuid IS NOT NULL AND created_by_user_id = $2::uuid))
		ORDER BY is_pinned DESC, updated_at DESC`, orgID, userID)
	if err != nil {
		return ListCustomerViewsOutput{}, err
	}
	defer rows.Close()

	views := make([]CustomerViewSnapshot, 0)
	for rows.Next() {
		var view CustomerViewSnapshot
		var filters []byte
		var updatedAt time.Time
		if err := rows.Scan(&view.ID, &view.Name, &filters, &view.IsShared, &view.IsPinned, &view.CreatedByUserID, &updatedAt); err != nil {
			return ListCustomerViewsOutput{}, err
		}
		var filterErr error
		view.Filters, filterErr = parseCustomerViewFilter(filters)
		if filterErr != nil {
			return ListCustomerViewsOutput{}, filterErr
		}
		if view.ID == "" || len(view.Name) < 1 || len(view.Name) > 60 || view.CreatedByUserID == "" {
			return ListCustomerViewsOutput{}, errors.New("saved customer view has invalid fields")
		}
		view.UpdatedAt = updatedAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		views = append(views, view)
	}
	if err := rows.Err(); err != nil {
		return ListCustomerViewsOutput{}, err
	}
	return ListCustomerViewsOutput{Views: views}, nil
}

func validCustomerViewFilter(filter CustomerViewFilter) bool {
	return (filter.Status == "active" || filter.Status == "inactive" || filter.Status == "all") &&
		len(utf16.Encode([]rune(filter.Owner))) <= 64 && len(utf16.Encode([]rune(filter.Tag))) <= 40
}

func parseCustomerViewFilter(raw []byte) (CustomerViewFilter, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil || len(fields) != 5 {
		return CustomerViewFilter{}, errors.New("filters must contain the customer filter fields")
	}
	for _, field := range []string{"status", "owner", "staleOnly", "duplicateOnly", "tag"} {
		if _, ok := fields[field]; !ok {
			return CustomerViewFilter{}, errors.New("filters must contain the customer filter fields")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var filter CustomerViewFilter
	if err := decoder.Decode(&filter); err != nil || !validCustomerViewFilter(filter) {
		return CustomerViewFilter{}, errors.New("filters are invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return CustomerViewFilter{}, errors.New("filters are invalid")
	}
	return filter, nil
}
