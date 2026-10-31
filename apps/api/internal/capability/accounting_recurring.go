package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	createRecurringTemplateCapabilityID = "accounting.createRecurringTemplate"
	pauseRecurringTemplateCapabilityID  = "accounting.pauseRecurringTemplate"
	resumeRecurringTemplateCapabilityID = "accounting.resumeRecurringTemplate"
	listRecurringTemplatesCapabilityID  = "accounting.listRecurringTemplates"
)

// Field order mirrors the TypeScript lineSchema shape so the frozen price
// book stored in recurring_invoices.lines hashes identically to zod output.
type CreateRecurringTemplateLine struct {
	Description    string  `json:"description"`
	Quantity       int64   `json:"quantity"`
	UnitPriceMinor int64   `json:"unitPriceMinor"`
	TaxMinor       *int64  `json:"taxMinor,omitempty"`
	TaxCodeID      *string `json:"taxCodeId,omitempty"`
}

type CreateRecurringTemplateInput struct {
	CustomerID string                        `json:"customerId"`
	Frequency  string                        `json:"frequency"`
	Memo       *string                       `json:"memo,omitempty"`
	Lines      []CreateRecurringTemplateLine `json:"lines"`
	FirstRunAt *string                       `json:"firstRunAt,omitempty"`
}

type CreateRecurringTemplateOutput struct {
	TemplateID string `json:"templateId"`
	NextRunAt  string `json:"nextRunAt"`
}

type PauseRecurringTemplateInput struct {
	TemplateID string `json:"templateId"`
}

type PauseRecurringTemplateOutput struct {
	Active bool `json:"active"`
}

type ResumeRecurringTemplateInput struct {
	TemplateID string `json:"templateId"`
}

type ResumeRecurringTemplateOutput struct {
	Active bool `json:"active"`
}

type ListRecurringTemplatesInput struct{}

type RecurringTemplateSummary struct {
	ID         string `json:"id"`
	CustomerID string `json:"customerId"`
	Frequency  string `json:"frequency"`
	Active     bool   `json:"active"`
	NextRunAt  string `json:"nextRunAt"`
}

type ListRecurringTemplatesOutput struct {
	Templates []RecurringTemplateSummary `json:"templates"`
}

func ParseCreateRecurringTemplateInput(raw json.RawMessage) (CreateRecurringTemplateInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateRecurringTemplateInput{}, err
	}
	customerID, err := requiredString(fields, "customerId")
	if err != nil {
		return CreateRecurringTemplateInput{}, err
	}
	if !isZodUUID(customerID) {
		return CreateRecurringTemplateInput{}, errors.New("customerId must be a UUID")
	}
	frequency, err := requiredString(fields, "frequency")
	if err != nil {
		return CreateRecurringTemplateInput{}, err
	}
	if !validRecurringTemplateFrequency(frequency) {
		return CreateRecurringTemplateInput{}, errors.New("frequency must be weekly, monthly, or quarterly")
	}
	input := CreateRecurringTemplateInput{CustomerID: customerID, Frequency: frequency}
	if input.Memo, err = optionalCRMDealString(fields, "memo", 300, false); err != nil {
		return CreateRecurringTemplateInput{}, err
	}
	if input.Lines, err = parseRecurringTemplateLines(fields); err != nil {
		return CreateRecurringTemplateInput{}, err
	}
	if input.FirstRunAt, err = crmTaskOptionalDateTime(fields, "firstRunAt"); err != nil {
		return CreateRecurringTemplateInput{}, err
	}
	return input, nil
}

func ParsePauseRecurringTemplateInput(raw json.RawMessage) (PauseRecurringTemplateInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PauseRecurringTemplateInput{}, err
	}
	templateID, err := requiredCRMDealString(fields, "templateId", 0, 0)
	if err != nil {
		return PauseRecurringTemplateInput{}, err
	}
	if !isZodUUID(templateID) {
		return PauseRecurringTemplateInput{}, errors.New("templateId must be a UUID")
	}
	return PauseRecurringTemplateInput{TemplateID: templateID}, nil
}

func ParseResumeRecurringTemplateInput(raw json.RawMessage) (ResumeRecurringTemplateInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ResumeRecurringTemplateInput{}, err
	}
	templateID, err := requiredCRMDealString(fields, "templateId", 0, 0)
	if err != nil {
		return ResumeRecurringTemplateInput{}, err
	}
	if !isZodUUID(templateID) {
		return ResumeRecurringTemplateInput{}, errors.New("templateId must be a UUID")
	}
	return ResumeRecurringTemplateInput{TemplateID: templateID}, nil
}

func ParseListRecurringTemplatesInput(raw json.RawMessage) (ListRecurringTemplatesInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ListRecurringTemplatesInput{}, err
	}
	return ListRecurringTemplatesInput{}, nil
}

func validRecurringTemplateFrequency(value string) bool {
	switch value {
	case "weekly", "monthly", "quarterly":
		return true
	default:
		return false
	}
}

func parseRecurringTemplateLines(fields map[string]json.RawMessage) ([]CreateRecurringTemplateLine, error) {
	linesRaw, ok := fields["lines"]
	if !ok || bytes.Equal(bytes.TrimSpace(linesRaw), []byte("null")) {
		return nil, errors.New("lines must contain at least one line")
	}
	var lineValues []json.RawMessage
	if err := json.Unmarshal(linesRaw, &lineValues); err != nil || len(lineValues) == 0 {
		return nil, errors.New("lines must contain at least one line")
	}
	lines := make([]CreateRecurringTemplateLine, 0, len(lineValues))
	for _, lineRaw := range lineValues {
		lineFields, err := decodeJSONObject(lineRaw)
		if err != nil {
			return nil, errors.New("each template line must be an object")
		}
		var line CreateRecurringTemplateLine
		line.Description, err = requiredString(lineFields, "description")
		if err != nil {
			return nil, err
		}
		if utf16Length(line.Description) < 1 {
			return nil, errors.New("line description must contain at least one character")
		}
		line.Quantity, err = requiredSafeInteger(lineFields, "quantity")
		if err != nil || line.Quantity <= 0 {
			return nil, errors.New("quantity must be a positive integer")
		}
		line.UnitPriceMinor, err = requiredSafeInteger(lineFields, "unitPriceMinor")
		if err != nil || line.UnitPriceMinor < 0 {
			return nil, errors.New("unitPriceMinor must be a non-negative integer")
		}
		if line.TaxMinor, err = optionalSafeInteger(lineFields, "taxMinor"); err != nil || line.TaxMinor != nil && *line.TaxMinor < 0 {
			return nil, errors.New("taxMinor must be a non-negative integer")
		}
		if line.TaxCodeID, err = optionalString(lineFields, "taxCodeId"); err != nil {
			return nil, err
		} else if line.TaxCodeID != nil && !isZodUUID(*line.TaxCodeID) {
			return nil, errors.New("taxCodeId must be a UUID")
		}
		if line.TaxCodeID != nil && line.TaxMinor != nil {
			return nil, errors.New("use a configured tax code or a manual tax amount, not both")
		}
		lines = append(lines, line)
	}
	return lines, nil
}

func createRecurringTemplate(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateRecurringTemplateInput, now time.Time) (CreateRecurringTemplateOutput, error) {
	var customerFound bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM customers WHERE id = $1::uuid AND org_id = $2::uuid)`, input.CustomerID, claims.OrganizationID).Scan(&customerFound); err != nil {
		return CreateRecurringTemplateOutput{}, err
	}
	if !customerFound {
		return CreateRecurringTemplateOutput{}, errors.New("customer not found")
	}
	// JavaScript Dates carry millisecond resolution; truncate so stored and
	// returned instants match the TypeScript output byte for byte.
	nextRunAt := now.UTC().Truncate(time.Millisecond)
	if input.FirstRunAt != nil {
		parsed, err := parseProjectDateTime(*input.FirstRunAt)
		if err != nil {
			return CreateRecurringTemplateOutput{}, err
		}
		nextRunAt = parsed.UTC().Truncate(time.Millisecond)
	}
	linesJSON, err := marshalJS(input.Lines)
	if err != nil {
		return CreateRecurringTemplateOutput{}, err
	}
	var templateID string
	err = tx.QueryRow(ctx, `
		INSERT INTO recurring_invoices (
			org_id, customer_id, frequency, lines, memo, next_run_at,
			created_by_actor_type, created_by_actor_id
		)
		VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7, $8::uuid)
		RETURNING id::text`,
		claims.OrganizationID, input.CustomerID, input.Frequency, linesJSON, input.Memo, nextRunAt,
		claims.ActorType, claims.ActorID).Scan(&templateID)
	if err != nil {
		return CreateRecurringTemplateOutput{}, err
	}
	return CreateRecurringTemplateOutput{TemplateID: templateID, NextRunAt: *crmISOTime(&nextRunAt)}, nil
}

func pauseRecurringTemplate(ctx context.Context, tx pgx.Tx, orgID string, input PauseRecurringTemplateInput) (PauseRecurringTemplateOutput, error) {
	var templateID string
	err := tx.QueryRow(ctx, `
		UPDATE recurring_invoices SET active = false
		WHERE id = $1::uuid AND org_id = $2::uuid
		RETURNING id::text`, input.TemplateID, orgID).Scan(&templateID)
	if errors.Is(err, pgx.ErrNoRows) {
		return PauseRecurringTemplateOutput{}, errors.New("template not found")
	}
	if err != nil {
		return PauseRecurringTemplateOutput{}, err
	}
	return PauseRecurringTemplateOutput{Active: false}, nil
}

func resumeRecurringTemplate(ctx context.Context, tx pgx.Tx, orgID string, input ResumeRecurringTemplateInput, now time.Time) (ResumeRecurringTemplateOutput, error) {
	var templateID string
	err := tx.QueryRow(ctx, `
		UPDATE recurring_invoices SET active = true, next_run_at = $3
		WHERE id = $1::uuid AND org_id = $2::uuid
		RETURNING id::text`, input.TemplateID, orgID, now.UTC().Truncate(time.Millisecond)).Scan(&templateID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ResumeRecurringTemplateOutput{}, errors.New("template not found")
	}
	if err != nil {
		return ResumeRecurringTemplateOutput{}, err
	}
	return ResumeRecurringTemplateOutput{Active: true}, nil
}

func listRecurringTemplates(ctx context.Context, tx pgx.Tx, orgID string) (ListRecurringTemplatesOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, customer_id::text, frequency, active, next_run_at
		FROM recurring_invoices
		WHERE org_id = $1::uuid
		ORDER BY created_at DESC
		LIMIT 100`, orgID)
	if err != nil {
		return ListRecurringTemplatesOutput{}, err
	}
	defer rows.Close()
	templates := make([]RecurringTemplateSummary, 0)
	for rows.Next() {
		var template RecurringTemplateSummary
		var nextRunAt time.Time
		if err := rows.Scan(&template.ID, &template.CustomerID, &template.Frequency, &template.Active, &nextRunAt); err != nil {
			return ListRecurringTemplatesOutput{}, err
		}
		template.NextRunAt = *crmISOTime(&nextRunAt)
		templates = append(templates, template)
	}
	if err := rows.Err(); err != nil {
		return ListRecurringTemplatesOutput{}, err
	}
	return ListRecurringTemplatesOutput{Templates: templates}, nil
}

func parseAccountingRecurringInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case createRecurringTemplateCapabilityID:
		return ParseCreateRecurringTemplateInput(raw)
	case pauseRecurringTemplateCapabilityID:
		return ParsePauseRecurringTemplateInput(raw)
	case resumeRecurringTemplateCapabilityID:
		return ParseResumeRecurringTemplateInput(raw)
	case listRecurringTemplatesCapabilityID:
		return ParseListRecurringTemplatesInput(raw)
	default:
		return nil, errors.New("unsupported accounting recurring capability")
	}
}
