package capability

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

func waveModuleClaims(fx *executorFixture, capabilityID, permission string, input json.RawMessage, actorType, agentSession, intent string) authbridge.CapabilityClaims {
	claims := fx.claims(input, actorType, agentSession, intent)
	claims.CapabilityID = capabilityID
	claims.Permissions = []string{permission}
	return claims
}

func grantWavePermission(t *testing.T, fx *executorFixture, permission string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, $2, $3::uuid)`, fx.roleID, permission, fx.orgID); err != nil {
		t.Fatal(err)
	}
}

func approveModuleWrite(t *testing.T, fx *executorFixture, capabilityID, permission string, input json.RawMessage) Result {
	t.Helper()
	pending, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, capabilityID, permission, input, "agent", fx.agentSession, ""), capabilityID, input)
	if err != nil || pending.OK || !pending.PendingApproval {
		t.Fatalf("agent %s result=%+v err=%v, want pending approval", capabilityID, pending, err)
	}
	var approvalID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM approvals WHERE org_id=$1::uuid AND capability_id=$2 AND status='pending'
		ORDER BY created_at DESC LIMIT 1`, fx.orgID, capabilityID).Scan(&approvalID); err != nil {
		t.Fatal(err)
	}
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	approved, err := decider.Decide(fx.ctx, waveModuleClaims(fx, capabilityID, permission, input, "human", "", ""), ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
	if err != nil || !approved.OK || approved.Status != "executed" || approved.Result == nil || !approved.Result.OK {
		t.Fatalf("approval %s result=%+v err=%v, want one completed execution", capabilityID, approved, err)
	}
	return *approved.Result
}

func TestGoAccountingQuotesGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin wave fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable wave fixture ledger cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id=$1::uuid)`, fx.orgID); err != nil {
			t.Errorf("delete wave fixture journal lines: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM journal_entries WHERE org_id=$1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete wave fixture journal entries: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM invoices WHERE org_id=$1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete wave fixture invoices: %v", err)
			return
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit wave fixture cleanup: %v", err)
		}
	})
	grantWavePermission(t, fx, "accounting.write")
	seedQuoteAccounts(t, fx)
	customerID := seedQuoteCustomer(t, fx, fx.orgID, nil)
	input := json.RawMessage(`{"customerId":"` + customerID + `","lines":[{"description":"Consulting day","quantity":1000,"unitPriceMinor":150000}]}`)
	claims := waveModuleClaims(fx, createQuoteCapabilityID, "accounting.write", input, "human", "", "wave-quote-create")

	first, err := fx.executor.Execute(fx.ctx, claims, createQuoteCapabilityID, input)
	if err != nil || !first.OK {
		t.Fatalf("createQuote result=%+v err=%v", first, err)
	}
	var created CreateQuoteOutput
	if err := json.Unmarshal(first.Data, &created); err != nil {
		t.Fatal(err)
	}
	if !isUUID(created.QuoteID) || created.QuoteNumber != 1 || created.TotalMinor != 150000 {
		t.Fatalf("createQuote output=%+v, want quote number one at 150000 minor", created)
	}
	replay, err := fx.executor.Execute(fx.ctx, claims, createQuoteCapabilityID, input)
	if err != nil || !replay.OK || !replay.Replayed || string(replay.Data) == "" {
		t.Fatalf("createQuote replay=%+v err=%v, want governed receipt replay", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM quotes WHERE org_id=$1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("quotes=%d, want one after replay", got)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, createQuoteCapabilityID, "crm.write", input, "human", "", "wave-quote-denied"), createQuoteCapabilityID, input)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.write") {
		t.Fatalf("denied result=%+v err=%v, want permission failure", denied, err)
	}

	acceptInput := json.RawMessage(`{"quoteId":"` + created.QuoteID + `"}`)
	accepted, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, acceptQuoteCapabilityID, "accounting.write", acceptInput, "human", "", "wave-quote-accept"), acceptQuoteCapabilityID, acceptInput)
	if err != nil || !accepted.OK {
		t.Fatalf("acceptQuote result=%+v err=%v", accepted, err)
	}
	var invoice AcceptQuoteOutput
	if err := json.Unmarshal(accepted.Data, &invoice); err != nil {
		t.Fatal(err)
	}
	if !isUUID(invoice.InvoiceID) || invoice.TotalMinor != 150000 {
		t.Fatalf("acceptQuote output=%+v, want converted invoice at 150000 minor", invoice)
	}
	if got := fx.count(`SELECT count(*) FROM quotes WHERE org_id=$1::uuid AND id=$2::uuid AND status='accepted' AND converted_invoice_id=$3::uuid`, fx.orgID, created.QuoteID, invoice.InvoiceID); got != 1 {
		t.Fatalf("accepted quotes=%d, want one linked to its invoice", got)
	}

	fx.addAgentSession()
	fx.addPolicy(createQuoteCapabilityID, "read", nil)
	secondInput := json.RawMessage(`{"customerId":"` + customerID + `","lines":[{"description":"Follow-up visit","quantity":1,"unitPriceMinor":90000}]}`)
	approved := approveModuleWrite(t, fx, createQuoteCapabilityID, "accounting.write", secondInput)
	var secondQuote CreateQuoteOutput
	if err := json.Unmarshal(approved.Data, &secondQuote); err != nil || secondQuote.QuoteNumber != 2 {
		t.Fatalf("approved createQuote output=%+v err=%v, want quote number two", secondQuote, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, createQuoteCapabilityID); got != 1 {
		t.Fatalf("approval request events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.granted' AND capability_id=$2`, fx.orgID, createQuoteCapabilityID); got != 0 {
		t.Fatalf("approval grant events=%d, want legacy human re-execution behavior of zero", got)
	}
}

func TestGoAccountingRecurringGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "accounting.write")
	customerID := seedQuoteCustomer(t, fx, fx.orgID, nil)
	input := json.RawMessage(`{"customerId":"` + customerID + `","frequency":"monthly","lines":[{"description":"Retainer","quantity":1,"unitPriceMinor":500000}]}`)
	claims := waveModuleClaims(fx, createRecurringTemplateCapabilityID, "accounting.write", input, "human", "", "wave-recurring-create")

	first, err := fx.executor.Execute(fx.ctx, claims, createRecurringTemplateCapabilityID, input)
	if err != nil || !first.OK {
		t.Fatalf("createRecurringTemplate result=%+v err=%v", first, err)
	}
	var created CreateRecurringTemplateOutput
	if err := json.Unmarshal(first.Data, &created); err != nil {
		t.Fatal(err)
	}
	if !isUUID(created.TemplateID) || created.NextRunAt == "" {
		t.Fatalf("createRecurringTemplate output=%+v, want template id and scheduled next run", created)
	}
	replay, err := fx.executor.Execute(fx.ctx, claims, createRecurringTemplateCapabilityID, input)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createRecurringTemplate replay=%+v err=%v, want governed receipt replay", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human' AND actor_id=$3::uuid`, fx.orgID, createRecurringTemplateCapabilityID, fx.userID); got != 1 {
		t.Fatalf("createRecurringTemplate audit events=%d, want one", got)
	}

	paused, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, pauseRecurringTemplateCapabilityID, "accounting.write", json.RawMessage(`{"templateId":"`+created.TemplateID+`"}`), "human", "", "wave-recurring-pause"), pauseRecurringTemplateCapabilityID, json.RawMessage(`{"templateId":"`+created.TemplateID+`"}`))
	if err != nil || !paused.OK {
		t.Fatalf("pauseRecurringTemplate result=%+v err=%v", paused, err)
	}
	var pauseOutput PauseRecurringTemplateOutput
	if err := json.Unmarshal(paused.Data, &pauseOutput); err != nil || pauseOutput.Active {
		t.Fatalf("pauseRecurringTemplate output=%+v err=%v, want inactive template", pauseOutput, err)
	}
}

func TestGoHREmployeesGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "hr.write")
	input := json.RawMessage(`{"name":"Ada Feature","email":"ada@fixture.test","monthlySalaryMinor":8000000}`)
	claims := waveModuleClaims(fx, hrHireEmployeeCapabilityID, "hr.write", input, "human", "", "wave-hr-hire")

	first, err := fx.executor.Execute(fx.ctx, claims, hrHireEmployeeCapabilityID, input)
	if err != nil || !first.OK {
		t.Fatalf("hireEmployee result=%+v err=%v", first, err)
	}
	var hired HRHireEmployeeOutput
	if err := json.Unmarshal(first.Data, &hired); err != nil {
		t.Fatal(err)
	}
	if !isUUID(hired.EmployeeID) {
		t.Fatalf("hireEmployee output=%+v, want UUID employeeId", hired)
	}
	replay, err := fx.executor.Execute(fx.ctx, claims, hrHireEmployeeCapabilityID, input)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("hireEmployee replay=%+v err=%v, want governed receipt replay", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM employees WHERE org_id=$1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("employees=%d, want one after replay", got)
	}

	structureInput := json.RawMessage(`{"employeeId":"` + hired.EmployeeID + `","department":"Operations"}`)
	structured, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrUpdateEmployeeStructureCapabilityID, "hr.write", structureInput, "human", "", "wave-hr-structure"), hrUpdateEmployeeStructureCapabilityID, structureInput)
	if err != nil || !structured.OK {
		t.Fatalf("updateEmployeeStructure result=%+v err=%v", structured, err)
	}
	var department string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT department FROM employees WHERE id=$1::uuid`, hired.EmployeeID).Scan(&department); err != nil {
		t.Fatal(err)
	}
	if department != "Operations" {
		t.Fatalf("department=%q, want Operations", department)
	}

	fx.addAgentSession()
	fx.addPolicy(hrHireEmployeeCapabilityID, "read", nil)
	approved := approveModuleWrite(t, fx, hrHireEmployeeCapabilityID, "hr.write", json.RawMessage(`{"name":"Agent Hire","monthlySalaryMinor":1000000,"taxRateBps":1000,"annualLeaveDays":21}`))
	var agentHire HRHireEmployeeOutput
	if err := json.Unmarshal(approved.Data, &agentHire); err != nil || !isUUID(agentHire.EmployeeID) {
		t.Fatalf("approved hireEmployee output=%+v err=%v", agentHire, err)
	}
}

func TestGoSalesOrdersGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "sales.write")
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "Governed buyer")
	itemID := seedSalesItem(t, fx, fx.orgID, "GO-CHAIR", "goods")
	seedSalesStock(t, fx, fx.orgID, itemID, 100000)
	input := json.RawMessage(`{"customerId":"` + customerID + `","lines":[{"description":"Chair","quantity":30000,"unitPriceMinor":20000,"sku":"GO-CHAIR"}]}`)
	claims := waveModuleClaims(fx, salesCreateOrderCapabilityID, "sales.write", input, "human", "", "wave-sales-create")

	first, err := fx.executor.Execute(fx.ctx, claims, salesCreateOrderCapabilityID, input)
	if err != nil || !first.OK {
		t.Fatalf("createOrder result=%+v err=%v", first, err)
	}
	var created SalesCreateOrderOutput
	if err := json.Unmarshal(first.Data, &created); err != nil {
		t.Fatal(err)
	}
	if !isUUID(created.OrderID) || created.OrderNumber != 1 {
		t.Fatalf("createOrder output=%+v, want order number one", created)
	}
	replay, err := fx.executor.Execute(fx.ctx, claims, salesCreateOrderCapabilityID, input)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createOrder replay=%+v err=%v, want governed receipt replay", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM sales_orders WHERE org_id=$1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("sales orders=%d, want one after replay", got)
	}

	confirmInput := json.RawMessage(`{"orderId":"` + created.OrderID + `"}`)
	confirmed, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, salesConfirmOrderCapabilityID, "sales.write", confirmInput, "human", "", "wave-sales-confirm"), salesConfirmOrderCapabilityID, confirmInput)
	if err != nil || !confirmed.OK {
		t.Fatalf("confirmOrder result=%+v err=%v", confirmed, err)
	}
	var confirmation SalesConfirmOrderOutput
	if err := json.Unmarshal(confirmed.Data, &confirmation); err != nil || !confirmation.Confirmed || confirmation.ReservedThousandths != 30000 {
		t.Fatalf("confirmOrder output=%+v err=%v, want confirmed reservation", confirmation, err)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, salesConfirmOrderCapabilityID); got != 1 {
		t.Fatalf("confirmOrder audit events=%d, want one", got)
	}

	fx.addAgentSession()
	fx.addPolicy(salesCreateOrderCapabilityID, "read", nil)
	approved := approveModuleWrite(t, fx, salesCreateOrderCapabilityID, "sales.write", json.RawMessage(`{"customerId":"` + customerID + `","lines":[{"description":"Service install","quantity":1,"unitPriceMinor":50000}]}`))
	var agentOrder SalesCreateOrderOutput
	if err := json.Unmarshal(approved.Data, &agentOrder); err != nil || !isUUID(agentOrder.OrderID) || agentOrder.OrderNumber != 2 {
		t.Fatalf("approved createOrder output=%+v err=%v, want order number two", agentOrder, err)
	}
}
