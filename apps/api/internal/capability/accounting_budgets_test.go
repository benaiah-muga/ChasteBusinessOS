package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestAccountingBudgetsParsersMirrorZodContracts(t *testing.T) {
	scenarioID := "22222222-2222-4222-8222-222222222222"
	previousID := "33333333-3333-4333-8333-333333333333"
	saveRaw := `{"scenarioKey":"2026-ops-plan","name":"FY26 Ops Plan","fiscalYear":2026,"currency":"USD",` +
		`"assumptions":{"collectionDelayDays":5,"spendUpliftBasisPoints":150,"expectedMonthlyInflowMinor":10,` +
		`"expectedMonthlyOutflowMinor":20,"minimumCashBufferMinor":30},` +
		`"lines":[{"month":1,"accountCode":"6000","plannedMinor":100,"note":"ops"},{"month":2,"accountCode":"4000","plannedMinor":200}],"unknown":true}`
	saved, err := ParseSaveBudgetScenarioInput(json.RawMessage(saveRaw))
	if err != nil {
		t.Fatal(err)
	}
	wantSave := SaveBudgetScenarioInput{
		ScenarioKey: "2026-ops-plan",
		Name:        "FY26 Ops Plan",
		FiscalYear:  2026,
		Currency:    "USD",
		Assumptions: BudgetScenarioAssumptions{
			CollectionDelayDays: 5, SpendUpliftBasisPoints: 150,
			ExpectedMonthlyInflowMinor: 10, ExpectedMonthlyOutflowMinor: 20, MinimumCashBufferMinor: 30,
		},
		Lines: []BudgetScenarioLineInput{
			{Month: 1, AccountCode: "6000", PlannedMinor: 100, Note: crmStringPointer("ops")},
			{Month: 2, AccountCode: "4000", PlannedMinor: 200},
		},
	}
	if saved.ScenarioKey != wantSave.ScenarioKey || saved.Name != wantSave.Name || saved.FiscalYear != wantSave.FiscalYear ||
		saved.Currency != wantSave.Currency || saved.Assumptions != wantSave.Assumptions || len(saved.Lines) != 2 ||
		saved.Lines[0].Month != 1 || saved.Lines[0].AccountCode != "6000" || saved.Lines[0].PlannedMinor != 100 ||
		saved.Lines[0].Note == nil || *saved.Lines[0].Note != "ops" ||
		saved.Lines[1] != (BudgetScenarioLineInput{Month: 2, AccountCode: "4000", PlannedMinor: 200}) {
		t.Fatalf("ParseSaveBudgetScenarioInput() = %+v, want %+v", saved, wantSave)
	}
	encoded, err := marshalJS(saved)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"scenarioKey":"2026-ops-plan","name":"FY26 Ops Plan","fiscalYear":2026,"currency":"USD",` +
		`"assumptions":{"collectionDelayDays":5,"spendUpliftBasisPoints":150,"expectedMonthlyInflowMinor":10,` +
		`"expectedMonthlyOutflowMinor":20,"minimumCashBufferMinor":30},` +
		`"lines":[{"month":1,"accountCode":"6000","plannedMinor":100,"note":"ops"},{"month":2,"accountCode":"4000","plannedMinor":200}]}`
	if string(encoded) != wantJSON {
		t.Fatalf("ParseSaveBudgetScenarioInput() JSON = %s, want %s", encoded, wantJSON)
	}
	minimal, err := ParseSaveBudgetScenarioInput(json.RawMessage(`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":12,"accountCode":"6000","plannedMinor":0}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if minimal.Assumptions != (BudgetScenarioAssumptions{}) || len(minimal.Lines) != 1 || minimal.Lines[0].Note != nil {
		t.Fatalf("minimal save input = %+v, want zeroed assumptions and absent note", minimal)
	}

	undoRaw := `{"scenarioId":"` + scenarioID + `","previousScenarioId":"` + previousID + `","unknown":1}`
	undone, err := ParseUndoBudgetScenarioVersionInput(json.RawMessage(undoRaw))
	if err != nil || undone.ScenarioID != scenarioID || undone.PreviousScenarioID == nil || *undone.PreviousScenarioID != previousID {
		t.Fatalf("ParseUndoBudgetScenarioVersionInput() = %+v, %v", undone, err)
	}
	nullPrevious, err := ParseUndoBudgetScenarioVersionInput(json.RawMessage(`{"scenarioId":"` + scenarioID + `","previousScenarioId":null}`))
	if nullPrevious.PreviousScenarioID != nil || err != nil {
		t.Fatalf("null previousScenarioId = %+v, %v, want nil pointer", nullPrevious.PreviousScenarioID, err)
	}
	restored, err := ParseRestoreBudgetScenarioVersionInput(json.RawMessage(`{"scenarioId":"` + scenarioID + `","previousScenarioId":null}`))
	if err != nil || restored.PreviousScenarioID != nil {
		t.Fatalf("ParseRestoreBudgetScenarioVersionInput() = %+v, %v", restored, err)
	}
	listed, err := ParseListBudgetScenariosInput(json.RawMessage(`{"fiscalYear":2026}`))
	if err != nil || listed.FiscalYear == nil || *listed.FiscalYear != 2026 {
		t.Fatalf("ParseListBudgetScenariosInput() = %+v, %v", listed, err)
	}
	if listed, err = ParseListBudgetScenariosInput(json.RawMessage(`{}`)); err != nil || listed.FiscalYear != nil {
		t.Fatalf("ParseListBudgetScenariosInput({}) = %+v, %v, want absent fiscalYear", listed, err)
	}
	planInput, err := ParseBudgetActualVsPlanInput(json.RawMessage(`{"scenarioId":"` + scenarioID + `"}`))
	if err != nil || planInput.ScenarioID != scenarioID {
		t.Fatalf("ParseBudgetActualVsPlanInput() = %+v, %v", planInput, err)
	}

	longKey := strings.Repeat("a", 81)
	longNote := strings.Repeat("n", 301)
	for _, raw := range []string{
		`[]`,
		`"x"`,
		`{}`,
		`{"scenarioKey":null,"name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"Uppercase","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"double--dash","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"-leading","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"` + longKey + `","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"P","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"` + strings.Repeat("n", 101) + `","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":null,"fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":1999,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2101,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026.5,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"usd","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USDD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","assumptions":null,"lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","assumptions":{"collectionDelayDays":-1},"lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","assumptions":{"collectionDelayDays":181},"lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","assumptions":{"spendUpliftBasisPoints":20001},"lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","assumptions":{"expectedMonthlyInflowMinor":-5},"lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD"}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":null}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":0,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":13,"accountCode":"6000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"600","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"60000","plannedMinor":1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":-1}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":null}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1,"note":"` + longNote + `"}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1,"note":null}]}`,
		`{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1},{"month":1,"accountCode":"6000","plannedMinor":2}]}`,
	} {
		if _, err := ParseSaveBudgetScenarioInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseSaveBudgetScenarioInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"scenarioId":"not-a-uuid","previousScenarioId":null}`,
		`{"scenarioId":"11111111-1111-1111-1111-111111111111","previousScenarioId":null}`,
		`{"scenarioId":"` + scenarioID + `"}`,
		`{"scenarioId":"` + scenarioID + `","previousScenarioId":"nope"}`,
		`{"scenarioId":"` + scenarioID + `","previousScenarioId":5}`,
	} {
		if _, err := ParseUndoBudgetScenarioVersionInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseUndoBudgetScenarioVersionInput accepted %s", raw)
		}
		if _, err := ParseRestoreBudgetScenarioVersionInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseRestoreBudgetScenarioVersionInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{"fiscalYear":1999}`,
		`{"fiscalYear":2101}`,
		`{"fiscalYear":2026.5}`,
		`{"fiscalYear":null}`,
	} {
		if _, err := ParseListBudgetScenariosInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseListBudgetScenariosInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"scenarioId":"not-a-uuid"}`,
		`{"scenarioId":null}`,
	} {
		if _, err := ParseBudgetActualVsPlanInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseBudgetActualVsPlanInput accepted %s", raw)
		}
	}

	validByCapability := map[string]string{
		saveBudgetScenarioCapabilityID:           `{"scenarioKey":"plan","name":"Plan","fiscalYear":2026,"currency":"USD","lines":[{"month":1,"accountCode":"6000","plannedMinor":1}]}`,
		undoBudgetScenarioVersionCapabilityID:    `{"scenarioId":"` + scenarioID + `","previousScenarioId":null}`,
		restoreBudgetScenarioVersionCapabilityID: `{"scenarioId":"` + scenarioID + `","previousScenarioId":null}`,
		listBudgetScenariosCapabilityID:          `{}`,
		budgetActualVsPlanCapabilityID:           `{"scenarioId":"` + scenarioID + `"}`,
	}
	for capabilityID, raw := range validByCapability {
		if _, err := parseAccountingBudgetInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseAccountingBudgetInput(%s) rejected %s: %v", capabilityID, raw, err)
		}
	}
	if _, err := parseAccountingBudgetInput("accounting.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("parseAccountingBudgetInput accepted an unsupported capability")
	}
}

func TestAccountingBudgetsDomainMathMirrorsErpCore(t *testing.T) {
	comparison, err := budgetCompare(100_000, 40_000, 0)
	if err != nil || comparison.projectedMinor != 40_000 || comparison.varianceMinor != -60_000 ||
		comparison.utilizationBps == nil || *comparison.utilizationBps != 4_000 {
		t.Fatalf("budgetCompare(100000, 40000, 0) = %+v, %v", comparison, err)
	}
	comparison, err = budgetCompare(0, 5_000, 4_800)
	if err != nil || comparison.projectedMinor != 9_800 || comparison.varianceMinor != 9_800 || comparison.utilizationBps != nil {
		t.Fatalf("budgetCompare(0, 5000, 4800) = %+v, %v, want null utilization at zero plan", comparison, err)
	}
	comparison, err = budgetCompare(10_000, -30_000, 0)
	if err != nil || comparison.projectedMinor != -30_000 || comparison.varianceMinor != -40_000 ||
		comparison.utilizationBps == nil || *comparison.utilizationBps != -30_000 {
		t.Fatalf("budgetCompare(10000, -30000, 0) = %+v, %v, want negative utilization away from zero", comparison, err)
	}
	comparison, err = budgetCompare(6, 1, 0)
	if err != nil || comparison.utilizationBps == nil || *comparison.utilizationBps != 1_667 {
		t.Fatalf("budgetCompare(6, 1, 0) = %+v, %v, want half-up 1667 bps", comparison, err)
	}
	comparison, err = budgetCompare(1, maxSafeInteger, 0)
	if err != nil || comparison.utilizationBps != nil {
		t.Fatalf("budgetCompare(1, maxSafe, 0) = %+v, %v, want null utilization beyond the safe range", comparison, err)
	}
	if _, err = budgetCompare(1, maxSafeInteger, maxSafeInteger); err == nil || err.Error() != "budget comparison exceeds the supported amount range" {
		t.Fatalf("budgetCompare overflow error = %v", err)
	}
	for _, bad := range []struct {
		plan, actual, committed int64
		wantErr                 string
	}{
		{-1, 0, 0, "plan must be a non-negative safe integer"},
		{0, 0, -1, "commitments must be a non-negative safe integer"},
		{0, -maxSafeInteger - 1, 0, "actual must be a safe integer"},
	} {
		if _, err := budgetCompare(bad.plan, bad.actual, bad.committed); err == nil || err.Error() != bad.wantErr {
			t.Errorf("budgetCompare(%d, %d, %d) error = %v, want %q", bad.plan, bad.actual, bad.committed, err, bad.wantErr)
		}
	}

	if got := budgetRemainingCommitment(20_000, 7_500); got != 12_500 {
		t.Fatalf("budgetRemainingCommitment(20000, 7500) = %d, want 12500", got)
	}
	if got := budgetRemainingCommitment(7_500, 20_000); got != 0 {
		t.Fatalf("budgetRemainingCommitment(7500, 20000) = %d, want 0", got)
	}

	net, err := budgetLineNetMinor(2_000, 10_000, 0, false)
	if err != nil || net != 20_000 {
		t.Fatalf("budgetLineNetMinor(2000, 10000, 0, false) = %d, %v", net, err)
	}
	net, err = budgetLineNetMinor(1, 500, 0, false)
	if err != nil || net != 1 {
		t.Fatalf("budgetLineNetMinor(1, 500) = %d, %v, want half-up 1", net, err)
	}
	net, err = budgetLineNetMinor(1, 499, 0, false)
	if err != nil || net != 0 {
		t.Fatalf("budgetLineNetMinor(1, 499) = %d, %v, want half-up 0", net, err)
	}
	net, err = budgetLineNetMinor(2_000, 10_000, 2_500, false)
	if err != nil || net != 20_000 {
		t.Fatalf("exclusive tax line net = %d, %v, want gross 20000", net, err)
	}
	net, err = budgetLineNetMinor(2_000, 10_000, 10_000, true)
	if err != nil || net != 10_000 {
		t.Fatalf("tax inclusive net = %d, %v, want 10000", net, err)
	}
	for _, bad := range []struct {
		quantity, unitPrice, rate int64
		inclusive                 bool
		wantErr                   string
	}{
		{0, 100, 0, false, "quantity must be positive thousandths"},
		{-5, 100, 0, false, "quantity must be positive thousandths"},
		{1, -1, 0, false, "unit price must be a non-negative safe integer"},
		{1, 100, -1, false, "tax rate must be non-negative basis points"},
	} {
		if _, err := budgetLineNetMinor(bad.quantity, bad.unitPrice, bad.rate, bad.inclusive); err == nil || err.Error() != bad.wantErr {
			t.Errorf("budgetLineNetMinor(%d, %d, %d, %v) error = %v, want %q", bad.quantity, bad.unitPrice, bad.rate, bad.inclusive, err, bad.wantErr)
		}
	}
}

func budgetTestClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

// cleanupBudgetFixture removes seeded rows in reverse dependency order:
// journal lines before entries, entry lines before accounts, bill and po
// lines before their headers, headers before vendors. Posted ledger rows
// refuse DELETE unless the transaction enables app.ledger_maintenance first.
func cleanupBudgetFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin budget fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable budget fixture ledger cleanup: %v", err)
			return
		}
		steps := []struct {
			label string
			query string
		}{
			{"journal lines", `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id = ANY($1::uuid[]))`},
			{"journal entries", `DELETE FROM journal_entries WHERE org_id = ANY($1::uuid[])`},
			{"vendor bill lines", `DELETE FROM vendor_bill_lines vbl USING vendor_bills vb WHERE vbl.bill_id = vb.id AND vb.org_id = ANY($1::uuid[])`},
			{"vendor bills", `DELETE FROM vendor_bills WHERE org_id = ANY($1::uuid[])`},
			{"po lines", `DELETE FROM po_lines pl USING purchase_orders po WHERE pl.po_id = po.id AND po.org_id = ANY($1::uuid[])`},
			{"purchase orders", `DELETE FROM purchase_orders WHERE org_id = ANY($1::uuid[])`},
			{"budget lines", `DELETE FROM budget_lines WHERE org_id = ANY($1::uuid[])`},
			{"budget scenarios", `DELETE FROM budget_scenarios WHERE org_id = ANY($1::uuid[])`},
			{"accounts", `DELETE FROM accounts WHERE org_id = ANY($1::uuid[])`},
			{"vendors", `DELETE FROM vendors WHERE org_id = ANY($1::uuid[])`},
		}
		for _, step := range steps {
			if _, err := tx.Exec(fx.ctx, step.query, []string{fx.orgID, fx.otherOrgID}); err != nil {
				t.Errorf("delete budget fixture %s: %v", step.label, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit budget fixture cleanup: %v", err)
		}
	})
}

func seedBudgetAccount(t *testing.T, fx *executorFixture, code, name, accountType string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)`, fx.orgID, code, name, accountType); err != nil {
		t.Fatal(err)
	}
}

func seedBudgetScenarioRow(t *testing.T, fx *executorFixture, orgID, scenarioKey, name string, fiscalYear, version int64, currency string, isCurrent bool, assumptions string, createdAt time.Time) string {
	t.Helper()
	var scenarioID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO budget_scenarios (org_id, scenario_key, name, fiscal_year, version, currency, assumptions, is_current, created_by_actor_type, created_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, 'human', $9)
		RETURNING id::text`, orgID, scenarioKey, name, fiscalYear, version, currency, assumptions, isCurrent, createdAt).Scan(&scenarioID)
	if err != nil {
		t.Fatal(err)
	}
	return scenarioID
}

func seedBudgetLineRow(t *testing.T, fx *executorFixture, orgID, scenarioID string, month int64, accountCode string, plannedMinor int64) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO budget_lines (org_id, scenario_id, month, account_code, planned_minor)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)`, orgID, scenarioID, month, accountCode, plannedMinor); err != nil {
		t.Fatal(err)
	}
}

type budgetSeedLine struct {
	accountCode string
	debitMinor  int64
	creditMinor int64
}

func budgetTimePointer(value time.Time) *time.Time { return &value }

func seedBudgetJournalEntry(t *testing.T, fx *executorFixture, orgID, currency, entryKind string, postedAt time.Time, lines []budgetSeedLine) string {
	t.Helper()
	tx, err := fx.owner.Begin(fx.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	var entryID string
	if err := tx.QueryRow(fx.ctx, `
		INSERT INTO journal_entries (org_id, memo, currency, entry_kind, posted_at, posted_by_actor_type)
		VALUES ($1::uuid, 'budget fixture entry', $2, $3, $4, 'system')
		RETURNING id::text`, orgID, currency, entryKind, postedAt).Scan(&entryID); err != nil {
		t.Fatal(err)
	}
	for _, line := range lines {
		if _, err := tx.Exec(fx.ctx, `
			INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor)
			SELECT $1::uuid, id, $2, $3 FROM accounts WHERE org_id = $4::uuid AND code = $5`,
			entryID, line.debitMinor, line.creditMinor, orgID, line.accountCode); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(fx.ctx); err != nil {
		t.Fatal(err)
	}
	return entryID
}

func seedBudgetVendor(t *testing.T, fx *executorFixture, orgID string) string {
	t.Helper()
	var vendorID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Budget fixture vendor')
		RETURNING id::text`, orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	return vendorID
}

func seedBudgetPurchaseOrder(t *testing.T, fx *executorFixture, orgID, vendorID, status string, number int64, promisedAt, orderedAt, createdAt *time.Time, voidedAt *time.Time) string {
	t.Helper()
	if createdAt == nil {
		createdAt = budgetTimePointer(time.Date(2025, 12, 1, 0, 0, 0, 0, time.UTC))
	}
	var poID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO purchase_orders (org_id, vendor_id, number, status, promised_at, ordered_at, created_at, voided_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
		RETURNING id::text`, orgID, vendorID, number, status, promisedAt, orderedAt, createdAt, voidedAt).Scan(&poID)
	if err != nil {
		t.Fatal(err)
	}
	return poID
}

func seedBudgetPOLine(t *testing.T, fx *executorFixture, poID string, position int64, expenseAccountCode string, quantity, unitPriceMinor int64) string {
	t.Helper()
	var poLineID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, expense_account_code, position)
		VALUES ($1::uuid, 'budget fixture line', $2, $3, $4, $5)
		RETURNING id::text`, poID, quantity, unitPriceMinor, expenseAccountCode, position).Scan(&poLineID)
	if err != nil {
		t.Fatal(err)
	}
	return poLineID
}

func seedBudgetVendorBill(t *testing.T, fx *executorFixture, orgID, vendorID, status string, number int64) string {
	t.Helper()
	var billID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, total_minor)
		VALUES ($1::uuid, $2::uuid, $3, $4, 0)
		RETURNING id::text`, orgID, vendorID, number, status).Scan(&billID)
	if err != nil {
		t.Fatal(err)
	}
	return billID
}

func seedBudgetBillLine(t *testing.T, fx *executorFixture, billID string, poLineID *string, quantity, unitPriceMinor int64, rateBasisPoints *int64, priceIncludesTax bool) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO vendor_bill_lines (bill_id, description, quantity, unit_price_minor, tax_rate_basis_points, price_includes_tax, expense_account_code, po_line_id)
		VALUES ($1::uuid, 'budget fixture bill line', $2, $3, $4, $5, '6000', $6::uuid)`,
		billID, quantity, unitPriceMinor, rateBasisPoints, priceIncludesTax, poLineID); err != nil {
		t.Fatal(err)
	}
}

func budgetScenarioState(t *testing.T, fx *executorFixture, scenarioID string) (version int64, isCurrent bool) {
	t.Helper()
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT version, is_current FROM budget_scenarios WHERE id = $1::uuid`, scenarioID).Scan(&version, &isCurrent); err != nil {
		t.Fatal(err)
	}
	return version, isCurrent
}

func TestAccountingBudgetsSaveVersionsAndGuardRefusals(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBudgetFixture(t, fx)
	seedBudgetAccount(t, fx, "1000", "Cash", "asset")
	seedBudgetAccount(t, fx, "3000", "Equity", "equity")
	seedBudgetAccount(t, fx, "4000", "Sales", "income")
	seedBudgetAccount(t, fx, "6000", "Ops expense", "expense")
	claims := budgetTestClaims(fx)

	first, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SaveBudgetScenarioOutput, error) {
		return saveBudgetScenario(fx.ctx, tx, claims, SaveBudgetScenarioInput{
			ScenarioKey: "ops-plan", Name: "Ops Plan", FiscalYear: 2026, Currency: "USD",
			Lines: []BudgetScenarioLineInput{
				{Month: 1, AccountCode: "4000", PlannedMinor: 100_000},
				{Month: 1, AccountCode: "6000", PlannedMinor: 50_000, Note: crmStringPointer("operations")},
			},
		})
	})
	if err != nil {
		t.Fatalf("saveBudgetScenario(first): %v", err)
	}
	if !isUUID(first.ScenarioID) || first.Version != 1 || first.PreviousScenarioID != nil {
		t.Fatalf("first save output = %+v, want version one without a previous scenario", first)
	}
	encoded, err := marshalJS(first)
	if err != nil || string(encoded) != fmt.Sprintf(`{"scenarioId":%q,"version":1,"previousScenarioId":null}`, first.ScenarioID) {
		t.Fatalf("first save output JSON = %s, %v", encoded, err)
	}
	var storedKey, storedName, storedCurrency, actorType string
	var storedYear, storedVersion int64
	var actorID *string
	var assumptionsRaw []byte
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT scenario_key, name, fiscal_year, version, currency, assumptions, created_by_actor_type, created_by_actor_id::text
		FROM budget_scenarios WHERE id = $1::uuid`, first.ScenarioID).
		Scan(&storedKey, &storedName, &storedYear, &storedVersion, &storedCurrency, &assumptionsRaw, &actorType, &actorID); err != nil {
		t.Fatal(err)
	}
	var storedAssumptions BudgetScenarioAssumptions
	if err := json.Unmarshal(assumptionsRaw, &storedAssumptions); err != nil {
		t.Fatal(err)
	}
	if storedKey != "ops-plan" || storedName != "Ops Plan" || storedYear != 2026 || storedVersion != 1 ||
		storedCurrency != "USD" || storedAssumptions != (BudgetScenarioAssumptions{}) ||
		actorType != "human" || actorID == nil || *actorID != fx.userID {
		t.Fatalf("stored scenario = key=%s name=%s year=%d version=%d currency=%s assumptions=%+v actor=%s/%v",
			storedKey, storedName, storedYear, storedVersion, storedCurrency, storedAssumptions, actorType, actorID)
	}
	var note *string
	var plannedMinor int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT planned_minor, note FROM budget_lines
		WHERE scenario_id = $1::uuid AND month = 1 AND account_code = '6000'`, first.ScenarioID).Scan(&plannedMinor, &note); err != nil {
		t.Fatal(err)
	}
	if plannedMinor != 50_000 || note == nil || *note != "operations" {
		t.Fatalf("stored budget line = planned=%d note=%v", plannedMinor, note)
	}

	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SaveBudgetScenarioOutput, error) {
		return saveBudgetScenario(fx.ctx, tx, claims, SaveBudgetScenarioInput{
			ScenarioKey: "ops-plan", Name: "Ops Plan Revised", FiscalYear: 2026, Currency: "USD",
			Assumptions: BudgetScenarioAssumptions{CollectionDelayDays: 7, MinimumCashBufferMinor: 4_500},
			Lines:       []BudgetScenarioLineInput{{Month: 2, AccountCode: "6000", PlannedMinor: 60_000}},
		})
	})
	if err != nil {
		t.Fatalf("saveBudgetScenario(second): %v", err)
	}
	if second.Version != 2 || second.PreviousScenarioID == nil || *second.PreviousScenarioID != first.ScenarioID {
		t.Fatalf("second save output = %+v, want version two chaining to the first scenario", second)
	}
	if _, current := budgetScenarioState(t, fx, first.ScenarioID); current {
		t.Fatal("first scenario is still current after the second save")
	}
	if _, current := budgetScenarioState(t, fx, second.ScenarioID); !current {
		t.Fatal("second scenario is not current after its save")
	}

	for _, bad := range []struct {
		label   string
		input   SaveBudgetScenarioInput
		wantErr string
	}{
		{
			label: "currency mismatch",
			input: SaveBudgetScenarioInput{
				ScenarioKey: "ops-plan", Name: "Euro Plan", FiscalYear: 2026, Currency: "EUR",
				Lines: []BudgetScenarioLineInput{{Month: 1, AccountCode: "6000", PlannedMinor: 1}},
			},
			wantErr: "budget currency must match the organization's base currency (USD)",
		},
		{
			label: "unknown account",
			input: SaveBudgetScenarioInput{
				ScenarioKey: "ops-plan", Name: "Mystery Plan", FiscalYear: 2026, Currency: "USD",
				Lines: []BudgetScenarioLineInput{{Month: 1, AccountCode: "9999", PlannedMinor: 1}},
			},
			wantErr: "budget lines must reference income or expense accounts: 9999",
		},
		{
			label: "balance sheet account",
			input: SaveBudgetScenarioInput{
				ScenarioKey: "ops-plan", Name: "Asset Plan", FiscalYear: 2026, Currency: "USD",
				Lines: []BudgetScenarioLineInput{
					{Month: 1, AccountCode: "6000", PlannedMinor: 1},
					{Month: 1, AccountCode: "1000", PlannedMinor: 5},
				},
			},
			wantErr: "budget lines must reference income or expense accounts: 1000",
		},
	} {
		if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SaveBudgetScenarioOutput, error) {
			return saveBudgetScenario(fx.ctx, tx, claims, bad.input)
		}); err == nil || err.Error() != bad.wantErr {
			t.Fatalf("saveBudgetScenario(%s) error = %v, want %q", bad.label, err, bad.wantErr)
		}
	}
	if got := fx.count(`SELECT count(*) FROM budget_scenarios WHERE org_id = $1::uuid`, fx.orgID); got != 2 {
		t.Fatalf("budget scenarios stored = %d, want only the two successful saves", got)
	}
	if got := fx.count(`SELECT count(*) FROM budget_lines WHERE org_id = $1::uuid`, fx.orgID); got != 3 {
		t.Fatalf("budget lines stored = %d, want three across the two versions", got)
	}
}

func TestAccountingBudgetsUndoRestoreWalkVersionChain(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBudgetFixture(t, fx)
	seedBudgetAccount(t, fx, "6000", "Ops expense", "expense")
	claims := budgetTestClaims(fx)

	v1, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SaveBudgetScenarioOutput, error) {
		return saveBudgetScenario(fx.ctx, tx, claims, SaveBudgetScenarioInput{
			ScenarioKey: "chain-plan", Name: "Chain Plan", FiscalYear: 2026, Currency: "USD",
			Lines: []BudgetScenarioLineInput{{Month: 1, AccountCode: "6000", PlannedMinor: 10_000}},
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	v2, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SaveBudgetScenarioOutput, error) {
		return saveBudgetScenario(fx.ctx, tx, claims, SaveBudgetScenarioInput{
			ScenarioKey: "chain-plan", Name: "Chain Plan Revised", FiscalYear: 2026, Currency: "USD",
			Lines: []BudgetScenarioLineInput{{Month: 2, AccountCode: "6000", PlannedMinor: 20_000}},
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	otherKey := seedBudgetScenarioRow(t, fx, fx.orgID, "cash-plan", "Cash Plan", 2026, 1, "USD", true, "{}", time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC))
	foreignScenario := seedBudgetScenarioRow(t, fx, fx.otherOrgID, "chain-plan", "Foreign Chain", 2026, 1, "USD", true, "{}", time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC))

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetScenarioVersionOutput, error) {
		return undoBudgetScenarioVersion(fx.ctx, tx, fx.orgID, BudgetScenarioVersionInput{ScenarioID: v1.ScenarioID, PreviousScenarioID: nil})
	}); err == nil || err.Error() != "the saved version is no longer current" {
		t.Fatalf("undo of a superseded version error = %v, want current-state refusal", err)
	}

	undone, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetScenarioVersionOutput, error) {
		return undoBudgetScenarioVersion(fx.ctx, tx, fx.orgID, BudgetScenarioVersionInput{ScenarioID: v2.ScenarioID, PreviousScenarioID: crmStringPointer(v1.ScenarioID)})
	})
	if err != nil {
		t.Fatalf("undoBudgetScenarioVersion: %v", err)
	}
	if undone.ScenarioID != v2.ScenarioID || undone.RestoredScenarioID == nil || *undone.RestoredScenarioID != v1.ScenarioID {
		t.Fatalf("undo output = %+v, want the prior version restored", undone)
	}
	encoded, err := marshalJS(undone)
	if err != nil || string(encoded) != fmt.Sprintf(`{"scenarioId":%q,"restoredScenarioId":%q}`, v2.ScenarioID, v1.ScenarioID) {
		t.Fatalf("undo output JSON = %s, %v", encoded, err)
	}
	if _, current := budgetScenarioState(t, fx, v1.ScenarioID); !current {
		t.Fatal("prior version is not current after undo")
	}
	if _, current := budgetScenarioState(t, fx, v2.ScenarioID); current {
		t.Fatal("undone version is still current")
	}

	unCurrented, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetScenarioVersionOutput, error) {
		return undoBudgetScenarioVersion(fx.ctx, tx, fx.orgID, BudgetScenarioVersionInput{ScenarioID: v1.ScenarioID, PreviousScenarioID: nil})
	})
	if err != nil {
		t.Fatalf("undo without a prior version: %v", err)
	}
	if unCurrented.RestoredScenarioID != nil {
		t.Fatalf("undo without prior = %+v, want null restored id", unCurrented)
	}
	if _, current := budgetScenarioState(t, fx, v1.ScenarioID); current {
		t.Fatal("version stayed current after an undo without a prior version")
	}
	if _, current := budgetScenarioState(t, fx, otherKey); !current {
		t.Fatal("unrelated scenario lost its current flag")
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetScenarioVersionOutput, error) {
		return undoBudgetScenarioVersion(fx.ctx, tx, fx.orgID, BudgetScenarioVersionInput{ScenarioID: v1.ScenarioID, PreviousScenarioID: nil})
	}); err == nil || err.Error() != "the saved version is no longer current" {
		t.Fatalf("repeat undo error = %v, want current-state refusal", err)
	}

	restored, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetScenarioVersionOutput, error) {
		return restoreBudgetScenarioVersion(fx.ctx, tx, fx.orgID, BudgetScenarioVersionInput{ScenarioID: v1.ScenarioID, PreviousScenarioID: crmStringPointer(v2.ScenarioID)})
	})
	if err != nil {
		t.Fatalf("restoreBudgetScenarioVersion: %v", err)
	}
	if restored.ScenarioID != v1.ScenarioID || restored.RestoredScenarioID == nil || *restored.RestoredScenarioID != v2.ScenarioID {
		t.Fatalf("restore output = %+v, want the requested version current again", restored)
	}
	if _, current := budgetScenarioState(t, fx, v1.ScenarioID); !current {
		t.Fatal("restored version is not current")
	}
	if _, current := budgetScenarioState(t, fx, v2.ScenarioID); current {
		t.Fatal("sibling version stayed current after the restore")
	}
	if _, current := budgetScenarioState(t, fx, otherKey); !current {
		t.Fatal("restore disturbed an unrelated scenario key")
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetScenarioVersionOutput, error) {
		return undoBudgetScenarioVersion(fx.ctx, tx, fx.orgID, BudgetScenarioVersionInput{ScenarioID: v1.ScenarioID, PreviousScenarioID: crmStringPointer(otherKey)})
	}); err == nil || err.Error() != "the prior budget version is no longer available" {
		t.Fatalf("undo across keys error = %v, want prior-version refusal", err)
	}
	if _, current := budgetScenarioState(t, fx, v1.ScenarioID); !current {
		t.Fatal("refused undo still un-currented the saved version")
	}

	for _, bad := range []struct {
		label      string
		scenarioID string
		wantErr    string
	}{
		{"unknown undo", executorUUID(t), "budget version not found"},
		{"foreign undo", foreignScenario, "budget version not found"},
	} {
		_, undoErr := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetScenarioVersionOutput, error) {
			return undoBudgetScenarioVersion(fx.ctx, tx, fx.orgID, BudgetScenarioVersionInput{ScenarioID: bad.scenarioID, PreviousScenarioID: nil})
		})
		if undoErr == nil || undoErr.Error() != bad.wantErr {
			t.Fatalf("%s error = %v, want %q", bad.label, undoErr, bad.wantErr)
		}
	}
	for _, bad := range []struct {
		label      string
		scenarioID string
		wantErr    string
	}{
		{"unknown restore", executorUUID(t), "budget version not found"},
		{"foreign restore", foreignScenario, "budget version not found"},
	} {
		_, restoreErr := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetScenarioVersionOutput, error) {
			return restoreBudgetScenarioVersion(fx.ctx, tx, fx.orgID, BudgetScenarioVersionInput{ScenarioID: bad.scenarioID, PreviousScenarioID: nil})
		})
		if restoreErr == nil || restoreErr.Error() != bad.wantErr {
			t.Fatalf("%s error = %v, want %q", bad.label, restoreErr, bad.wantErr)
		}
	}
}

func TestAccountingBudgetsListOrdersFiltersAndScopesTenants(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBudgetFixture(t, fx)
	base := time.Date(2026, 1, 2, 10, 30, 0, 0, time.UTC)
	seedBudgetScenarioRow(t, fx, fx.orgID, "a-plan", "A Plan v1", 2026, 1, "USD", false, "{}", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	newest := seedBudgetScenarioRow(t, fx, fx.orgID, "a-plan", "A Plan v2", 2026, 2, "USD", true,
		`{"collectionDelayDays":3,"spendUpliftBasisPoints":250,"expectedMonthlyInflowMinor":11,"expectedMonthlyOutflowMinor":22,"minimumCashBufferMinor":33}`, base)
	otherYear := seedBudgetScenarioRow(t, fx, fx.orgID, "b-plan", "B Plan", 2027, 1, "USD", true, "{}", base)
	seedBudgetScenarioRow(t, fx, fx.otherOrgID, "a-plan", "Foreign Plan", 2026, 9, "USD", true, "{}", base)

	all, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListBudgetScenariosOutput, error) {
		return listBudgetScenarios(fx.ctx, tx, fx.orgID, ListBudgetScenariosInput{})
	})
	if err != nil {
		t.Fatalf("listBudgetScenarios: %v", err)
	}
	if len(all.Scenarios) != 3 || all.Scenarios[0].ID != newest || all.Scenarios[1].Key != "a-plan" || all.Scenarios[1].Version != 1 || all.Scenarios[2].ID != otherYear {
		t.Fatalf("listBudgetScenarios order = %+v, want key ascending and version descending", all.Scenarios)
	}
	first := all.Scenarios[0]
	if first.Name != "A Plan v2" || first.FiscalYear != 2026 || first.Currency != "USD" || !first.IsCurrent ||
		first.Assumptions != (BudgetScenarioAssumptions{CollectionDelayDays: 3, SpendUpliftBasisPoints: 250, ExpectedMonthlyInflowMinor: 11, ExpectedMonthlyOutflowMinor: 22, MinimumCashBufferMinor: 33}) ||
		first.CreatedAt != "2026-01-02T10:30:00.000Z" {
		t.Fatalf("newest scenario row = %+v", first)
	}
	encoded, err := marshalJS(first)
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(`{"id":%q,"key":"a-plan","name":"A Plan v2","fiscalYear":2026,"version":2,"currency":"USD","isCurrent":true,`+
		`"assumptions":{"collectionDelayDays":3,"spendUpliftBasisPoints":250,"expectedMonthlyInflowMinor":11,"expectedMonthlyOutflowMinor":22,"minimumCashBufferMinor":33},`+
		`"createdAt":"2026-01-02T10:30:00.000Z"}`, newest)
	if string(encoded) != want {
		t.Fatalf("list row JSON = %s, want %s", encoded, want)
	}

	year := int64(2026)
	filtered, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListBudgetScenariosOutput, error) {
		return listBudgetScenarios(fx.ctx, tx, fx.orgID, ListBudgetScenariosInput{FiscalYear: &year})
	})
	if err != nil {
		t.Fatalf("listBudgetScenarios(2026): %v", err)
	}
	if len(filtered.Scenarios) != 2 || filtered.Scenarios[0].ID != newest {
		t.Fatalf("filtered list = %+v, want only fiscal year 2026 rows", filtered.Scenarios)
	}
	emptyYear := int64(2025)
	empty, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListBudgetScenariosOutput, error) {
		return listBudgetScenarios(fx.ctx, tx, fx.orgID, ListBudgetScenariosInput{FiscalYear: &emptyYear})
	})
	if err != nil {
		t.Fatalf("listBudgetScenarios(2025): %v", err)
	}
	emptyEncoded, err := marshalJS(empty)
	if err != nil || string(emptyEncoded) != `{"scenarios":[]}` {
		t.Fatalf("empty list JSON = %s, %v", emptyEncoded, err)
	}
}

func TestAccountingBudgetsActualVsPlanAggregatesActualsAndCommitments(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBudgetFixture(t, fx)
	seedBudgetAccount(t, fx, "1000", "Cash", "asset")
	seedBudgetAccount(t, fx, "3000", "Equity", "equity")
	seedBudgetAccount(t, fx, "4000", "Sales", "income")
	seedBudgetAccount(t, fx, "6000", "Ops expense", "expense")
	seedBudgetAccount(t, fx, "6100", "Consulting", "expense")
	seedBudgetAccount(t, fx, "6200", "Ghost spend", "expense")

	scenarioID := seedBudgetScenarioRow(t, fx, fx.orgID, "actuals-plan", "Actuals Plan", 2026, 1, "USD", true, "{}", time.Date(2025, 12, 1, 0, 0, 0, 0, time.UTC))
	seedBudgetLineRow(t, fx, fx.orgID, scenarioID, 1, "4000", 100_000)
	seedBudgetLineRow(t, fx, fx.orgID, scenarioID, 1, "6000", 50_000)
	seedBudgetLineRow(t, fx, fx.orgID, scenarioID, 2, "6000", 60_000)

	seedBudgetJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC), []budgetSeedLine{
		{accountCode: "4000", creditMinor: 40_000},
		{accountCode: "1000", debitMinor: 40_000},
	})
	seedBudgetJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 1, 20, 12, 0, 0, 0, time.UTC), []budgetSeedLine{
		{accountCode: "6000", debitMinor: 30_000},
		{accountCode: "1000", creditMinor: 30_000},
	})
	seedBudgetJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 12, 31, 12, 0, 0, 0, time.UTC), []budgetSeedLine{
		{accountCode: "6000", debitMinor: 5_000},
		{accountCode: "1000", creditMinor: 5_000},
	})
	seedBudgetJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 12, 15, 12, 0, 0, 0, time.UTC), []budgetSeedLine{
		{accountCode: "6100", debitMinor: 7_500},
		{accountCode: "1000", creditMinor: 7_500},
	})
	seedBudgetJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC), []budgetSeedLine{
		{accountCode: "6200", debitMinor: 2_000},
		{accountCode: "1000", creditMinor: 2_000},
	})
	seedBudgetJournalEntry(t, fx, fx.orgID, "USD", "year_end_close", time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC), []budgetSeedLine{
		{accountCode: "4000", debitMinor: 70_000},
		{accountCode: "3000", creditMinor: 70_000},
	})
	seedBudgetJournalEntry(t, fx, fx.orgID, "EUR", "operational", time.Date(2026, 2, 10, 12, 0, 0, 0, time.UTC), []budgetSeedLine{
		{accountCode: "6000", debitMinor: 12_345},
		{accountCode: "1000", creditMinor: 12_345},
	})
	seedBudgetJournalEntry(t, fx, fx.orgID, "USD", "operational", time.Date(2025, 12, 31, 12, 0, 0, 0, time.UTC), []budgetSeedLine{
		{accountCode: "6000", debitMinor: 44_000},
		{accountCode: "1000", creditMinor: 44_000},
	})

	vendorID := seedBudgetVendor(t, fx, fx.orgID)
	foreignVendorID := seedBudgetVendor(t, fx, fx.otherOrgID)

	promisedMarch := time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC)
	poFullyBilled := seedBudgetPurchaseOrder(t, fx, fx.orgID, vendorID, "ordered", 1, &promisedMarch, nil, nil, nil)
	fullyBilledLine := seedBudgetPOLine(t, fx, poFullyBilled, 1, "6000", 2_000, 10_000)

	createdApril := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	poPartiallyBilled := seedBudgetPurchaseOrder(t, fx, fx.orgID, vendorID, "partial", 2, nil, nil, &createdApril, nil)
	partiallyBilledLine := seedBudgetPOLine(t, fx, poPartiallyBilled, 1, "6000", 1_000, 8_000)

	promisedMay := time.Date(2026, 5, 2, 0, 0, 0, 0, time.UTC)
	poUnbilled := seedBudgetPurchaseOrder(t, fx, fx.orgID, vendorID, "received", 3, &promisedMay, nil, nil, nil)
	unbilledLine := seedBudgetPOLine(t, fx, poUnbilled, 1, "6100", 500, 5_000)

	promisedJuly := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	seedBudgetPurchaseOrder(t, fx, fx.orgID, vendorID, "ordered", 4, &promisedJuly, nil, nil, budgetTimePointer(time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC)))
	seedBudgetPurchaseOrder(t, fx, fx.orgID, vendorID, "closed", 5, &promisedJuly, nil, nil, nil)
	promisedNextYear := time.Date(2027, 1, 5, 0, 0, 0, 0, time.UTC)
	seedBudgetPurchaseOrder(t, fx, fx.orgID, vendorID, "ordered", 6, &promisedNextYear, nil, nil, nil)

	billFull := seedBudgetVendorBill(t, fx, fx.orgID, vendorID, "open", 1)
	seedBudgetBillLine(t, fx, billFull, &fullyBilledLine, 2_000, 10_000, nil, false)
	billPartial := seedBudgetVendorBill(t, fx, fx.orgID, vendorID, "open", 2)
	partialRate := int64(2_500)
	seedBudgetBillLine(t, fx, billPartial, &partiallyBilledLine, 400, 8_000, &partialRate, false)
	billVoid := seedBudgetVendorBill(t, fx, fx.orgID, vendorID, "void", 3)
	seedBudgetBillLine(t, fx, billVoid, &unbilledLine, 5_000, 5_000, nil, false)
	foreignBill := seedBudgetVendorBill(t, fx, fx.otherOrgID, foreignVendorID, "open", 1)
	seedBudgetBillLine(t, fx, foreignBill, &unbilledLine, 5_000, 5_000, nil, false)

	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetActualVsPlanOutput, error) {
		return budgetActualVsPlan(fx.ctx, tx, fx.orgID, BudgetActualVsPlanInput{ScenarioID: scenarioID})
	})
	if err != nil {
		t.Fatalf("budgetActualVsPlan: %v", err)
	}
	if output.ScenarioID != scenarioID || output.Name != "Actuals Plan" || output.FiscalYear != 2026 ||
		output.Currency != "USD" || output.UnconvertedEntryCount != 1 || len(output.Months) != 12 {
		t.Fatalf("budgetActualVsPlan header = %+v, want the scenario header with one unconverted entry and 12 months", output)
	}

	lineByMonthCode := make(map[string]BudgetActualVsPlanLine)
	var nonEmptyMonths []int64
	for _, month := range output.Months {
		if len(month.Lines) > 0 {
			nonEmptyMonths = append(nonEmptyMonths, month.Month)
			for _, line := range month.Lines {
				lineByMonthCode[fmt.Sprintf("%d:%s", month.Month, line.AccountCode)] = line
			}
		}
	}
	if len(nonEmptyMonths) != 6 {
		t.Fatalf("non empty months = %v, want January, February, April, May, November, December", nonEmptyMonths)
	}

	janIncome := lineByMonthCode["1:4000"]
	if janIncome.AccountName != "Sales" || janIncome.AccountType != "income" || janIncome.PlanMinor != 100_000 ||
		janIncome.ActualMinor != 40_000 || janIncome.CommittedMinor != 0 || janIncome.ProjectedMinor != 40_000 ||
		janIncome.VarianceMinor != -60_000 || janIncome.UtilizationBps == nil || *janIncome.UtilizationBps != 4_000 {
		t.Fatalf("january income line = %+v, want credited income against the 100000 plan", janIncome)
	}
	janExpense := lineByMonthCode["1:6000"]
	if janExpense.AccountName != "Ops expense" || janExpense.PlanMinor != 50_000 || janExpense.ActualMinor != 30_000 ||
		janExpense.ProjectedMinor != 30_000 || janExpense.VarianceMinor != -20_000 ||
		janExpense.UtilizationBps == nil || *janExpense.UtilizationBps != 6_000 {
		t.Fatalf("january expense line = %+v", janExpense)
	}
	febExpense := lineByMonthCode["2:6000"]
	if febExpense.PlanMinor != 60_000 || febExpense.ActualMinor != 0 || febExpense.UtilizationBps == nil || *febExpense.UtilizationBps != 0 {
		t.Fatalf("february expense line = %+v, want plan only with zero utilization", febExpense)
	}
	aprilCommitted := lineByMonthCode["4:6000"]
	if aprilCommitted.PlanMinor != 0 || aprilCommitted.ActualMinor != 0 || aprilCommitted.CommittedMinor != 4_800 ||
		aprilCommitted.ProjectedMinor != 4_800 || aprilCommitted.VarianceMinor != 4_800 || aprilCommitted.UtilizationBps != nil {
		t.Fatalf("april committed line = %+v, want the 4800 minor unbilled remainder with null utilization", aprilCommitted)
	}
	mayCommitted := lineByMonthCode["5:6100"]
	if mayCommitted.AccountName != "Consulting" || mayCommitted.CommittedMinor != 2_500 || mayCommitted.UtilizationBps != nil {
		t.Fatalf("may committed line = %+v, want the unbilled consulting commitment", mayCommitted)
	}
	novemberGhost := lineByMonthCode["11:6200"]
	if novemberGhost.AccountName != "6200" || novemberGhost.AccountType != "expense" || novemberGhost.ActualMinor != 2_000 {
		t.Fatalf("november ghost line = %+v, want code fallback naming for an unplanned account", novemberGhost)
	}
	decemberExpense := lineByMonthCode["12:6000"]
	if decemberExpense.ActualMinor != 5_000 || decemberExpense.UtilizationBps != nil {
		t.Fatalf("december expense line = %+v", decemberExpense)
	}
	decemberConsulting := lineByMonthCode["12:6100"]
	if decemberConsulting.ActualMinor != 7_500 || decemberConsulting.CommittedMinor != 0 ||
		decemberConsulting.ProjectedMinor != 7_500 || decemberConsulting.VarianceMinor != 7_500 {
		t.Fatalf("december consulting line = %+v, want actuals only, the commitment stays in May", decemberConsulting)
	}
	if _, ok := lineByMonthCode["3:6000"]; ok {
		t.Fatal("fully billed march commitment still appears")
	}
	if _, ok := lineByMonthCode["1:1000"]; ok {
		t.Fatal("balance sheet account leaked into the budget comparison")
	}
	if _, ok := lineByMonthCode["6:4000"]; ok {
		t.Fatal("year end close entry leaked into the actuals")
	}
	februaryEntryCount := output.UnconvertedEntryCount
	if februaryEntryCount != 1 {
		t.Fatalf("unconverted entries = %d, want only the EUR entry", februaryEntryCount)
	}

	encoded, err := marshalJS(aprilCommitted)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"accountCode":"6000","accountName":"Ops expense","accountType":"expense","planMinor":0,"actualMinor":0,` +
		`"committedMinor":4800,"projectedMinor":4800,"varianceMinor":4800,"utilizationBps":null}`
	if string(encoded) != want {
		t.Fatalf("april line JSON = %s, want %s", encoded, want)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetActualVsPlanOutput, error) {
		return budgetActualVsPlan(fx.ctx, tx, fx.orgID, BudgetActualVsPlanInput{ScenarioID: executorUUID(t)})
	}); err == nil || err.Error() != "budget scenario not found" {
		t.Fatalf("missing scenario error = %v, want budget scenario not found", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (BudgetActualVsPlanOutput, error) {
		return budgetActualVsPlan(fx.ctx, tx, fx.orgID, BudgetActualVsPlanInput{ScenarioID: seedBudgetScenarioRow(t, fx, fx.otherOrgID, "foreign-actuals", "Foreign Actuals", 2026, 1, "USD", true, "{}", time.Date(2025, 12, 1, 0, 0, 0, 0, time.UTC))})
	}); err == nil || err.Error() != "budget scenario not found" {
		t.Fatalf("foreign scenario error = %v, want budget scenario not found", err)
	}
}

func TestAccountingBudgetsConcurrentSavesSerializeVersions(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupBudgetFixture(t, fx)
	seedBudgetAccount(t, fx, "6000", "Ops expense", "expense")
	claims := budgetTestClaims(fx)
	input := SaveBudgetScenarioInput{
		ScenarioKey: "race-plan", Name: "Race Plan", FiscalYear: 2026, Currency: "USD",
		Lines: []BudgetScenarioLineInput{{Month: 1, AccountCode: "6000", PlannedMinor: 5_000}},
	}

	firstReady := make(chan struct{})
	releaseFirst := make(chan struct{})
	defer func() {
		select {
		case <-releaseFirst:
		default:
			close(releaseFirst)
		}
	}()
	firstDone := make(chan error, 1)
	go func() {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SaveBudgetScenarioOutput, error) {
			out, err := saveBudgetScenario(fx.ctx, tx, claims, input)
			if err != nil {
				return SaveBudgetScenarioOutput{}, err
			}
			close(firstReady)
			<-releaseFirst
			return out, nil
		})
		firstDone <- err
	}()
	select {
	case <-firstReady:
	case <-time.After(5 * time.Second):
		t.Fatal("first save did not reach the held transaction")
	}

	secondDone := make(chan error, 1)
	go func() {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SaveBudgetScenarioOutput, error) {
			return saveBudgetScenario(fx.ctx, tx, claims, input)
		})
		secondDone <- err
	}()
	select {
	case err := <-secondDone:
		t.Fatalf("second save returned before the first transaction released the advisory lock: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatalf("first save transaction failed: %v", err)
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second save failed: %v", err)
	}
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT version, is_current FROM budget_scenarios
		WHERE org_id = $1::uuid AND scenario_key = $2 ORDER BY version`, fx.orgID, input.ScenarioKey)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	versions := make([]struct {
		version   int64
		isCurrent bool
	}, 0, 2)
	for rows.Next() {
		var row struct {
			version   int64
			isCurrent bool
		}
		if err := rows.Scan(&row.version, &row.isCurrent); err != nil {
			t.Fatal(err)
		}
		versions = append(versions, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(versions) != 2 || versions[0].version != 1 || versions[0].isCurrent || !versions[1].isCurrent || versions[1].version != 2 {
		t.Fatalf("concurrent saves produced %+v, want two serialized versions with only the newest current", versions)
	}
}
