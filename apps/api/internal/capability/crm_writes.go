package capability

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/crm"
	"github.com/jackc/pgx/v5"
)

type CustomerMergeInput struct {
	SurvivorCustomerID  string `json:"survivorCustomerId"`
	DuplicateCustomerID string `json:"duplicateCustomerId"`
}

type CustomerMergeSnapshot struct {
	CustomerID             string   `json:"customerId"`
	Email                  *string  `json:"email"`
	Phone                  *string  `json:"phone"`
	PreferredContactMethod string   `json:"preferredContactMethod"`
	DoNotContact           bool     `json:"doNotContact"`
	ReminderOptOut         bool     `json:"reminderOptOut"`
	MarketingOptOut        bool     `json:"marketingOptOut"`
	OwnerUserID            *string  `json:"ownerUserId"`
	Tags                   []string `json:"tags"`
	Notes                  *string  `json:"notes"`
	CreditLimitMinor       *int64   `json:"creditLimitMinor"`
	PaymentTermDays        *int64   `json:"paymentTermDays"`
	DeactivatedAt          *string  `json:"deactivatedAt"`
	MergedIntoCustomerID   *string  `json:"mergedIntoCustomerId"`
	MergedAt               *string  `json:"mergedAt"`
}

type CustomerMergeSnapshotInput struct {
	SurvivorCustomerID  string                  `json:"survivorCustomerId"`
	DuplicateCustomerID string                  `json:"duplicateCustomerId"`
	Previous            []CustomerMergeSnapshot `json:"previous"`
}

type CustomerMergeOutput struct {
	SurvivorCustomerID  string                  `json:"survivorCustomerId"`
	DuplicateCustomerID string                  `json:"duplicateCustomerId"`
	Previous            []CustomerMergeSnapshot `json:"previous"`
}

type CustomerImportRow struct {
	RowNumber           int
	Name                string
	Email               *string
	EmailSet            bool
	Phone               *string
	PhoneSet            bool
	CreditLimitMinor    *int64
	CreditLimitMinorSet bool
	PaymentTermDays     *int64
	PaymentTermDaysSet  bool
	AllowDuplicate      bool
}

func (row CustomerImportRow) MarshalJSON() ([]byte, error) {
	value := map[string]any{
		"rowNumber":      row.RowNumber,
		"name":           row.Name,
		"allowDuplicate": row.AllowDuplicate,
	}
	if row.EmailSet {
		value["email"] = row.Email
	}
	if row.PhoneSet {
		value["phone"] = row.Phone
	}
	if row.CreditLimitMinorSet {
		value["creditLimitMinor"] = row.CreditLimitMinor
	}
	if row.PaymentTermDaysSet {
		value["paymentTermDays"] = row.PaymentTermDays
	}
	return json.Marshal(value)
}

type CustomerImportInput struct {
	Rows []CustomerImportRow `json:"rows"`
}

type CustomerImportOutput struct {
	CreatedIDs           []string `json:"createdIds"`
	Imported             int      `json:"imported"`
	SkippedDuplicateRows []int    `json:"skippedDuplicateRows"`
}

type CustomerIDsInput struct {
	CustomerIDs []string `json:"customerIds"`
}

type CustomerUndoImportOutput struct {
	CustomerIDs []string `json:"customerIds"`
	Deactivated int      `json:"deactivated"`
}

type CustomerRestoreImportOutput struct {
	CustomerIDs []string `json:"customerIds"`
	Restored    int      `json:"restored"`
}

func ParseCustomerMergeInput(raw json.RawMessage) (CustomerMergeInput, error) {
	fields, err := jsonObject(raw)
	if err != nil {
		return CustomerMergeInput{}, err
	}
	survivorID, survivorErr := requiredString(fields, "survivorCustomerId")
	duplicateID, duplicateErr := requiredString(fields, "duplicateCustomerId")
	if survivorErr != nil || duplicateErr != nil || !isZodUUID(survivorID) || !isZodUUID(duplicateID) {
		return CustomerMergeInput{}, errors.New("survivorCustomerId and duplicateCustomerId must be UUIDs")
	}
	if survivorID == duplicateID {
		return CustomerMergeInput{}, errors.New("Choose two different customers")
	}
	return CustomerMergeInput{SurvivorCustomerID: survivorID, DuplicateCustomerID: duplicateID}, nil
}

func ParseCustomerMergeSnapshotInput(raw json.RawMessage) (CustomerMergeSnapshotInput, error) {
	fields, err := jsonObject(raw)
	if err != nil {
		return CustomerMergeSnapshotInput{}, err
	}
	survivorID, survivorErr := requiredString(fields, "survivorCustomerId")
	duplicateID, duplicateErr := requiredString(fields, "duplicateCustomerId")
	if survivorErr != nil || duplicateErr != nil || !isZodUUID(survivorID) || !isZodUUID(duplicateID) {
		return CustomerMergeSnapshotInput{}, errors.New("survivorCustomerId and duplicateCustomerId must be UUIDs")
	}
	previousRaw, ok := fields["previous"]
	if !ok || bytesIsNull(previousRaw) {
		return CustomerMergeSnapshotInput{}, errors.New("previous must contain between 2 and 502 snapshots")
	}
	var snapshots []json.RawMessage
	if err := json.Unmarshal(previousRaw, &snapshots); err != nil || len(snapshots) < 2 || len(snapshots) > 502 {
		return CustomerMergeSnapshotInput{}, errors.New("previous must contain between 2 and 502 snapshots")
	}
	input := CustomerMergeSnapshotInput{
		SurvivorCustomerID:  survivorID,
		DuplicateCustomerID: duplicateID,
		Previous:            make([]CustomerMergeSnapshot, 0, len(snapshots)),
	}
	for _, snapshotRaw := range snapshots {
		snapshot, err := parseCustomerMergeSnapshot(snapshotRaw)
		if err != nil {
			return CustomerMergeSnapshotInput{}, err
		}
		input.Previous = append(input.Previous, snapshot)
	}
	return input, nil
}

func parseCustomerMergeSnapshot(raw json.RawMessage) (CustomerMergeSnapshot, error) {
	fields, err := jsonObject(raw)
	if err != nil {
		return CustomerMergeSnapshot{}, err
	}
	var snapshot CustomerMergeSnapshot
	customerID, err := requiredString(fields, "customerId")
	if err != nil || !isZodUUID(customerID) {
		return CustomerMergeSnapshot{}, errors.New("customerId must be a UUID")
	}
	snapshot.CustomerID = customerID
	if snapshot.Email, err = requiredNullableString(fields, "email"); err != nil {
		return CustomerMergeSnapshot{}, err
	}
	if snapshot.Phone, err = requiredNullableString(fields, "phone"); err != nil {
		return CustomerMergeSnapshot{}, err
	}
	method, err := requiredString(fields, "preferredContactMethod")
	if err != nil || !validContactMethod(method) {
		return CustomerMergeSnapshot{}, errors.New("preferredContactMethod is invalid")
	}
	snapshot.PreferredContactMethod = method
	if snapshot.DoNotContact, err = requiredBoolean(fields, "doNotContact"); err != nil {
		return CustomerMergeSnapshot{}, err
	}
	if snapshot.ReminderOptOut, err = requiredBoolean(fields, "reminderOptOut"); err != nil {
		return CustomerMergeSnapshot{}, err
	}
	if snapshot.MarketingOptOut, err = requiredBoolean(fields, "marketingOptOut"); err != nil {
		return CustomerMergeSnapshot{}, err
	}
	ownerRaw, ok := fields["ownerUserId"]
	if !ok {
		return CustomerMergeSnapshot{}, errors.New("ownerUserId is required")
	}
	if snapshot.OwnerUserID, err = readNullableUUID(ownerRaw); err != nil {
		return CustomerMergeSnapshot{}, errors.New("ownerUserId must be a UUID or null")
	}
	tagsRaw, ok := fields["tags"]
	if !ok || bytesIsNull(tagsRaw) || json.Unmarshal(tagsRaw, &snapshot.Tags) != nil || snapshot.Tags == nil {
		return CustomerMergeSnapshot{}, errors.New("tags must be an array of strings")
	}
	for _, tag := range snapshot.Tags {
		if utf16Length(tag) > 40 {
			return CustomerMergeSnapshot{}, errors.New("each tag must be at most 40 characters")
		}
	}
	if snapshot.Notes, err = requiredNullableString(fields, "notes"); err != nil {
		return CustomerMergeSnapshot{}, err
	}
	if snapshot.CreditLimitMinor, err = requiredNullableInteger(fields, "creditLimitMinor"); err != nil {
		return CustomerMergeSnapshot{}, err
	}
	if snapshot.PaymentTermDays, err = requiredNullableInteger(fields, "paymentTermDays"); err != nil {
		return CustomerMergeSnapshot{}, err
	}
	if snapshot.DeactivatedAt, err = requiredNullableString(fields, "deactivatedAt"); err != nil {
		return CustomerMergeSnapshot{}, err
	}
	mergedIntoRaw, ok := fields["mergedIntoCustomerId"]
	if !ok {
		return CustomerMergeSnapshot{}, errors.New("mergedIntoCustomerId is required")
	}
	if snapshot.MergedIntoCustomerID, err = readNullableUUID(mergedIntoRaw); err != nil {
		return CustomerMergeSnapshot{}, errors.New("mergedIntoCustomerId must be a UUID or null")
	}
	if snapshot.MergedAt, err = requiredNullableString(fields, "mergedAt"); err != nil {
		return CustomerMergeSnapshot{}, err
	}
	return snapshot, nil
}

func ParseCustomerImportInput(raw json.RawMessage) (CustomerImportInput, error) {
	fields, err := jsonObject(raw)
	if err != nil {
		return CustomerImportInput{}, err
	}
	rowsRaw, ok := fields["rows"]
	if !ok || bytesIsNull(rowsRaw) {
		return CustomerImportInput{}, errors.New("rows must contain between 1 and 5000 entries")
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(rowsRaw, &entries); err != nil || len(entries) < 1 || len(entries) > 5000 {
		return CustomerImportInput{}, errors.New("rows must contain between 1 and 5000 entries")
	}
	input := CustomerImportInput{Rows: make([]CustomerImportRow, 0, len(entries))}
	for _, entry := range entries {
		row, err := parseCustomerImportRow(entry)
		if err != nil {
			return CustomerImportInput{}, err
		}
		input.Rows = append(input.Rows, row)
	}
	return input, nil
}

func parseCustomerImportRow(raw json.RawMessage) (CustomerImportRow, error) {
	fields, err := jsonObject(raw)
	if err != nil {
		return CustomerImportRow{}, err
	}
	var row CustomerImportRow
	rowNumberRaw, ok := fields["rowNumber"]
	if !ok {
		return CustomerImportRow{}, errors.New("rowNumber must be a positive integer")
	}
	rowNumber, err := readInteger(rowNumberRaw)
	if err != nil || rowNumber < 1 || rowNumber > int64(math.MaxInt) {
		return CustomerImportRow{}, errors.New("rowNumber must be a positive integer")
	}
	row.RowNumber = int(rowNumber)
	name, err := requiredString(fields, "name")
	if err != nil {
		return CustomerImportRow{}, errors.New("name must be a non-empty string of at most 120 characters")
	}
	row.Name = strings.TrimFunc(name, isJSWhitespace)
	if utf16Length(row.Name) < 1 || utf16Length(row.Name) > 120 {
		return CustomerImportRow{}, errors.New("name must be a non-empty string of at most 120 characters")
	}
	if value, exists := fields["email"]; exists {
		row.EmailSet = true
		row.Email, err = readNullableString(value)
		if err != nil || row.Email != nil && !validCustomerEmail(*row.Email) {
			return CustomerImportRow{}, errors.New("email must be a valid email address or null")
		}
	}
	if value, exists := fields["phone"]; exists {
		row.PhoneSet = true
		row.Phone, err = readNullableString(value)
		if err != nil {
			return CustomerImportRow{}, errors.New("phone must be a string or null")
		}
		if row.Phone != nil {
			phone := strings.TrimFunc(*row.Phone, isJSWhitespace)
			if utf16Length(phone) > 40 {
				return CustomerImportRow{}, errors.New("phone must be at most 40 characters")
			}
			row.Phone = &phone
		}
	}
	if value, exists := fields["creditLimitMinor"]; exists {
		row.CreditLimitMinorSet = true
		row.CreditLimitMinor, err = readNullableInteger(value)
		if err != nil || row.CreditLimitMinor != nil && *row.CreditLimitMinor < 0 {
			return CustomerImportRow{}, errors.New("creditLimitMinor must be a non-negative integer or null")
		}
	}
	if value, exists := fields["paymentTermDays"]; exists {
		row.PaymentTermDaysSet = true
		row.PaymentTermDays, err = readNullableInteger(value)
		if err != nil || row.PaymentTermDays != nil && *row.PaymentTermDays < 0 {
			return CustomerImportRow{}, errors.New("paymentTermDays must be a non-negative integer or null")
		}
	}
	if value, exists := fields["allowDuplicate"]; exists {
		if bytesIsNull(value) || json.Unmarshal(value, &row.AllowDuplicate) != nil {
			return CustomerImportRow{}, errors.New("allowDuplicate must be a boolean")
		}
	}
	return row, nil
}

func ParseCustomerIDsInput(raw json.RawMessage) (CustomerIDsInput, error) {
	fields, err := jsonObject(raw)
	if err != nil {
		return CustomerIDsInput{}, err
	}
	idsRaw, ok := fields["customerIds"]
	if !ok || bytesIsNull(idsRaw) {
		return CustomerIDsInput{}, errors.New("customerIds must contain between 1 and 5000 UUIDs")
	}
	var ids []string
	if err := json.Unmarshal(idsRaw, &ids); err != nil || len(ids) < 1 || len(ids) > 5000 {
		return CustomerIDsInput{}, errors.New("customerIds must contain between 1 and 5000 UUIDs")
	}
	for _, id := range ids {
		if !isZodUUID(id) {
			return CustomerIDsInput{}, errors.New("customerIds must contain UUIDs")
		}
	}
	return CustomerIDsInput{CustomerIDs: ids}, nil
}

func (input CustomerMergeInput) CanonicalHash() (string, error) {
	return canonicalHash(input)
}

func (input CustomerMergeSnapshotInput) CanonicalHash() (string, error) {
	return canonicalHash(input)
}

func (input CustomerImportInput) CanonicalHash() (string, error) {
	return canonicalHash(input)
}

func (input CustomerIDsInput) CanonicalHash() (string, error) {
	return canonicalHash(input)
}

func requiredNullableString(fields map[string]json.RawMessage, key string) (*string, error) {
	value, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	result, err := readNullableString(value)
	if err != nil {
		return nil, fmt.Errorf("%s must be a string or null", key)
	}
	return result, nil
}

func requiredBoolean(fields map[string]json.RawMessage, key string) (bool, error) {
	value, ok := fields[key]
	var result bool
	if !ok || bytesIsNull(value) || json.Unmarshal(value, &result) != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return result, nil
}

func requiredNullableInteger(fields map[string]json.RawMessage, key string) (*int64, error) {
	value, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	result, err := readNullableInteger(value)
	if err != nil {
		return nil, fmt.Errorf("%s must be an integer or null", key)
	}
	return result, nil
}

func readNullableInteger(raw json.RawMessage) (*int64, error) {
	if bytesIsNull(raw) {
		return nil, nil
	}
	value, err := readInteger(raw)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func readInteger(raw json.RawMessage) (int64, error) {
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value || value < math.MinInt64 || value >= math.MaxInt64 {
		return 0, errors.New("expected an integer")
	}
	return int64(value), nil
}

func bytesIsNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

type customerMergeRecord struct {
	ID                     string
	Name                   string
	Email                  *string
	Phone                  *string
	PreferredContactMethod string
	DoNotContact           bool
	ReminderOptOut         bool
	MarketingOptOut        bool
	OwnerUserID            *string
	Tags                   []string
	Notes                  *string
	CreditLimitMinor       *int64
	PaymentTermDays        *int64
	DeactivatedAt          *time.Time
	MergedIntoCustomerID   *string
	MergedAt               *time.Time
}

func queryCustomerMergeRecords(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]customerMergeRecord, error) {
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []customerMergeRecord
	for rows.Next() {
		var row customerMergeRecord
		if err := rows.Scan(
			&row.ID, &row.Name, &row.Email, &row.Phone, &row.PreferredContactMethod,
			&row.DoNotContact, &row.ReminderOptOut, &row.MarketingOptOut, &row.OwnerUserID,
			&row.Tags, &row.Notes, &row.CreditLimitMinor, &row.PaymentTermDays,
			&row.DeactivatedAt, &row.MergedIntoCustomerID, &row.MergedAt,
		); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

const customerMergeColumns = `id::text, name, email, phone, preferred_contact_method,
	do_not_contact, reminder_opt_out, marketing_opt_out, owner_user_id::text, tags, notes,
	credit_limit_minor::bigint, payment_term_days::bigint, deactivated_at,
	merged_into_customer_id::text, merged_at`

func customerMergeSnapshot(row customerMergeRecord) CustomerMergeSnapshot {
	return CustomerMergeSnapshot{
		CustomerID:             row.ID,
		Email:                  row.Email,
		Phone:                  row.Phone,
		PreferredContactMethod: row.PreferredContactMethod,
		DoNotContact:           row.DoNotContact,
		ReminderOptOut:         row.ReminderOptOut,
		MarketingOptOut:        row.MarketingOptOut,
		OwnerUserID:            row.OwnerUserID,
		Tags:                   row.Tags,
		Notes:                  row.Notes,
		CreditLimitMinor:       row.CreditLimitMinor,
		PaymentTermDays:        row.PaymentTermDays,
		DeactivatedAt:          timeString(row.DeactivatedAt),
		MergedIntoCustomerID:   row.MergedIntoCustomerID,
		MergedAt:               timeString(row.MergedAt),
	}
}

func timeString(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
	return &formatted
}

func mergeCustomers(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CustomerMergeInput, now time.Time) (CustomerMergeOutput, error) {
	ids := []string{input.SurvivorCustomerID, input.DuplicateCustomerID}
	rows, err := queryCustomerMergeRecords(ctx, tx, `
		SELECT `+customerMergeColumns+` FROM customers
		WHERE org_id = $1::uuid AND id = ANY($2::uuid[]) FOR UPDATE`, claims.OrganizationID, ids)
	if err != nil {
		return CustomerMergeOutput{}, err
	}
	if len(rows) != 2 {
		return CustomerMergeOutput{}, errors.New("both customers must belong to this organization")
	}
	var survivor, duplicate *customerMergeRecord
	for index := range rows {
		if rows[index].ID == input.SurvivorCustomerID {
			survivor = &rows[index]
		}
		if rows[index].ID == input.DuplicateCustomerID {
			duplicate = &rows[index]
		}
	}
	if survivor == nil || duplicate == nil {
		return CustomerMergeOutput{}, errors.New("both customers must belong to this organization")
	}
	if survivor.MergedIntoCustomerID != nil {
		return CustomerMergeOutput{}, errors.New("the surviving customer was already merged; choose the current surviving record")
	}
	if duplicate.MergedIntoCustomerID != nil || duplicate.DeactivatedAt != nil {
		return CustomerMergeOutput{}, errors.New("the duplicate is inactive or already merged")
	}
	children, err := queryCustomerMergeRecords(ctx, tx, `
		SELECT `+customerMergeColumns+` FROM customers
		WHERE org_id = $1::uuid AND merged_into_customer_id = $2::uuid`, claims.OrganizationID, duplicate.ID)
	if err != nil {
		return CustomerMergeOutput{}, err
	}
	affected := make([]customerMergeRecord, 0, 2+len(children))
	affected = append(affected, *survivor, *duplicate)
	affected = append(affected, children...)
	previous := make([]CustomerMergeSnapshot, 0, len(affected))
	for _, row := range affected {
		previous = append(previous, customerMergeSnapshot(row))
	}

	tags := make([]string, 0, len(survivor.Tags)+len(duplicate.Tags))
	tags = append(tags, survivor.Tags...)
	seen := make(map[string]struct{}, len(tags)+len(duplicate.Tags))
	lower := cases.Lower(language.Und)
	for _, tag := range tags {
		seen[lower.String(strings.TrimFunc(tag, isJSWhitespace))] = struct{}{}
	}
	for _, tag := range duplicate.Tags {
		key := lower.String(strings.TrimFunc(tag, isJSWhitespace))
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		tags = append(tags, tag)
	}
	contact := survivor
	if survivor.Email == nil || *survivor.Email == "" {
		if survivor.Phone == nil || *survivor.Phone == "" {
			contact = duplicate
		}
	}
	email := survivor.Email
	if email == nil {
		email = duplicate.Email
	}
	phone := survivor.Phone
	if phone == nil {
		phone = duplicate.Phone
	}
	ownerUserID := survivor.OwnerUserID
	if ownerUserID == nil {
		ownerUserID = duplicate.OwnerUserID
	}
	creditLimit := survivor.CreditLimitMinor
	if creditLimit == nil {
		creditLimit = duplicate.CreditLimitMinor
	}
	paymentTerm := survivor.PaymentTermDays
	if paymentTerm == nil {
		paymentTerm = duplicate.PaymentTermDays
	}
	doNotContact := survivor.DoNotContact || duplicate.DoNotContact
	reminderOptOut := survivor.ReminderOptOut || duplicate.ReminderOptOut
	marketingOptOut := survivor.MarketingOptOut || duplicate.MarketingOptOut
	updatedBy := humanActorID(claims)
	if _, err := tx.Exec(ctx, `
		UPDATE customers SET email = $1, phone = $2, preferred_contact_method = $3,
			owner_user_id = $4::uuid, tags = $5::text[], do_not_contact = $6,
			reminder_opt_out = $7, marketing_opt_out = $8, credit_limit_minor = $9::integer,
			payment_term_days = $10::integer, updated_by_user_id = $11::uuid, updated_at = $12
		WHERE org_id = $13::uuid AND id = $14::uuid`,
		email, phone, contact.PreferredContactMethod, ownerUserID, tags, doNotContact,
		reminderOptOut, marketingOptOut, creditLimit, paymentTerm, updatedBy, now,
		claims.OrganizationID, survivor.ID); err != nil {
		return CustomerMergeOutput{}, err
	}
	mergedIDs := make([]string, 0, 1+len(children))
	mergedIDs = append(mergedIDs, duplicate.ID)
	for _, child := range children {
		mergedIDs = append(mergedIDs, child.ID)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE customers SET merged_into_customer_id = $1::uuid, merged_at = $2,
			deactivated_at = $2, updated_by_user_id = $3::uuid, updated_at = $2
		WHERE org_id = $4::uuid AND id = ANY($5::uuid[])`,
		survivor.ID, now, updatedBy, claims.OrganizationID, mergedIDs); err != nil {
		return CustomerMergeOutput{}, err
	}
	return CustomerMergeOutput{SurvivorCustomerID: survivor.ID, DuplicateCustomerID: duplicate.ID, Previous: previous}, nil
}

func restoreCustomerMerge(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CustomerMergeSnapshotInput, now time.Time) (CustomerMergeOutput, error) {
	ids := make([]string, 0, len(input.Previous))
	for _, snapshot := range input.Previous {
		ids = append(ids, snapshot.CustomerID)
	}
	rows, err := queryCustomerMergeRecords(ctx, tx, `
		SELECT `+customerMergeColumns+` FROM customers
		WHERE org_id = $1::uuid AND id = ANY($2::uuid[]) FOR UPDATE`, claims.OrganizationID, ids)
	if err != nil {
		return CustomerMergeOutput{}, err
	}
	if len(rows) != len(ids) {
		return CustomerMergeOutput{}, errors.New("a merged customer record is no longer available to restore")
	}
	current := make([]CustomerMergeSnapshot, 0, len(rows))
	for _, row := range rows {
		current = append(current, customerMergeSnapshot(row))
	}
	updatedBy := humanActorID(claims)
	for _, snapshot := range input.Previous {
		deactivatedAt := legacySnapshotTime(snapshot.DeactivatedAt)
		mergedAt := legacySnapshotTime(snapshot.MergedAt)
		if _, err := tx.Exec(ctx, `
			UPDATE customers SET email = $1, phone = $2, preferred_contact_method = $3,
				do_not_contact = $4, reminder_opt_out = $5, marketing_opt_out = $6,
				owner_user_id = $7::uuid, tags = $8::text[], notes = $9,
				credit_limit_minor = $10::integer, payment_term_days = $11::integer,
				deactivated_at = $12::text::timestamptz, merged_into_customer_id = $13::uuid,
				merged_at = $14::text::timestamptz,
				updated_by_user_id = $15::uuid, updated_at = $16
			WHERE org_id = $17::uuid AND id = $18::uuid`,
			snapshot.Email, snapshot.Phone, snapshot.PreferredContactMethod,
			snapshot.DoNotContact, snapshot.ReminderOptOut, snapshot.MarketingOptOut,
			snapshot.OwnerUserID, snapshot.Tags, snapshot.Notes, snapshot.CreditLimitMinor,
			snapshot.PaymentTermDays, deactivatedAt, snapshot.MergedIntoCustomerID, mergedAt,
			updatedBy, now, claims.OrganizationID, snapshot.CustomerID); err != nil {
			return CustomerMergeOutput{}, err
		}
	}
	return CustomerMergeOutput{
		SurvivorCustomerID:  input.SurvivorCustomerID,
		DuplicateCustomerID: input.DuplicateCustomerID,
		Previous:            current,
	}, nil
}

func legacySnapshotTime(value *string) *string {
	if value == nil {
		return nil
	}
	layouts := []string{
		time.RFC3339Nano,
		"2006-01-02",
		"2006-01-02 15:04:05.999999999Z07:00",
		"Mon, 02 Jan 2006 15:04:05 MST",
	}
	for _, layout := range layouts {
		parsed, err := time.Parse(layout, *value)
		if err == nil {
			formatted := parsed.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
			return &formatted
		}
	}
	return value
}

type customerImportInsert struct {
	ID                     string
	OrgID                  string
	Name                   string
	Email                  *string
	Phone                  *string
	CreditLimitMinor       *int64
	PaymentTermDays        *int64
	PreferredContactMethod string
	UpdatedByUserID        *string
}

func importCustomers(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CustomerImportInput) (CustomerImportOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT name, email, phone FROM customers
		WHERE org_id = $1::uuid AND deactivated_at IS NULL`, claims.OrganizationID)
	if err != nil {
		return CustomerImportOutput{}, err
	}
	fingerprints := make([]crm.CustomerFingerprint, 0)
	for rows.Next() {
		var fingerprint crm.CustomerFingerprint
		if err := rows.Scan(&fingerprint.Name, &fingerprint.Email, &fingerprint.Phone); err != nil {
			rows.Close()
			return CustomerImportOutput{}, err
		}
		fingerprints = append(fingerprints, fingerprint)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return CustomerImportOutput{}, err
	}
	rows.Close()
	created := make([]customerImportInsert, 0, len(input.Rows))
	skipped := make([]int, 0)
	updatedBy := humanActorID(claims)
	for _, row := range input.Rows {
		verdict := crm.FindDuplicate(fingerprints, crm.CustomerFingerprint{Name: row.Name, Email: row.Email, Phone: row.Phone})
		if verdict.Duplicate && !row.AllowDuplicate {
			skipped = append(skipped, row.RowNumber)
			continue
		}
		fingerprints = append(fingerprints, crm.CustomerFingerprint{Name: row.Name, Email: row.Email, Phone: row.Phone})
		id, err := newCustomerUUID()
		if err != nil {
			return CustomerImportOutput{}, err
		}
		method := "phone"
		if row.Email != nil && *row.Email != "" {
			method = "email"
		}
		created = append(created, customerImportInsert{
			ID: id, OrgID: claims.OrganizationID, Name: row.Name, Email: row.Email, Phone: row.Phone,
			CreditLimitMinor: row.CreditLimitMinor, PaymentTermDays: row.PaymentTermDays,
			PreferredContactMethod: method, UpdatedByUserID: updatedBy,
		})
	}
	for offset := 0; offset < len(created); offset += 500 {
		end := min(offset+500, len(created))
		if err := insertCustomerImportBatch(ctx, tx, created[offset:end]); err != nil {
			return CustomerImportOutput{}, err
		}
	}
	createdIDs := make([]string, 0, len(created))
	for _, row := range created {
		createdIDs = append(createdIDs, row.ID)
	}
	return CustomerImportOutput{CreatedIDs: createdIDs, Imported: len(createdIDs), SkippedDuplicateRows: skipped}, nil
}

func insertCustomerImportBatch(ctx context.Context, tx pgx.Tx, batch []customerImportInsert) error {
	if len(batch) == 0 {
		return nil
	}
	var query strings.Builder
	query.WriteString(`INSERT INTO customers
		(id, org_id, name, email, phone, credit_limit_minor, payment_term_days, preferred_contact_method, updated_by_user_id)
		VALUES `)
	args := make([]any, 0, len(batch)*9)
	for index, row := range batch {
		if index > 0 {
			query.WriteByte(',')
		}
		base := index*9 + 1
		fmt.Fprintf(&query, "($%d::uuid,$%d::uuid,$%d,$%d,$%d,$%d::integer,$%d::integer,$%d,$%d::uuid)",
			base, base+1, base+2, base+3, base+4, base+5, base+6, base+7, base+8)
		args = append(args, row.ID, row.OrgID, row.Name, row.Email, row.Phone, row.CreditLimitMinor, row.PaymentTermDays, row.PreferredContactMethod, row.UpdatedByUserID)
	}
	_, err := tx.Exec(ctx, query.String(), args...)
	return err
}

func toggleImportedCustomers(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CustomerIDsInput, now time.Time, restore bool) (any, error) {
	ids := dedupeCustomerIDs(input.CustomerIDs)
	updatedBy := humanActorID(claims)
	var rows pgx.Rows
	var err error
	if restore {
		rows, err = tx.Query(ctx, `
			UPDATE customers SET deactivated_at = NULL, updated_by_user_id = $1::uuid, updated_at = $2
			WHERE org_id = $3::uuid AND id = ANY($4::uuid[]) AND deactivated_at IS NOT NULL
			RETURNING id::text`, updatedBy, now, claims.OrganizationID, ids)
	} else {
		rows, err = tx.Query(ctx, `
			UPDATE customers SET deactivated_at = $1, updated_by_user_id = $2::uuid, updated_at = $1
			WHERE org_id = $3::uuid AND id = ANY($4::uuid[]) AND deactivated_at IS NULL
			RETURNING id::text`, now, updatedBy, claims.OrganizationID, ids)
	}
	if err != nil {
		return nil, err
	}
	changedIDs := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		changedIDs = append(changedIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if restore {
		return CustomerRestoreImportOutput{CustomerIDs: changedIDs, Restored: len(changedIDs)}, nil
	}
	return CustomerUndoImportOutput{CustomerIDs: changedIDs, Deactivated: len(changedIDs)}, nil
}

func dedupeCustomerIDs(input []string) []string {
	ids := make([]string, 0, len(input))
	seen := make(map[string]struct{}, len(input))
	for _, id := range input {
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids
}

func humanActorID(claims authbridge.CapabilityClaims) *string {
	if claims.ActorType != "human" {
		return nil
	}
	return claims.ActorID
}

func newCustomerUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := make([]byte, 36)
	hex.Encode(encoded[0:8], value[0:4])
	encoded[8] = '-'
	hex.Encode(encoded[9:13], value[4:6])
	encoded[13] = '-'
	hex.Encode(encoded[14:18], value[6:8])
	encoded[18] = '-'
	hex.Encode(encoded[19:23], value[8:10])
	encoded[23] = '-'
	hex.Encode(encoded[24:36], value[10:16])
	return string(encoded), nil
}

func executeCustomerMergeCapability(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, capabilityID string, input any, now time.Time) (any, error) {
	switch capabilityID {
	case mergeCustomersCapabilityID:
		parsed, ok := input.(CustomerMergeInput)
		if !ok {
			return nil, errors.New("invalid merge customer input")
		}
		return mergeCustomers(ctx, tx, claims, parsed, now)
	case restoreCustomerMergeCapabilityID:
		parsed, ok := input.(CustomerMergeSnapshotInput)
		if !ok {
			return nil, errors.New("invalid restore customer merge input")
		}
		return restoreCustomerMerge(ctx, tx, claims, parsed, now)
	case importCustomersCapabilityID:
		parsed, ok := input.(CustomerImportInput)
		if !ok {
			return nil, errors.New("invalid import customer input")
		}
		return importCustomers(ctx, tx, claims, parsed)
	case undoCustomerImportCapabilityID:
		parsed, ok := input.(CustomerIDsInput)
		if !ok {
			return nil, errors.New("invalid undo customer import input")
		}
		return toggleImportedCustomers(ctx, tx, claims, parsed, now, false)
	case restoreImportedCustomersCapabilityID:
		parsed, ok := input.(CustomerIDsInput)
		if !ok {
			return nil, errors.New("invalid restore imported customer input")
		}
		return toggleImportedCustomers(ctx, tx, claims, parsed, now, true)
	default:
		return nil, errors.New("unsupported CRM capability input")
	}
}
