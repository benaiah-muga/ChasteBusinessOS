package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestGoAccountingFxRevaluationUsesGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFxLedger(t, fx)
	grantWavePermission(t, fx, "accounting.post")
	seedAccountingFxBase(t, fx, fx.orgID)

	historicalNum, historicalDen := int64(11), int64(10)
	issuedAt := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	seedAccountingFxInvoice(t, fx, fx.orgID, "EUR", "sent", 100_000, 0, 0, &issuedAt, nil, &historicalNum, &historicalDen)
	seedAccountingFxRate(t, fx, fx.orgID, "USD", "EUR", 12, 10, time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC))

	revalueInput := json.RawMessage(`{"year":2026,"month":8}`)
	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(
		fx, revalueForeignReceivablesCapabilityID, "crm.write", revalueInput, "human", "", "fx-revalue-denied"),
		revalueForeignReceivablesCapabilityID, revalueInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.post") {
		t.Fatalf("revalueForeignReceivables denied result=%+v err=%v, want accounting.post denial", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM period_fx_revaluations WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("permission-denied revaluation wrote %d rows, want none", got)
	}

	revalueClaims := waveModuleClaims(fx, revalueForeignReceivablesCapabilityID, "accounting.post", revalueInput, "human", "", "fx-revalue")
	revaluedResult, err := fx.executor.Execute(fx.ctx, revalueClaims, revalueForeignReceivablesCapabilityID, revalueInput)
	if err != nil || !revaluedResult.OK || revaluedResult.PendingApproval {
		t.Fatalf("revalueForeignReceivables result=%+v err=%v, want governed execution", revaluedResult, err)
	}
	var revalued RevalueForeignReceivablesOutput
	if err := json.Unmarshal(revaluedResult.Data, &revalued); err != nil {
		t.Fatalf("decode revalueForeignReceivables output %s: %v", revaluedResult.Data, err)
	}
	if !isUUID(revalued.RevaluationID) || revalued.EntryID == nil || revalued.TotalAdjustmentMinor != 10_000 || len(revalued.Currencies) != 1 ||
		revalued.Currencies[0].Currency != "EUR" || revalued.Currencies[0].ForeignMinor != 100_000 ||
		revalued.Currencies[0].HistoricalBaseMinor != 110_000 || revalued.Currencies[0].CloseBaseMinor != 120_000 ||
		revalued.Currencies[0].AdjustmentMinor != 10_000 {
		t.Fatalf("revaluation output=%+v, want EUR 100000 revalued from 110000 to 120000", revalued)
	}
	replay, err := fx.executor.Execute(fx.ctx, revalueClaims, revalueForeignReceivablesCapabilityID, revalueInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("revalueForeignReceivables replay=%+v err=%v, want governed receipt replay", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM period_fx_revaluations WHERE org_id=$1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("replay created %d FX revaluation rows, want one", got)
	}

	reverseInput := json.RawMessage(fmt.Sprintf(`{"revaluationId":%q,"reason":"corrected close rate"}`, revalued.RevaluationID))
	reverseClaims := waveModuleClaims(fx, reversePeriodFxRevaluationCapabilityID, "accounting.post", reverseInput, "human", "", "fx-reverse")
	reversedResult, err := fx.executor.Execute(fx.ctx, reverseClaims, reversePeriodFxRevaluationCapabilityID, reverseInput)
	if err != nil || !reversedResult.OK || reversedResult.PendingApproval {
		t.Fatalf("reversePeriodFxRevaluation result=%+v err=%v, want governed execution", reversedResult, err)
	}
	var reversed ReversePeriodFxRevaluationOutput
	if err := json.Unmarshal(reversedResult.Data, &reversed); err != nil {
		t.Fatalf("decode reversePeriodFxRevaluation output %s: %v", reversedResult.Data, err)
	}
	if reversed.EntryID == nil || !isUUID(*reversed.EntryID) || reversed.Year != 2026 || reversed.Month != 8 {
		t.Fatalf("reversal output=%+v, want a 2026-08 reversal receipt", reversed)
	}
	if lines := accountingFxEntryLines(t, fx, *reversed.EntryID); len(lines) != 2 ||
		lines[0] != (accountingFxLineSummary{code: "1100", debit: 0, credit: 10_000}) ||
		lines[1] != (accountingFxLineSummary{code: "7910", debit: 10_000, credit: 0}) {
		t.Fatalf("reversal lines=%+v, want an exact mirror of the revaluation", lines)
	}
	for _, capabilityID := range []string{revalueForeignReceivablesCapabilityID, reversePeriodFxRevaluationCapabilityID} {
		if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`,
			fx.orgID, capabilityID); got != 1 {
			t.Errorf("%s human audit events=%d, want one", capabilityID, got)
		}
	}
}

func TestGoAccountingFxRevaluationUsesJPYUnitsAndPeriodEndRate(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupAccountingFxLedger(t, fx)
	grantWavePermission(t, fx, "accounting.post")
	seedAccountingFxBase(t, fx, fx.orgID)

	historicalNum, historicalDen := int64(67), int64(10_000)
	issuedAt := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	seedAccountingFxInvoice(t, fx, fx.orgID, "JPY", "sent", 10_000, 0, 0, &issuedAt, nil, &historicalNum, &historicalDen)
	periodEnd := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(-time.Millisecond)
	seedAccountingFxRate(t, fx, fx.orgID, "USD", "JPY", 1, 100, periodEnd)
	seedAccountingFxRate(t, fx, fx.orgID, "USD", "JPY", 2, 100, periodEnd.Add(time.Millisecond))

	input := json.RawMessage(`{"year":2026,"month":8}`)
	claims := waveModuleClaims(fx, revalueForeignReceivablesCapabilityID, "accounting.post", input, "human", "", "fx-jpy-period-end")
	result, err := fx.executor.Execute(fx.ctx, claims, revalueForeignReceivablesCapabilityID, input)
	if err != nil || !result.OK || result.PendingApproval {
		t.Fatalf("JPY revaluation result=%+v err=%v, want governed execution", result, err)
	}
	var revalued RevalueForeignReceivablesOutput
	if err := json.Unmarshal(result.Data, &revalued); err != nil {
		t.Fatalf("decode JPY revaluation output %s: %v", result.Data, err)
	}
	wantLine := FxRevaluationCurrencyLine{
		Currency: "JPY", ForeignMinor: 10_000, HistoricalBaseMinor: 6_700,
		CloseBaseMinor: 10_000, AdjustmentMinor: 3_300, RateNum: 1, RateDen: 100,
	}
	if revalued.TotalAdjustmentMinor != wantLine.AdjustmentMinor || len(revalued.Currencies) != 1 || revalued.Currencies[0] != wantLine || revalued.EntryID == nil {
		t.Fatalf("JPY revaluation output=%+v, want line %+v with a posted adjustment", revalued, wantLine)
	}

	var snapshotJSON string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT rate_snapshot::text FROM period_fx_revaluations WHERE id = $1::uuid`, revalued.RevaluationID).Scan(&snapshotJSON); err != nil {
		t.Fatal(err)
	}
	var snapshot []FxRevaluationRateSnapshot
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		t.Fatalf("decode stored rate snapshot %s: %v", snapshotJSON, err)
	}
	if len(snapshot) != 1 || snapshot[0] != (FxRevaluationRateSnapshot{
		Currency: "JPY", RateNum: 1, RateDen: 100, ForeignMinor: 10_000,
		HistoricalBaseMinor: 6_700, CloseBaseMinor: 10_000,
	}) {
		t.Fatalf("stored JPY rate snapshot=%+v, want the exact period-end quote and zero-decimal conversion", snapshot)
	}
	if lines := accountingFxEntryLines(t, fx, *revalued.EntryID); len(lines) != 2 ||
		lines[0] != (accountingFxLineSummary{code: "1100", debit: 3_300, credit: 0}) ||
		lines[1] != (accountingFxLineSummary{code: "7910", debit: 0, credit: 3_300}) {
		t.Fatalf("JPY revaluation lines=%+v, want a balanced USD 3,300 adjustment", lines)
	}
}
