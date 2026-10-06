package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

var errCustomerProfileOwnerNotMember = errors.New("the selected owner is not a member of this organization")

type CustomerProfileUpdateInput struct {
	CustomerIDs            []string
	Name                   string
	NameSet                bool
	OwnerUserID            *string
	OwnerUserIDSet         bool
	AddTags                []string
	AddTagsSet             bool
	RemoveTags             []string
	RemoveTagsSet          bool
	Notes                  *string
	NotesSet               bool
	Phone                  *string
	PhoneSet               bool
	PreferredContactMethod string
	PreferredContactSet    bool
	DoNotContact           bool
	DoNotContactSet        bool
}

func (input CustomerProfileUpdateInput) MarshalJSON() ([]byte, error) {
	value := map[string]any{"customerIds": input.CustomerIDs}
	if input.NameSet {
		value["name"] = input.Name
	}
	if input.OwnerUserIDSet {
		value["ownerUserId"] = input.OwnerUserID
	}
	if input.AddTagsSet {
		value["addTags"] = input.AddTags
	}
	if input.RemoveTagsSet {
		value["removeTags"] = input.RemoveTags
	}
	if input.NotesSet {
		value["notes"] = input.Notes
	}
	if input.PhoneSet {
		value["phone"] = input.Phone
	}
	if input.PreferredContactSet {
		value["preferredContactMethod"] = input.PreferredContactMethod
	}
	if input.DoNotContactSet {
		value["doNotContact"] = input.DoNotContact
	}
	return json.Marshal(value)
}

type CustomerProfileSnapshot struct {
	CustomerID             string   `json:"customerId"`
	Name                   *string  `json:"name,omitempty"`
	OwnerUserID            *string  `json:"ownerUserId"`
	Tags                   []string `json:"tags"`
	Notes                  *string  `json:"notes"`
	Phone                  *string  `json:"phone"`
	PreferredContactMethod string   `json:"preferredContactMethod"`
	DoNotContact           bool     `json:"doNotContact"`
}

type CustomerProfileSnapshotsInput struct {
	Profiles []CustomerProfileSnapshot `json:"profiles"`
}

type CustomerProfileUpdateOutput struct {
	UpdatedCount int                       `json:"updatedCount"`
	Previous     []CustomerProfileSnapshot `json:"previous"`
}

func ParseCustomerProfileUpdateInput(raw json.RawMessage) (CustomerProfileUpdateInput, error) {
	fields, err := jsonObject(raw)
	if err != nil {
		return CustomerProfileUpdateInput{}, err
	}
	var input CustomerProfileUpdateInput

	customerIDsRaw, ok := fields["customerIds"]
	if !ok || bytes.Equal(bytes.TrimSpace(customerIDsRaw), []byte("null")) || json.Unmarshal(customerIDsRaw, &input.CustomerIDs) != nil || len(input.CustomerIDs) < 1 || len(input.CustomerIDs) > 100 {
		return CustomerProfileUpdateInput{}, errors.New("customerIds must contain between 1 and 100 UUIDs")
	}
	seenCustomerIDs := make(map[string]struct{}, len(input.CustomerIDs))
	for _, id := range input.CustomerIDs {
		if !isZodUUID(id) {
			return CustomerProfileUpdateInput{}, errors.New("customerIds must contain UUIDs")
		}
		canonicalID := strings.ToLower(id)
		if _, exists := seenCustomerIDs[canonicalID]; exists {
			return CustomerProfileUpdateInput{}, errors.New("customerIds must not contain duplicates")
		}
		seenCustomerIDs[canonicalID] = struct{}{}
	}

	if value, exists := fields["name"]; exists {
		name, err := readOptionalString(value)
		if err != nil {
			return CustomerProfileUpdateInput{}, errors.New("name must be a string")
		}
		input.Name = strings.TrimFunc(*name, isJSWhitespace)
		if utf16Length(input.Name) < 1 || utf16Length(input.Name) > 120 {
			return CustomerProfileUpdateInput{}, errors.New("name must be between 1 and 120 characters")
		}
		input.NameSet = true
		if len(input.CustomerIDs) != 1 {
			return CustomerProfileUpdateInput{}, errors.New("a customer name can only be changed on one record at a time")
		}
	}
	if value, exists := fields["ownerUserId"]; exists {
		owner, err := readNullableUUID(value)
		if err != nil {
			return CustomerProfileUpdateInput{}, errors.New("ownerUserId must be a UUID or null")
		}
		input.OwnerUserID = owner
		input.OwnerUserIDSet = true
	}
	if value, exists := fields["addTags"]; exists {
		tags, err := parseCustomerTags(value, 20, true)
		if err != nil {
			return CustomerProfileUpdateInput{}, fmt.Errorf("addTags: %w", err)
		}
		input.AddTags = tags
		input.AddTagsSet = true
	}
	if value, exists := fields["removeTags"]; exists {
		tags, err := parseCustomerTags(value, 20, true)
		if err != nil {
			return CustomerProfileUpdateInput{}, fmt.Errorf("removeTags: %w", err)
		}
		input.RemoveTags = tags
		input.RemoveTagsSet = true
	}
	if value, exists := fields["notes"]; exists {
		notes, err := readNullableString(value)
		if err != nil || notes != nil && utf16Length(*notes) > 4000 {
			return CustomerProfileUpdateInput{}, errors.New("notes must be a string of at most 4000 characters or null")
		}
		input.Notes = notes
		input.NotesSet = true
	}
	if value, exists := fields["phone"]; exists {
		phone, err := readNullableString(value)
		if err != nil {
			return CustomerProfileUpdateInput{}, errors.New("phone must be a string or null")
		}
		if phone != nil {
			trimmed := strings.TrimFunc(*phone, isJSWhitespace)
			if utf16Length(trimmed) > 40 {
				return CustomerProfileUpdateInput{}, errors.New("phone must be at most 40 characters")
			}
			phone = &trimmed
		}
		input.Phone = phone
		input.PhoneSet = true
	}
	if value, exists := fields["preferredContactMethod"]; exists {
		method, err := readOptionalString(value)
		if err != nil || !validContactMethod(*method) {
			return CustomerProfileUpdateInput{}, errors.New("preferredContactMethod is invalid")
		}
		input.PreferredContactMethod = *method
		input.PreferredContactSet = true
	}
	if value, exists := fields["doNotContact"]; exists {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &input.DoNotContact) != nil {
			return CustomerProfileUpdateInput{}, errors.New("doNotContact must be a boolean")
		}
		input.DoNotContactSet = true
	}
	if !input.NameSet && !input.OwnerUserIDSet && !input.NotesSet && !input.PhoneSet && !input.PreferredContactSet && !input.DoNotContactSet && len(input.AddTags) == 0 && len(input.RemoveTags) == 0 {
		return CustomerProfileUpdateInput{}, errors.New("provide at least one profile change")
	}
	return input, nil
}

func ParseCustomerProfileSnapshotsInput(raw json.RawMessage) (CustomerProfileSnapshotsInput, error) {
	fields, err := jsonObject(raw)
	if err != nil {
		return CustomerProfileSnapshotsInput{}, err
	}
	profilesRaw, ok := fields["profiles"]
	if !ok || bytes.Equal(bytes.TrimSpace(profilesRaw), []byte("null")) {
		return CustomerProfileSnapshotsInput{}, errors.New("profiles must be an array")
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(profilesRaw, &entries); err != nil || len(entries) < 1 || len(entries) > 100 {
		return CustomerProfileSnapshotsInput{}, errors.New("profiles must contain between 1 and 100 snapshots")
	}
	input := CustomerProfileSnapshotsInput{Profiles: make([]CustomerProfileSnapshot, 0, len(entries))}
	seenCustomerIDs := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		profile, err := parseCustomerProfileSnapshot(entry)
		if err != nil {
			return CustomerProfileSnapshotsInput{}, err
		}
		canonicalID := strings.ToLower(profile.CustomerID)
		if _, exists := seenCustomerIDs[canonicalID]; exists {
			return CustomerProfileSnapshotsInput{}, errors.New("profiles must not contain duplicate customers")
		}
		seenCustomerIDs[canonicalID] = struct{}{}
		input.Profiles = append(input.Profiles, profile)
	}
	return input, nil
}

func parseCustomerProfileSnapshot(raw json.RawMessage) (CustomerProfileSnapshot, error) {
	fields, err := jsonObject(raw)
	if err != nil {
		return CustomerProfileSnapshot{}, err
	}
	var profile CustomerProfileSnapshot
	customerID, err := requiredString(fields, "customerId")
	if err != nil || !isZodUUID(customerID) {
		return CustomerProfileSnapshot{}, errors.New("customerId must be a UUID")
	}
	profile.CustomerID = customerID
	if value, exists := fields["name"]; exists {
		name, err := readOptionalString(value)
		if err != nil || utf16Length(*name) < 1 || utf16Length(*name) > 120 {
			return CustomerProfileSnapshot{}, errors.New("name must be between 1 and 120 characters")
		}
		profile.Name = name
	}
	ownerRaw, ok := fields["ownerUserId"]
	if !ok {
		return CustomerProfileSnapshot{}, errors.New("ownerUserId is required")
	}
	profile.OwnerUserID, err = readNullableUUID(ownerRaw)
	if err != nil {
		return CustomerProfileSnapshot{}, errors.New("ownerUserId must be a UUID or null")
	}
	tagsRaw, ok := fields["tags"]
	if !ok {
		return CustomerProfileSnapshot{}, errors.New("tags is required")
	}
	profile.Tags, err = parseCustomerTags(tagsRaw, 0, false)
	if err != nil {
		return CustomerProfileSnapshot{}, fmt.Errorf("tags: %w", err)
	}
	if value, ok := fields["notes"]; !ok {
		return CustomerProfileSnapshot{}, errors.New("notes is required")
	} else {
		profile.Notes, err = readNullableString(value)
		if err != nil {
			return CustomerProfileSnapshot{}, errors.New("notes must be a string or null")
		}
	}
	if value, ok := fields["phone"]; !ok {
		return CustomerProfileSnapshot{}, errors.New("phone is required")
	} else {
		profile.Phone, err = readNullableString(value)
		if err != nil {
			return CustomerProfileSnapshot{}, errors.New("phone must be a string or null")
		}
	}
	method, err := requiredString(fields, "preferredContactMethod")
	if err != nil || !validContactMethod(method) {
		return CustomerProfileSnapshot{}, errors.New("preferredContactMethod is invalid")
	}
	profile.PreferredContactMethod = method
	value, ok := fields["doNotContact"]
	if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &profile.DoNotContact) != nil {
		return CustomerProfileSnapshot{}, errors.New("doNotContact must be a boolean")
	}
	return profile, nil
}

func parseCustomerTags(raw json.RawMessage, maximum int, trim bool) ([]string, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, errors.New("must be an array")
	}
	var tags []string
	if err := json.Unmarshal(raw, &tags); err != nil || tags == nil {
		return nil, errors.New("must be an array of strings")
	}
	if maximum > 0 && len(tags) > maximum {
		return nil, fmt.Errorf("must contain at most %d items", maximum)
	}
	for index, tag := range tags {
		if trim {
			tag = strings.TrimFunc(tag, isJSWhitespace)
		}
		if utf16Length(tag) > 40 || trim && utf16Length(tag) < 1 {
			return nil, errors.New("tags must be at most 40 characters and updated tags cannot be empty")
		}
		tags[index] = tag
	}
	return tags, nil
}

func jsonObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, errors.New("expected an object")
	}
	return fields, nil
}

func requiredString(fields map[string]json.RawMessage, key string) (string, error) {
	value, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return "", fmt.Errorf("%s is required", key)
	}
	var result string
	if err := json.Unmarshal(value, &result); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return result, nil
}

func readNullableString(raw json.RawMessage) (*string, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func readNullableUUID(raw json.RawMessage) (*string, error) {
	value, err := readNullableString(raw)
	if err != nil || value != nil && !isZodUUID(*value) {
		return nil, errors.New("invalid UUID")
	}
	return value, nil
}

func validContactMethod(value string) bool {
	switch value {
	case "email", "phone", "whatsapp", "other":
		return true
	default:
		return false
	}
}

func isZodUUID(value string) bool {
	if !isUUID(value) {
		return false
	}
	if value == "00000000-0000-0000-0000-000000000000" || strings.EqualFold(value, "ffffffff-ffff-ffff-ffff-ffffffffffff") {
		return true
	}
	return strings.ContainsRune("12345678", rune(value[14])) && strings.ContainsRune("89abcdef", rune(strings.ToLower(value)[19]))
}

func (input CustomerProfileUpdateInput) CanonicalHash() (string, error) {
	return canonicalHash(input)
}

func (input CustomerProfileSnapshotsInput) CanonicalHash() (string, error) {
	return canonicalHash(input)
}

func updateCustomerProfiles(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CustomerProfileUpdateInput, now time.Time) (CustomerProfileUpdateOutput, error) {
	if input.OwnerUserIDSet && input.OwnerUserID != nil {
		if err := requireOrganizationOwners(ctx, tx, claims.OrganizationID, []string{*input.OwnerUserID}); err != nil {
			return CustomerProfileUpdateOutput{}, err
		}
	}
	ids := uniqueStrings(input.CustomerIDs)
	rows, err := selectCustomerProfiles(ctx, tx, claims.OrganizationID, ids)
	if err != nil {
		return CustomerProfileUpdateOutput{}, err
	}
	if len(rows) != len(ids) {
		return CustomerProfileUpdateOutput{}, errors.New("one or more customers were not found in this organization")
	}
	previous := make([]CustomerProfileSnapshot, len(rows))
	for index, row := range rows {
		previous[index] = row.snapshot()
	}
	caseFolder := cases.Lower(language.Und)
	for _, row := range rows {
		tags := updateTags(row.Tags, input, caseFolder)
		changes := CustomerProfileChanges{
			Name:                   optionalName(input.Name, input.NameSet),
			OwnerUserID:            input.OwnerUserID,
			OwnerUserIDSet:         input.OwnerUserIDSet,
			Tags:                   tags,
			Notes:                  input.Notes,
			NotesSet:               input.NotesSet,
			Phone:                  input.Phone,
			PhoneSet:               input.PhoneSet,
			PreferredContactMethod: input.PreferredContactMethod,
			PreferredContactSet:    input.PreferredContactSet,
			DoNotContact:           input.DoNotContact,
			DoNotContactSet:        input.DoNotContactSet,
		}
		if err := updateCustomerProfileRow(ctx, tx, claims, row.CustomerID, changes, now); err != nil {
			return CustomerProfileUpdateOutput{}, err
		}
	}
	return CustomerProfileUpdateOutput{UpdatedCount: len(rows), Previous: previous}, nil
}

func applyCustomerProfileSnapshots(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CustomerProfileSnapshotsInput, now time.Time) (CustomerProfileUpdateOutput, error) {
	owners := make([]string, 0, len(input.Profiles))
	for _, profile := range input.Profiles {
		if profile.OwnerUserID != nil {
			owners = append(owners, *profile.OwnerUserID)
		}
	}
	owners = uniqueStrings(owners)
	if len(owners) > 0 {
		if err := requireOrganizationOwners(ctx, tx, claims.OrganizationID, owners); err != nil {
			if errors.Is(err, errCustomerProfileOwnerNotMember) {
				return CustomerProfileUpdateOutput{}, errors.New("a previous owner is no longer a member of this organization")
			}
			return CustomerProfileUpdateOutput{}, err
		}
	}
	ids := make([]string, 0, len(input.Profiles))
	for _, profile := range input.Profiles {
		ids = append(ids, profile.CustomerID)
	}
	ids = uniqueStrings(ids)
	rows, err := selectCustomerProfiles(ctx, tx, claims.OrganizationID, ids)
	if err != nil {
		return CustomerProfileUpdateOutput{}, err
	}
	if len(rows) != len(ids) {
		return CustomerProfileUpdateOutput{}, errors.New("one or more customers were not found in this organization")
	}
	previous := make([]CustomerProfileSnapshot, len(rows))
	for index, row := range rows {
		previous[index] = row.snapshot()
	}
	for _, profile := range input.Profiles {
		changes := CustomerProfileChanges{
			Name:                   profile.Name,
			OwnerUserID:            profile.OwnerUserID,
			OwnerUserIDSet:         true,
			Tags:                   profile.Tags,
			Notes:                  profile.Notes,
			NotesSet:               true,
			Phone:                  profile.Phone,
			PhoneSet:               true,
			PreferredContactMethod: profile.PreferredContactMethod,
			PreferredContactSet:    true,
			DoNotContact:           profile.DoNotContact,
			DoNotContactSet:        true,
		}
		if err := updateCustomerProfileRow(ctx, tx, claims, profile.CustomerID, changes, now); err != nil {
			return CustomerProfileUpdateOutput{}, err
		}
	}
	return CustomerProfileUpdateOutput{UpdatedCount: len(input.Profiles), Previous: previous}, nil
}

type customerProfileRow struct {
	CustomerID             string
	Name                   string
	OwnerUserID            *string
	Tags                   []string
	Notes                  *string
	Phone                  *string
	PreferredContactMethod string
	DoNotContact           bool
}

func (row customerProfileRow) snapshot() CustomerProfileSnapshot {
	return CustomerProfileSnapshot{
		CustomerID:             row.CustomerID,
		Name:                   stringPointer(row.Name),
		OwnerUserID:            row.OwnerUserID,
		Tags:                   append([]string{}, row.Tags...),
		Notes:                  row.Notes,
		Phone:                  row.Phone,
		PreferredContactMethod: row.PreferredContactMethod,
		DoNotContact:           row.DoNotContact,
	}
}

func selectCustomerProfiles(ctx context.Context, tx pgx.Tx, orgID string, ids []string) ([]customerProfileRow, error) {
	arguments := []any{orgID}
	placeholders := make([]string, len(ids))
	for index, id := range ids {
		arguments = append(arguments, id)
		placeholders[index] = fmt.Sprintf("$%d::uuid", index+2)
	}
	query := `SELECT id::text, name, owner_user_id::text, tags, notes, phone, preferred_contact_method, do_not_contact FROM customers WHERE org_id = $1::uuid AND id IN (` + strings.Join(placeholders, ",") + ") ORDER BY id FOR UPDATE"
	rows, err := tx.Query(ctx, query, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []customerProfileRow
	for rows.Next() {
		var row customerProfileRow
		if err := rows.Scan(&row.CustomerID, &row.Name, &row.OwnerUserID, &row.Tags, &row.Notes, &row.Phone, &row.PreferredContactMethod, &row.DoNotContact); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func requireOrganizationOwners(ctx context.Context, tx pgx.Tx, orgID string, owners []string) error {
	if len(owners) == 0 {
		return nil
	}
	arguments := []any{orgID}
	placeholders := make([]string, len(owners))
	for index, owner := range owners {
		arguments = append(arguments, owner)
		placeholders[index] = fmt.Sprintf("$%d::uuid", index+2)
	}
	query := `SELECT user_id::text FROM memberships WHERE org_id = $1::uuid AND user_id IN (` + strings.Join(placeholders, ",") + ") ORDER BY user_id FOR KEY SHARE"
	rows, err := tx.Query(ctx, query, arguments...)
	if err != nil {
		return err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var ownerID string
		if err := rows.Scan(&ownerID); err != nil {
			return err
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if count != len(owners) {
		return errCustomerProfileOwnerNotMember
	}
	return nil
}

type CustomerProfileChanges struct {
	Name                   *string
	OwnerUserID            *string
	OwnerUserIDSet         bool
	Tags                   []string
	Notes                  *string
	NotesSet               bool
	Phone                  *string
	PhoneSet               bool
	PreferredContactMethod string
	PreferredContactSet    bool
	DoNotContact           bool
	DoNotContactSet        bool
}

func updateCustomerProfileRow(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, customerID string, changes CustomerProfileChanges, now time.Time) error {
	var updatedByUserID *string
	if claims.ActorType == "human" {
		updatedByUserID = claims.ActorID
	}
	result, err := tx.Exec(ctx, `
		UPDATE customers SET
			name = CASE WHEN $1::boolean THEN $2::text ELSE name END,
			owner_user_id = CASE WHEN $3::boolean THEN $4::uuid ELSE owner_user_id END,
			tags = $5::text[],
			notes = CASE WHEN $6::boolean THEN $7::text ELSE notes END,
			phone = CASE WHEN $8::boolean THEN $9::text ELSE phone END,
			preferred_contact_method = CASE WHEN $10::boolean THEN $11::text ELSE preferred_contact_method END,
			do_not_contact = CASE WHEN $12::boolean THEN $13::boolean ELSE do_not_contact END,
			updated_by_user_id = $14::uuid, updated_at = $15
		WHERE org_id = $16::uuid AND id = $17::uuid`,
		changes.Name != nil, changes.Name, changes.OwnerUserIDSet, changes.OwnerUserID, changes.Tags,
		changes.NotesSet, changes.Notes, changes.PhoneSet, changes.Phone,
		changes.PreferredContactSet, changes.PreferredContactMethod,
		changes.DoNotContactSet, changes.DoNotContact, updatedByUserID, now,
		claims.OrganizationID, customerID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("customer profile changed while applying the update")
	}
	return nil
}

func updateTags(existing []string, input CustomerProfileUpdateInput, fold cases.Caser) []string {
	remove := make(map[string]struct{}, len(input.RemoveTags))
	for _, tag := range input.RemoveTags {
		remove[fold.String(tag)] = struct{}{}
	}
	result := make([]string, 0, len(existing)+len(input.AddTags))
	seen := make(map[string]struct{}, len(existing)+len(input.AddTags))
	for _, tag := range existing {
		key := fold.String(tag)
		if _, removed := remove[key]; removed {
			continue
		}
		result = append(result, tag)
		seen[key] = struct{}{}
	}
	for _, tag := range input.AddTags {
		key := fold.String(tag)
		if _, exists := seen[key]; exists {
			continue
		}
		result = append(result, tag)
		seen[key] = struct{}{}
	}
	return result
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func stringPointer(value string) *string { return &value }

func optionalName(value string, set bool) *string {
	if !set {
		return nil
	}
	return &value
}
