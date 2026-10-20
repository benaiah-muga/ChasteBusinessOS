package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	upsertOperationalRecordCapabilityID = "operations.upsertRecord"
	getOperationalRecordCapabilityID    = "operations.getRecord"
	listOperationalRecordsCapabilityID  = "operations.listRecords"
)

type UpsertOperationalRecordInput struct {
	Kind         string          `json:"kind"`
	StableKey    string          `json:"stableKey"`
	Status       string          `json:"status"`
	Title        string          `json:"title"`
	Summary      *string         `json:"summary,omitempty"`
	Details      json.RawMessage `json:"details,omitempty"`
	AuthorityRef *string         `json:"authorityRef,omitempty"`
	ApprovalID   *string         `json:"approvalId,omitempty"`
	OwnerUserID  *string         `json:"ownerUserId,omitempty"`
}

type OperationalRecord struct {
	ID           string           `json:"id"`
	Kind         string           `json:"kind"`
	StableKey    string           `json:"stableKey"`
	Status       string           `json:"status"`
	Title        string           `json:"title"`
	Summary      *string          `json:"summary"`
	Details      json.RawMessage  `json:"details"`
	Revision     int              `json:"revision"`
	AuthorityRef *string          `json:"authorityRef"`
	ApprovalID   *string          `json:"approvalId"`
	OwnerUserID  *string          `json:"ownerUserId"`
	CreatedAt    string           `json:"createdAt"`
	UpdatedAt    string           `json:"updatedAt"`
	ResolvedAt   *string          `json:"resolvedAt"`
	Card         *OperationalCard `json:"card,omitempty"`
}

type OperationalCard struct {
	Kind     string          `json:"kind"`
	Title    string          `json:"title"`
	Status   string          `json:"status"`
	Severity string          `json:"severity,omitempty"`
	Summary  string          `json:"summary,omitempty"`
	Next     string          `json:"next,omitempty"`
	Evidence json.RawMessage `json:"evidence,omitempty"`
}

type GetOperationalRecordInput struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	StableKey string `json:"stableKey"`
}

type ListOperationalRecordsInput struct {
	Kind   string `json:"kind"`
	Status string `json:"status"`
	Limit  int    `json:"limit"`
}

type ListOperationalRecordsOutput struct {
	Records []OperationalRecord `json:"records"`
}

func ParseUpsertOperationalRecordInput(raw json.RawMessage) (UpsertOperationalRecordInput, error) {
	var input UpsertOperationalRecordInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return UpsertOperationalRecordInput{}, err
	}
	input.Kind = strings.TrimSpace(input.Kind)
	input.StableKey = strings.TrimSpace(input.StableKey)
	input.Status = strings.TrimSpace(input.Status)
	input.Title = strings.TrimSpace(input.Title)
	if input.Kind != "objective" && input.Kind != "exception" && input.Kind != "decision" {
		return UpsertOperationalRecordInput{}, errors.New("kind must be objective, exception, or decision")
	}
	if input.StableKey == "" || len(input.StableKey) > 200 {
		return UpsertOperationalRecordInput{}, errors.New("stableKey must be 1-200 characters")
	}
	if input.Title == "" || len(input.Title) > 200 {
		return UpsertOperationalRecordInput{}, errors.New("title must be 1-200 characters")
	}
	if !validOperationalStatus(input.Kind, input.Status) {
		return UpsertOperationalRecordInput{}, fmt.Errorf("status %q is not valid for a %s", input.Status, input.Kind)
	}
	if input.Summary != nil {
		trimmed := strings.TrimSpace(*input.Summary)
		if len(trimmed) > 2000 {
			return UpsertOperationalRecordInput{}, errors.New("summary must be at most 2000 characters")
		}
		input.Summary = &trimmed
	}
	if len(input.Details) == 0 {
		input.Details = json.RawMessage(`{}`)
	}
	var details map[string]any
	if err := json.Unmarshal(input.Details, &details); err != nil {
		return UpsertOperationalRecordInput{}, errors.New("details must be a JSON object")
	}
	if len(input.Details) > 64<<10 {
		return UpsertOperationalRecordInput{}, errors.New("details must be at most 64KB")
	}
	if input.AuthorityRef != nil {
		trimmed := strings.TrimSpace(*input.AuthorityRef)
		if len(trimmed) > 200 {
			return UpsertOperationalRecordInput{}, errors.New("authorityRef must be at most 200 characters")
		}
		input.AuthorityRef = &trimmed
	}
	if input.ApprovalID != nil && !isUUID(strings.TrimSpace(*input.ApprovalID)) {
		return UpsertOperationalRecordInput{}, errors.New("approvalId must be a UUID")
	}
	if input.OwnerUserID != nil && !isUUID(strings.TrimSpace(*input.OwnerUserID)) {
		return UpsertOperationalRecordInput{}, errors.New("ownerUserId must be a UUID")
	}
	return input, nil
}

func validOperationalStatus(kind, status string) bool {
	switch kind {
	case "objective":
		return status == "open" || status == "waiting" || status == "blocked" || status == "verified" || status == "cancelled"
	case "exception":
		return status == "open" || status == "acknowledged" || status == "resolved" || status == "suppressed"
	case "decision":
		return status == "recorded" || status == "approved" || status == "rejected"
	default:
		return false
	}
}

func ParseGetOperationalRecordInput(raw json.RawMessage) (GetOperationalRecordInput, error) {
	var input GetOperationalRecordInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return GetOperationalRecordInput{}, err
	}
	input.ID = strings.TrimSpace(input.ID)
	input.Kind = strings.TrimSpace(input.Kind)
	input.StableKey = strings.TrimSpace(input.StableKey)
	if input.ID == "" && (input.Kind == "" || input.StableKey == "") {
		return GetOperationalRecordInput{}, errors.New("provide id or kind and stableKey")
	}
	if input.ID != "" && !isUUID(input.ID) {
		return GetOperationalRecordInput{}, errors.New("id must be a UUID")
	}
	return input, nil
}

func ParseListOperationalRecordsInput(raw json.RawMessage) (ListOperationalRecordsInput, error) {
	var input ListOperationalRecordsInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return ListOperationalRecordsInput{}, err
	}
	input.Kind = strings.TrimSpace(input.Kind)
	input.Status = strings.TrimSpace(input.Status)
	if input.Kind != "" && input.Kind != "objective" && input.Kind != "exception" && input.Kind != "decision" {
		return ListOperationalRecordsInput{}, errors.New("kind must be objective, exception, or decision")
	}
	if input.Limit <= 0 || input.Limit > 100 {
		input.Limit = 50
	}
	return input, nil
}

func upsertOperationalRecord(ctx context.Context, tx pgx.Tx, orgID string, actorID *string, input UpsertOperationalRecordInput, now time.Time) (OperationalRecord, error) {
	var resolvedAt *time.Time
	if input.Status == "resolved" || input.Status == "verified" || input.Status == "suppressed" || input.Status == "cancelled" {
		resolvedAt = &now
	}
	var createdBy any
	if actorID != nil {
		createdBy = *actorID
	}
	var record OperationalRecord
	var details []byte
	var createdAt, updatedAt time.Time
	var resolved *time.Time
	err := tx.QueryRow(ctx, `
		INSERT INTO operational_records (
			org_id, kind, stable_key, status, title, summary, details,
			authority_ref, approval_id, owner_user_id, created_by, resolved_at
		) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::uuid, $10::uuid, $11::uuid, $12)
		ON CONFLICT (org_id, kind, stable_key) DO UPDATE SET
			status = EXCLUDED.status, title = EXCLUDED.title, summary = EXCLUDED.summary,
			details = EXCLUDED.details, authority_ref = EXCLUDED.authority_ref,
			approval_id = EXCLUDED.approval_id, owner_user_id = EXCLUDED.owner_user_id,
			revision = operational_records.revision + 1, updated_at = now(),
			resolved_at = EXCLUDED.resolved_at
		RETURNING id::text, kind, stable_key, status, title, summary, details::text,
			revision, authority_ref, approval_id::text, owner_user_id::text,
			created_at, updated_at, resolved_at`,
		orgID, input.Kind, input.StableKey, input.Status, input.Title, input.Summary, input.Details,
		input.AuthorityRef, input.ApprovalID, input.OwnerUserID, createdBy, resolvedAt,
	).Scan(&record.ID, &record.Kind, &record.StableKey, &record.Status, &record.Title, &record.Summary, &details,
		&record.Revision, &record.AuthorityRef, &record.ApprovalID, &record.OwnerUserID,
		&createdAt, &updatedAt, &resolved)
	if err != nil {
		return OperationalRecord{}, err
	}
	record.Details = json.RawMessage(details)
	record.CreatedAt = formatOperationalTime(createdAt)
	record.UpdatedAt = formatOperationalTime(updatedAt)
	if resolved != nil {
		formatted := formatOperationalTime(*resolved)
		record.ResolvedAt = &formatted
	}
	record.Card = operationalCard(record)
	return record, nil
}

func getOperationalRecord(ctx context.Context, tx pgx.Tx, orgID string, input GetOperationalRecordInput) (OperationalRecord, error) {
	query := `
		SELECT id::text, kind, stable_key, status, title, summary, details::text,
			revision, authority_ref, approval_id::text, owner_user_id::text,
			created_at, updated_at, resolved_at
		FROM operational_records
		WHERE org_id = $1::uuid AND id = $2::uuid`
	args := []any{orgID, input.ID}
	if input.ID == "" {
		query = `
			SELECT id::text, kind, stable_key, status, title, summary, details::text,
				revision, authority_ref, approval_id::text, owner_user_id::text,
				created_at, updated_at, resolved_at
			FROM operational_records
			WHERE org_id = $1::uuid AND kind = $2 AND stable_key = $3`
		args = []any{orgID, input.Kind, input.StableKey}
	}
	var record OperationalRecord
	var details []byte
	var createdAt, updatedAt time.Time
	var resolved *time.Time
	err := tx.QueryRow(ctx, query, args...).Scan(&record.ID, &record.Kind, &record.StableKey, &record.Status, &record.Title, &record.Summary, &details,
		&record.Revision, &record.AuthorityRef, &record.ApprovalID, &record.OwnerUserID,
		&createdAt, &updatedAt, &resolved)
	if errors.Is(err, pgx.ErrNoRows) {
		return OperationalRecord{}, errors.New("operational record not found")
	}
	if err != nil {
		return OperationalRecord{}, err
	}
	record.Details = json.RawMessage(details)
	record.CreatedAt = formatOperationalTime(createdAt)
	record.UpdatedAt = formatOperationalTime(updatedAt)
	if resolved != nil {
		formatted := formatOperationalTime(*resolved)
		record.ResolvedAt = &formatted
	}
	record.Card = operationalCard(record)
	return record, nil
}

func listOperationalRecords(ctx context.Context, tx pgx.Tx, orgID string, input ListOperationalRecordsInput) (ListOperationalRecordsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, kind, stable_key, status, title, summary, details::text,
			revision, authority_ref, approval_id::text, owner_user_id::text,
			created_at, updated_at, resolved_at
		FROM operational_records
		WHERE org_id = $1::uuid
		  AND ($2 = '' OR kind = $2)
		  AND ($3 = '' OR status = $3)
		ORDER BY updated_at DESC
		LIMIT $4`, orgID, input.Kind, input.Status, input.Limit)
	if err != nil {
		return ListOperationalRecordsOutput{}, err
	}
	defer rows.Close()
	records := make([]OperationalRecord, 0, input.Limit)
	for rows.Next() {
		var record OperationalRecord
		var details []byte
		var createdAt, updatedAt time.Time
		var resolved *time.Time
		if err := rows.Scan(&record.ID, &record.Kind, &record.StableKey, &record.Status, &record.Title, &record.Summary, &details,
			&record.Revision, &record.AuthorityRef, &record.ApprovalID, &record.OwnerUserID,
			&createdAt, &updatedAt, &resolved); err != nil {
			return ListOperationalRecordsOutput{}, err
		}
		record.Details = json.RawMessage(details)
		record.CreatedAt = formatOperationalTime(createdAt)
		record.UpdatedAt = formatOperationalTime(updatedAt)
		if resolved != nil {
			formatted := formatOperationalTime(*resolved)
			record.ResolvedAt = &formatted
		}
		record.Card = operationalCard(record)
		records = append(records, record)
	}
	return ListOperationalRecordsOutput{Records: records}, rows.Err()
}

func operationalCard(record OperationalRecord) *OperationalCard {
	var details map[string]json.RawMessage
	_ = json.Unmarshal(record.Details, &details)
	card := &OperationalCard{Title: record.Title, Status: record.Status}
	switch record.Kind {
	case "exception":
		card.Kind = "exception"
	case "decision":
		card.Kind = "result"
	default:
		switch record.Status {
		case "waiting", "blocked":
			card.Kind = "waiting"
		case "verified":
			card.Kind = "result"
		default:
			card.Kind = "progress"
		}
	}
	if raw, ok := details["severity"]; ok {
		_ = json.Unmarshal(raw, &card.Severity)
	}
	if record.Summary != nil {
		card.Summary = *record.Summary
	}
	if raw, ok := details["next"]; ok {
		_ = json.Unmarshal(raw, &card.Next)
	}
	if raw, ok := details["evidence"]; ok {
		card.Evidence = raw
	}
	return card
}

func formatOperationalTime(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
