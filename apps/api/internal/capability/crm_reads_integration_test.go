package capability

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

func TestGoCustomerReadCapabilitiesMatchLegacy(t *testing.T) {
	fx := newExecutorFixture(t)
	noReadInput := json.RawMessage(`{"query":"no matching customer"}`)
	noReadClaims := crmReadClaims(fx, listCustomersCapabilityID, noReadInput)
	noReadClaims.Permissions = []string{"crm.write"}
	denied, err := fx.executor.Execute(fx.ctx, noReadClaims, listCustomersCapabilityID, noReadInput)
	if err != nil || denied.OK || denied.Error != "forbidden: missing permission: crm.read" {
		t.Fatalf("crm.read denial result=%+v err=%v, want missing permission", denied, err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'crm.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}

	activeCustomer := seedCRMReadCustomer(t, fx, fx.orgID, "Alpha customer", "alpha@fixture.test", nil, nil)
	seedCRMReadCustomer(t, fx, fx.orgID, "Beta customer", "", nil, nil)
	seedCRMReadCustomer(t, fx, fx.orgID, "Inactive customer", "inactive@fixture.test", ptrTime(time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)), nil)
	seedCRMReadCustomer(t, fx, fx.orgID, "Merged customer", "merged@fixture.test", nil, &activeCustomer)
	otherCustomer := seedCRMReadCustomer(t, fx, fx.otherOrgID, "Other organization customer", "other@fixture.test", nil, nil)

	listResult, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, listCustomersCapabilityID, noReadInput), listCustomersCapabilityID, noReadInput)
	if err != nil || !listResult.OK {
		t.Fatalf("listCustomers result=%+v err=%v", listResult, err)
	}
	var customers ListCustomersOutput
	if err := json.Unmarshal(listResult.Data, &customers); err != nil {
		t.Fatalf("decode listCustomers output %s: %v", listResult.Data, err)
	}
	if len(customers.Customers) != 2 {
		t.Fatalf("listCustomers returned %d rows, want two active, non-merged organization customers", len(customers.Customers))
	}
	gotCustomers := map[string]*string{}
	for _, customer := range customers.Customers {
		gotCustomers[customer.Name] = customer.Email
		if customer.ID == otherCustomer {
			t.Fatalf("listCustomers leaked other organization's customer %s", customer.ID)
		}
	}
	if email := gotCustomers["Alpha customer"]; email == nil || *email != "alpha@fixture.test" {
		t.Fatalf("Alpha customer email=%v, want alpha@fixture.test", email)
	}
	if email, ok := gotCustomers["Beta customer"]; !ok || email != nil {
		t.Fatalf("Beta customer email=%v present=%v, want null email", email, ok)
	}
	if _, ok := gotCustomers["Inactive customer"]; ok {
		t.Fatal("listCustomers included a deactivated customer")
	}
	if _, ok := gotCustomers["Merged customer"]; ok {
		t.Fatal("listCustomers included a merged customer")
	}

	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO customers (org_id, name, email)
		SELECT $1::uuid, 'Bulk customer ' || n, 'bulk-' || n || '@fixture.test'
		FROM generate_series(1, 101) AS n`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	limitResult, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, listCustomersCapabilityID, noReadInput), listCustomersCapabilityID, noReadInput)
	if err != nil || !limitResult.OK {
		t.Fatalf("listCustomers limit result=%+v err=%v", limitResult, err)
	}
	if err := json.Unmarshal(limitResult.Data, &customers); err != nil {
		t.Fatal(err)
	}
	if len(customers.Customers) != 100 {
		t.Fatalf("listCustomers returned %d rows, want legacy limit of 100", len(customers.Customers))
	}
	for _, customer := range customers.Customers {
		if customer.Name == "Inactive customer" || customer.Name == "Merged customer" || customer.ID == otherCustomer {
			t.Fatalf("limited listCustomers included an inactive, merged, or other-organization row: %+v", customer)
		}
	}

	for _, deal := range []struct {
		stage string
		value int64
	}{
		{"lead", 105}, {"lead", 105}, {"qualified", 101}, {"proposal", 101},
		{"negotiation", 99}, {"won", 20}, {"lost", 7},
	} {
		if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO deals (org_id, title, stage, value_minor) VALUES ($1::uuid, $2, $3, $4)`, fx.orgID, "Fixture "+deal.stage, deal.stage, deal.value); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO deals (org_id, title, stage, value_minor) VALUES ($1::uuid, 'Foreign organization deal', 'lead', 90000)`, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	pipelineInput := json.RawMessage(`{}`)
	pipelineResult, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, pipelineReportCapabilityID, pipelineInput), pipelineReportCapabilityID, pipelineInput)
	if err != nil || !pipelineResult.OK {
		t.Fatalf("pipelineReport result=%+v err=%v", pipelineResult, err)
	}
	var pipeline PipelineReportOutput
	if err := json.Unmarshal(pipelineResult.Data, &pipeline); err != nil {
		t.Fatalf("decode pipelineReport output %s: %v", pipelineResult.Data, err)
	}
	wantStages := []PipelineStageSummary{
		{Stage: "lead", Count: 2, TotalMinor: 210, WeightedMinor: 21},
		{Stage: "qualified", Count: 1, TotalMinor: 101, WeightedMinor: 30},
		{Stage: "proposal", Count: 1, TotalMinor: 101, WeightedMinor: 51},
		{Stage: "negotiation", Count: 1, TotalMinor: 99, WeightedMinor: 69},
		{Stage: "won", Count: 1, TotalMinor: 20, WeightedMinor: 20},
		{Stage: "lost", Count: 1, TotalMinor: 7, WeightedMinor: 0},
	}
	if !reflect.DeepEqual(pipeline.Stages, wantStages) || pipeline.OpenValueMinor != 511 || pipeline.WeightedForecastMinor != 172 {
		t.Fatalf("pipeline report=%+v, want ordered stages %+v, open=511, weighted=172", pipeline, wantStages)
	}

	fallbackUserID := executorUUID(t)
	fallbackEmail := "crm-read-fallback-" + fallbackUserID[:8] + "@fixture.test"
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, NULL)`, fallbackUserID, fallbackEmail); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, fx.orgID, fallbackUserID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM users WHERE id=$1::uuid`, fallbackUserID); err != nil {
			t.Errorf("delete task assignee fixture: %v", err)
		}
	})
	completedAt := time.Date(2025, 1, 2, 12, 0, 0, 0, time.UTC)
	dueOne := time.Date(2025, 1, 1, 9, 30, 0, 123_000_000, time.UTC)
	dueTwo := time.Date(2025, 1, 2, 9, 30, 0, 456_000_000, time.UTC)
	completedTaskID := seedCRMReadTask(t, fx, fx.orgID, "Completed follow-up", &dueOne, &completedAt, nil, nil, nil)
	ownedCustomerTaskID := seedCRMReadTask(t, fx, fx.orgID, "Owned customer follow-up", &dueOne, nil, &fx.userID, ptrString("customer"), &activeCustomer)
	fallbackTaskID := seedCRMReadTask(t, fx, fx.orgID, "Fallback assignee follow-up", &dueTwo, nil, &fallbackUserID, ptrString("customer"), &otherCustomer)
	unscheduledTaskID := seedCRMReadTask(t, fx, fx.orgID, "Unscheduled follow-up", nil, nil, nil, nil, nil)
	otherTaskID := seedCRMReadTask(t, fx, fx.otherOrgID, "Other organization follow-up", nil, nil, nil, nil, nil)

	allTasksInput := json.RawMessage(`{}`)
	tasksResult, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, listTasksCapabilityID, allTasksInput), listTasksCapabilityID, allTasksInput)
	if err != nil || !tasksResult.OK {
		t.Fatalf("listTasks result=%+v err=%v", tasksResult, err)
	}
	var tasks ListTasksOutput
	if err := json.Unmarshal(tasksResult.Data, &tasks); err != nil {
		t.Fatalf("decode listTasks output %s: %v", tasksResult.Data, err)
	}
	wantTaskOrder := []string{completedTaskID, ownedCustomerTaskID, fallbackTaskID, unscheduledTaskID}
	gotTaskOrder := make([]string, len(tasks.Tasks))
	tasksByID := make(map[string]CRMTaskSummary, len(tasks.Tasks))
	for index, task := range tasks.Tasks {
		gotTaskOrder[index] = task.ID
		tasksByID[task.ID] = task
	}
	if !reflect.DeepEqual(gotTaskOrder, wantTaskOrder) {
		t.Fatalf("listTasks order=%v, want doneAt then dueAt order %v", gotTaskOrder, wantTaskOrder)
	}
	if _, leaked := tasksByID[otherTaskID]; leaked {
		t.Fatal("listTasks leaked another organization's task")
	}
	completed := tasksByID[completedTaskID]
	if completed.DueAt == nil || *completed.DueAt != "2025-01-01T09:30:00.123Z" || completed.DoneAt == nil || *completed.DoneAt != "2025-01-02T12:00:00.000Z" {
		t.Fatalf("completed task timestamps due=%v done=%v, want UTC millisecond ISO strings", completed.DueAt, completed.DoneAt)
	}
	owned := tasksByID[ownedCustomerTaskID]
	if owned.AssigneeUserID == nil || *owned.AssigneeUserID != fx.userID || owned.AssigneeName == nil || *owned.AssigneeName != "Go capability user" || owned.CustomerName == nil || *owned.CustomerName != "Alpha customer" {
		t.Fatalf("owned customer task=%+v, want user and same-organization customer display names", owned)
	}
	fallback := tasksByID[fallbackTaskID]
	if fallback.AssigneeName == nil || *fallback.AssigneeName != fallbackEmail || fallback.CustomerName != nil {
		t.Fatalf("fallback/cross-org task=%+v, want email fallback and no foreign customer name", fallback)
	}
	unscheduled := tasksByID[unscheduledTaskID]
	if unscheduled.DueAt != nil || unscheduled.DoneAt != nil || unscheduled.CustomerName != nil {
		t.Fatalf("unscheduled task=%+v, want null date and reference fields", unscheduled)
	}

	openOnlyInput := json.RawMessage(`{"openOnly":true}`)
	openResult, err := fx.executor.Execute(fx.ctx, crmReadClaims(fx, listTasksCapabilityID, openOnlyInput), listTasksCapabilityID, openOnlyInput)
	if err != nil || !openResult.OK {
		t.Fatalf("openOnly listTasks result=%+v err=%v", openResult, err)
	}
	if err := json.Unmarshal(openResult.Data, &tasks); err != nil {
		t.Fatal(err)
	}
	gotOpenOrder := make([]string, len(tasks.Tasks))
	for index, task := range tasks.Tasks {
		gotOpenOrder[index] = task.ID
	}
	if !reflect.DeepEqual(gotOpenOrder, []string{ownedCustomerTaskID, fallbackTaskID, unscheduledTaskID}) {
		t.Fatalf("openOnly task IDs=%v, want the three open tasks in due order", gotOpenOrder)
	}
}

func crmReadClaims(fx *executorFixture, capabilityID string, input json.RawMessage) authbridge.CapabilityClaims {
	claims := fx.humanClaims(input, "")
	claims.CapabilityID = capabilityID
	claims.Permissions = []string{"crm.read"}
	return claims
}

func seedCRMReadCustomer(t *testing.T, fx *executorFixture, orgID, name, email string, deactivatedAt *time.Time, mergedInto *string) string {
	t.Helper()
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name, email, deactivated_at, merged_into_customer_id)
		VALUES ($1::uuid, $2, NULLIF($3, ''), $4, $5::uuid)
		RETURNING id::text`, orgID, name, email, deactivatedAt, mergedInto).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	return customerID
}

func seedCRMReadTask(t *testing.T, fx *executorFixture, orgID, title string, dueAt, doneAt *time.Time, assigneeUserID, refType, refID *string) string {
	t.Helper()
	var taskID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tasks (org_id, title, due_at, done_at, assignee_user_id, ref_type, ref_id)
		VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7::uuid)
		RETURNING id::text`, orgID, title, dueAt, doneAt, assigneeUserID, refType, refID).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	return taskID
}

func ptrString(value string) *string {
	return &value
}

func ptrTime(value time.Time) *time.Time {
	return &value
}
