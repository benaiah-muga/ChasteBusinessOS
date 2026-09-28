package capability

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGoWave4PaymentRunsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPaymentRunsFixture(t, fx)
	grantWavePermission(t, fx, "purchasing.write")
	grantWavePermission(t, fx, "purchasing.post")
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1000', 'Cash', 'asset'),
		($1::uuid, '2000', 'Accounts Payable', 'liability')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	billID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 1, "open", "UGX", nil, 500000, 0, 0)

	createInput := json.RawMessage(`{"memo":"Wave4 supplier run","lines":[{"billId":"` + billID + `","amountMinor":500000}]}`)
	createClaims := waveModuleClaims(fx, createPaymentRunCapabilityID, "purchasing.write", createInput, "human", "", "wave4-run-create")
	created, err := fx.executor.Execute(fx.ctx, createClaims, createPaymentRunCapabilityID, createInput)
	if err != nil || !created.OK {
		t.Fatalf("createPaymentRun result=%+v err=%v", created, err)
	}
	var run CreatePaymentRunOutput
	if err := json.Unmarshal(created.Data, &run); err != nil {
		t.Fatal(err)
	}
	if !isUUID(run.PaymentRunID) {
		t.Fatalf("createPaymentRun output=%+v, want UUID paymentRunId", run)
	}
	replay, err := fx.executor.Execute(fx.ctx, createClaims, createPaymentRunCapabilityID, createInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createPaymentRun replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, createPaymentRunCapabilityID, "crm.write", createInput, "human", "", "wave4-run-denied"), createPaymentRunCapabilityID, createInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: purchasing.write") {
		t.Fatalf("createPaymentRun denied result=%+v err=%v, want permission failure", denied, err)
	}

	fx.addAgentSession()
	fx.addPolicy(instructPaymentRunCapabilityID, "read", nil)
	instructInput := json.RawMessage(`{"paymentRunId":"` + run.PaymentRunID + `"}`)
	approved := approveModuleWrite(t, fx, instructPaymentRunCapabilityID, "purchasing.post", instructInput)
	var instructed InstructPaymentRunOutput
	if err := json.Unmarshal(approved.Data, &instructed); err != nil {
		t.Fatal(err)
	}
	if !isUUID(instructed.EntryID) {
		t.Fatalf("instructPaymentRun output=%+v, want a posted journal entry", instructed)
	}
	if got := fx.count(`SELECT count(*) FROM vendor_payments WHERE org_id=$1::uuid AND status='instructed'`, fx.orgID); got != 1 {
		t.Fatalf("instructed vendor payments=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM vendor_bills WHERE org_id=$1::uuid AND id=$2::uuid AND status='paid'`, fx.orgID, billID); got != 1 {
		t.Fatalf("settled bills=%d, want the bill marked paid", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, instructPaymentRunCapabilityID); got != 1 {
		t.Fatalf("instruct audit events=%d, want one", got)
	}
}

func TestGoWave4PeriodCloseGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPeriodCloseFixtureLedger(t, fx)
	grantWavePermission(t, fx, "accounting.write")

	checkInput := json.RawMessage(`{"year":2026,"month":8,"taskKey":"review_journal","completed":true}`)
	checkClaims := waveModuleClaims(fx, updatePeriodCloseCheckCapabilityID, "accounting.write", checkInput, "human", "", "wave4-check-update")
	updated, err := fx.executor.Execute(fx.ctx, checkClaims, updatePeriodCloseCheckCapabilityID, checkInput)
	if err != nil || !updated.OK {
		t.Fatalf("updatePeriodCloseCheck result=%+v err=%v", updated, err)
	}
	var check PeriodCloseCheckOutput
	if err := json.Unmarshal(updated.Data, &check); err != nil {
		t.Fatal(err)
	}
	replay, err := fx.executor.Execute(fx.ctx, checkClaims, updatePeriodCloseCheckCapabilityID, checkInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("updatePeriodCloseCheck replay=%+v err=%v, want governed receipt replay", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM period_close_checks WHERE org_id=$1::uuid AND year=2026 AND month=8 AND task_key='review_journal' AND completed`, fx.orgID); got != 1 {
		t.Fatalf("completed checks=%d, want one", got)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, updatePeriodCloseCheckCapabilityID, "crm.write", checkInput, "human", "", "wave4-check-denied"), updatePeriodCloseCheckCapabilityID, checkInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.write") {
		t.Fatalf("updatePeriodCloseCheck denied result=%+v err=%v, want permission failure", denied, err)
	}

	fx.addAgentSession()
	fx.addPolicy(restorePeriodCloseCheckCapabilityID, "read", nil)
	restoreInput := json.RawMessage(`{"year":2026,"month":8,"taskKey":"review_journal","completed":false}`)
	approved := approveModuleWrite(t, fx, restorePeriodCloseCheckCapabilityID, "accounting.write", restoreInput)
	var restored PeriodCloseCheckOutput
	if err := json.Unmarshal(approved.Data, &restored); err != nil {
		t.Fatal(err)
	}
	if got := fx.count(`SELECT count(*) FROM period_close_checks WHERE org_id=$1::uuid AND year=2026 AND month=8 AND task_key='review_journal' AND NOT completed`, fx.orgID); got != 1 {
		t.Fatalf("reopened checks=%d, want the check flipped back", got)
	}
}

func TestGoWave4ImportsReservationsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin wave4 inventory cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable wave4 inventory ledger cleanup: %v", err)
			return
		}
		for _, stmt := range []string{
			`DELETE FROM stock_reservations WHERE org_id=$1::uuid`,
			`DELETE FROM stock_movements WHERE org_id=$1::uuid`,
			`DELETE FROM stock_balances WHERE org_id=$1::uuid`,
			`DELETE FROM items WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("wave4 inventory cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit wave4 inventory cleanup: %v", err)
		}
	})
	grantWavePermission(t, fx, "inventory.write")
	grantWavePermission(t, fx, "inventory.read")

	importInput := json.RawMessage(`{"rows":[{"rowNumber":1,"sku":"SKU-IMP1","name":"Imported Widget","kind":"goods","unitLabel":"pc","salePriceMinor":4000,"reorderPointThousandths":1000,"tags":["imported"]}]}`)
	importClaims := waveModuleClaims(fx, inventoryImportItemsCapabilityID, "inventory.write", importInput, "human", "", "wave4-import")
	imported, err := fx.executor.Execute(fx.ctx, importClaims, inventoryImportItemsCapabilityID, importInput)
	if err != nil || !imported.OK {
		t.Fatalf("importItems result=%+v err=%v", imported, err)
	}
	var batch InventoryImportItemsOutput
	if err := json.Unmarshal(imported.Data, &batch); err != nil {
		t.Fatal(err)
	}
	if len(batch.CreatedIDs) != 1 || !isUUID(batch.CreatedIDs[0]) {
		t.Fatalf("importItems output=%+v, want one created item", batch)
	}
	replay, err := fx.executor.Execute(fx.ctx, importClaims, inventoryImportItemsCapabilityID, importInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("importItems replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	seedSalesStock(t, fx, fx.orgID, batch.CreatedIDs[0], 5000)
	reserveInput := json.RawMessage(`{"sku":"SKU-IMP1","quantityThousandths":2000,"reason":"Wave4 order hold"}`)
	reserved, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryReserveStockCapabilityID, "inventory.write", reserveInput, "human", "", "wave4-reserve"), inventoryReserveStockCapabilityID, reserveInput)
	if err != nil || !reserved.OK {
		t.Fatalf("reserveStock result=%+v err=%v", reserved, err)
	}
	var reservation InventoryReserveStockOutput
	if err := json.Unmarshal(reserved.Data, &reservation); err != nil {
		t.Fatal(err)
	}
	if !isUUID(reservation.ReservationID) || reservation.AvailableAfterThousandths != 3000 {
		t.Fatalf("reserveStock output=%+v, want a reservation leaving 3000 available", reservation)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryReserveStockCapabilityID, "sales.write", reserveInput, "human", "", "wave4-reserve-denied"), inventoryReserveStockCapabilityID, reserveInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: inventory.write") {
		t.Fatalf("reserveStock denied result=%+v err=%v, want permission failure", denied, err)
	}

	released, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryReleaseReservationCapabilityID, "inventory.write", json.RawMessage(`{"reservationId":"`+reservation.ReservationID+`"}`), "human", "", "wave4-release"), inventoryReleaseReservationCapabilityID, json.RawMessage(`{"reservationId":"`+reservation.ReservationID+`"}`))
	if err != nil || !released.OK {
		t.Fatalf("releaseReservation result=%+v err=%v", released, err)
	}
	var release InventoryReleaseReservationOutput
	if err := json.Unmarshal(released.Data, &release); err != nil || !release.Released {
		t.Fatalf("releaseReservation output=%+v err=%v, want released", release, err)
	}
	if got := fx.count(`SELECT count(*) FROM stock_reservations WHERE org_id=$1::uuid AND id=$2::uuid AND status='released'`, fx.orgID, reservation.ReservationID); got != 1 {
		t.Fatalf("released reservations=%d, want one", got)
	}
}

func TestGoWave4BudgetsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBudgetFixture(t, fx)
	grantWavePermission(t, fx, "accounting.write")
	grantWavePermission(t, fx, "accounting.read")
	seedBudgetAccount(t, fx, "6000", "Operating Expenses", "expense")

	saveInput := json.RawMessage(`{"scenarioKey":"wave4-base","name":"Wave4 baseline","fiscalYear":2026,"currency":"USD","assumptions":{"collectionDelayDays":5,"spendUpliftBasisPoints":0,"expectedMonthlyInflowMinor":10000000,"expectedMonthlyOutflowMinor":8000000,"minimumCashBufferMinor":2000000},"lines":[{"month":8,"accountCode":"6000","plannedMinor":500000}]}`)
	saveClaims := waveModuleClaims(fx, saveBudgetScenarioCapabilityID, "accounting.write", saveInput, "human", "", "wave4-budget-save")
	saved, err := fx.executor.Execute(fx.ctx, saveClaims, saveBudgetScenarioCapabilityID, saveInput)
	if err != nil || !saved.OK {
		t.Fatalf("saveBudgetScenario result=%+v err=%v", saved, err)
	}
	var scenario SaveBudgetScenarioOutput
	if err := json.Unmarshal(saved.Data, &scenario); err != nil {
		t.Fatal(err)
	}
	if !isUUID(scenario.ScenarioID) {
		t.Fatalf("saveBudgetScenario output=%+v, want UUID scenarioId", scenario)
	}
	replay, err := fx.executor.Execute(fx.ctx, saveClaims, saveBudgetScenarioCapabilityID, saveInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("saveBudgetScenario replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, saveBudgetScenarioCapabilityID, "crm.write", saveInput, "human", "", "wave4-budget-denied"), saveBudgetScenarioCapabilityID, saveInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.write") {
		t.Fatalf("saveBudgetScenario denied result=%+v err=%v, want permission failure", denied, err)
	}

	fx.addAgentSession()
	fx.addPolicy(undoBudgetScenarioVersionCapabilityID, "read", nil)
	undoInput := json.RawMessage(`{"scenarioId":"` + scenario.ScenarioID + `","previousScenarioId":null}`)
	approved := approveModuleWrite(t, fx, undoBudgetScenarioVersionCapabilityID, "accounting.write", undoInput)
	var undo BudgetScenarioVersionOutput
	if err := json.Unmarshal(approved.Data, &undo); err != nil {
		t.Fatal(err)
	}
	if got := fx.count(`SELECT count(*) FROM budget_scenarios WHERE org_id=$1::uuid AND scenario_key='wave4-base' AND is_current`, fx.orgID); got != 0 {
		t.Fatalf("current versions after undo=%d, want the only version retired", got)
	}
}
