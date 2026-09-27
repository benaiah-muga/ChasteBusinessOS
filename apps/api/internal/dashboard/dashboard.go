package dashboard

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// Payload is the Go-owned core of the legacy dashboard response. Signals stay
// outside this type until their producers have Go parity.
type Payload struct {
	Money          Money          `json:"money"`
	WorkingCapital WorkingCapital `json:"workingCapital"`
	Pipeline       Pipeline       `json:"pipeline"`
	Ops            Operations     `json:"ops"`
	Trend          []TrendMonth   `json:"trend"`
	Activity       []Activity     `json:"activity"`
}

type Money struct {
	RevenueMinor     int64  `json:"revenueMinor"`
	ExpenseMinor     int64  `json:"expenseMinor"`
	NetIncomeMinor   int64  `json:"netIncomeMinor"`
	CashMinor        *int64 `json:"cashMinor"`
	Balanced         *bool  `json:"balanced"`
	AssetsMinor      int64  `json:"assetsMinor"`
	LiabilitiesMinor int64  `json:"liabilitiesMinor"`
	EquityMinor      int64  `json:"equityMinor"`
}

type WorkingCapital struct {
	AROutstandingMinor int64 `json:"arOutstandingMinor"`
	OverdueCount       int64 `json:"overdueCount"`
	OverdueAmountMinor int64 `json:"overdueAmountMinor"`
	APOutstandingMinor int64 `json:"apOutstandingMinor"`
}

type Pipeline struct {
	Stages                []PipelineStage `json:"stages"`
	OpenCount             int64           `json:"openCount"`
	WeightedForecastMinor int64           `json:"weightedForecastMinor"`
}

type PipelineStage struct {
	Stage      string `json:"stage"`
	Count      int64  `json:"count"`
	ValueMinor int64  `json:"valueMinor"`
}

type Operations struct {
	Headcount          int64          `json:"headcount"`
	PendingLeave       int64          `json:"pendingLeave"`
	POSOpen            *POSOpen       `json:"posOpen"`
	LowStock           []LowStockItem `json:"lowStock"`
	PendingApprovals   int64          `json:"pendingApprovals"`
	DocsParsed         int64          `json:"docsParsed"`
	DocsAwaitingCoding int64          `json:"docsAwaitingCoding"`
}

type POSOpen struct {
	Register string `json:"register"`
}

type LowStockItem struct {
	SKU  string `json:"sku"`
	Name string `json:"name"`
}

type TrendMonth struct {
	Month        string `json:"month"`
	IncomeMinor  int64  `json:"incomeMinor"`
	ExpenseMinor int64  `json:"expenseMinor"`
}

type Activity struct {
	Seq          int64   `json:"seq"`
	Kind         string  `json:"kind"`
	CapabilityID *string `json:"capabilityId"`
	ActorType    string  `json:"actorType"`
	OccurredAt   string  `json:"occurredAt"`
}

type PostgresReader struct {
	pool dbx.Beginner
}

// ReportReadAccess carries the result of the legacy report-capability reads.
// Callers set each field false when its report capability is denied or fails,
// which preserves the dashboard's existing zero/null fallback behavior.
type ReportReadAccess struct {
	IncomeStatement bool
	BalanceSheet    bool
	TrialBalance    bool
}

func NewPostgresReader(pool dbx.Beginner) *PostgresReader {
	return &PostgresReader{pool: pool}
}

// ForOrg reads one tenant-scoped dashboard snapshot. This is an internal
// read model: the caller must derive reportAccess from the legacy report
// capability results before exposing money fields. now is injected so time
// windows stay testable.
func (r *PostgresReader) ForOrg(ctx context.Context, orgID string, now time.Time, reportAccess ReportReadAccess) (Payload, error) {
	if r == nil || r.pool == nil {
		return Payload{}, errors.New("dashboard reader is unavailable")
	}
	return dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (Payload, error) {
		payload := emptyPayload()
		if err := readMoney(ctx, tx, orgID, &payload.Money); err != nil {
			return Payload{}, fmt.Errorf("read dashboard money: %w", err)
		}
		payload.Money = applyReportReadAccess(payload.Money, reportAccess)
		if err := readWorkingCapital(ctx, tx, orgID, now, &payload.WorkingCapital); err != nil {
			return Payload{}, fmt.Errorf("read dashboard working capital: %w", err)
		}
		deals, err := readDeals(ctx, tx, orgID)
		if err != nil {
			return Payload{}, fmt.Errorf("read dashboard pipeline: %w", err)
		}
		payload.Pipeline = summarizePipeline(deals)
		if err := readOperations(ctx, tx, orgID, &payload.Ops); err != nil {
			return Payload{}, fmt.Errorf("read dashboard operations: %w", err)
		}
		trendRows, err := readTrend(ctx, tx, orgID)
		if err != nil {
			return Payload{}, fmt.Errorf("read dashboard trend: %w", err)
		}
		payload.Trend = summarizeTrend(trendRows, now)
		activity, err := readActivity(ctx, tx, orgID)
		if err != nil {
			return Payload{}, fmt.Errorf("read dashboard activity: %w", err)
		}
		payload.Activity = activity
		return payload, nil
	})
}

func applyReportReadAccess(money Money, access ReportReadAccess) Money {
	if !access.IncomeStatement {
		money.RevenueMinor = 0
		money.ExpenseMinor = 0
		money.NetIncomeMinor = 0
	}
	if !access.BalanceSheet {
		money.Balanced = nil
		money.AssetsMinor = 0
		money.LiabilitiesMinor = 0
		money.EquityMinor = 0
	}
	if !access.TrialBalance {
		money.CashMinor = nil
	}
	return money
}

func emptyPayload() Payload {
	return Payload{
		Pipeline: Pipeline{Stages: make([]PipelineStage, 0, 6)},
		Ops:      Operations{LowStock: make([]LowStockItem, 0)},
		Trend:    make([]TrendMonth, 0, 6),
		Activity: make([]Activity, 0, 8),
	}
}

type accountBalance struct {
	code            string
	typeName        string
	operatingDebit  int64
	operatingCredit int64
	allDebit        int64
	allCredit       int64
}

func readMoney(ctx context.Context, tx pgx.Tx, orgID string, target *Money) error {
	var baseCurrency string
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE((SELECT base_currency FROM organizations WHERE id = $1::uuid), 'USD')`, orgID,
	).Scan(&baseCurrency); err != nil {
		return err
	}

	rows, err := tx.Query(ctx, `
		SELECT a.code, a.type,
		       COALESCE(SUM(jl.debit_minor) FILTER (WHERE je.entry_kind <> 'year_end_close'), 0)::bigint,
		       COALESCE(SUM(jl.credit_minor) FILTER (WHERE je.entry_kind <> 'year_end_close'), 0)::bigint,
		       COALESCE(SUM(jl.debit_minor), 0)::bigint,
		       COALESCE(SUM(jl.credit_minor), 0)::bigint
		FROM accounts a
		JOIN journal_lines jl ON jl.account_id = a.id
		JOIN journal_entries je ON je.id = jl.entry_id
		WHERE a.org_id = $1::uuid AND je.org_id = $1::uuid
		  AND (je.currency IS NULL OR je.currency = $2)
		GROUP BY a.code, a.type
		ORDER BY a.code`, orgID, baseCurrency)
	if err != nil {
		return err
	}
	balances := make([]accountBalance, 0)
	for rows.Next() {
		var row accountBalance
		if err := rows.Scan(&row.code, &row.typeName, &row.operatingDebit, &row.operatingCredit, &row.allDebit, &row.allCredit); err != nil {
			rows.Close()
			return err
		}
		balances = append(balances, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	*target = summarizeMoney(balances)
	var cash int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(jl.debit_minor::bigint - jl.credit_minor::bigint), 0)::bigint
		FROM accounts a
		JOIN journal_lines jl ON jl.account_id = a.id
		JOIN journal_entries je ON je.id = jl.entry_id
		WHERE a.org_id = $1::uuid AND je.org_id = $1::uuid AND a.code = '1000'`, orgID,
	).Scan(&cash); err != nil {
		return err
	}
	target.CashMinor = int64Pointer(cash)
	return nil
}

func summarizeMoney(rows []accountBalance) Money {
	var money Money
	var retainedRevenue, retainedExpense int64
	for _, row := range rows {
		operatingNet := row.operatingDebit - row.operatingCredit
		allNet := row.allDebit - row.allCredit
		switch row.typeName {
		case "income":
			money.RevenueMinor += -operatingNet
			retainedRevenue += -allNet
		case "expense":
			money.ExpenseMinor += operatingNet
			retainedExpense += allNet
		case "asset":
			money.AssetsMinor += allNet
		case "liability":
			money.LiabilitiesMinor += -allNet
		case "equity":
			money.EquityMinor += -allNet
		}
	}
	money.NetIncomeMinor = money.RevenueMinor - money.ExpenseMinor
	retainedResult := retainedRevenue - retainedExpense
	balanced := abs64(money.AssetsMinor-(money.LiabilitiesMinor+money.EquityMinor+retainedResult)) < 1
	money.Balanced = boolPointer(balanced)
	return money
}

type documentMoney struct {
	total    int64
	credited int64
	paid     int64
}

func readWorkingCapital(ctx context.Context, tx pgx.Tx, orgID string, now time.Time, target *WorkingCapital) error {
	rows, err := tx.Query(ctx, `
		SELECT total_minor, credited_minor, paid_minor, due_at, issued_at
		FROM invoices
		WHERE org_id = $1::uuid AND status <> 'void' AND voided_at IS NULL`, orgID)
	if err != nil {
		return err
	}
	nowMillis := now.UTC().UnixMilli()
	dayMillis := int64(24 * time.Hour / time.Millisecond)
	for rows.Next() {
		var money documentMoney
		var dueAt, issuedAt pgtype.Timestamptz
		if err := rows.Scan(&money.total, &money.credited, &money.paid, &dueAt, &issuedAt); err != nil {
			rows.Close()
			return err
		}
		outstanding, err := outstandingMinor(money)
		if err != nil {
			rows.Close()
			return err
		}
		target.AROutstandingMinor += outstanding
		ref := dueAt
		if !ref.Valid {
			ref = issuedAt
		}
		if ref.Valid && overdueAt(ref.Time, nowMillis, dayMillis, outstanding) {
			target.OverdueCount++
			target.OverdueAmountMinor += outstanding
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	bills, err := tx.Query(ctx, `
		SELECT total_minor, credited_minor, paid_minor
		FROM vendor_bills
		WHERE org_id = $1::uuid AND status <> 'void'`, orgID)
	if err != nil {
		return err
	}
	for bills.Next() {
		var money documentMoney
		if err := bills.Scan(&money.total, &money.credited, &money.paid); err != nil {
			bills.Close()
			return err
		}
		outstanding, err := outstandingMinor(money)
		if err != nil {
			bills.Close()
			return err
		}
		target.APOutstandingMinor += outstanding
	}
	if err := bills.Err(); err != nil {
		bills.Close()
		return err
	}
	bills.Close()
	return nil
}

func outstandingMinor(row documentMoney) (int64, error) {
	if row.total < 0 || row.credited < 0 || row.paid < 0 {
		return 0, errors.New("document money fields must be non-negative integer minor amounts")
	}
	return max64(0, row.total-row.credited-row.paid), nil
}

func overdueAt(reference time.Time, nowMillis, dayMillis, outstanding int64) bool {
	return outstanding > 0 && nowMillis-reference.UTC().UnixMilli() > 30*dayMillis
}

type dealRow struct {
	stage string
	value int64
}

func readDeals(ctx context.Context, tx pgx.Tx, orgID string) ([]dealRow, error) {
	rows, err := tx.Query(ctx, `SELECT stage, value_minor FROM deals WHERE org_id = $1::uuid`, orgID)
	if err != nil {
		return nil, err
	}
	deals := make([]dealRow, 0)
	for rows.Next() {
		var deal dealRow
		if err := rows.Scan(&deal.stage, &deal.value); err != nil {
			rows.Close()
			return nil, err
		}
		deals = append(deals, deal)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	return deals, nil
}

func summarizePipeline(deals []dealRow) Pipeline {
	stageNames := []string{"lead", "qualified", "proposal", "negotiation", "won", "lost"}
	values := map[string]float64{
		"lead": 0.1, "qualified": 0.3, "proposal": 0.5,
		"negotiation": 0.7, "won": 1, "lost": 0,
	}
	byStage := make(map[string]*PipelineStage, len(stageNames))
	result := Pipeline{Stages: make([]PipelineStage, 0, len(stageNames))}
	for _, stage := range stageNames {
		result.Stages = append(result.Stages, PipelineStage{Stage: stage})
		byStage[stage] = &result.Stages[len(result.Stages)-1]
	}
	for _, deal := range deals {
		if deal.stage != "won" && deal.stage != "lost" {
			result.OpenCount++
		}
		if stage, ok := byStage[deal.stage]; ok {
			stage.Count++
			stage.ValueMinor += deal.value
		}
		result.WeightedForecastMinor += jsRound(float64(deal.value) * values[deal.stage])
	}
	return result
}

func jsRound(value float64) int64 {
	return int64(math.Floor(value + 0.5))
}

func readOperations(ctx context.Context, tx pgx.Tx, orgID string, target *Operations) error {
	var openRegister pgtype.Text
	if err := tx.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM employees WHERE org_id = $1::uuid AND deactivated_at IS NULL),
		  (SELECT count(*) FROM leave_requests WHERE org_id = $1::uuid AND status = 'pending'),
		  (SELECT register FROM pos_sessions WHERE org_id = $1::uuid AND status = 'open' LIMIT 1),
		  (SELECT count(*) FROM approvals WHERE org_id = $1::uuid AND status = 'pending'),
		  (SELECT count(*) FROM documents WHERE org_id = $1::uuid AND status = 'parsed'),
		  (SELECT count(*) FROM document_suggestions WHERE org_id = $1::uuid AND status = 'open')`, orgID,
	).Scan(&target.Headcount, &target.PendingLeave, &openRegister, &target.PendingApprovals, &target.DocsParsed, &target.DocsAwaitingCoding); err != nil {
		return err
	}
	if openRegister.Valid {
		target.POSOpen = &POSOpen{Register: openRegister.String}
	}

	rows, err := tx.Query(ctx, `
		SELECT i.sku, i.name, i.reorder_point_thousandths,
		       COALESCE(SUM(sm.quantity_delta), 0)::bigint
		FROM items i
		LEFT JOIN stock_movements sm ON sm.item_id = i.id AND sm.org_id = $1::uuid
		WHERE i.org_id = $1::uuid
		GROUP BY i.sku, i.name, i.reorder_point_thousandths`, orgID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var sku, name string
		var reorderPoint int64
		var onHand int64
		if err := rows.Scan(&sku, &name, &reorderPoint, &onHand); err != nil {
			rows.Close()
			return err
		}
		if reorderPoint > 0 && onHand <= reorderPoint {
			target.LowStock = append(target.LowStock, LowStockItem{SKU: sku, Name: name})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	return nil
}

type trendRow struct {
	month    string
	typeName string
	amount   int64
}

func readTrend(ctx context.Context, tx pgx.Tx, orgID string) ([]trendRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT to_char(date_trunc('month', je.posted_at), 'YYYY-MM'), a.type,
		       COALESCE(SUM(jl.credit_minor::bigint - jl.debit_minor::bigint), 0)::bigint
		FROM journal_lines jl
		JOIN journal_entries je ON je.id = jl.entry_id
		JOIN accounts a ON a.id = jl.account_id
		WHERE je.org_id = $1::uuid AND a.type IN ('income', 'expense')
		GROUP BY date_trunc('month', je.posted_at), a.type
		ORDER BY date_trunc('month', je.posted_at), a.type`, orgID)
	if err != nil {
		return nil, err
	}
	result := make([]trendRow, 0)
	for rows.Next() {
		var row trendRow
		if err := rows.Scan(&row.month, &row.typeName, &row.amount); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	return result, nil
}

func summarizeTrend(rows []trendRow, now time.Time) []TrendMonth {
	amounts := make(map[string]map[string]int64)
	for _, row := range rows {
		if amounts[row.month] == nil {
			amounts[row.month] = make(map[string]int64)
		}
		amounts[row.month][row.typeName] += row.amount
	}
	months := make([]TrendMonth, 0, 6)
	monthStart := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	for offset := 5; offset >= 0; offset-- {
		month := monthStart.AddDate(0, -offset, 0).Format("2006-01")
		values := amounts[month]
		months = append(months, TrendMonth{
			Month:        month,
			IncomeMinor:  values["income"],
			ExpenseMinor: -values["expense"],
		})
	}
	return months
}

func readActivity(ctx context.Context, tx pgx.Tx, orgID string) ([]Activity, error) {
	rows, err := tx.Query(ctx, `
		SELECT seq, kind, capability_id, actor_type, occurred_at
		FROM ledger_events
		WHERE org_id = $1::uuid
		ORDER BY seq DESC
		LIMIT 8`, orgID)
	if err != nil {
		return nil, err
	}
	activity := make([]Activity, 0, 8)
	for rows.Next() {
		var item Activity
		var capabilityID pgtype.Text
		var occurredAt time.Time
		if err := rows.Scan(&item.Seq, &item.Kind, &capabilityID, &item.ActorType, &occurredAt); err != nil {
			rows.Close()
			return nil, err
		}
		if capabilityID.Valid {
			value := capabilityID.String
			item.CapabilityID = &value
		}
		item.OccurredAt = legacyTimestamp(occurredAt)
		activity = append(activity, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	return activity, nil
}

func legacyTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func int64Pointer(value int64) *int64 { return &value }
func boolPointer(value bool) *bool    { return &value }

func abs64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

func max64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}
