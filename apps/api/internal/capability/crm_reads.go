package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

type ListCustomersInput struct {
	Query *string `json:"query,omitempty"`
}

type CRMCustomerSummary struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Email *string `json:"email"`
}

type CRMCustomerMergedRecord struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	MergedAt *string `json:"mergedAt"`
}

type CRMCustomerNextStep struct {
	Kind        string `json:"kind"`
	Summary     string `json:"summary"`
	RefID       string `json:"refId"`
	AmountMinor *int64 `json:"amountMinor,omitempty"`
}

// CRMCustomerCollectionItem contains the CRM UI's richer customer profile.
// Keep it separate from CRMCustomerSummary, which is exposed to agent tools.
type CRMCustomerCollectionItem struct {
	ID                     string                    `json:"id"`
	Name                   string                    `json:"name"`
	Email                  *string                   `json:"email"`
	OwnerUserID            *string                   `json:"ownerUserId"`
	OwnerName              *string                   `json:"ownerName"`
	OwnerEmail             *string                   `json:"ownerEmail"`
	Phone                  *string                   `json:"phone"`
	PreferredContactMethod string                    `json:"preferredContactMethod"`
	DoNotContact           bool                      `json:"doNotContact"`
	UpdatedByUserID        *string                   `json:"updatedByUserId"`
	UpdatedByName          *string                   `json:"updatedByName"`
	UpdatedByEmail         *string                   `json:"updatedByEmail"`
	Tags                   []string                  `json:"tags"`
	Notes                  *string                   `json:"notes"`
	CreatedAt              string                    `json:"createdAt"`
	UpdatedAt              string                    `json:"updatedAt"`
	DeactivatedAt          *string                   `json:"deactivatedAt"`
	MergedRecords          []CRMCustomerMergedRecord `json:"mergedRecords"`
	PurchaseCount          int64                     `json:"purchaseCount"`
	LifetimeSpendMinor     int64                     `json:"lifetimeSpendMinor"`
	LastActivityAt         string                    `json:"lastActivityAt"`
	NextStep               *CRMCustomerNextStep      `json:"nextStep"`
}

type ListCRMCustomerCollectionOutput struct {
	Customers []CRMCustomerCollectionItem `json:"customers"`
}

type ListCustomersOutput struct {
	Customers []CRMCustomerSummary `json:"customers"`
}

type PipelineReportInput struct{}

type PipelineStageSummary struct {
	Stage         string `json:"stage"`
	Count         int64  `json:"count"`
	TotalMinor    int64  `json:"totalMinor"`
	WeightedMinor int64  `json:"weightedMinor"`
}

type PipelineReportOutput struct {
	Stages                []PipelineStageSummary `json:"stages"`
	OpenValueMinor        int64                  `json:"openValueMinor"`
	WeightedForecastMinor int64                  `json:"weightedForecastMinor"`
}

type ListTasksInput struct {
	OpenOnly *bool `json:"openOnly,omitempty"`
}

type CRMTaskSummary struct {
	ID             string  `json:"id"`
	Title          string  `json:"title"`
	DueAt          *string `json:"dueAt"`
	DoneAt         *string `json:"doneAt"`
	RefType        *string `json:"refType"`
	RefID          *string `json:"refId"`
	AssigneeUserID *string `json:"assigneeUserId"`
	AssigneeName   *string `json:"assigneeName"`
	CustomerName   *string `json:"customerName"`
}

type ListTasksOutput struct {
	Tasks []CRMTaskSummary `json:"tasks"`
}

var dealStages = []string{"lead", "qualified", "proposal", "negotiation", "won", "lost"}

var dealStageWeights = map[string]float64{
	"lead":        0.1,
	"qualified":   0.3,
	"proposal":    0.5,
	"negotiation": 0.7,
	"won":         1,
	"lost":        0,
}

func ParseListCustomersInput(raw json.RawMessage) (ListCustomersInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ListCustomersInput{}, err
	}
	query, err := optionalString(fields, "query")
	if err != nil {
		return ListCustomersInput{}, err
	}
	return ListCustomersInput{Query: query}, nil
}

func ParsePipelineReportInput(raw json.RawMessage) (PipelineReportInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return PipelineReportInput{}, err
	}
	return PipelineReportInput{}, nil
}

func ParseListTasksInput(raw json.RawMessage) (ListTasksInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ListTasksInput{}, err
	}
	rawOpenOnly, ok := fields["openOnly"]
	if !ok {
		return ListTasksInput{}, nil
	}
	if bytes.Equal(bytes.TrimSpace(rawOpenOnly), []byte("null")) {
		return ListTasksInput{}, errors.New("openOnly must be a boolean")
	}
	var openOnly bool
	if err := json.Unmarshal(rawOpenOnly, &openOnly); err != nil {
		return ListTasksInput{}, errors.New("openOnly must be a boolean")
	}
	return ListTasksInput{OpenOnly: &openOnly}, nil
}

func listCustomers(ctx context.Context, tx pgx.Tx, orgID string, _ ListCustomersInput) (ListCustomersOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, email
		FROM customers
		WHERE org_id = $1::uuid AND deactivated_at IS NULL AND merged_into_customer_id IS NULL
		LIMIT 100`, orgID)
	if err != nil {
		return ListCustomersOutput{}, err
	}
	defer rows.Close()
	customers := make([]CRMCustomerSummary, 0)
	for rows.Next() {
		var customer CRMCustomerSummary
		if err := rows.Scan(&customer.ID, &customer.Name, &customer.Email); err != nil {
			return ListCustomersOutput{}, err
		}
		customers = append(customers, customer)
	}
	if err := rows.Err(); err != nil {
		return ListCustomersOutput{}, err
	}
	return ListCustomersOutput{Customers: customers}, nil
}

type pipelineStageAggregate struct {
	count int64
	total int64
}

func pipelineReport(ctx context.Context, tx pgx.Tx, orgID string, _ PipelineReportInput) (PipelineReportOutput, error) {
	rows, err := tx.Query(ctx, `SELECT stage, value_minor FROM deals WHERE org_id = $1::uuid`, orgID)
	if err != nil {
		return PipelineReportOutput{}, err
	}
	byStage := make(map[string]pipelineStageAggregate)
	var openValueMinor int64
	var weightedForecastMinor int64
	for rows.Next() {
		var stage string
		var valueMinor int64
		if err := rows.Scan(&stage, &valueMinor); err != nil {
			rows.Close()
			return PipelineReportOutput{}, err
		}
		aggregate := byStage[stage]
		aggregate.count++
		aggregate.total += valueMinor
		byStage[stage] = aggregate
		if stage != "won" && stage != "lost" {
			openValueMinor += valueMinor
			weightedForecastMinor += jsRoundStageWeight(valueMinor, dealStageWeights[stage])
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return PipelineReportOutput{}, err
	}
	rows.Close()

	stages := make([]PipelineStageSummary, 0, len(dealStages))
	for _, stage := range dealStages {
		aggregate := byStage[stage]
		stages = append(stages, PipelineStageSummary{
			Stage:         stage,
			Count:         aggregate.count,
			TotalMinor:    aggregate.total,
			WeightedMinor: jsRoundStageWeight(aggregate.total, dealStageWeights[stage]),
		})
	}
	return PipelineReportOutput{Stages: stages, OpenValueMinor: openValueMinor, WeightedForecastMinor: weightedForecastMinor}, nil
}

func jsRoundStageWeight(value int64, weight float64) int64 {
	return int64(math.Floor(float64(value)*weight + 0.5))
}

func listTasks(ctx context.Context, tx pgx.Tx, orgID string, input ListTasksInput) (ListTasksOutput, error) {
	query := `
		SELECT t.id::text, t.title, t.due_at, t.done_at, t.ref_type, t.ref_id::text,
		       t.assignee_user_id::text, u.name, u.email, c.name
		FROM tasks t
		LEFT JOIN users u ON u.id = t.assignee_user_id
		LEFT JOIN customers c ON c.id = t.ref_id AND c.org_id = $1::uuid AND t.ref_type = 'customer'
		WHERE t.org_id = $1::uuid`
	if input.OpenOnly != nil && *input.OpenOnly {
		query += ` AND t.done_at IS NULL`
	}
	query += ` ORDER BY t.done_at ASC NULLS LAST, t.due_at ASC NULLS LAST LIMIT 200`
	rows, err := tx.Query(ctx, query, orgID)
	if err != nil {
		return ListTasksOutput{}, err
	}
	defer rows.Close()
	tasks := make([]CRMTaskSummary, 0)
	for rows.Next() {
		var task CRMTaskSummary
		var dueAt, doneAt *time.Time
		var assigneeName, assigneeEmail *string
		if err := rows.Scan(&task.ID, &task.Title, &dueAt, &doneAt, &task.RefType, &task.RefID, &task.AssigneeUserID, &assigneeName, &assigneeEmail, &task.CustomerName); err != nil {
			return ListTasksOutput{}, err
		}
		task.DueAt = crmISOTime(dueAt)
		task.DoneAt = crmISOTime(doneAt)
		task.AssigneeName = assigneeName
		if task.AssigneeName == nil {
			task.AssigneeName = assigneeEmail
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return ListTasksOutput{}, err
	}
	return ListTasksOutput{Tasks: tasks}, nil
}

func crmISOTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
	return &formatted
}
