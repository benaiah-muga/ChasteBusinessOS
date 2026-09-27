package dashboard

import (
	"reflect"
	"testing"
	"time"
)

func TestSummarizeMoneyMatchesLegacyReportFiltersAndSigns(t *testing.T) {
	money := summarizeMoney([]accountBalance{
		{code: "1000", typeName: "asset", allDebit: 8_000},
		{code: "3000", typeName: "equity", allCredit: 8_000},
		{code: "4000", typeName: "income", operatingCredit: 10_000},
		{code: "6000", typeName: "expense", operatingDebit: 2_000},
	})
	if money.RevenueMinor != 10_000 || money.ExpenseMinor != 2_000 || money.NetIncomeMinor != 8_000 {
		t.Fatalf("operating report totals = %+v, want revenue=10000 expense=2000 net=8000", money)
	}
	if money.AssetsMinor != 8_000 || money.LiabilitiesMinor != 0 || money.EquityMinor != 8_000 || money.Balanced == nil || !*money.Balanced {
		t.Fatalf("balance sheet = %+v, want assets/equity 8000 and balanced", money)
	}

	closed := summarizeMoney([]accountBalance{
		{typeName: "asset", allDebit: 8_000},
		{typeName: "equity", allCredit: 8_000},
		{typeName: "income", operatingCredit: 10_000, allDebit: 10_000, allCredit: 10_000},
		{typeName: "expense", operatingDebit: 2_000, allDebit: 2_000, allCredit: 2_000},
	})
	if closed.RevenueMinor != 10_000 || closed.ExpenseMinor != 2_000 || closed.NetIncomeMinor != 8_000 {
		t.Fatalf("operating totals included closing rows: %+v", closed)
	}
	if closed.Balanced == nil || !*closed.Balanced || closed.EquityMinor != 8_000 {
		t.Fatalf("all-entry balance sheet did not include the close: %+v", closed)
	}
}

func TestSummarizePipelineMatchesStageOrderAndPerDealMathRound(t *testing.T) {
	got := summarizePipeline([]dealRow{
		{stage: "lead", value: 5},
		{stage: "qualified", value: 5},
		{stage: "proposal", value: 3},
		{stage: "negotiation", value: 7},
		{stage: "won", value: 10},
		{stage: "lost", value: 11},
		{stage: "future-stage", value: 900},
	})
	wantStages := []PipelineStage{
		{Stage: "lead", Count: 1, ValueMinor: 5},
		{Stage: "qualified", Count: 1, ValueMinor: 5},
		{Stage: "proposal", Count: 1, ValueMinor: 3},
		{Stage: "negotiation", Count: 1, ValueMinor: 7},
		{Stage: "won", Count: 1, ValueMinor: 10},
		{Stage: "lost", Count: 1, ValueMinor: 11},
	}
	if !reflect.DeepEqual(got.Stages, wantStages) || got.OpenCount != 5 || got.WeightedForecastMinor != 20 {
		t.Fatalf("pipeline = %+v, want stages=%+v open=5 weighted=20", got, wantStages)
	}
	if got := jsRound(-15 * 0.1); got != -1 {
		t.Fatalf("legacy Math.round behavior for negative half = %d, want -1", got)
	}
}

func TestOutstandingMinorClampsOverAllocationAndRejectsCorruptMoney(t *testing.T) {
	got, err := outstandingMinor(documentMoney{total: 100, credited: 70, paid: 40})
	if err != nil || got != 0 {
		t.Fatalf("over-allocated outstanding = %d, err=%v, want 0", got, err)
	}
	got, err = outstandingMinor(documentMoney{total: 100, credited: 20, paid: 30})
	if err != nil || got != 50 {
		t.Fatalf("outstanding = %d, err=%v, want 50", got, err)
	}
	if _, err := outstandingMinor(documentMoney{total: -1}); err == nil {
		t.Fatal("negative document total was accepted")
	}
}

func TestOverdueBoundaryMatchesLegacyStrictThirtyDays(t *testing.T) {
	now := time.Date(2026, time.June, 15, 12, 0, 0, 987_000_000, time.UTC)
	dayMillis := int64(24 * time.Hour / time.Millisecond)
	nowMillis := now.UnixMilli()
	exact := time.UnixMilli(nowMillis - 30*dayMillis)
	if overdueAt(exact, nowMillis, dayMillis, 1) {
		t.Fatal("invoice exactly 30 days old was marked overdue")
	}
	oneMillisecondOlder := time.UnixMilli(nowMillis - 30*dayMillis - 1)
	if !overdueAt(oneMillisecondOlder, nowMillis, dayMillis, 1) {
		t.Fatal("invoice 30 days and one millisecond old was not marked overdue")
	}
	if overdueAt(oneMillisecondOlder, nowMillis, dayMillis, 0) {
		t.Fatal("settled invoice was marked overdue")
	}
}

func TestSummarizeTrendUsesSixUTCMonthsAndKeepsCloseEntries(t *testing.T) {
	now := time.Date(2026, 6, 15, 23, 59, 59, 0, time.FixedZone("UTC+3", 3*60*60))
	got := summarizeTrend([]trendRow{
		{month: "2026-01", typeName: "income", amount: 10_000},
		{month: "2026-01", typeName: "expense", amount: -2_000},
		{month: "2026-05", typeName: "income", amount: 500},
		{month: "2026-06", typeName: "income", amount: -10_000},
		{month: "2026-06", typeName: "expense", amount: 2_000},
		{month: "2025-12", typeName: "income", amount: 99_000},
	}, now)
	want := []TrendMonth{
		{Month: "2026-01", IncomeMinor: 10_000, ExpenseMinor: 2_000},
		{Month: "2026-02", IncomeMinor: 0, ExpenseMinor: 0},
		{Month: "2026-03", IncomeMinor: 0, ExpenseMinor: 0},
		{Month: "2026-04", IncomeMinor: 0, ExpenseMinor: 0},
		{Month: "2026-05", IncomeMinor: 500, ExpenseMinor: 0},
		{Month: "2026-06", IncomeMinor: -10_000, ExpenseMinor: -2_000},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("trend = %+v, want %+v", got, want)
	}
}

func TestLegacyTimestampTruncatesToMillisecondsInUTC(t *testing.T) {
	value := time.Date(2026, 9, 27, 13, 11, 12, 130_987_000, time.FixedZone("UTC+3", 3*60*60))
	if got, want := legacyTimestamp(value), "2026-09-27T10:11:12.130Z"; got != want {
		t.Fatalf("timestamp = %q, want %q", got, want)
	}
}

func TestReportFailuresPreserveLegacyDashboardMoneyDefaults(t *testing.T) {
	input := Money{
		RevenueMinor: 100, ExpenseMinor: 20, NetIncomeMinor: 80,
		CashMinor: int64Pointer(70), Balanced: boolPointer(true),
		AssetsMinor: 100, LiabilitiesMinor: 10, EquityMinor: 10,
	}
	got := applyReportReadAccess(input, ReportReadAccess{IncomeStatement: true, TrialBalance: true})
	if got.RevenueMinor != 100 || got.ExpenseMinor != 20 || got.NetIncomeMinor != 80 || got.CashMinor == nil || *got.CashMinor != 70 {
		t.Fatalf("authorized P&L and trial balance fields = %+v", got)
	}
	if got.Balanced != nil || got.AssetsMinor != 0 || got.LiabilitiesMinor != 0 || got.EquityMinor != 0 {
		t.Fatalf("failed balance sheet did not preserve legacy defaults: %+v", got)
	}

	allFailed := applyReportReadAccess(input, ReportReadAccess{})
	if allFailed.RevenueMinor != 0 || allFailed.ExpenseMinor != 0 || allFailed.NetIncomeMinor != 0 || allFailed.CashMinor != nil || allFailed.Balanced != nil || allFailed.AssetsMinor != 0 || allFailed.LiabilitiesMinor != 0 || allFailed.EquityMinor != 0 {
		t.Fatalf("failed report reads did not preserve zero/null defaults: %+v", allFailed)
	}
}
