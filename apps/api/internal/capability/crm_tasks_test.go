package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestGoCRMTasksCapabilityContractsDispatchAndOutputs(t *testing.T) {
	assigneeID := "11111111-1111-4111-8111-111111111111"
	customerID := "22222222-2222-4222-8222-222222222222"
	taskID := "33333333-3333-4333-8333-333333333333"
	dueAt := "2026-10-01T09:30:00.123Z"
	cases := []struct {
		id         string
		raw        string
		permission string
		want       any
		wantJSON   string
		output     any
		outputJSON string
	}{
		{
			id:         createTaskCapabilityID,
			raw:        `{"title":"Call Acme","dueAt":"` + dueAt + `","assigneeUserId":"` + assigneeID + `","refType":"customer","refId":"` + customerID + `","note":"Follow up","unknown":true}`,
			permission: "crm.write",
			want: CreateTaskInput{
				Title: "Call Acme", DueAt: crmStringPointer(dueAt), AssigneeUserID: crmStringPointer(assigneeID),
				RefType: crmStringPointer("customer"), RefID: crmStringPointer(customerID), Note: crmStringPointer("Follow up"),
			},
			wantJSON:   `{"title":"Call Acme","dueAt":"` + dueAt + `","assigneeUserId":"` + assigneeID + `","refType":"customer","refId":"` + customerID + `","note":"Follow up"}`,
			output:     CreateTaskOutput{TaskID: taskID},
			outputJSON: `{"taskId":"` + taskID + `"}`,
		},
		{
			id:         completeTaskCapabilityID,
			raw:        `{"taskId":"` + taskID + `"}`,
			permission: "crm.write",
			want:       CompleteTaskInput{TaskID: taskID},
			wantJSON:   `{"taskId":"` + taskID + `"}`,
			output:     CompleteTaskOutput{Completed: true},
			outputJSON: `{"completed":true}`,
		},
		{
			id:         updateTaskDetailsCapabilityID,
			raw:        `{"taskId":"` + taskID + `","dueAt":null,"assigneeUserId":null}`,
			permission: "crm.write",
			want:       UpdateTaskDetailsInput{TaskID: taskID, DueAt: nil, DueAtSet: true, AssigneeUserID: nil, AssigneeUserIDSet: true},
			wantJSON:   `{"assigneeUserId":null,"dueAt":null,"taskId":"` + taskID + `"}`,
			output:     UpdateTaskDetailsOutput{TaskID: taskID, Previous: TaskDetailsPreviousState{DueAt: nil, AssigneeUserID: nil}},
			outputJSON: `{"taskId":"` + taskID + `","previous":{"dueAt":null,"assigneeUserId":null}}`,
		},
		{
			id:         restoreTaskDetailsCapabilityID,
			raw:        `{"taskId":"` + taskID + `","dueAt":"` + dueAt + `","assigneeUserId":"` + assigneeID + `"}`,
			permission: "crm.write",
			want:       UpdateTaskDetailsInput{TaskID: taskID, DueAt: crmStringPointer(dueAt), DueAtSet: true, AssigneeUserID: crmStringPointer(assigneeID), AssigneeUserIDSet: true},
			wantJSON:   `{"assigneeUserId":"` + assigneeID + `","dueAt":"` + dueAt + `","taskId":"` + taskID + `"}`,
			output:     UpdateTaskDetailsOutput{TaskID: taskID, Previous: TaskDetailsPreviousState{DueAt: crmStringPointer(dueAt), AssigneeUserID: crmStringPointer(assigneeID)}},
			outputJSON: `{"taskId":"` + taskID + `","previous":{"dueAt":"` + dueAt + `","assigneeUserId":"` + assigneeID + `"}}`,
		},
	}
	for _, test := range cases {
		t.Run(test.id, func(t *testing.T) {
			spec, exists := capabilitySpecs[test.id]
			if !supportedCapability(test.id) || !exists || spec.module != "crm" || spec.permission != test.permission || spec.risk != "write" {
				t.Fatalf("capability %q has spec %+v, supported=%t", test.id, spec, supportedCapability(test.id))
			}
			parsed, err := parseCRMTaskInput(test.id, json.RawMessage(test.raw))
			if err != nil {
				t.Fatal(err)
			}
			got, err := marshalJS(parsed)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != test.wantJSON {
				t.Fatalf("parseCRMTaskInput() = %s, want %s", got, test.wantJSON)
			}
			hash, err := canonicalInputHash(parsed)
			if err != nil || hash == "" {
				t.Fatalf("canonicalInputHash() = %q, %v", hash, err)
			}
			encodedOutput, err := marshalJS(test.output)
			if err != nil {
				t.Fatal(err)
			}
			if string(encodedOutput) != test.outputJSON {
				t.Fatalf("capability output = %s, want %s", encodedOutput, test.outputJSON)
			}
		})
	}
	for _, capabilityID := range []string{createTaskCapabilityID, completeTaskCapabilityID, updateTaskDetailsCapabilityID, restoreTaskDetailsCapabilityID} {
		if permission, ok := permissionForCapability(capabilityID); !ok || permission != "crm.write" {
			t.Fatalf("approval permission for %s = %q, %t", capabilityID, permission, ok)
		}
	}
}

func TestGoCRMTasksParsersMatchCRMContracts(t *testing.T) {
	validID := "11111111-1111-4111-8111-111111111111"
	input, err := ParseCreateTaskInput(json.RawMessage(`{"title":"  Call Acme  ","dueAt":"2026-10-01T09:30:00.123Z","refType":"customer","refId":"` + validID + `","note":"` + strings.Repeat("n", 2000) + `","unknown":true}`))
	if err != nil || input.Title != "  Call Acme  " || input.DueAt == nil || input.RefType == nil || input.RefID == nil || len(*input.Note) != 2000 {
		t.Fatalf("create task input=%+v err=%v", input, err)
	}
	if input.AssigneeUserID != nil {
		t.Fatalf("absent assigneeUserId = %q, want nil", *input.AssigneeUserID)
	}
	for _, raw := range []string{
		`{"title":""}`,
		`{"title":null}`,
		`{"title":"Call","dueAt":"2026-10-01T09:30:00+02:00"}`,
		`{"title":"Call","dueAt":"2026-10-01 09:30:00"}`,
		`{"title":"Call","dueAt":null}`,
		`{"title":"Call","assigneeUserId":"not-a-uuid"}`,
		`{"title":"Call","assigneeUserId":null}`,
		`{"title":"Call","refType":"` + strings.Repeat("r", 51) + `"}`,
		`{"title":"Call","refId":"not-a-uuid"}`,
		`{"title":"Call","note":"` + strings.Repeat("n", 2001) + `"}`,
	} {
		if _, err := ParseCreateTaskInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreateTaskInput accepted %s", raw)
		}
	}

	if _, err := ParseCompleteTaskInput(json.RawMessage(`{}`)); err == nil {
		t.Fatal("missing completeTask taskId was accepted")
	}
	if _, err := ParseCompleteTaskInput(json.RawMessage(`{"taskId":null}`)); err == nil {
		t.Fatal("null completeTask taskId was accepted")
	}
	completed, err := ParseCompleteTaskInput(json.RawMessage(`{"taskId":"any-string-value"}`))
	if err != nil || completed.TaskID != "any-string-value" {
		t.Fatalf("completeTask input=%+v err=%v, want unconstrained string taskId", completed, err)
	}

	for _, raw := range []string{
		`{"dueAt":null}`,
		`{"taskId":"not-a-uuid","dueAt":null}`,
		`{"taskId":"` + validID + `"}`,
		`{"taskId":"` + validID + `","dueAt":"2026-10-01T09:30:00+02:00"}`,
		`{"taskId":"` + validID + `","dueAt":"soon"}`,
		`{"taskId":"` + validID + `","dueAt":123}`,
		`{"taskId":"` + validID + `","assigneeUserId":"nope"}`,
	} {
		if _, err := ParseUpdateTaskDetailsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseUpdateTaskDetailsInput accepted %s", raw)
		}
	}
	cleared, err := ParseUpdateTaskDetailsInput(json.RawMessage(`{"taskId":"` + validID + `","dueAt":null,"unknown":true}`))
	if err != nil || !cleared.DueAtSet || cleared.DueAt != nil || cleared.AssigneeUserIDSet {
		t.Fatalf("cleared due date input=%+v err=%v", cleared, err)
	}
	reassigned, err := ParseUpdateTaskDetailsInput(json.RawMessage(`{"taskId":"` + validID + `","assigneeUserId":null}`))
	if err != nil || !reassigned.AssigneeUserIDSet || reassigned.AssigneeUserID != nil || reassigned.DueAtSet {
		t.Fatalf("cleared assignee input=%+v err=%v", reassigned, err)
	}
}

func TestGoCRMTasksEnforceTenancyCompletionAuditsAndReceiptReplay(t *testing.T) {
	fx := newExecutorFixture(t)
	localCustomerID := seedCRMDealCustomer(t, fx, fx.orgID, "Local customer")
	dueAt := "2026-10-01T09:30:00.123Z"
	createPayload := json.RawMessage(fmt.Sprintf(`{"title":"Call Acme","dueAt":%q,"assigneeUserId":%q,"refType":"customer","refId":%q,"note":"first follow-up"}`, dueAt, fx.userID, localCustomerID))
	first := executeCRMTask(t, fx, createTaskCapabilityID, createPayload, "crm-task-receipt-create")
	if !first.OK || first.Replayed {
		t.Fatalf("createTask result=%+v, want first success", first)
	}
	var created CreateTaskOutput
	if err := json.Unmarshal(first.Data, &created); err != nil {
		t.Fatal(err)
	}
	if !isUUID(created.TaskID) {
		t.Fatalf("createTask output=%+v, want UUID taskId", created)
	}
	replay := executeCRMTask(t, fx, createTaskCapabilityID, createPayload, "crm-task-receipt-create")
	var replayed CreateTaskOutput
	if err := json.Unmarshal(replay.Data, &replayed); err != nil {
		t.Fatal(err)
	}
	if !replay.OK || !replay.Replayed || replayed != created {
		t.Fatalf("createTask replay=%+v, want original result", replay)
	}
	var stored struct {
		OrgID          string
		Title          string
		DueAt          *time.Time
		AssigneeUserID *string
		RefType        *string
		RefID          *string
		Note           *string
		CreatedType    string
		CreatedByID    *string
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text,title,due_at,assignee_user_id::text,ref_type,ref_id::text,note,created_by_actor_type,created_by_actor_id::text
		FROM tasks WHERE id=$1::uuid`, created.TaskID).
		Scan(&stored.OrgID, &stored.Title, &stored.DueAt, &stored.AssigneeUserID, &stored.RefType, &stored.RefID, &stored.Note, &stored.CreatedType, &stored.CreatedByID); err != nil {
		t.Fatal(err)
	}
	if stored.OrgID != fx.orgID || stored.Title != "Call Acme" || stored.DueAt == nil || crmISOTime(stored.DueAt) == nil || *crmISOTime(stored.DueAt) != dueAt || stored.AssigneeUserID == nil || *stored.AssigneeUserID != fx.userID ||
		stored.RefType == nil || *stored.RefType != "customer" || stored.RefID == nil || *stored.RefID != localCustomerID || stored.Note == nil || *stored.Note != "first follow-up" ||
		stored.CreatedType != "human" || stored.CreatedByID == nil || *stored.CreatedByID != fx.userID {
		t.Fatalf("stored task=%+v, want normalized fields and human attribution", stored)
	}
	if got := fx.count(`SELECT count(*) FROM tasks WHERE org_id=$1::uuid AND title='Call Acme'`, fx.orgID); got != 1 {
		t.Fatalf("receipt replay inserted %d tasks, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":crm-task-receipt-create"); got != 1 {
		t.Fatalf("action receipts=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human' AND actor_id=$3::uuid`, fx.orgID, createTaskCapabilityID, fx.userID); got != 1 {
		t.Fatalf("createTask audit events=%d, want one", got)
	}

	defaultedRef := executeCRMTask(t, fx, createTaskCapabilityID, json.RawMessage(`{"title":"Ref defaults to customer"}`), "crm-task-ref-default")
	var defaultedRefOutput CreateTaskOutput
	if err := json.Unmarshal(defaultedRef.Data, &defaultedRefOutput); err != nil {
		t.Fatal(err)
	}
	if defaultedRefOutput.TaskID == "" {
		t.Fatalf("minimal createTask output=%+v", defaultedRefOutput)
	}

	completePayload := json.RawMessage(fmt.Sprintf(`{"taskId":%q}`, created.TaskID))
	completed := executeCRMTask(t, fx, completeTaskCapabilityID, completePayload, "crm-task-receipt-complete")
	if !completed.OK {
		t.Fatalf("completeTask result=%+v, want completed", completed)
	}
	var completedOutput CompleteTaskOutput
	if err := json.Unmarshal(completed.Data, &completedOutput); err != nil {
		t.Fatal(err)
	}
	if !completedOutput.Completed {
		t.Fatalf("completeTask output=%+v, want completed true", completedOutput)
	}
	completionReplay := executeCRMTask(t, fx, completeTaskCapabilityID, completePayload, "crm-task-receipt-complete")
	var completionReplayOutput CompleteTaskOutput
	if err := json.Unmarshal(completionReplay.Data, &completionReplayOutput); err != nil {
		t.Fatal(err)
	}
	if !completionReplay.OK || !completionReplay.Replayed || !completionReplayOutput.Completed {
		t.Fatalf("completeTask replay=%+v, want original result", completionReplay)
	}
	var doneAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT done_at FROM tasks WHERE id=$1::uuid`, created.TaskID).Scan(&doneAt); err != nil {
		t.Fatal(err)
	}
	if doneAt == nil {
		t.Fatal("completeTask left done_at null")
	}
	if _, err := executeCRMTaskWithError(fx, completeTaskCapabilityID, completePayload, "crm-task-receipt-complete-second"); err == nil || !strings.Contains(err.Error(), "task not found or already completed") {
		t.Fatalf("second completeTask error=%v", err)
	}

	foreignTaskID := seedCRMTask(t, fx, fx.otherOrgID, seedCRMTaskValues{Title: "Foreign task"})
	if _, err := executeCRMTaskWithError(fx, completeTaskCapabilityID, json.RawMessage(fmt.Sprintf(`{"taskId":%q}`, foreignTaskID)), "crm-task-foreign-complete"); err == nil || !strings.Contains(err.Error(), "task not found or already completed") {
		t.Fatalf("foreign completeTask error=%v", err)
	}
	if got := fx.count(`SELECT count(*) FROM tasks WHERE id=$1::uuid AND done_at IS NULL`, foreignTaskID); got != 1 {
		t.Fatalf("foreign task still open=%d, want unchanged", got)
	}

	dueUpdatePayload := json.RawMessage(fmt.Sprintf(`{"taskId":%q,"dueAt":%q}`, defaultedRefOutput.TaskID, "2026-11-15T08:00:00.000Z"))
	dueUpdate := executeCRMTask(t, fx, updateTaskDetailsCapabilityID, dueUpdatePayload, "crm-task-receipt-due")
	var dueUpdateOutput UpdateTaskDetailsOutput
	if err := json.Unmarshal(dueUpdate.Data, &dueUpdateOutput); err != nil {
		t.Fatal(err)
	}
	if dueUpdateOutput.TaskID != defaultedRefOutput.TaskID || dueUpdateOutput.Previous.DueAt != nil || dueUpdateOutput.Previous.AssigneeUserID != nil {
		t.Fatalf("due update output=%+v, want untouched previous state", dueUpdateOutput)
	}
	conflictingPayload := json.RawMessage(fmt.Sprintf(`{"taskId":%q,"dueAt":"2026-12-01T08:00:00.000Z"}`, defaultedRefOutput.TaskID))
	conflictResult, conflictErr := executeCRMTaskWithError(fx, updateTaskDetailsCapabilityID, conflictingPayload, "crm-task-receipt-due")
	if conflictErr != nil || conflictResult.OK || !strings.Contains(conflictResult.Error, "same action key used with a different payload") {
		t.Fatalf("updateTaskDetails conflicting payload under one intent result=%+v err=%v", conflictResult, conflictErr)
	}

	detailsTaskID := seedCRMTask(t, fx, fx.orgID, seedCRMTaskValues{Title: "Reassign me", DueAt: parseCRMTaskTime(t, dueAt), Assignee: crmStringPointer(fx.userID)})
	reassignPayload := json.RawMessage(fmt.Sprintf(`{"taskId":%q,"dueAt":null,"assigneeUserId":null}`, detailsTaskID))
	reassign := executeCRMTask(t, fx, updateTaskDetailsCapabilityID, reassignPayload, "crm-task-receipt-clear")
	var reassignOutput UpdateTaskDetailsOutput
	if err := json.Unmarshal(reassign.Data, &reassignOutput); err != nil {
		t.Fatal(err)
	}
	if reassignOutput.Previous.DueAt == nil || *reassignOutput.Previous.DueAt != dueAt || reassignOutput.Previous.AssigneeUserID == nil || *reassignOutput.Previous.AssigneeUserID != fx.userID {
		t.Fatalf("clear output=%+v, want previous due date and assignee", reassignOutput)
	}
	var clearedDue, clearedAssignee *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT due_at::text, assignee_user_id::text FROM tasks WHERE id=$1::uuid`, detailsTaskID).Scan(&clearedDue, &clearedAssignee); err != nil {
		t.Fatal(err)
	}
	if clearedDue != nil || clearedAssignee != nil {
		t.Fatalf("cleared task state=%v/%v, want null due date and assignee", clearedDue, clearedAssignee)
	}

	nonMemberID := executorUUID(t)
	if _, err := executeCRMTaskWithError(fx, updateTaskDetailsCapabilityID, json.RawMessage(fmt.Sprintf(`{"taskId":%q,"assigneeUserId":%q}`, detailsTaskID, nonMemberID)), "crm-task-nonmember"); err == nil || !strings.Contains(err.Error(), "assignee is not a member of this organization") {
		t.Fatalf("non-member assignee error=%v", err)
	}
	if _, err := executeCRMTaskWithError(fx, updateTaskDetailsCapabilityID, json.RawMessage(fmt.Sprintf(`{"taskId":%q,"dueAt":%q}`, foreignTaskID, dueAt)), "crm-task-foreign-update"); err == nil || !strings.Contains(err.Error(), "open task not found in this organization") {
		t.Fatalf("foreign updateTaskDetails error=%v", err)
	}
	if _, err := executeCRMTaskWithError(fx, updateTaskDetailsCapabilityID, json.RawMessage(fmt.Sprintf(`{"taskId":%q,"dueAt":%q}`, created.TaskID, dueAt)), "crm-task-update-completed"); err == nil || !strings.Contains(err.Error(), "open task not found in this organization") {
		t.Fatalf("completed task updateTaskDetails error=%v", err)
	}

	restorePayload := json.RawMessage(fmt.Sprintf(`{"taskId":%q,"dueAt":%q,"assigneeUserId":%q}`, detailsTaskID, dueAt, fx.userID))
	restore := executeCRMTask(t, fx, restoreTaskDetailsCapabilityID, restorePayload, "crm-task-receipt-restore")
	var restoreOutput UpdateTaskDetailsOutput
	if err := json.Unmarshal(restore.Data, &restoreOutput); err != nil {
		t.Fatal(err)
	}
	if restoreOutput.Previous.DueAt != nil || restoreOutput.Previous.AssigneeUserID != nil {
		t.Fatalf("restore output=%+v, want previous cleared state", restoreOutput)
	}
	var restoredDue *time.Time
	var restoredAssignee *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT due_at, assignee_user_id::text FROM tasks WHERE id=$1::uuid`, detailsTaskID).Scan(&restoredDue, &restoredAssignee); err != nil {
		t.Fatal(err)
	}
	if restoredDue == nil || crmISOTime(restoredDue) == nil || *crmISOTime(restoredDue) != dueAt || restoredAssignee == nil || *restoredAssignee != fx.userID {
		t.Fatalf("restored task state=%v/%v, want original due date and assignee", restoredDue, restoredAssignee)
	}

	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, updateTaskDetailsCapabilityID); got != 2 {
		t.Fatalf("successful updateTaskDetails audit events=%d, want two", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, restoreTaskDetailsCapabilityID); got != 1 {
		t.Fatalf("restoreTaskDetails audit events=%d, want one", got)
	}
}

func TestGoCRMTasksAgentWritesUseExistingApprovalPipeline(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	fx.addPolicy(createTaskCapabilityID, "read", nil)
	fx.addPolicy(completeTaskCapabilityID, "read", nil)
	fx.addPolicy(updateTaskDetailsCapabilityID, "read", nil)
	fx.addPolicy(restoreTaskDetailsCapabilityID, "read", nil)
	input := json.RawMessage(`{"title":"Approval-gated follow-up","dueAt":"2026-10-01T09:30:00.123Z"}`)
	result := executeCRMWriteWithActorApproval(t, fx, createTaskCapabilityID, input)
	var output CreateTaskOutput
	if err := json.Unmarshal(result.Data, &output); err != nil || !result.OK || !isUUID(output.TaskID) {
		t.Fatalf("approved createTask result=%+v output=%+v err=%v", result, output, err)
	}
	dueUpdateInput := json.RawMessage(fmt.Sprintf(`{"taskId":%q,"dueAt":"2026-11-01T09:30:00.123Z"}`, output.TaskID))
	dueUpdateResult := executeCRMWriteWithActorApproval(t, fx, updateTaskDetailsCapabilityID, dueUpdateInput)
	var dueUpdateOutput UpdateTaskDetailsOutput
	if err := json.Unmarshal(dueUpdateResult.Data, &dueUpdateOutput); err != nil || !dueUpdateResult.OK || dueUpdateOutput.Previous.DueAt == nil {
		t.Fatalf("approved updateTaskDetails result=%+v output=%+v err=%v", dueUpdateResult, dueUpdateOutput, err)
	}
	restoreInput := json.RawMessage(fmt.Sprintf(`{"taskId":%q,"dueAt":%q}`, output.TaskID, *dueUpdateOutput.Previous.DueAt))
	restoreResult := executeCRMWriteWithActorApproval(t, fx, restoreTaskDetailsCapabilityID, restoreInput)
	if !restoreResult.OK {
		t.Fatalf("approved restoreTaskDetails result=%+v", restoreResult)
	}
	completeInput := json.RawMessage(fmt.Sprintf(`{"taskId":%q}`, output.TaskID))
	completeResult := executeCRMWriteWithActorApproval(t, fx, completeTaskCapabilityID, completeInput)
	if !completeResult.OK || string(completeResult.Data) != `{"completed":true}` {
		t.Fatalf("approved completeTask result=%+v", completeResult)
	}
	for _, capabilityID := range []string{createTaskCapabilityID, updateTaskDetailsCapabilityID, restoreTaskDetailsCapabilityID, completeTaskCapabilityID} {
		if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, capabilityID); got != 1 {
			t.Errorf("%s approval request events=%d, want one", capabilityID, got)
		}
		if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.granted' AND capability_id=$2`, fx.orgID, capabilityID); got != 0 {
			t.Errorf("%s approval grant events=%d, want legacy human re-execution behavior of zero", capabilityID, got)
		}
	}
}

func executeCRMTask(t *testing.T, fx *executorFixture, capabilityID string, raw json.RawMessage, intent string) Result {
	t.Helper()
	result, err := executeCRMTaskWithError(fx, capabilityID, raw, intent)
	if err != nil {
		t.Fatalf("execute %s: %v", capabilityID, err)
	}
	return result
}

func executeCRMTaskWithError(fx *executorFixture, capabilityID string, raw json.RawMessage, intent string) (Result, error) {
	claims := crmWriteClaims(fx, capabilityID, raw, "human", "", intent)
	return fx.executor.Execute(fx.ctx, claims, capabilityID, raw)
}

type seedCRMTaskValues struct {
	Title    string
	DueAt    *time.Time
	Assignee *string
	Done     bool
}

func seedCRMTask(t *testing.T, fx *executorFixture, orgID string, values seedCRMTaskValues) string {
	t.Helper()
	var doneAt any
	if values.Done {
		doneAt = time.Now().UTC()
	}
	var taskID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tasks (org_id, title, due_at, assignee_user_id, done_at)
		VALUES ($1::uuid, $2, $3::timestamptz, $4::uuid, $5)
		RETURNING id::text`, orgID, values.Title, values.DueAt, values.Assignee, doneAt).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	return taskID
}

func parseCRMTaskTime(t *testing.T, value string) *time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return &parsed
}
