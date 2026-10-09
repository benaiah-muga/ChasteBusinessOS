package capability

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

var projectUUIDPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

const (
	ProjectBoardReadCapabilityID     = "projects.listBoard"
	ProjectCollectionReadOperationID = "projects.list"
	projectRestoreCapabilityID       = "projects.restoreProject"
	projectDeleteTaskCapabilityID    = "projects.deleteTask"
	projectRestoreTaskCapabilityID   = "projects.restoreTask"
	projectRestorePlacementID        = "projects.restoreTaskPlacement"
	projectRestoreAssigneeID         = "projects.restoreTaskAssignment"
)

type ProjectBoardInput struct {
	ProjectID string `json:"projectId"`
}

type ProjectBoardTask struct {
	ID             string  `json:"id"`
	Title          string  `json:"title"`
	ParentTaskID   *string `json:"parentTaskId"`
	Priority       string  `json:"priority"`
	AssigneeUserID *string `json:"assigneeUserId"`
	DueAt          *string `json:"dueAt"`
	Position       int64   `json:"position"`
}

type ProjectBoardColumn struct {
	Status string             `json:"status"`
	Tasks  []ProjectBoardTask `json:"tasks"`
}

type ProjectBoardOutput struct {
	Columns []ProjectBoardColumn `json:"columns"`
}

type ProjectCollectionItem struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Status    string  `json:"status"`
	DueAt     *string `json:"dueAt"`
	CreatedAt string  `json:"createdAt"`
}

type ProjectCollectionOutput struct {
	Projects []ProjectCollectionItem `json:"projects"`
}

type CreateProjectInput struct {
	Name  string  `json:"name"`
	DueAt *string `json:"dueAt,omitempty"`
}

type CreateProjectOutput struct {
	ProjectID string `json:"projectId"`
}

type ArchiveProjectInput struct {
	ProjectID string `json:"projectId"`
}

type ArchiveProjectOutput struct {
	Archived  bool   `json:"archived"`
	ProjectID string `json:"projectId"`
}

type CreateProjectTaskInput struct {
	ProjectID      string  `json:"projectId"`
	Title          string  `json:"title"`
	ParentTaskID   *string `json:"parentTaskId,omitempty"`
	AssigneeUserID *string `json:"assigneeUserId,omitempty"`
	DueAt          *string `json:"dueAt,omitempty"`
	Priority       *string `json:"priority,omitempty"`
}

type CreateProjectTaskOutput struct {
	ProjectTaskSnapshot
}

type ProjectTaskSnapshot struct {
	TaskID         string  `json:"taskId"`
	ProjectID      string  `json:"projectId"`
	Title          string  `json:"title"`
	ParentTaskID   *string `json:"parentTaskId"`
	Status         string  `json:"status"`
	Priority       string  `json:"priority"`
	AssigneeUserID *string `json:"assigneeUserId"`
	DueAt          *string `json:"dueAt"`
	Position       int64   `json:"position"`
	Note           *string `json:"note"`
	CreatedAt      string  `json:"createdAt"`
}

type RestoreProjectInput struct {
	ProjectID string `json:"projectId"`
}

type RestoreProjectOutput struct {
	ProjectID string `json:"projectId"`
	Restored  bool   `json:"restored"`
}

type DeleteProjectTaskInput struct{ ProjectTaskSnapshot }

type DeleteProjectTaskOutput struct{ ProjectTaskSnapshot }

type RestoreProjectTaskInput struct{ ProjectTaskSnapshot }

type RestoreProjectTaskOutput struct{ ProjectTaskSnapshot }

type MoveProjectTaskInput struct {
	TaskID   string   `json:"taskId"`
	Status   string   `json:"status"`
	Position *float64 `json:"position,omitempty"`
}

type MoveProjectTaskOutput struct {
	Moved            bool   `json:"moved"`
	Status           string `json:"status"`
	Position         int64  `json:"position"`
	TaskID           string `json:"taskId"`
	RestoreStatus    string `json:"restoreStatus"`
	RestorePosition  int64  `json:"restorePosition"`
	ExpectedStatus   string `json:"expectedStatus"`
	ExpectedPosition int64  `json:"expectedPosition"`
}

type RestoreProjectTaskPlacementInput struct {
	TaskID           string `json:"taskId"`
	RestoreStatus    string `json:"restoreStatus"`
	RestorePosition  int64  `json:"restorePosition"`
	ExpectedStatus   string `json:"expectedStatus"`
	ExpectedPosition int64  `json:"expectedPosition"`
}

type RestoreProjectTaskPlacementOutput struct {
	Moved            bool   `json:"moved"`
	TaskID           string `json:"taskId"`
	Status           string `json:"status"`
	Position         int64  `json:"position"`
	RestoreStatus    string `json:"restoreStatus"`
	RestorePosition  int64  `json:"restorePosition"`
	ExpectedStatus   string `json:"expectedStatus"`
	ExpectedPosition int64  `json:"expectedPosition"`
}

type AssignProjectTaskInput struct {
	TaskID         string  `json:"taskId"`
	AssigneeUserID *string `json:"assigneeUserId,omitempty"`
}

type AssignProjectTaskOutput struct {
	Assigned               bool    `json:"assigned"`
	TaskID                 string  `json:"taskId"`
	RestoreAssigneeUserID  *string `json:"restoreAssigneeUserId"`
	ExpectedAssigneeUserID *string `json:"expectedAssigneeUserId"`
}

type RestoreProjectTaskAssigneeInput struct {
	TaskID                 string  `json:"taskId"`
	RestoreAssigneeUserID  *string `json:"restoreAssigneeUserId"`
	ExpectedAssigneeUserID *string `json:"expectedAssigneeUserId"`
}

type RestoreProjectTaskAssigneeOutput struct {
	Assigned               bool    `json:"assigned"`
	TaskID                 string  `json:"taskId"`
	AssigneeUserID         *string `json:"assigneeUserId"`
	RestoreAssigneeUserID  *string `json:"restoreAssigneeUserId"`
	ExpectedAssigneeUserID *string `json:"expectedAssigneeUserId"`
}

func ParseCreateProjectInput(raw json.RawMessage) (CreateProjectInput, error) {
	fields, err := projectInputObject(raw)
	if err != nil {
		return CreateProjectInput{}, err
	}
	name, err := projectRequiredText(fields, "name", 1, 120)
	if err != nil {
		return CreateProjectInput{}, err
	}
	dueAt, err := projectOptionalDateTime(fields, "dueAt")
	if err != nil {
		return CreateProjectInput{}, err
	}
	return CreateProjectInput{Name: name, DueAt: dueAt}, nil
}

func ParseProjectBoardInput(raw json.RawMessage) (ProjectBoardInput, error) {
	fields, err := projectInputObject(raw)
	if err != nil {
		return ProjectBoardInput{}, err
	}
	projectID, err := projectRequiredUUID(fields, "projectId")
	if err != nil {
		return ProjectBoardInput{}, err
	}
	return ProjectBoardInput{ProjectID: projectID}, nil
}

func ParseArchiveProjectInput(raw json.RawMessage) (ArchiveProjectInput, error) {
	fields, err := projectInputObject(raw)
	if err != nil {
		return ArchiveProjectInput{}, err
	}
	projectID, err := projectRequiredUUID(fields, "projectId")
	if err != nil {
		return ArchiveProjectInput{}, err
	}
	return ArchiveProjectInput{ProjectID: projectID}, nil
}

func ParseRestoreProjectInput(raw json.RawMessage) (RestoreProjectInput, error) {
	fields, err := projectInputObject(raw)
	if err != nil {
		return RestoreProjectInput{}, err
	}
	projectID, err := projectRequiredUUID(fields, "projectId")
	if err != nil {
		return RestoreProjectInput{}, err
	}
	return RestoreProjectInput{ProjectID: projectID}, nil
}

func ParseDeleteProjectTaskInput(raw json.RawMessage) (DeleteProjectTaskInput, error) {
	snapshot, err := parseProjectTaskSnapshot(raw)
	return DeleteProjectTaskInput{ProjectTaskSnapshot: snapshot}, err
}

func ParseRestoreProjectTaskInput(raw json.RawMessage) (RestoreProjectTaskInput, error) {
	snapshot, err := parseProjectTaskSnapshot(raw)
	return RestoreProjectTaskInput{ProjectTaskSnapshot: snapshot}, err
}

func parseProjectTaskSnapshot(raw json.RawMessage) (ProjectTaskSnapshot, error) {
	fields, err := projectInputObject(raw)
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	taskID, err := projectRequiredUUID(fields, "taskId")
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	projectID, err := projectRequiredUUID(fields, "projectId")
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	title, err := projectRequiredText(fields, "title", 1, 200)
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	parentTaskID, err := projectRequiredOptionalUUID(fields, "parentTaskId")
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	status, err := projectRequiredEnum(fields, "status", []string{"todo", "doing", "done"})
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	priority, err := projectRequiredEnum(fields, "priority", []string{"low", "medium", "high"})
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	assigneeUserID, err := projectRequiredOptionalUUID(fields, "assigneeUserId")
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	dueAt, err := projectRequiredOptionalDateTime(fields, "dueAt")
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	position, err := projectRequiredPosition(fields, "position")
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	note, err := projectRequiredOptionalText(fields, "note", 10000)
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	createdAt, err := projectRequiredDateTime(fields, "createdAt")
	if err != nil {
		return ProjectTaskSnapshot{}, err
	}
	return ProjectTaskSnapshot{
		TaskID: taskID, ProjectID: projectID, Title: title, ParentTaskID: parentTaskID,
		Status: status, Priority: priority, AssigneeUserID: assigneeUserID,
		DueAt: dueAt, Position: position, Note: note, CreatedAt: createdAt,
	}, nil
}

func ParseRestoreProjectTaskPlacementInput(raw json.RawMessage) (RestoreProjectTaskPlacementInput, error) {
	fields, err := projectInputObject(raw)
	if err != nil {
		return RestoreProjectTaskPlacementInput{}, err
	}
	taskID, err := projectRequiredUUID(fields, "taskId")
	if err != nil {
		return RestoreProjectTaskPlacementInput{}, err
	}
	restoreStatus, err := projectRequiredEnum(fields, "restoreStatus", []string{"todo", "doing", "done"})
	if err != nil {
		return RestoreProjectTaskPlacementInput{}, err
	}
	restorePosition, err := projectRequiredPosition(fields, "restorePosition")
	if err != nil {
		return RestoreProjectTaskPlacementInput{}, err
	}
	expectedStatus, err := projectRequiredEnum(fields, "expectedStatus", []string{"todo", "doing", "done"})
	if err != nil {
		return RestoreProjectTaskPlacementInput{}, err
	}
	expectedPosition, err := projectRequiredPosition(fields, "expectedPosition")
	if err != nil {
		return RestoreProjectTaskPlacementInput{}, err
	}
	return RestoreProjectTaskPlacementInput{
		TaskID: taskID, RestoreStatus: restoreStatus, RestorePosition: restorePosition,
		ExpectedStatus: expectedStatus, ExpectedPosition: expectedPosition,
	}, nil
}

func ParseRestoreProjectTaskAssigneeInput(raw json.RawMessage) (RestoreProjectTaskAssigneeInput, error) {
	fields, err := projectInputObject(raw)
	if err != nil {
		return RestoreProjectTaskAssigneeInput{}, err
	}
	taskID, err := projectRequiredUUID(fields, "taskId")
	if err != nil {
		return RestoreProjectTaskAssigneeInput{}, err
	}
	restoreAssigneeUserID, err := projectRequiredOptionalUUID(fields, "restoreAssigneeUserId")
	if err != nil {
		return RestoreProjectTaskAssigneeInput{}, err
	}
	expectedAssigneeUserID, err := projectRequiredOptionalUUID(fields, "expectedAssigneeUserId")
	if err != nil {
		return RestoreProjectTaskAssigneeInput{}, err
	}
	return RestoreProjectTaskAssigneeInput{TaskID: taskID, RestoreAssigneeUserID: restoreAssigneeUserID, ExpectedAssigneeUserID: expectedAssigneeUserID}, nil
}

func ParseCreateProjectTaskInput(raw json.RawMessage) (CreateProjectTaskInput, error) {
	fields, err := projectInputObject(raw)
	if err != nil {
		return CreateProjectTaskInput{}, err
	}
	projectID, err := projectRequiredUUID(fields, "projectId")
	if err != nil {
		return CreateProjectTaskInput{}, err
	}
	title, err := projectRequiredText(fields, "title", 1, 200)
	if err != nil {
		return CreateProjectTaskInput{}, err
	}
	parentTaskID, err := projectOptionalUUID(fields, "parentTaskId")
	if err != nil {
		return CreateProjectTaskInput{}, err
	}
	assigneeUserID, err := projectOptionalUUID(fields, "assigneeUserId")
	if err != nil {
		return CreateProjectTaskInput{}, err
	}
	dueAt, err := projectOptionalDateTime(fields, "dueAt")
	if err != nil {
		return CreateProjectTaskInput{}, err
	}
	priority, err := projectOptionalEnum(fields, "priority", []string{"low", "medium", "high"})
	if err != nil {
		return CreateProjectTaskInput{}, err
	}
	return CreateProjectTaskInput{
		ProjectID: projectID, Title: title, ParentTaskID: parentTaskID,
		AssigneeUserID: assigneeUserID, DueAt: dueAt, Priority: priority,
	}, nil
}

func ParseMoveProjectTaskInput(raw json.RawMessage) (MoveProjectTaskInput, error) {
	fields, err := projectInputObject(raw)
	if err != nil {
		return MoveProjectTaskInput{}, err
	}
	taskID, err := projectRequiredUUID(fields, "taskId")
	if err != nil {
		return MoveProjectTaskInput{}, err
	}
	status, err := projectRequiredEnum(fields, "status", []string{"todo", "doing", "done"})
	if err != nil {
		return MoveProjectTaskInput{}, err
	}
	position, err := projectOptionalPosition(fields)
	if err != nil {
		return MoveProjectTaskInput{}, err
	}
	return MoveProjectTaskInput{TaskID: taskID, Status: status, Position: position}, nil
}

func ParseAssignProjectTaskInput(raw json.RawMessage) (AssignProjectTaskInput, error) {
	fields, err := projectInputObject(raw)
	if err != nil {
		return AssignProjectTaskInput{}, err
	}
	taskID, err := projectRequiredUUID(fields, "taskId")
	if err != nil {
		return AssignProjectTaskInput{}, err
	}
	assigneeUserID, err := projectOptionalUUID(fields, "assigneeUserId")
	if err != nil {
		return AssignProjectTaskInput{}, err
	}
	return AssignProjectTaskInput{TaskID: taskID, AssigneeUserID: assigneeUserID}, nil
}

func projectInputObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, errors.New("expected an object")
	}
	return fields, nil
}

func projectRequiredText(fields map[string]json.RawMessage, key string, min, max int) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("%s is required", key)
	}
	var value string
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	length := utf16Length(value)
	if length < min || length > max {
		return "", fmt.Errorf("%s must contain between %d and %d characters", key, min, max)
	}
	return value, nil
}

func projectRequiredUUID(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("%s is required", key)
	}
	value, err := readOptionalString(raw)
	if err != nil || value == nil || !projectUUIDPattern.MatchString(*value) {
		return "", fmt.Errorf("%s must be a UUID", key)
	}
	return *value, nil
}

func projectRequiredOptionalUUID(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	value, err := projectNullableString(raw)
	if err != nil || (value != nil && !projectUUIDPattern.MatchString(*value)) {
		return nil, fmt.Errorf("%s must be a UUID or null", key)
	}
	return value, nil
}

func projectOptionalUUID(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	value, err := readOptionalString(raw)
	if err != nil || value == nil || !projectUUIDPattern.MatchString(*value) {
		return nil, fmt.Errorf("%s must be a UUID", key)
	}
	return value, nil
}

func projectOptionalDateTime(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	value, err := readOptionalString(raw)
	if err != nil || value == nil {
		return nil, fmt.Errorf("%s must be a UTC ISO datetime", key)
	}
	if _, err := parseProjectDateTime(*value); err != nil {
		return nil, fmt.Errorf("%s must be a UTC ISO datetime", key)
	}
	return value, nil
}

func projectRequiredOptionalDateTime(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	value, err := projectNullableString(raw)
	if err != nil {
		return nil, fmt.Errorf("%s must be a UTC ISO datetime or null", key)
	}
	if value != nil {
		if _, err := parseProjectDateTime(*value); err != nil {
			return nil, fmt.Errorf("%s must be a UTC ISO datetime or null", key)
		}
	}
	return value, nil
}

func projectRequiredDateTime(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := projectRequiredText(fields, key, 1, 64)
	if err != nil {
		return "", err
	}
	if _, err := parseProjectDateTime(value); err != nil {
		return "", fmt.Errorf("%s must be a UTC ISO datetime", key)
	}
	return value, nil
}

func projectRequiredOptionalText(fields map[string]json.RawMessage, key string, max int) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	value, err := projectNullableString(raw)
	if err != nil || (value != nil && utf16Length(*value) > max) {
		return nil, fmt.Errorf("%s must be a string or null", key)
	}
	return value, nil
}

func projectNullableString(raw json.RawMessage) (*string, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func projectRequiredPosition(fields map[string]json.RawMessage, key string) (int64, error) {
	raw, ok := fields[key]
	if !ok {
		return 0, fmt.Errorf("%s is required", key)
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || math.Trunc(value) != value || value > math.MaxInt64 {
		return 0, fmt.Errorf("%s must be a non-negative integer", key)
	}
	return int64(value), nil
}

func parseProjectDateTime(value string) (time.Time, error) {
	if !strings.HasSuffix(value, "Z") {
		return time.Time{}, errors.New("datetime must use UTC Z notation")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err == nil {
		return parsed, nil
	}
	return time.Parse("2006-01-02T15:04Z07:00", value)
}

func projectDateTimeValue(value *string) (any, error) {
	if value == nil {
		return nil, nil
	}
	parsed, err := parseProjectDateTime(*value)
	if err != nil {
		return nil, err
	}
	return parsed.UTC().Truncate(time.Millisecond), nil
}

func listProjectBoard(ctx context.Context, tx pgx.Tx, orgID string, input ProjectBoardInput) (ProjectBoardOutput, error) {
	output := ProjectBoardOutput{Columns: []ProjectBoardColumn{
		{Status: "todo", Tasks: make([]ProjectBoardTask, 0)},
		{Status: "doing", Tasks: make([]ProjectBoardTask, 0)},
		{Status: "done", Tasks: make([]ProjectBoardTask, 0)},
	}}
	var projectExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM projects WHERE id = $1::uuid AND org_id = $2::uuid)`, input.ProjectID, orgID).Scan(&projectExists); err != nil {
		return ProjectBoardOutput{}, err
	}
	if !projectExists {
		return output, nil
	}

	rows, err := tx.Query(ctx, `
		SELECT id::text, title, parent_task_id::text, priority, assignee_user_id::text, due_at, position, status
		FROM project_tasks
		WHERE project_id = $1::uuid AND org_id = $2::uuid
		ORDER BY position ASC`, input.ProjectID, orgID)
	if err != nil {
		return ProjectBoardOutput{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var task ProjectBoardTask
		var dueAt *time.Time
		var status string
		if err := rows.Scan(&task.ID, &task.Title, &task.ParentTaskID, &task.Priority, &task.AssigneeUserID, &dueAt, &task.Position, &status); err != nil {
			return ProjectBoardOutput{}, err
		}
		task.DueAt = projectISOTime(dueAt)
		switch status {
		case "todo":
			output.Columns[0].Tasks = append(output.Columns[0].Tasks, task)
		case "doing":
			output.Columns[1].Tasks = append(output.Columns[1].Tasks, task)
		case "done":
			output.Columns[2].Tasks = append(output.Columns[2].Tasks, task)
		}
	}
	if err := rows.Err(); err != nil {
		return ProjectBoardOutput{}, err
	}
	return output, nil
}

func listProjectCollection(ctx context.Context, tx pgx.Tx, orgID string) (ProjectCollectionOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, status, due_at, created_at
		FROM projects
		WHERE org_id = $1::uuid
		ORDER BY created_at DESC
		LIMIT 50`, orgID)
	if err != nil {
		return ProjectCollectionOutput{}, err
	}
	defer rows.Close()
	projects := make([]ProjectCollectionItem, 0)
	for rows.Next() {
		var project ProjectCollectionItem
		var dueAt, createdAt *time.Time
		if err := rows.Scan(&project.ID, &project.Name, &project.Status, &dueAt, &createdAt); err != nil {
			return ProjectCollectionOutput{}, err
		}
		project.DueAt = projectISOTime(dueAt)
		if createdAt == nil {
			return ProjectCollectionOutput{}, errors.New("project created_at is null")
		}
		project.CreatedAt = *projectISOTime(createdAt)
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return ProjectCollectionOutput{}, err
	}
	return ProjectCollectionOutput{Projects: projects}, nil
}

func projectISOTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
	return &formatted
}

// ReadProjectCollection intentionally shares identity and grant checks with capabilities without emitting a capability audit event.
func (e *Executor) ReadProjectCollection(ctx context.Context, claims authbridge.CapabilityClaims, rawInput json.RawMessage) (Result, error) {
	if e == nil || e.pool == nil {
		return Result{}, errors.New("capability executor is unavailable")
	}
	if claims.CapabilityID != ProjectCollectionReadOperationID || claims.Audience != authbridge.CapabilityExecuteAudience ||
		claims.ActorType != "human" || !isUUID(claims.Subject) || !isUUID(claims.OrganizationID) || claims.ActorID == nil ||
		!isUUID(*claims.ActorID) || *claims.ActorID != claims.Subject || claims.AgentSessionID != "" {
		return Result{}, ErrSessionInvalid
	}
	if !bytes.Equal(bytes.TrimSpace(rawInput), []byte("{}")) {
		return Result{}, ErrScopeMismatch
	}
	inputDigest, err := InputHash(rawInput)
	if err != nil || inputDigest != claims.InputSHA256 {
		return Result{}, ErrScopeMismatch
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	return dbx.WithOrgTx(ctx, e.pool, claims.OrganizationID, func(tx pgx.Tx) (Result, error) {
		if err := verifyIdentity(ctx, tx, claims, now); err != nil {
			return Result{}, err
		}
		enabled, err := isModuleEnabled(ctx, tx, claims.OrganizationID, "projects")
		if err != nil {
			return Result{}, err
		}
		if !enabled {
			return Result{OK: false, Error: `module "projects" is disabled for this organization`}, nil
		}
		permissions, err := effectivePermissions(ctx, tx, claims)
		if err != nil {
			return Result{}, err
		}
		if !permissions["*"] && !permissions["projects.read"] {
			return Result{OK: false, Error: "forbidden: missing permission: projects.read"}, nil
		}
		output, err := listProjectCollection(ctx, tx, claims.OrganizationID)
		if err != nil {
			return Result{}, err
		}
		data, err := marshalJS(output)
		if err != nil {
			return Result{}, err
		}
		return Result{OK: true, Data: data}, nil
	})
}

func projectRequiredEnum(fields map[string]json.RawMessage, key string, allowed []string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("%s is required", key)
	}
	value, err := readOptionalString(raw)
	if err != nil || value == nil {
		return "", fmt.Errorf("%s is invalid", key)
	}
	for _, option := range allowed {
		if *value == option {
			return *value, nil
		}
	}
	return "", fmt.Errorf("%s is invalid", key)
}

func projectOptionalEnum(fields map[string]json.RawMessage, key string, allowed []string) (*string, error) {
	if _, ok := fields[key]; !ok {
		return nil, nil
	}
	value, err := projectRequiredEnum(fields, key, allowed)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func projectOptionalPosition(fields map[string]json.RawMessage) (*float64, error) {
	raw, ok := fields["position"]
	if !ok {
		return nil, nil
	}
	var value float64
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || math.Trunc(value) != value {
		return nil, errors.New("position must be a nonnegative integer")
	}
	if value == 0 {
		value = 0
	}
	return &value, nil
}

func createProject(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateProjectInput) (CreateProjectOutput, error) {
	var output CreateProjectOutput
	dueAt, err := projectDateTimeValue(input.DueAt)
	if err != nil {
		return output, err
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO projects (org_id, name, due_at, created_by_actor_type, created_by_actor_id)
		VALUES ($1::uuid, $2, $3::timestamptz, $4, $5::uuid)
		RETURNING id::text`, claims.OrganizationID, input.Name, dueAt, claims.ActorType, claims.ActorID).Scan(&output.ProjectID)
	return output, err
}

func archiveProject(ctx context.Context, tx pgx.Tx, orgID string, input ArchiveProjectInput) (ArchiveProjectOutput, error) {
	var id string
	err := tx.QueryRow(ctx, `
		UPDATE projects SET status = 'archived'
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'active'
		RETURNING id::text`, input.ProjectID, orgID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ArchiveProjectOutput{}, errors.New("project not found")
	}
	if err != nil {
		return ArchiveProjectOutput{}, err
	}
	return ArchiveProjectOutput{Archived: true, ProjectID: id}, nil
}

func restoreProject(ctx context.Context, tx pgx.Tx, orgID string, input RestoreProjectInput) (RestoreProjectOutput, error) {
	var id string
	err := tx.QueryRow(ctx, `
		UPDATE projects SET status = 'active'
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'archived'
		RETURNING id::text`, input.ProjectID, orgID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return RestoreProjectOutput{}, errors.New("project not found or is not archived")
	}
	if err != nil {
		return RestoreProjectOutput{}, err
	}
	return RestoreProjectOutput{ProjectID: id, Restored: true}, nil
}

func createProjectTask(ctx context.Context, tx pgx.Tx, orgID string, input CreateProjectTaskInput) (CreateProjectTaskOutput, error) {
	var projectStatus string
	err := tx.QueryRow(ctx, `
		SELECT status FROM projects WHERE id = $1::uuid AND org_id = $2::uuid FOR UPDATE`, input.ProjectID, orgID).Scan(&projectStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateProjectTaskOutput{}, errors.New("project not found")
	}
	if err != nil {
		return CreateProjectTaskOutput{}, err
	}
	if projectStatus != "active" {
		return CreateProjectTaskOutput{}, errors.New("project is not active")
	}
	if input.ParentTaskID != nil {
		var parentProjectID string
		err := tx.QueryRow(ctx, `
			SELECT project_id::text FROM project_tasks WHERE id = $1::uuid AND org_id = $2::uuid`, *input.ParentTaskID, orgID).Scan(&parentProjectID)
		if errors.Is(err, pgx.ErrNoRows) {
			return CreateProjectTaskOutput{}, errors.New("parent task not found")
		}
		if err != nil {
			return CreateProjectTaskOutput{}, err
		}
		if parentProjectID != input.ProjectID {
			return CreateProjectTaskOutput{}, errors.New("parent task belongs to a different project")
		}
	}
	var maxPosition int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(position), 0) FROM project_tasks
		WHERE project_id = $1::uuid AND org_id = $2::uuid AND status = 'todo'`, input.ProjectID, orgID).Scan(&maxPosition); err != nil {
		return CreateProjectTaskOutput{}, err
	}
	priority := "medium"
	if input.Priority != nil {
		priority = *input.Priority
	}
	dueAt, err := projectDateTimeValue(input.DueAt)
	if err != nil {
		return CreateProjectTaskOutput{}, err
	}
	var output CreateProjectTaskOutput
	var position int64
	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO project_tasks (org_id, project_id, parent_task_id, title, status, priority, assignee_user_id, due_at, position)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'todo', $5, $6::uuid, $7::timestamptz, $8)
		RETURNING id::text, position, created_at`, orgID, input.ProjectID, input.ParentTaskID, input.Title, priority, input.AssigneeUserID, dueAt, maxPosition+1).Scan(&output.TaskID, &position, &createdAt)
	if err != nil {
		return output, err
	}
	output.ProjectID = input.ProjectID
	output.Title = input.Title
	output.ParentTaskID = input.ParentTaskID
	output.Status = "todo"
	output.Priority = priority
	output.AssigneeUserID = input.AssigneeUserID
	output.Position = position
	output.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	if input.DueAt != nil {
		parsed, parseErr := parseProjectDateTime(*input.DueAt)
		if parseErr != nil {
			return CreateProjectTaskOutput{}, parseErr
		}
		formatted := parsed.UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano)
		output.DueAt = &formatted
	}
	return output, nil
}

func deleteProjectTask(ctx context.Context, tx pgx.Tx, orgID string, input DeleteProjectTaskInput) (DeleteProjectTaskOutput, error) {
	createdAt, err := parseProjectDateTime(input.CreatedAt)
	if err != nil {
		return DeleteProjectTaskOutput{}, errors.New("invalid task snapshot")
	}
	dueAt, err := projectSnapshotTimeValue(input.DueAt)
	if err != nil {
		return DeleteProjectTaskOutput{}, err
	}
	var deletedID string
	err = tx.QueryRow(ctx, `
		DELETE FROM project_tasks task
		WHERE task.id = $1::uuid AND task.org_id = $2::uuid AND task.project_id = $3::uuid
		  AND task.parent_task_id IS NOT DISTINCT FROM $4::uuid
		  AND task.title = $5 AND task.status = $6 AND task.priority = $7
		  AND task.assignee_user_id IS NOT DISTINCT FROM $8::uuid
		  AND task.due_at IS NOT DISTINCT FROM $9::timestamptz
		  AND task.position = $10 AND task.note IS NOT DISTINCT FROM $11::text
		  AND task.created_at = $12::timestamptz
		  AND NOT EXISTS (SELECT 1 FROM project_tasks child WHERE child.org_id = task.org_id AND child.parent_task_id = task.id)
		RETURNING task.id::text`, input.TaskID, orgID, input.ProjectID, input.ParentTaskID, input.Title, input.Status, input.Priority, input.AssigneeUserID, dueAt, input.Position, input.Note, createdAt).Scan(&deletedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return DeleteProjectTaskOutput{}, errors.New("task changed or has child tasks")
	}
	if err != nil {
		return DeleteProjectTaskOutput{}, err
	}
	input.TaskID = deletedID
	return DeleteProjectTaskOutput{ProjectTaskSnapshot: input.ProjectTaskSnapshot}, nil
}

func restoreProjectTask(ctx context.Context, tx pgx.Tx, orgID string, input RestoreProjectTaskInput) (RestoreProjectTaskOutput, error) {
	snapshotJSON, err := marshalJS(input.ProjectTaskSnapshot)
	if err != nil {
		return RestoreProjectTaskOutput{}, err
	}
	var hasDeleteReceipt bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM action_receipts
			WHERE org_id = $1::uuid AND capability_id = $2 AND ok = true AND outcome = 'known'
			  AND data = $3::jsonb
		)`, orgID, deleteProjectTaskCapabilityID, snapshotJSON).Scan(&hasDeleteReceipt); err != nil {
		return RestoreProjectTaskOutput{}, err
	}
	if !hasDeleteReceipt {
		return RestoreProjectTaskOutput{}, errors.New("task restore requires a matching successful delete receipt")
	}
	createdAt, err := parseProjectDateTime(input.CreatedAt)
	if err != nil {
		return RestoreProjectTaskOutput{}, errors.New("invalid task snapshot")
	}
	dueAt, err := projectSnapshotTimeValue(input.DueAt)
	if err != nil {
		return RestoreProjectTaskOutput{}, err
	}
	var projectStatus string
	err = tx.QueryRow(ctx, `SELECT status FROM projects WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE`, input.ProjectID, orgID).Scan(&projectStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return RestoreProjectTaskOutput{}, errors.New("project not found")
	}
	if err != nil {
		return RestoreProjectTaskOutput{}, err
	}
	if projectStatus != "active" {
		return RestoreProjectTaskOutput{}, errors.New("project is not active")
	}
	if input.ParentTaskID != nil {
		var parentProjectID string
		if err := tx.QueryRow(ctx, `SELECT project_id::text FROM project_tasks WHERE id=$1::uuid AND org_id=$2::uuid`, *input.ParentTaskID, orgID).Scan(&parentProjectID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return RestoreProjectTaskOutput{}, errors.New("parent task not found")
			}
			return RestoreProjectTaskOutput{}, err
		}
		if parentProjectID != input.ProjectID {
			return RestoreProjectTaskOutput{}, errors.New("parent task belongs to a different project")
		}
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO project_tasks (id, org_id, project_id, parent_task_id, title, status, priority, assignee_user_id, due_at, position, note, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid, $9::timestamptz, $10, $11, $12::timestamptz)`,
		input.TaskID, orgID, input.ProjectID, input.ParentTaskID, input.Title, input.Status, input.Priority, input.AssigneeUserID, dueAt, input.Position, input.Note, createdAt)
	if err != nil {
		return RestoreProjectTaskOutput{}, errors.New("task cannot be restored because its ID is already in use")
	}
	return RestoreProjectTaskOutput{ProjectTaskSnapshot: input.ProjectTaskSnapshot}, nil
}

func projectSnapshotTimeValue(value *string) (any, error) {
	if value == nil {
		return nil, nil
	}
	parsed, err := parseProjectDateTime(*value)
	if err != nil {
		return nil, errors.New("task snapshot contains an invalid datetime")
	}
	return parsed.UTC(), nil
}

func moveProjectTask(ctx context.Context, tx pgx.Tx, orgID string, input MoveProjectTaskInput) (MoveProjectTaskOutput, error) {
	if err := lockActiveProjectForTask(ctx, tx, orgID, input.TaskID); err != nil {
		return MoveProjectTaskOutput{}, err
	}
	var previousStatus string
	var previousPosition int64
	if err := tx.QueryRow(ctx, `SELECT status, position FROM project_tasks WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE`, input.TaskID, orgID).Scan(&previousStatus, &previousPosition); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MoveProjectTaskOutput{}, errors.New("task not found")
		}
		return MoveProjectTaskOutput{}, err
	}
	position := previousPosition
	if input.Position != nil {
		position = int64(*input.Position)
	}
	var newPosition int64
	err := tx.QueryRow(ctx, `
		UPDATE project_tasks SET status=$1, position=$2
		WHERE id=$3::uuid AND org_id=$4::uuid
		RETURNING position`, input.Status, position, input.TaskID, orgID).Scan(&newPosition)
	if err != nil {
		return MoveProjectTaskOutput{}, err
	}
	return MoveProjectTaskOutput{
		Moved: true, Status: input.Status, Position: newPosition, TaskID: input.TaskID,
		RestoreStatus: previousStatus, RestorePosition: previousPosition,
		ExpectedStatus: input.Status, ExpectedPosition: newPosition,
	}, nil
}

func restoreProjectTaskPlacement(ctx context.Context, tx pgx.Tx, orgID string, input RestoreProjectTaskPlacementInput) (RestoreProjectTaskPlacementOutput, error) {
	var projectStatus string
	err := tx.QueryRow(ctx, `
		SELECT p.status FROM project_tasks t JOIN projects p ON p.id=t.project_id AND p.org_id=t.org_id
		WHERE t.id=$1::uuid AND t.org_id=$2::uuid FOR UPDATE OF p, t`, input.TaskID, orgID).Scan(&projectStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return RestoreProjectTaskPlacementOutput{}, errors.New("task not found")
	}
	if err != nil {
		return RestoreProjectTaskPlacementOutput{}, err
	}
	if projectStatus != "active" {
		return RestoreProjectTaskPlacementOutput{}, errors.New("project is not active")
	}
	var id string
	err = tx.QueryRow(ctx, `
		UPDATE project_tasks SET status=$1, position=$2
		WHERE id=$3::uuid AND org_id=$4::uuid AND status=$5 AND position=$6
		RETURNING id::text`, input.RestoreStatus, input.RestorePosition, input.TaskID, orgID, input.ExpectedStatus, input.ExpectedPosition).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return RestoreProjectTaskPlacementOutput{}, errors.New("task placement changed since this action")
	}
	if err != nil {
		return RestoreProjectTaskPlacementOutput{}, err
	}
	return RestoreProjectTaskPlacementOutput{
		Moved: true, TaskID: id, Status: input.ExpectedStatus, Position: input.ExpectedPosition, RestoreStatus: input.ExpectedStatus, RestorePosition: input.ExpectedPosition,
		ExpectedStatus: input.RestoreStatus, ExpectedPosition: input.RestorePosition,
	}, nil
}

func assignProjectTask(ctx context.Context, tx pgx.Tx, orgID string, input AssignProjectTaskInput) (AssignProjectTaskOutput, error) {
	if err := lockActiveProjectForTask(ctx, tx, orgID, input.TaskID); err != nil {
		return AssignProjectTaskOutput{}, err
	}
	var previousAssignee sql.NullString
	if err := tx.QueryRow(ctx, `SELECT assignee_user_id::text FROM project_tasks WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE`, input.TaskID, orgID).Scan(&previousAssignee); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return AssignProjectTaskOutput{}, errors.New("task not found")
		}
		return AssignProjectTaskOutput{}, err
	}
	var id string
	err := tx.QueryRow(ctx, `
		UPDATE project_tasks SET assignee_user_id = $1::uuid
		WHERE id = $2::uuid AND org_id = $3::uuid
		RETURNING id::text`, input.AssigneeUserID, input.TaskID, orgID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return AssignProjectTaskOutput{}, errors.New("task not found")
	}
	if err != nil {
		return AssignProjectTaskOutput{}, err
	}
	return AssignProjectTaskOutput{Assigned: true, TaskID: id, RestoreAssigneeUserID: nullableString(previousAssignee), ExpectedAssigneeUserID: input.AssigneeUserID}, nil
}

func restoreProjectTaskAssignee(ctx context.Context, tx pgx.Tx, orgID string, input RestoreProjectTaskAssigneeInput) (RestoreProjectTaskAssigneeOutput, error) {
	if err := lockActiveProjectForTask(ctx, tx, orgID, input.TaskID); err != nil {
		return RestoreProjectTaskAssigneeOutput{}, err
	}
	var id string
	err := tx.QueryRow(ctx, `
		UPDATE project_tasks SET assignee_user_id=$1::uuid
		WHERE id=$2::uuid AND org_id=$3::uuid AND assignee_user_id IS NOT DISTINCT FROM $4::uuid
		RETURNING id::text`, input.RestoreAssigneeUserID, input.TaskID, orgID, input.ExpectedAssigneeUserID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return RestoreProjectTaskAssigneeOutput{}, errors.New("task assignment changed since this action")
	}
	if err != nil {
		return RestoreProjectTaskAssigneeOutput{}, err
	}
	return RestoreProjectTaskAssigneeOutput{
		Assigned: true, TaskID: id, AssigneeUserID: input.ExpectedAssigneeUserID, RestoreAssigneeUserID: input.ExpectedAssigneeUserID,
		ExpectedAssigneeUserID: input.RestoreAssigneeUserID,
	}, nil
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func lockActiveProjectForTask(ctx context.Context, tx pgx.Tx, orgID, taskID string) error {
	var status string
	err := tx.QueryRow(ctx, `
		SELECT p.status
		FROM project_tasks t
		JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
		WHERE t.id = $1::uuid AND t.org_id = $2::uuid AND p.org_id = $2::uuid
		FOR UPDATE OF p`, taskID, orgID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("task not found")
	}
	if err != nil {
		return err
	}
	if status != "active" {
		return errors.New("project is not active")
	}
	return nil
}
