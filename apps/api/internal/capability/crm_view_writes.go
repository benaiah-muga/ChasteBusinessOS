package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

type CustomerViewSavedSnapshot struct {
	ID              string             `json:"id"`
	Name            string             `json:"name"`
	Filters         CustomerViewFilter `json:"filters"`
	IsShared        bool               `json:"isShared"`
	IsPinned        bool               `json:"isPinned"`
	CreatedByUserID string             `json:"createdByUserId"`
}

type SaveCustomerViewInput struct {
	ID       *string            `json:"id,omitempty"`
	Name     string             `json:"name"`
	Filters  CustomerViewFilter `json:"filters"`
	IsShared bool               `json:"isShared"`
	IsPinned bool               `json:"isPinned"`
}

type SaveCustomerViewOutput struct {
	ViewID   string                     `json:"viewId"`
	Previous *CustomerViewSavedSnapshot `json:"previous"`
}

type RestoreCustomerViewInput struct {
	ViewID   string                     `json:"viewId"`
	Previous *CustomerViewSavedSnapshot `json:"previous"`
}

type RestoreCustomerViewOutput struct {
	Restored bool `json:"restored"`
}

func ParseSaveCustomerViewInput(raw json.RawMessage) (SaveCustomerViewInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SaveCustomerViewInput{}, err
	}
	var input SaveCustomerViewInput
	if rawID, ok := fields["id"]; ok {
		id, err := requiredViewString(rawID, "id")
		if err != nil || !isZodUUID(id) {
			return SaveCustomerViewInput{}, errors.New("id must be a UUID")
		}
		input.ID = &id
	}
	nameRaw, ok := fields["name"]
	if !ok {
		return SaveCustomerViewInput{}, errors.New("name is required")
	}
	name, err := requiredViewString(nameRaw, "name")
	if err != nil {
		return SaveCustomerViewInput{}, err
	}
	input.Name = strings.TrimSpace(name)
	if n := len(utf16.Encode([]rune(input.Name))); n < 1 || n > 60 {
		return SaveCustomerViewInput{}, errors.New("name must be between 1 and 60 characters")
	}
	filterRaw, ok := fields["filters"]
	if !ok {
		return SaveCustomerViewInput{}, errors.New("filters are required")
	}
	input.Filters, err = parseCustomerViewFilter(filterRaw)
	if err != nil {
		return SaveCustomerViewInput{}, err
	}
	input.IsShared, err = requiredViewBoolean(fields, "isShared")
	if err != nil {
		return SaveCustomerViewInput{}, err
	}
	input.IsPinned, err = requiredViewBoolean(fields, "isPinned")
	if err != nil {
		return SaveCustomerViewInput{}, err
	}
	return input, nil
}

func ParseRestoreCustomerViewInput(raw json.RawMessage) (RestoreCustomerViewInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return RestoreCustomerViewInput{}, err
	}
	viewIDRaw, ok := fields["viewId"]
	if !ok {
		return RestoreCustomerViewInput{}, errors.New("viewId is required")
	}
	viewID, err := requiredViewString(viewIDRaw, "viewId")
	if err != nil || !isZodUUID(viewID) {
		return RestoreCustomerViewInput{}, errors.New("viewId must be a UUID")
	}
	previousRaw, ok := fields["previous"]
	if !ok {
		return RestoreCustomerViewInput{}, errors.New("previous is required")
	}
	previous, err := parseCustomerViewSavedSnapshot(previousRaw)
	if err != nil {
		return RestoreCustomerViewInput{}, err
	}
	return RestoreCustomerViewInput{ViewID: viewID, Previous: previous}, nil
}

func parseCustomerViewSavedSnapshot(raw json.RawMessage) (*CustomerViewSavedSnapshot, error) {
	if bytesIsNull(raw) {
		return nil, nil
	}
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return nil, errors.New("previous must be a saved view or null")
	}
	var snapshot CustomerViewSavedSnapshot
	for key, target := range map[string]*string{"id": &snapshot.ID, "name": &snapshot.Name, "createdByUserId": &snapshot.CreatedByUserID} {
		value, ok := fields[key]
		if !ok {
			return nil, fmt.Errorf("previous.%s is required", key)
		}
		*target, err = requiredViewString(value, "previous."+key)
		if err != nil {
			return nil, err
		}
	}
	if !isZodUUID(snapshot.ID) || !isZodUUID(snapshot.CreatedByUserID) {
		return nil, errors.New("previous id and createdByUserId must be UUIDs")
	}
	if n := len(utf16.Encode([]rune(snapshot.Name))); n < 1 || n > 60 {
		return nil, errors.New("previous.name must be between 1 and 60 characters")
	}
	filterRaw, ok := fields["filters"]
	if !ok {
		return nil, errors.New("previous.filters is required")
	}
	snapshot.Filters, err = parseCustomerViewFilter(filterRaw)
	if err != nil {
		return nil, fmt.Errorf("previous.%w", err)
	}
	snapshot.IsShared, err = requiredViewBoolean(fields, "isShared")
	if err != nil {
		return nil, fmt.Errorf("previous.%w", err)
	}
	snapshot.IsPinned, err = requiredViewBoolean(fields, "isPinned")
	if err != nil {
		return nil, fmt.Errorf("previous.%w", err)
	}
	return &snapshot, nil
}

func requiredViewString(raw json.RawMessage, field string) (string, error) {
	var value string
	if bytesIsNull(raw) || json.Unmarshal(raw, &value) != nil {
		return "", fmt.Errorf("%s must be a string", field)
	}
	return value, nil
}

func requiredViewBoolean(fields map[string]json.RawMessage, field string) (bool, error) {
	raw, ok := fields[field]
	if !ok || bytesIsNull(raw) {
		return false, fmt.Errorf("%s must be a boolean", field)
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, fmt.Errorf("%s must be a boolean", field)
	}
	return value, nil
}

func saveCustomerView(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SaveCustomerViewInput, now time.Time) (SaveCustomerViewOutput, error) {
	if claims.ActorType != "human" || claims.ActorID == nil || *claims.ActorID != claims.Subject {
		return SaveCustomerViewOutput{}, errors.New("a signed-in user is required to save a customer view")
	}

	var existing CustomerViewSavedSnapshot
	var rawFilters []byte
	var findErr error
	if input.ID != nil {
		findErr = tx.QueryRow(ctx, `
			SELECT id::text, name, filters, is_shared, is_pinned, created_by_user_id::text
			FROM crm_customer_views
			WHERE id = $1::uuid AND org_id = $2::uuid
			FOR UPDATE`, *input.ID, claims.OrganizationID).
			Scan(&existing.ID, &existing.Name, &rawFilters, &existing.IsShared, &existing.IsPinned, &existing.CreatedByUserID)
	} else {
		findErr = tx.QueryRow(ctx, `
			SELECT id::text, name, filters, is_shared, is_pinned, created_by_user_id::text
			FROM crm_customer_views
			WHERE org_id = $1::uuid AND name = $2
			FOR UPDATE`, claims.OrganizationID, input.Name).
			Scan(&existing.ID, &existing.Name, &rawFilters, &existing.IsShared, &existing.IsPinned, &existing.CreatedByUserID)
	}
	if findErr != nil && !errors.Is(findErr, pgx.ErrNoRows) {
		return SaveCustomerViewOutput{}, findErr
	}
	var previous *CustomerViewSavedSnapshot
	if findErr == nil {
		if !existing.IsShared && existing.CreatedByUserID != *claims.ActorID {
			return SaveCustomerViewOutput{}, errors.New("This private view belongs to another team member")
		}
		filters, err := parseCustomerViewFilter(rawFilters)
		if err != nil {
			return SaveCustomerViewOutput{}, err
		}
		existing.Filters = filters
		previous = &existing
		filterJSON, err := json.Marshal(input.Filters)
		if err != nil {
			return SaveCustomerViewOutput{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE crm_customer_views
			SET name = $1, filters = $2::jsonb, is_shared = $3, is_pinned = $4,
			    updated_by_user_id = $5::uuid, updated_at = $6
			WHERE id = $7::uuid AND org_id = $8::uuid`,
			input.Name, string(filterJSON), input.IsShared, input.IsPinned, *claims.ActorID, now, existing.ID, claims.OrganizationID); err != nil {
			return SaveCustomerViewOutput{}, err
		}
		return SaveCustomerViewOutput{ViewID: existing.ID, Previous: previous}, nil
	}

	var viewID string
	filterJSON, err := json.Marshal(input.Filters)
	if err != nil {
		return SaveCustomerViewOutput{}, err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO crm_customer_views (org_id, name, filters, is_shared, is_pinned, created_by_user_id, updated_by_user_id, updated_at)
		VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6::uuid, $6::uuid, $7)
		RETURNING id::text`, claims.OrganizationID, input.Name, string(filterJSON), input.IsShared, input.IsPinned, *claims.ActorID, now).Scan(&viewID); err != nil {
		return SaveCustomerViewOutput{}, err
	}
	return SaveCustomerViewOutput{ViewID: viewID, Previous: nil}, nil
}

func restoreCustomerView(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input RestoreCustomerViewInput, now time.Time) (RestoreCustomerViewOutput, error) {
	if claims.ActorType != "human" || claims.ActorID == nil || *claims.ActorID != claims.Subject {
		return RestoreCustomerViewOutput{}, errors.New("a signed-in user is required to restore a customer view")
	}
	if input.Previous == nil {
		if _, err := tx.Exec(ctx, `DELETE FROM crm_customer_views WHERE id = $1::uuid AND org_id = $2::uuid`, input.ViewID, claims.OrganizationID); err != nil {
			return RestoreCustomerViewOutput{}, err
		}
		return RestoreCustomerViewOutput{Restored: true}, nil
	}
	filterJSON, err := json.Marshal(input.Previous.Filters)
	if err != nil {
		return RestoreCustomerViewOutput{}, err
	}
	result, err := tx.Exec(ctx, `
		INSERT INTO crm_customer_views (id, org_id, name, filters, is_shared, is_pinned, created_by_user_id, updated_by_user_id, updated_at)
		VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7::uuid, $8::uuid, $9)
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name,
			filters = EXCLUDED.filters,
			is_shared = EXCLUDED.is_shared,
			is_pinned = EXCLUDED.is_pinned,
			created_by_user_id = EXCLUDED.created_by_user_id,
			updated_by_user_id = EXCLUDED.updated_by_user_id,
			updated_at = EXCLUDED.updated_at
		WHERE crm_customer_views.org_id = EXCLUDED.org_id`,
		input.Previous.ID, claims.OrganizationID, input.Previous.Name, string(filterJSON), input.Previous.IsShared,
		input.Previous.IsPinned, input.Previous.CreatedByUserID, *claims.ActorID, now)
	if err != nil {
		return RestoreCustomerViewOutput{}, err
	}
	if result.RowsAffected() == 0 {
		return RestoreCustomerViewOutput{}, errors.New("previous customer view belongs to another organization")
	}
	return RestoreCustomerViewOutput{Restored: true}, nil
}
