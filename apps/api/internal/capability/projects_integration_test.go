package capability

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

func newProjectsFixture(t *testing.T) *executorFixture {
	t.Helper()
	fx := newExecutorFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'projects.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	return fx
}

func projectsClaims(fx *executorFixture, capabilityID string, raw json.RawMessage, intent string) authbridge.CapabilityClaims {
	digest, err := InputHash(raw)
	if err != nil {
		fx.t.Fatal(err)
	}
	actorID := fx.userID
	return authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		Subject:        fx.userID,
		OrganizationID: fx.orgID,
		CapabilityID:   capabilityID,
		InputSHA256:    digest,
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    []string{"projects.write"},
		AuthSessionID:  fx.authSessionID,
		IntentID:       intent,
	}
}

func projectReadClaims(fx *executorFixture, capabilityID string, raw json.RawMessage) authbridge.CapabilityClaims {
	digest, err := InputHash(raw)
	if err != nil {
		fx.t.Fatal(err)
	}
	actorID := fx.userID
	return authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		Subject:        fx.userID,
		OrganizationID: fx.orgID,
		CapabilityID:   capabilityID,
		InputSHA256:    digest,
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    []string{"projects.read"},
		AuthSessionID:  fx.authSessionID,
	}
}

func grantProjectsRead(t *testing.T, fx *executorFixture) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		VALUES ($1::uuid, 'projects.read', $2::uuid) ON CONFLICT DO NOTHING`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
}

func executeProjectCapability(fx *executorFixture, capabilityID, input, intent string) (Result, error) {
	raw := json.RawMessage(input)
	return fx.executor.Execute(fx.ctx, projectsClaims(fx, capabilityID, raw, intent), capabilityID, raw)
}

func TestGoProjectsLifecyclePreservesDefaultsAttributionAuditAndReceiptReplay(t *testing.T) {
	fx := newProjectsFixture(t)
	dueAt := "2030-01-02T03:04:05.123456789Z"
	createProjectInput := `{"name":"Warehouse relayout","dueAt":"` + dueAt + `"}`
	first, err := executeProjectCapability(fx, createProjectCapabilityID, createProjectInput, "projects-create-once")
	if err != nil || !first.OK {
		t.Fatalf("create project result=%+v err=%v", first, err)
	}
	second, err := executeProjectCapability(fx, createProjectCapabilityID, createProjectInput, "projects-create-once")
	var created, replayed CreateProjectOutput
	if decodeErr := json.Unmarshal(first.Data, &created); decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if err != nil || !second.OK || !second.Replayed {
		t.Fatalf("same-intent project replay=%+v err=%v, want original result", second, err)
	}
	if err := json.Unmarshal(second.Data, &replayed); err != nil || created.ProjectID == "" || replayed.ProjectID != created.ProjectID {
		t.Fatalf("create project data=%s replay=%s err=%v, want same project id", first.Data, second.Data, err)
	}
	var createdByType string
	var createdByID string
	var storedDueAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT created_by_actor_type, created_by_actor_id::text, due_at
		FROM projects WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, created.ProjectID).
		Scan(&createdByType, &createdByID, &storedDueAt); err != nil {
		t.Fatal(err)
	}
	wantDueAt, _ := time.Parse(time.RFC3339Nano, dueAt)
	if createdByType != "human" || createdByID != fx.userID || !storedDueAt.Equal(wantDueAt.Truncate(time.Millisecond)) {
		t.Fatalf("project row actor=(%s,%s) dueAt=%s, want authenticated actor and JavaScript millisecond date %s", createdByType, createdByID, storedDueAt, wantDueAt.Truncate(time.Millisecond))
	}

	createTaskInput := `{"projectId":"` + created.ProjectID + `","title":"Measure the floor"}`
	taskResult, err := executeProjectCapability(fx, createProjectTaskCapabilityID, createTaskInput, "projects-task-defaults")
	if err != nil || !taskResult.OK {
		t.Fatalf("create task result=%+v err=%v", taskResult, err)
	}
	var firstTask CreateProjectTaskOutput
	if err := json.Unmarshal(taskResult.Data, &firstTask); err != nil || firstTask.TaskID == "" {
		t.Fatalf("create task data=%s err=%v", taskResult.Data, err)
	}
	var status, priority string
	var position int
	var assignee, parent sql.NullString
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, priority, position, assignee_user_id::text, parent_task_id::text
		FROM project_tasks WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, firstTask.TaskID).
		Scan(&status, &priority, &position, &assignee, &parent); err != nil {
		t.Fatal(err)
	}
	if status != "todo" || priority != "medium" || position != 1 || assignee.Valid || parent.Valid {
		t.Fatalf("task defaults status=%s priority=%s position=%d assignee=%+v parent=%+v", status, priority, position, assignee, parent)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND payload #> '{input,priority}' IS NULL`, fx.orgID, createProjectTaskCapabilityID); got != 1 {
		t.Fatalf("task create audit omitted the optional priority in %d/1 events", got)
	}

	childInput := `{"projectId":"` + created.ProjectID + `","title":"Order racking","parentTaskId":"` + firstTask.TaskID + `","priority":"high"}`
	childResult, err := executeProjectCapability(fx, createProjectTaskCapabilityID, childInput, "projects-task-child")
	if err != nil || !childResult.OK {
		t.Fatalf("create child task result=%+v err=%v", childResult, err)
	}
	var secondTask CreateProjectTaskOutput
	if err := json.Unmarshal(childResult.Data, &secondTask); err != nil {
		t.Fatal(err)
	}
	if got := fx.count(`SELECT count(*) FROM project_tasks WHERE id=$1::uuid AND org_id=$2::uuid AND parent_task_id=$3::uuid AND priority='high' AND position=2`, secondTask.TaskID, fx.orgID, firstTask.TaskID); got != 1 {
		t.Fatalf("child task row count=%d, want parent, priority, and next todo position", got)
	}

	assignResult, err := executeProjectCapability(fx, assignProjectTaskCapabilityID, `{"taskId":"`+firstTask.TaskID+`","assigneeUserId":"`+fx.userID+`"}`, "projects-assign-task")
	if err != nil || !assignResult.OK || string(assignResult.Data) != `{"assigned":true}` {
		t.Fatalf("assign result=%+v err=%v", assignResult, err)
	}
	moveResult, err := executeProjectCapability(fx, moveProjectTaskCapabilityID, `{"taskId":"`+firstTask.TaskID+`","status":"doing","position":0}`, "projects-move-task")
	if err != nil || !moveResult.OK || string(moveResult.Data) != `{"moved":true,"status":"doing"}` {
		t.Fatalf("move result=%+v err=%v", moveResult, err)
	}
	if got := fx.count(`SELECT count(*) FROM project_tasks WHERE id=$1::uuid AND org_id=$2::uuid AND status='doing' AND position=0 AND assignee_user_id=$3::uuid`, firstTask.TaskID, fx.orgID, fx.userID); got != 1 {
		t.Fatalf("moved and assigned task count=%d, want 1", got)
	}
	moveWithoutPosition, err := executeProjectCapability(fx, moveProjectTaskCapabilityID, `{"taskId":"`+secondTask.TaskID+`","status":"done"}`, "projects-move-without-position")
	if err != nil || !moveWithoutPosition.OK {
		t.Fatalf("move without optional position result=%+v err=%v", moveWithoutPosition, err)
	}
	if got := fx.count(`SELECT count(*) FROM project_tasks WHERE id=$1::uuid AND org_id=$2::uuid AND status='done' AND position=2`, secondTask.TaskID, fx.orgID); got != 1 {
		t.Fatalf("move without position changed the task's position, matching rows=%d", got)
	}
	clearAssignee, err := executeProjectCapability(fx, assignProjectTaskCapabilityID, `{"taskId":"`+secondTask.TaskID+`"}`, "projects-clear-assignee")
	if err != nil || !clearAssignee.OK || string(clearAssignee.Data) != `{"assigned":true}` {
		t.Fatalf("clear assignee result=%+v err=%v", clearAssignee, err)
	}
	if got := fx.count(`SELECT count(*) FROM project_tasks WHERE id=$1::uuid AND org_id=$2::uuid AND assignee_user_id IS NULL`, secondTask.TaskID, fx.orgID); got != 1 {
		t.Fatalf("omitted assignment did not clear the assignee, matching rows=%d", got)
	}
	archiveResult, err := executeProjectCapability(fx, archiveProjectCapabilityID, `{"projectId":"`+created.ProjectID+`"}`, "projects-archive")
	if err != nil || !archiveResult.OK || string(archiveResult.Data) != `{"archived":true}` {
		t.Fatalf("archive result=%+v err=%v", archiveResult, err)
	}
	if got := fx.count(`SELECT count(*) FROM projects WHERE id=$1::uuid AND org_id=$2::uuid AND status='archived'`, created.ProjectID, fx.orgID); got != 1 {
		t.Fatalf("archived project count=%d, want 1", got)
	}
	_, err = executeProjectCapability(fx, createProjectTaskCapabilityID, `{"projectId":"`+created.ProjectID+`","title":"Too late"}`, "projects-task-after-archive")
	if err == nil || err.Error() != "project is not active" {
		t.Fatalf("create task after archive error=%v, want project is not active", err)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid`, fx.orgID); got != 8 {
		t.Fatalf("receipt count=%d, want one per successful action and no replay receipt", got)
	}
	if got := fx.count(`
		SELECT count(*) FROM ledger_events
		WHERE org_id=$1::uuid AND kind='capability.executed' AND actor_type='human' AND actor_id=$2::uuid`, fx.orgID, fx.userID); got != 8 {
		t.Fatalf("human attributed execution events=%d, want 8", got)
	}
}

func TestGoProjectsEnforcesModuleAndGrantedPermissionBeforeWrites(t *testing.T) {
	fx := newProjectsFixture(t)
	fx.setModuleList(`["accounting"]`)
	result, err := executeProjectCapability(fx, createProjectCapabilityID, `{"name":""}`, "projects-disabled-module")
	if err != nil || result.OK || result.Error != `module "projects" is disabled for this organization` {
		t.Fatalf("disabled module result=%+v err=%v", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM projects WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("disabled module created %d projects", got)
	}
	fx.setModuleList(`null`)
	if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM role_permissions WHERE role_id=$1::uuid AND org_id=$2::uuid AND permission_key='projects.write'`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	result, err = executeProjectCapability(fx, createProjectCapabilityID, `{"name":"Denied"}`, "projects-denied-permission")
	if err != nil || result.OK || result.Error != "forbidden: missing permission: projects.write" {
		t.Fatalf("missing grant result=%+v err=%v", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM projects WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("missing permission created %d projects", got)
	}
}

func TestGoProjectsRechecksVerifiedIdentityAndOrganizationMembership(t *testing.T) {
	fx := newProjectsFixture(t)
	raw := json.RawMessage(`{"name":"Identity must still be valid"}`)
	claims := projectsClaims(fx, createProjectCapabilityID, raw, "projects-invalid-session")
	claims.AuthSessionID = "missing-project-session"
	if _, err := fx.executor.Execute(fx.ctx, claims, createProjectCapabilityID, raw); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("missing verified session error=%v, want ErrSessionInvalid", err)
	}
	claims = projectsClaims(fx, createProjectCapabilityID, raw, "projects-foreign-org")
	claims.OrganizationID = fx.otherOrgID
	if _, err := fx.executor.Execute(fx.ctx, claims, createProjectCapabilityID, raw); !errors.Is(err, ErrNotMember) {
		t.Fatalf("unaffiliated organization error=%v, want ErrNotMember", err)
	}
	if got := fx.count(`SELECT count(*) FROM projects WHERE org_id IN ($1::uuid,$2::uuid)`, fx.orgID, fx.otherOrgID); got != 0 {
		t.Fatalf("identity failures created %d projects", got)
	}
}

func TestGoProjectsHidesMissingAndCrossOrganizationRows(t *testing.T) {
	fx := newProjectsFixture(t)
	var foreignProjectID, foreignTaskID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO projects (org_id, name) VALUES ($1::uuid, 'Foreign project') RETURNING id::text`, fx.otherOrgID).Scan(&foreignProjectID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO project_tasks (org_id, project_id, title) VALUES ($1::uuid, $2::uuid, 'Foreign task') RETURNING id::text`, fx.otherOrgID, foreignProjectID).Scan(&foreignTaskID); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		id, input, want string
	}{
		{archiveProjectCapabilityID, `{"projectId":"` + foreignProjectID + `"}`, "project not found"},
		{archiveProjectCapabilityID, `{"projectId":"` + executorUUID(t) + `"}`, "project not found"},
		{createProjectTaskCapabilityID, `{"projectId":"` + foreignProjectID + `","title":"Should stay hidden"}`, "project not found"},
		{createProjectTaskCapabilityID, `{"projectId":"` + executorUUID(t) + `","title":"Missing project"}`, "project not found"},
		{moveProjectTaskCapabilityID, `{"taskId":"` + foreignTaskID + `","status":"done"}`, "task not found"},
		{assignProjectTaskCapabilityID, `{"taskId":"` + foreignTaskID + `"}`, "task not found"},
	} {
		_, err := executeProjectCapability(fx, test.id, test.input, "")
		if err == nil || err.Error() != test.want {
			t.Errorf("%s input=%s error=%v, want %q", test.id, test.input, err, test.want)
		}
	}
	if got := fx.count(`SELECT count(*) FROM projects WHERE id=$1::uuid AND org_id=$2::uuid AND status='active'`, foreignProjectID, fx.otherOrgID); got != 1 {
		t.Fatalf("foreign project was changed, matching rows=%d", got)
	}
	if got := fx.count(`SELECT count(*) FROM project_tasks WHERE id=$1::uuid AND org_id=$2::uuid AND status='todo' AND assignee_user_id IS NULL`, foreignTaskID, fx.otherOrgID); got != 1 {
		t.Fatalf("foreign task was changed, matching rows=%d", got)
	}
}

func TestGoProjectsRequiresExactStoredApprovalPayload(t *testing.T) {
	fx := newProjectsFixture(t)
	fx.addPolicy("projects.*", "read", nil)
	raw := json.RawMessage(`{"name":"Approved project","unknown":"stripped by TypeScript object schema"}`)
	request := SystemClaims{
		OrganizationID: fx.orgID,
		CapabilityID:   createProjectCapabilityID,
		Permission:     "projects.write",
		IntentID:       executorUUID(t),
	}
	pending, err := fx.executor.ExecuteSystem(fx.ctx, request, raw)
	if err != nil || pending.OK || !pending.PendingApproval || pending.ApprovalID == "" {
		t.Fatalf("approval request result=%+v err=%v", pending, err)
	}
	if got := fx.count(`SELECT count(*) FROM projects WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("pending approval created %d projects", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("pending approval created %d effect receipts", got)
	}
	var storedPayload []byte
	if err := fx.owner.QueryRow(fx.ctx, `SELECT payload::text FROM approvals WHERE id=$1::uuid AND org_id=$2::uuid`, pending.ApprovalID, fx.orgID).Scan(&storedPayload); err != nil {
		t.Fatal(err)
	}
	var storedFields map[string]json.RawMessage
	if err := json.Unmarshal(storedPayload, &storedFields); err != nil {
		t.Fatal(err)
	}
	if len(storedFields) != 1 || string(storedFields["name"]) != `"Approved project"` {
		t.Fatalf("stored approval payload=%s, want exact parsed legacy payload", storedPayload)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE approvals SET status='executing' WHERE id=$1::uuid AND org_id=$2::uuid`, pending.ApprovalID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	request.ApprovedApprovalID = pending.ApprovalID
	wrongPayload := json.RawMessage(`{"name":"Different project","unknown":"stripped by TypeScript object schema"}`)
	wrong, err := fx.executor.ExecuteSystem(fx.ctx, request, wrongPayload)
	if err != nil || wrong.OK || wrong.Error == "" {
		t.Fatalf("wrong approval payload result=%+v err=%v, want refusal", wrong, err)
	}
	if got := fx.count(`SELECT count(*) FROM projects WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("wrong approved payload created %d projects", got)
	}
	result, err := fx.executor.ExecuteSystem(fx.ctx, request, raw)
	if err != nil || !result.OK {
		t.Fatalf("approved exact payload result=%+v err=%v", result, err)
	}
	var created CreateProjectOutput
	if err := json.Unmarshal(result.Data, &created); err != nil {
		t.Fatal(err)
	}
	var actorType string
	var actorID *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT created_by_actor_type, created_by_actor_id::text FROM projects WHERE id=$1::uuid AND org_id=$2::uuid`, created.ProjectID, fx.orgID).Scan(&actorType, &actorID); err != nil {
		t.Fatal(err)
	}
	if actorType != "system" || actorID != nil {
		t.Fatalf("system-created project actor=(%s,%v), want system with null actor id", actorType, actorID)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='system' AND actor_id IS NULL`, fx.orgID, createProjectCapabilityID); got != 1 {
		t.Fatalf("system execution audit rows=%d, want one null-id system actor", got)
	}
}

func TestGoProjectsRollsBackMutationAndReceiptWhenAuditAppendFails(t *testing.T) {
	fx := newProjectsFixture(t)
	functionName := "go_projects_fail_ledger_" + strings.ReplaceAll(fx.orgID, "-", "")
	triggerName := functionName + "_trigger"
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE FUNCTION public.%s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'fixture project audit failure'; END
		$$`, functionName)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON ledger_events`, triggerName)); err != nil {
			t.Errorf("drop project audit fixture trigger: %v", err)
		}
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS public.%s()`, functionName)); err != nil {
			t.Errorf("drop project audit fixture function: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE TRIGGER %s BEFORE INSERT ON ledger_events FOR EACH ROW
		WHEN (NEW.org_id = '%s'::uuid AND NEW.kind = 'capability.executed' AND NEW.capability_id = '%s')
		EXECUTE FUNCTION public.%s()`, triggerName, fx.orgID, createProjectCapabilityID, functionName)); err != nil {
		t.Fatal(err)
	}
	_, err := executeProjectCapability(fx, createProjectCapabilityID, `{"name":"Rollback project"}`, "projects-audit-rollback")
	if err == nil {
		t.Fatal("project write succeeded despite audit append failure")
	}
	if got := fx.count(`SELECT count(*) FROM projects WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("audit failure left %d project rows", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("audit failure left %d action receipts", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, createProjectCapabilityID); got != 0 {
		t.Fatalf("audit failure left %d capability events", got)
	}
}

func TestGoProjectsReadBoardMatchesLegacyColumnsAndAuditBehavior(t *testing.T) {
	fx := newProjectsFixture(t)
	grantProjectsRead(t, fx)
	var projectID string
	if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO projects (org_id, name) VALUES ($1::uuid, 'Board parity') RETURNING id::text`, fx.orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	var foreignProjectID string
	if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO projects (org_id, name) VALUES ($1::uuid, 'Foreign board') RETURNING id::text`, fx.otherOrgID).Scan(&foreignProjectID); err != nil {
		t.Fatal(err)
	}
	var todoLaterID, todoEarlierID, doingID, doneID string
	for _, task := range []struct {
		id     *string
		title  string
		status string
		pos    int
		dueAt  *time.Time
	}{
		{&todoLaterID, "Todo later", "todo", 5, nil},
		{&todoEarlierID, "Todo earlier", "todo", 1, projectTimePointer(time.Date(2026, 8, 10, 14, 30, 1, 987_654_000, time.UTC))},
		{&doingID, "In progress", "doing", 2, nil},
		{&doneID, "Complete", "done", 0, nil},
	} {
		if err := fx.owner.QueryRow(fx.ctx, `
			INSERT INTO project_tasks (org_id, project_id, title, status, position, due_at)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
			RETURNING id::text`, fx.orgID, projectID, task.title, task.status, task.pos, task.dueAt).Scan(task.id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO project_tasks (org_id, project_id, title)
		VALUES ($1::uuid, $2::uuid, 'Foreign task')`, fx.otherOrgID, foreignProjectID); err != nil {
		t.Fatal(err)
	}

	before := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, ProjectBoardReadCapabilityID)
	boardInput := json.RawMessage(`{"projectId":"` + projectID + `"}`)
	board, err := fx.executor.Execute(fx.ctx, projectReadClaims(fx, ProjectBoardReadCapabilityID, boardInput), ProjectBoardReadCapabilityID, boardInput)
	if err != nil || !board.OK {
		t.Fatalf("board result=%+v err=%v", board, err)
	}
	var output ProjectBoardOutput
	if err := json.Unmarshal(board.Data, &output); err != nil {
		t.Fatalf("decode board data %s: %v", board.Data, err)
	}
	if len(output.Columns) != 3 || output.Columns[0].Status != "todo" || output.Columns[1].Status != "doing" || output.Columns[2].Status != "done" {
		t.Fatalf("board columns=%+v, want fixed todo, doing, done order", output.Columns)
	}
	if len(output.Columns[0].Tasks) != 2 || output.Columns[0].Tasks[0].ID != todoEarlierID || output.Columns[0].Tasks[1].ID != todoLaterID {
		t.Fatalf("todo tasks=%+v, want position order %s then %s", output.Columns[0].Tasks, todoEarlierID, todoLaterID)
	}
	if len(output.Columns[1].Tasks) != 1 || output.Columns[1].Tasks[0].ID != doingID ||
		len(output.Columns[2].Tasks) != 1 || output.Columns[2].Tasks[0].ID != doneID {
		t.Fatalf("doing/done tasks=%+v/%+v, want fixture tasks", output.Columns[1].Tasks, output.Columns[2].Tasks)
	}
	if output.Columns[0].Tasks[0].ParentTaskID != nil || output.Columns[0].Tasks[0].AssigneeUserID != nil ||
		output.Columns[0].Tasks[0].DueAt == nil || *output.Columns[0].Tasks[0].DueAt != "2026-08-10T14:30:01.987Z" ||
		output.Columns[0].Tasks[0].Position != 1 {
		t.Fatalf("board task=%+v, want nullable fields and JavaScript millisecond ISO precision", output.Columns[0].Tasks[0])
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, ProjectBoardReadCapabilityID); got != before+1 {
		t.Fatalf("board audit count=%d, want exactly one capability event", got)
	}

	for _, missingID := range []string{executorUUID(t), foreignProjectID} {
		raw := json.RawMessage(`{"projectId":"` + missingID + `"}`)
		result, err := fx.executor.Execute(fx.ctx, projectReadClaims(fx, ProjectBoardReadCapabilityID, raw), ProjectBoardReadCapabilityID, raw)
		if err != nil || !result.OK {
			t.Fatalf("empty board %s result=%+v err=%v", missingID, result, err)
		}
		var empty ProjectBoardOutput
		if err := json.Unmarshal(result.Data, &empty); err != nil {
			t.Fatal(err)
		}
		if len(empty.Columns) != 3 || empty.Columns[0].Status != "todo" || empty.Columns[1].Status != "doing" || empty.Columns[2].Status != "done" {
			t.Fatalf("empty board columns=%+v, want fixed columns", empty.Columns)
		}
		for _, column := range empty.Columns {
			if column.Tasks == nil || len(column.Tasks) != 0 {
				t.Fatalf("missing/foreign board column=%+v, want an empty task array", column)
			}
		}
	}
}

func TestGoProjectsReadCollectionPreservesLegacyOrderingLimitDatesAndNoAudit(t *testing.T) {
	fx := newProjectsFixture(t)
	grantProjectsRead(t, fx)
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO projects (org_id, name, due_at, created_at)
		SELECT $1::uuid, 'Project ' || n,
		       CASE WHEN n = 55 THEN '2026-10-01T09:30:00.987654Z'::timestamptz ELSE NULL END,
	       '2026-06-30T12:00:00.123456Z'::timestamptz + ((n - 1) * interval '1 second')
		FROM generate_series(1, 55) AS n`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO projects (org_id, name, created_at)
		VALUES ($1::uuid, 'Foreign project', '2099-01-01T00:00:00Z')`, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	fx.setModuleList(`[]`)

	before := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid`, fx.orgID)
	input := json.RawMessage(`{}`)
	result, err := fx.executor.ReadProjectCollection(fx.ctx, projectReadClaims(fx, ProjectCollectionReadOperationID, input), input)
	if err != nil || !result.OK {
		t.Fatalf("collection result=%+v err=%v", result, err)
	}
	var output ProjectCollectionOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode collection data %s: %v", result.Data, err)
	}
	if len(output.Projects) != 50 || output.Projects[0].Name != "Project 55" || output.Projects[49].Name != "Project 6" {
		t.Fatalf("collection size=%d first=%+v last=%+v, want newest 50 projects 55 through 6", len(output.Projects), output.Projects[0], output.Projects[len(output.Projects)-1])
	}
	if output.Projects[0].DueAt == nil || *output.Projects[0].DueAt != "2026-10-01T09:30:00.987Z" || output.Projects[0].CreatedAt != "2026-06-30T12:00:54.123Z" {
		t.Fatalf("newest project dates=%+v, want JS millisecond ISO strings", output.Projects[0])
	}
	if output.Projects[1].DueAt != nil {
		t.Fatalf("nullable due date=%v, want JSON null", output.Projects[1].DueAt)
	}
	for _, project := range output.Projects {
		if project.Name == "Foreign project" || project.Name == "Project 5" {
			t.Fatalf("collection included foreign or over-limit row %+v", project)
		}
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid`, fx.orgID); got != before {
		t.Fatalf("collection read appended ledger rows: before=%d after=%d", before, got)
	}
}

func TestGoProjectsReadCollectionRechecksSessionMembershipAndCurrentGrants(t *testing.T) {
	fx := newProjectsFixture(t)
	grantProjectsRead(t, fx)
	raw := json.RawMessage(`{}`)
	claims := projectReadClaims(fx, ProjectCollectionReadOperationID, raw)
	claims.AuthSessionID = "missing-project-read-session"
	if _, err := fx.executor.ReadProjectCollection(fx.ctx, claims, raw); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("missing active verified session err=%v, want ErrSessionInvalid", err)
	}
	claims = projectReadClaims(fx, ProjectCollectionReadOperationID, raw)
	claims.OrganizationID = fx.otherOrgID
	if _, err := fx.executor.ReadProjectCollection(fx.ctx, claims, raw); !errors.Is(err, ErrNotMember) {
		t.Fatalf("cross-organization membership err=%v, want ErrNotMember", err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM role_permissions WHERE role_id=$1::uuid AND org_id=$2::uuid AND permission_key='projects.read'`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	denied, err := fx.executor.ReadProjectCollection(fx.ctx, projectReadClaims(fx, ProjectCollectionReadOperationID, raw), raw)
	if err != nil || denied.OK || denied.Error != "forbidden: missing permission: projects.read" {
		t.Fatalf("revoked current grant result=%+v err=%v, want denied projects.read", denied, err)
	}
}

func TestGoProjectsReadBoardEnforcesModuleAndCurrentReadGrant(t *testing.T) {
	fx := newProjectsFixture(t)
	grantProjectsRead(t, fx)
	input := json.RawMessage(`{"projectId":"` + executorUUID(t) + `"}`)
	claims := projectReadClaims(fx, ProjectBoardReadCapabilityID, input)
	fx.setModuleList(`[]`)
	result, err := fx.executor.Execute(fx.ctx, claims, ProjectBoardReadCapabilityID, input)
	if err != nil || result.OK || result.Error != `module "projects" is disabled for this organization` {
		t.Fatalf("disabled Projects board result=%+v err=%v, want module gate", result, err)
	}
	fx.setModuleList(`null`)
	if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM role_permissions WHERE role_id=$1::uuid AND org_id=$2::uuid AND permission_key='projects.read'`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	result, err = fx.executor.Execute(fx.ctx, claims, ProjectBoardReadCapabilityID, input)
	if err != nil || result.OK || result.Error != "forbidden: missing permission: projects.read" {
		t.Fatalf("revoked current read grant result=%+v err=%v, want projects.read denial", result, err)
	}
}

func projectTimePointer(value time.Time) *time.Time { return &value }
