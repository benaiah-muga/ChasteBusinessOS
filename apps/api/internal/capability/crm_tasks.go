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

const (
	createTaskCapabilityID         = "crm.createTask"
	completeTaskCapabilityID       = "crm.completeTask"
	updateTaskDetailsCapabilityID  = "crm.updateTaskDetails"
	restoreTaskDetailsCapabilityID = "crm.restoreTaskDetails"
)

type CreateTaskInput struct {
	Title          string  `json:"title"`
	DueAt          *string `json:"dueAt,omitempty"`
	AssigneeUserID *string `json:"assigneeUserId,omitempty"`
	RefType        *string `json:"refType,omitempty"`
	RefID          *string `json:"refId,omitempty"`
	Note           *string `json:"note,omitempty"`
}

type CreateTaskOutput struct {
	TaskID string `json:"taskId"`
}

type CompleteTaskInput struct {
	TaskID string `json:"taskId"`
}

type CompleteTaskOutput struct {
	Completed bool `json:"completed"`
}

type UpdateTaskDetailsInput struct {
	TaskID            string  `json:"taskId"`
	DueAt             *string `json:"-"`
	DueAtSet          bool    `json:"-"`
	AssigneeUserID    *string `json:"-"`
	AssigneeUserIDSet bool    `json:"-"`
}

func (input UpdateTaskDetailsInput) MarshalJSON() ([]byte, error) {
	value := map[string]any{"taskId": input.TaskID}
	if input.DueAtSet {
		value["dueAt"] = input.DueAt
	}
	if input.AssigneeUserIDSet {
		value["assigneeUserId"] = input.AssigneeUserID
	}
	return json.Marshal(value)
}

type TaskDetailsPreviousState struct {
	DueAt          *string `json:"dueAt"`
	AssigneeUserID *string `json:"assigneeUserId"`
}

type UpdateTaskDetailsOutput struct {
	TaskID   string                   `json:"taskId"`
	Previous TaskDetailsPreviousState `json:"previous"`
}

func parseCRMTaskInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case createTaskCapabilityID:
		return ParseCreateTaskInput(raw)
	case completeTaskCapabilityID:
		return ParseCompleteTaskInput(raw)
	case updateTaskDetailsCapabilityID, restoreTaskDetailsCapabilityID:
		return ParseUpdateTaskDetailsInput(raw)
	default:
		return nil, errors.New("unsupported CRM task capability")
	}
}

func ParseCreateTaskInput(raw json.RawMessage) (CreateTaskInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreateTaskInput{}, err
	}
	title, err := requiredCRMDealString(fields, "title", 1, 0)
	if err != nil {
		return CreateTaskInput{}, err
	}
	input := CreateTaskInput{Title: title}
	input.DueAt, err = crmTaskOptionalDateTime(fields, "dueAt")
	if err != nil {
		return CreateTaskInput{}, err
	}
	input.AssigneeUserID, err = crmTaskOptionalUUID(fields, "assigneeUserId")
	if err != nil {
		return CreateTaskInput{}, err
	}
	input.RefType, err = optionalCRMDealString(fields, "refType", 50, false)
	if err != nil {
		return CreateTaskInput{}, err
	}
	input.RefID, err = crmTaskOptionalUUID(fields, "refId")
	if err != nil {
		return CreateTaskInput{}, err
	}
	input.Note, err = optionalCRMDealString(fields, "note", 2000, false)
	if err != nil {
		return CreateTaskInput{}, err
	}
	return input, nil
}

func ParseCompleteTaskInput(raw json.RawMessage) (CompleteTaskInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CompleteTaskInput{}, err
	}
	taskID, err := requiredCRMDealString(fields, "taskId", 0, 0)
	if err != nil {
		return CompleteTaskInput{}, err
	}
	return CompleteTaskInput{TaskID: taskID}, nil
}

func ParseUpdateTaskDetailsInput(raw json.RawMessage) (UpdateTaskDetailsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return UpdateTaskDetailsInput{}, err
	}
	taskID, err := requiredCRMDealString(fields, "taskId", 0, 0)
	if err != nil {
		return UpdateTaskDetailsInput{}, err
	}
	if !isZodUUID(taskID) {
		return UpdateTaskDetailsInput{}, errors.New("taskId must be a UUID")
	}
	input := UpdateTaskDetailsInput{TaskID: taskID}
	if rawDueAt, ok := fields["dueAt"]; ok {
		dueAt, parseErr := crmTaskNullableDateTime(rawDueAt)
		if parseErr != nil {
			return UpdateTaskDetailsInput{}, parseErr
		}
		input.DueAt = dueAt
		input.DueAtSet = true
	}
	if rawAssignee, ok := fields["assigneeUserId"]; ok {
		assignee, parseErr := readNullableUUID(rawAssignee)
		if parseErr != nil {
			return UpdateTaskDetailsInput{}, errors.New("assigneeUserId must be a UUID or null")
		}
		input.AssigneeUserID = assignee
		input.AssigneeUserIDSet = true
	}
	if !input.DueAtSet && !input.AssigneeUserIDSet {
		return UpdateTaskDetailsInput{}, errors.New("include a due date or assignee change")
	}
	return input, nil
}

func crmTaskOptionalDateTime(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	value, err := readOptionalString(raw)
	if err != nil {
		return nil, fmt.Errorf("%s must be a UTC ISO datetime", key)
	}
	if _, err := parseProjectDateTime(*value); err != nil {
		return nil, fmt.Errorf("%s must be a UTC ISO datetime", key)
	}
	return value, nil
}

func crmTaskNullableDateTime(raw json.RawMessage) (*string, error) {
	value, err := readNullableString(raw)
	if err != nil {
		return nil, errors.New("dueAt must be a UTC ISO datetime or null")
	}
	if value == nil {
		return nil, nil
	}
	if _, err := parseProjectDateTime(*value); err != nil {
		return nil, errors.New("dueAt must be a UTC ISO datetime or null")
	}
	return value, nil
}

func crmTaskOptionalUUID(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	value, err := readOptionalString(raw)
	if err != nil || !isZodUUID(*value) {
		return nil, fmt.Errorf("%s must be a UUID", key)
	}
	return value, nil
}

func createTask(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateTaskInput) (CreateTaskOutput, error) {
	dueAt, err := projectDateTimeValue(input.DueAt)
	if err != nil {
		return CreateTaskOutput{}, err
	}
	var refType *string
	if input.RefID != nil {
		fallback := "customer"
		if input.RefType != nil {
			fallback = *input.RefType
		}
		refType = &fallback
	}
	var taskID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO tasks (
			org_id, title, due_at, assignee_user_id, ref_type, ref_id, note,
			created_by_actor_type, created_by_actor_id
		)
		VALUES ($1::uuid, $2, $3::timestamptz, $4::uuid, $5, $6::uuid, $7, $8, $9::uuid)
		RETURNING id::text`, claims.OrganizationID, input.Title, dueAt, input.AssigneeUserID,
		refType, input.RefID, input.Note, claims.ActorType, claims.ActorID).Scan(&taskID); err != nil {
		return CreateTaskOutput{}, err
	}
	return CreateTaskOutput{TaskID: taskID}, nil
}

func completeTask(ctx context.Context, tx pgx.Tx, orgID string, input CompleteTaskInput, now time.Time) (CompleteTaskOutput, error) {
	var taskID string
	err := tx.QueryRow(ctx, `
		UPDATE tasks SET done_at = $3
		WHERE id = $1::uuid AND org_id = $2::uuid AND done_at IS NULL
		RETURNING id::text`, input.TaskID, orgID, now).Scan(&taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return CompleteTaskOutput{}, errors.New("task not found or already completed")
	}
	if err != nil {
		return CompleteTaskOutput{}, err
	}
	return CompleteTaskOutput{Completed: true}, nil
}

func updateTaskDetails(ctx context.Context, tx pgx.Tx, orgID string, input UpdateTaskDetailsInput) (UpdateTaskDetailsOutput, error) {
	var taskID string
	var previous TaskDetailsPreviousState
	var previousDueAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT id::text, due_at, assignee_user_id::text
		FROM tasks
		WHERE id = $1::uuid AND org_id = $2::uuid AND done_at IS NULL
		LIMIT 1`, input.TaskID, orgID).Scan(&taskID, &previousDueAt, &previous.AssigneeUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return UpdateTaskDetailsOutput{}, errors.New("open task not found in this organization")
	}
	if err != nil {
		return UpdateTaskDetailsOutput{}, err
	}
	previous.DueAt = crmISOTime(previousDueAt)
	if input.AssigneeUserID != nil {
		var member bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM memberships WHERE org_id = $1::uuid AND user_id = $2::uuid
			)`, orgID, *input.AssigneeUserID).Scan(&member); err != nil {
			return UpdateTaskDetailsOutput{}, err
		}
		if !member {
			return UpdateTaskDetailsOutput{}, errors.New("assignee is not a member of this organization")
		}
	}
	setClauses := make([]string, 0, 2)
	args := make([]any, 0, 4)
	if input.DueAtSet {
		dueAt, err := projectDateTimeValue(input.DueAt)
		if err != nil {
			return UpdateTaskDetailsOutput{}, err
		}
		setClauses = append(setClauses, fmt.Sprintf("due_at = $%d::timestamptz", len(args)+1))
		args = append(args, dueAt)
	}
	if input.AssigneeUserIDSet {
		setClauses = append(setClauses, fmt.Sprintf("assignee_user_id = $%d::uuid", len(args)+1))
		args = append(args, input.AssigneeUserID)
	}
	args = append(args, input.TaskID, orgID)
	query := "UPDATE tasks SET " + strings.Join(setClauses, ", ") +
		" WHERE id = $" + fmt.Sprintf("%d", len(args)-1) + "::uuid AND org_id = $" + fmt.Sprintf("%d", len(args)) + "::uuid AND done_at IS NULL"
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		return UpdateTaskDetailsOutput{}, err
	}
	return UpdateTaskDetailsOutput{TaskID: taskID, Previous: previous}, nil
}
