package capability

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestAnalyticsParsers(t *testing.T) {
	report, err := ParseAnalyticsRenderReportInput(json.RawMessage(`{"title":"Monthly","sections":[{"heading":"Sales","columns":["sku","amount"],"rows":[{"sku":"A","amount":5}],"ops":[{"op":"sort","by":"amount","desc":true}],"chart":{"type":"bar","x":"sku","y":["amount"]}}]}`))
	if err != nil || len(report.Sections) != 1 || len(report.Sections[0].Ops) != 1 || report.Sections[0].Chart == nil {
		t.Fatalf("report parse=%+v err=%v", report, err)
	}
	if _, err := ParseAnalyticsRenderReportInput(json.RawMessage(`{"title":"Monthly","sections":[]}`)); err == nil {
		t.Fatal("empty sections refused")
	}
	months, err := ParseAnalyticsRevenueByMonthInput(json.RawMessage(`{}`))
	if err != nil || months.MonthsBack != 12 {
		t.Fatalf("monthsBack default=%+v err=%v", months, err)
	}
	if _, err := ParseAnalyticsRevenueByMonthInput(json.RawMessage(`{"monthsBack":99}`)); err == nil {
		t.Fatal("monthsBack over 36 refused")
	}
	explain, err := ParseAnalyticsExplainChangeInput(json.RawMessage(`{"dimension":"product","periodAFrom":"2026-01-01T00:00:00Z","periodATo":"2026-02-01T00:00:00Z","periodBFrom":"2026-02-01T00:00:00Z","periodBTo":"2026-03-01T00:00:00Z"}`))
	if err != nil || explain.Dimension != "product" {
		t.Fatalf("explain parse=%+v err=%v", explain, err)
	}
	if _, err := ParseAnalyticsExplainChangeInput(json.RawMessage(`{"dimension":"product","periodAFrom":"not-a-date","periodATo":"2026-02-01T00:00:00Z","periodBFrom":"2026-02-01T00:00:00Z","periodBTo":"2026-03-01T00:00:00Z"}`)); err == nil {
		t.Fatal("bad datetime refused")
	}
	if _, err := parseAnalyticsInput(analyticsRenderReportCapabilityID, json.RawMessage(`{"title":"x","sections":[{"heading":"h","columns":["c"],"rows":[]}]}`)); err != nil {
		t.Fatalf("dispatcher refused renderReport: %v", err)
	}
	if _, err := parseAnalyticsInput("analytics.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("dispatcher refused unknown id")
	}
}

func TestAnalyticsFrameOps(t *testing.T) {
	rows := []map[string]any{
		{"sku": "A", "amount": float64(30)},
		{"sku": "B", "amount": float64(10)},
		{"sku": "C", "amount": float64(20)},
	}
	frame := analyticsApplyFrameOps(rows, []analyticsFrameOp{
		{Op: "sort", By: strPtrPurchasing("amount"), Desc: true},
		{Op: "top", N: int64Ptr(2)},
		{Op: "pctOfTotal", Column: strPtrPurchasing("amount"), As: strPtrPurchasing("share")},
	})
	if len(frame.rows) != 2 || frame.rows[0]["sku"] != "A" {
		t.Fatalf("sorted frame=%+v, want A then B", frame.rows)
	}
	first, _ := frame.rows[0]["share"].(float64)
	if first != 0.5 {
		t.Fatalf("share=%v, want 0.5 over the three input rows", frame.rows[0]["share"])
	}

	grouped := analyticsApplyFrameOps(rows, []analyticsFrameOp{
		{Op: "groupBy", Keys: []string{"sku"}, Aggs: []analyticsAggOp{{Fn: "sum", Column: strPtrPurchasing("amount"), As: "total"}}},
	})
	if len(grouped.rows) != 3 || grouped.rows[0]["sku"] != "A" {
		t.Fatalf("grouped frame=%+v, want three groups ordered by sku", grouped.rows)
	}
	filtered := analyticsApplyFrameOps(rows, []analyticsFrameOp{
		{Op: "filter", Column: strPtrPurchasing("sku"), Matches: strPtrPurchasing("contains"), Value: "a"},
	})
	if len(filtered.rows) != 1 || filtered.rows[0]["sku"] != "A" {
		t.Fatalf("filtered frame=%+v, want only A", filtered.rows)
	}
}

func TestAnalyticsExplainChangePure(t *testing.T) {
	prior, current, delta, contributions := analyticsExplainChangePure(
		[]analyticsMetricRow{{Key: "A", ValueMinor: 100}, {Key: "B", ValueMinor: 50}},
		[]analyticsMetricRow{{Key: "A", ValueMinor: 80}, {Key: "B", ValueMinor: 120}},
	)
	if prior != 150 || current != 200 || delta != 50 {
		t.Fatalf("totals=%d/%d/%d, want 150/200/50", prior, current, delta)
	}
	if len(contributions) != 2 {
		t.Fatalf("contributions=%d, want two keys", len(contributions))
	}
	if contributions[0].Key != "A" || contributions[0].DeltaMinor != -20 {
		t.Fatalf("first contribution=%+v, want A -20 first", contributions[0])
	}
	if contributions[1].ShareOfDelta == nil || *contributions[1].ShareOfDelta != 1.4 {
		t.Fatalf("B share=%+v, want 1.4", contributions[1].ShareOfDelta)
	}
}

func TestAnalyticsRenderReportArtifact(t *testing.T) {
	fx := newExecutorFixture(t)
	input := AnalyticsRenderReportInput{
		Title: "Monthly <report>",
		Sections: []analyticsReportSectionInput{{
			Heading: "Sales", Columns: []string{"sku", "amount"},
			Rows:  []map[string]any{{"sku": "A", "amount": float64(5)}},
			Chart: &analyticsChartSpec{Type: "bar", X: "sku", Y: []string{"amount"}},
		}},
	}
	var out AnalyticsRenderReportOutput
	if _, err := dbx.WithOrgTx(context.Background(), fx.owner, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		result, err := analyticsRenderReport(context.Background(), tx, fx.orgID, input)
		out = result
		return struct{}{}, err
	}); err != nil {
		t.Fatal(err)
	}
	if out.HTML == "" || !strings.Contains(out.HTML, "Monthly &lt;report&gt;") || !strings.Contains(out.HTML, "<table>") {
		t.Fatalf("html missing escaped title or table: %.200s", out.HTML)
	}
	if out.Sections[0].SVG == nil || !strings.HasPrefix(*out.Sections[0].SVG, "<svg") {
		t.Fatalf("section svg=%v, want rendered svg", out.Sections[0].SVG)
	}
}

func TestAnalyticsExtractors(t *testing.T) {
	fx := newExecutorFixture(t)
	customerID := seedReportsCustomer(t, fx, fx.orgID, "Wave9 Customer")
	seedReportsInvoice(t, fx, fx.orgID, customerID, 1, "paid", "USD", 250000, 0, 250000, 250000, 0, nil, nil, nil)

	if _, err := dbx.WithOrgTx(fx.ctx, fx.owner, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		revenue, err := analyticsRevenueByMonth(context.Background(), tx, fx.orgID, AnalyticsRevenueByMonthInput{MonthsBack: 3})
		if err != nil {
			return struct{}{}, err
		}
		total := 0.0
		for _, row := range revenue.Rows {
			num, _ := row["totalMinor"].(float64)
			total += num
		}
		if total != 250000 {
			t.Fatalf("revenue total=%v, want 250000", revenue.Rows)
		}
		sales, err := analyticsSalesByCustomer(context.Background(), tx, fx.orgID, AnalyticsSalesByCustomerInput{Limit: 10})
		if err != nil || len(sales.Rows) != 1 || sales.Rows[0]["customerName"] != "Wave9 Customer" {
			t.Fatalf("sales output=%+v err=%v", sales.Rows, err)
		}
		aging, err := analyticsInvoiceAging(context.Background(), tx, fx.orgID)
		if err != nil {
			return struct{}{}, err
		}
		var openBalance float64
		for _, row := range aging.Rows {
			num, _ := row["balanceMinor"].(float64)
			openBalance += num
		}
		if openBalance != 0 {
			t.Fatalf("aging balance=%v, want zero because the invoice is paid", aging.Rows)
		}
		ask, err := analyticsAskYourBusiness(context.Background(), tx, fx.orgID, AnalyticsAskYourBusinessInput{}, time.Now().UTC())
		if err != nil || len(ask.Sections) == 0 {
			t.Fatalf("askYourBusiness output=%+v err=%v", ask, err)
		}
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
}
