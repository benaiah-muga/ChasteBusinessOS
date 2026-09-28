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

func posTestClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

func cleanupPosSalesFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin POS fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable POS fixture ledger cleanup: %v", err)
			return
		}
		steps := []struct {
			label string
			query string
		}{
			{"stock movements", `DELETE FROM stock_movements WHERE org_id = $1::uuid`},
			{"stock reservations", `DELETE FROM stock_reservations WHERE org_id = $1::uuid`},
			{"POS return lines", `DELETE FROM pos_return_lines WHERE org_id = $1::uuid`},
			{"POS returns", `DELETE FROM pos_returns WHERE org_id = $1::uuid`},
			{"payments", `DELETE FROM payments WHERE org_id = $1::uuid`},
			{"invoices", `DELETE FROM invoices WHERE org_id = $1::uuid`},
			{"journal lines", `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id = $1::uuid)`},
			{"journal entries", `DELETE FROM journal_entries WHERE org_id = $1::uuid`},
			{"POS sessions", `DELETE FROM pos_sessions WHERE org_id = $1::uuid`},
			{"items", `DELETE FROM items WHERE org_id = $1::uuid`},
			{"customers", `DELETE FROM customers WHERE org_id = $1::uuid`},
		}
		for _, orgID := range []string{fx.orgID, fx.otherOrgID} {
			for _, step := range steps {
				if _, err := tx.Exec(fx.ctx, step.query, orgID); err != nil {
					t.Errorf("delete POS fixture %s: %v", step.label, err)
					return
				}
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit POS fixture cleanup: %v", err)
		}
	})
}

func seedPosAccounts(t *testing.T, fx *executorFixture) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1000', 'Cash', 'asset'),
		($1::uuid, '2100', 'Sales Tax Payable', 'liability'),
		($1::uuid, '4000', 'Sales Revenue', 'income')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
}

func seedPosItem(t *testing.T, fx *executorFixture, orgID, sku, kind string) string {
	t.Helper()
	var itemID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO items (org_id, sku, name, kind)
		VALUES ($1::uuid, $2, $3, $4)
		RETURNING id::text`, orgID, sku, "POS fixture "+sku, kind).Scan(&itemID); err != nil {
		t.Fatal(err)
	}
	return itemID
}

func seedPosStock(t *testing.T, fx *executorFixture, orgID, itemID string, quantityDelta int64) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, actor_type)
		VALUES ($1::uuid, $2::uuid, $3, 'purchase', 'human')`, orgID, itemID, quantityDelta); err != nil {
		t.Fatal(err)
	}
}

func seedPosSession(t *testing.T, fx *executorFixture, orgID, register, status string, openingFloatMinor, expectedCashMinor int64) string {
	t.Helper()
	var sessionID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO pos_sessions (org_id, register, status, opening_float_minor, expected_cash_minor)
		VALUES ($1::uuid, $2, $3, $4, $5)
		RETURNING id::text`, orgID, register, status, openingFloatMinor, expectedCashMinor).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	return sessionID
}

func seedPosCustomer(t *testing.T, fx *executorFixture, orgID, name string) string {
	t.Helper()
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name) VALUES ($1::uuid, $2) RETURNING id::text`, orgID, name).
		Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	return customerID
}

func posEntryLines(t *testing.T, fx *executorFixture, entryID string) map[string][2]int64 {
	t.Helper()
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl JOIN accounts a ON jl.account_id = a.id
		WHERE jl.entry_id = $1::uuid ORDER BY a.code`, entryID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	lines := make(map[string][2]int64)
	for rows.Next() {
		var code string
		var debit, credit int64
		if err := rows.Scan(&code, &debit, &credit); err != nil {
			t.Fatal(err)
		}
		lines[code] = [2]int64{debit, credit}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

func posJournalDrift(t *testing.T, fx *executorFixture) int64 {
	t.Helper()
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	return drift
}

func TestPosSalesParsersMirrorZodContracts(t *testing.T) {
	uuid := "11111111-1111-4111-8111-111111111111"
	opened, err := ParsePosOpenSessionInput(json.RawMessage(`{}`))
	if err != nil || opened.Register != "main" || opened.OpeningFloatMinor != 0 {
		t.Fatalf("ParsePosOpenSessionInput({}) = %+v, %v, want defaults", opened, err)
	}
	if opened, err = ParsePosOpenSessionInput(json.RawMessage(`{"register":"kiosk","openingFloatMinor":2500}`)); err != nil ||
		opened.Register != "kiosk" || opened.OpeningFloatMinor != 2500 {
		t.Fatalf("ParsePosOpenSessionInput(kiosk) = %+v, %v", opened, err)
	}
	for _, raw := range []string{
		`[]`,
		`null`,
		`{"register":null}`,
		`{"register":5}`,
		`{"openingFloatMinor":-1}`,
		`{"openingFloatMinor":1.5}`,
		`{"openingFloatMinor":null}`,
	} {
		if _, err := ParsePosOpenSessionInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParsePosOpenSessionInput accepted %s", raw)
		}
	}

	sale, err := ParsePosCompleteSaleInput(json.RawMessage(
		`{"sessionId":"session-1","lines":[{"description":"Widget","quantity":2000,"unitPriceMinor":1500,"taxMinor":500,"sku":"POS-1"}],"cashReceivedMinor":4000}`))
	if err != nil || sale.SessionID != "session-1" || sale.Method != "cash" || len(sale.Lines) != 1 ||
		sale.Lines[0].TaxMinor != 500 || sale.Lines[0].SKU == nil || *sale.Lines[0].SKU != "POS-1" ||
		sale.CashReceivedMinor == nil || *sale.CashReceivedMinor != 4000 || sale.Tenders != nil {
		t.Fatalf("ParsePosCompleteSaleInput(cash) = %+v, %v", sale, err)
	}
	encoded, err := marshalJS(sale)
	if err != nil {
		t.Fatal(err)
	}
	wantSale := `{"sessionId":"session-1","lines":[{"description":"Widget","quantity":2000,"unitPriceMinor":1500,"taxMinor":500,"sku":"POS-1"}],"method":"cash","cashReceivedMinor":4000}`
	if string(encoded) != wantSale {
		t.Fatalf("ParsePosCompleteSaleInput JSON = %s, want %s", encoded, wantSale)
	}
	if sale, err = ParsePosCompleteSaleInput(json.RawMessage(
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"tenders":[{"method":"card","amountMinor":60},{"method":"cash","amountMinor":40}],"cashReceivedMinor":50}`)); err != nil ||
		sale.Method != "cash" || len(sale.Tenders) != 2 || sale.Tenders[0].Method != "card" {
		t.Fatalf("ParsePosCompleteSaleInput(tenders) = %+v, %v", sale, err)
	}
	if sale, err = ParsePosCompleteSaleInput(json.RawMessage(
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"method":"card"}`)); err != nil || sale.Method != "card" {
		t.Fatalf("ParsePosCompleteSaleInput(card) = %+v, %v", sale, err)
	}
	line := `{"lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}]}`
	for _, raw := range []string{
		`[]`,
		`null`,
		`{"sessionId":"s"}`,
		`{"sessionId":"s","lines":[]}`,
		`{"sessionId":"s","lines":null}`,
		`{"sessionId":"s","lines":"x"}`,
		`{"sessionId":"s","lines":["nope"]}`,
		`{"sessionId":"s","lines":[{"quantity":1000,"unitPriceMinor":1}]}`,
		`{"sessionId":"s","lines":[{"description":"","quantity":1000,"unitPriceMinor":1}]}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":0,"unitPriceMinor":1}]}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000.5,"unitPriceMinor":1}]}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":-1}]}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":1,"taxMinor":-1}]}`,
		`{"sessionId":123,"` + line[1:],
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"method":"upi"}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"method":null}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"method":"cash","cashReceivedMinor":-5}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"method":"cash","cashReceivedMinor":99}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"method":"card","cashReceivedMinor":100}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"customerId":"nope"}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"tenders":[]}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"tenders":null}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"tenders":[{"method":"cash","amountMinor":50},{"method":"card","amountMinor":50},{"method":"cash","amountMinor":10},{"method":"card","amountMinor":10}]}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"tenders":[{"method":"cheque","amountMinor":100}]}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"tenders":[{"method":"cash","amountMinor":0}]}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"tenders":[{"method":"cash","amountMinor":50.5}]}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"tenders":[{"method":"cash","amountMinor":99}]}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"tenders":[{"method":"card","amountMinor":100}],"cashReceivedMinor":100}`,
		`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}],"tenders":[{"method":"cash","amountMinor":100}],"cashReceivedMinor":99}`,
	} {
		if _, err := ParsePosCompleteSaleInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParsePosCompleteSaleInput accepted %s", raw)
		}
	}

	closed, err := ParsePosCloseSessionInput(json.RawMessage(`{"sessionId":"s1","countedCashMinor":2500,"varianceReason":" short one "}`))
	if err != nil || closed.SessionID != "s1" || closed.CountedCashMinor != 2500 || closed.VarianceReason == nil || *closed.VarianceReason != "short one" {
		t.Fatalf("ParsePosCloseSessionInput = %+v, %v, want trimmed reason", closed, err)
	}
	if closed, err = ParsePosCloseSessionInput(json.RawMessage(`{"sessionId":"s1","countedCashMinor":0}`)); err != nil || closed.VarianceReason != nil {
		t.Fatalf("ParsePosCloseSessionInput(minimal) = %+v, %v", closed, err)
	}
	for _, raw := range []string{
		`{}`,
		`{"sessionId":"s1"}`,
		`{"sessionId":"s1","countedCashMinor":-1}`,
		`{"sessionId":"s1","countedCashMinor":1.5}`,
		`{"sessionId":"s1","countedCashMinor":null}`,
		`{"sessionId":"s1","countedCashMinor":0,"varianceReason":null}`,
		`{"sessionId":"s1","countedCashMinor":0,"varianceReason":"ab"}`,
		`{"sessionId":"s1","countedCashMinor":0,"varianceReason":"` + strings.Repeat("a", 501) + `"}`,
	} {
		if _, err := ParsePosCloseSessionInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParsePosCloseSessionInput accepted %s", raw)
		}
	}

	returned, err := ParsePosReturnSaleInput(json.RawMessage(`{"invoiceId":"` + uuid + `","reason":"damaged goods"}`))
	if err != nil || returned.InvoiceID != uuid || returned.Reason != "damaged goods" ||
		returned.RefundMethod != "cash" || returned.Lines != nil {
		t.Fatalf("ParsePosReturnSaleInput(minimal) = %+v, %v", returned, err)
	}
	if returned, err = ParsePosReturnSaleInput(json.RawMessage(
		`{"invoiceId":"` + uuid + `","reason":"wrong item","refundMethod":"card","lines":[{"invoiceLineId":"22222222-2222-4222-8222-222222222222","quantity":1000}]}`)); err != nil ||
		returned.RefundMethod != "card" || len(returned.Lines) != 1 || returned.Lines[0].Quantity != 1000 {
		t.Fatalf("ParsePosReturnSaleInput(lines) = %+v, %v", returned, err)
	}
	returnLine := `"invoiceId":"` + uuid + `","reason":"damaged goods"`
	for _, raw := range []string{
		`{}`,
		`{"invoiceId":"not-a-uuid","reason":"damaged goods"}`,
		`{"invoiceId":"` + uuid + `"}`,
		`{"invoiceId":"` + uuid + `","reason":"no"}`,
		`{"invoiceId":"` + uuid + `","reason":"` + strings.Repeat("a", 501) + `"}`,
		`{"invoiceId":"` + uuid + `","reason":"damaged goods","refundMethod":"store_credit"}`,
		`{"invoiceId":"` + uuid + `","reason":"damaged goods","refundMethod":null}`,
		`{` + returnLine + `,"lines":[]}`,
		`{` + returnLine + `,"lines":null}`,
		`{` + returnLine + `,"lines":[{"invoiceLineId":"nope","quantity":1000}]}`,
		`{` + returnLine + `,"lines":[{"invoiceLineId":"` + uuid + `","quantity":0}]}`,
		`{` + returnLine + `,"lines":[{"invoiceLineId":"` + uuid + `","quantity":-1000}]}`,
		`{` + returnLine + `,"lines":[{"invoiceLineId":"` + uuid + `","quantity":10.5}]}`,
	} {
		if _, err := ParsePosReturnSaleInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParsePosReturnSaleInput accepted %s", raw)
		}
	}

	summary, err := ParsePosShiftSummaryInput(json.RawMessage(`{"sessionId":"` + uuid + `"}`))
	if err != nil || summary.SessionID != uuid {
		t.Fatalf("ParsePosShiftSummaryInput = %+v, %v", summary, err)
	}
	for _, raw := range []string{`{}`, `{"sessionId":"nope"}`, `{"sessionId":null}`, `{"sessionId":5}`} {
		if _, err := ParsePosShiftSummaryInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParsePosShiftSummaryInput accepted %s", raw)
		}
	}

	validByCapability := map[string]json.RawMessage{
		posOpenSessionCapabilityID:  json.RawMessage(`{}`),
		posCompleteSaleCapabilityID: json.RawMessage(`{"sessionId":"s","lines":[{"description":"d","quantity":1000,"unitPriceMinor":100}]}`),
		posCloseSessionCapabilityID: json.RawMessage(`{"sessionId":"s","countedCashMinor":0}`),
		posReturnSaleCapabilityID:   json.RawMessage(`{"invoiceId":"` + uuid + `","reason":"damaged goods"}`),
		posShiftSummaryCapabilityID: json.RawMessage(`{"sessionId":"` + uuid + `"}`),
	}
	for capabilityID, raw := range validByCapability {
		if parsed, err := parsePosSaleInput(capabilityID, raw); err != nil || parsed == nil {
			t.Errorf("parsePosSaleInput(%s) = %v, %v", capabilityID, parsed, err)
		}
	}
	if _, err := parsePosSaleInput("pos.bogus", json.RawMessage(`{}`)); err == nil {
		t.Error("parsePosSaleInput(pos.bogus) accepted an unsupported capability")
	}
}
func posSameEntryLines(got, want map[string][2]int64) bool {
	if len(got) != len(want) {
		return false
	}
	for code, pair := range want {
		other, ok := got[code]
		if !ok || other != pair {
			return false
		}
	}
	return true
}

func TestPosSalesOpenSessionLifecycleAndGuards(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPosSalesFixture(t, fx)
	claims := posTestClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	open := func(claims authbridge.CapabilityClaims, input PosOpenSessionInput) (PosOpenSessionOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, claims.OrganizationID, func(tx pgx.Tx) (PosOpenSessionOutput, error) {
			return posOpenSession(fx.ctx, tx, claims, input)
		})
	}
	first, err := open(claims, PosOpenSessionInput{Register: "main"})
	if err != nil || !isUUID(first.SessionID) {
		t.Fatalf("posOpenSession = %+v, %v", first, err)
	}
	encoded, err := marshalJS(first)
	if err != nil || string(encoded) != fmt.Sprintf(`{"sessionId":%q}`, first.SessionID) {
		t.Fatalf("posOpenSession output = %s, %v", encoded, err)
	}
	var register, status string
	var openingFloat, expectedCash int64
	var openedBy, closedBy *string
	var closedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT register, status, opening_float_minor, expected_cash_minor, opened_by_user_id::text, closed_by_user_id::text, closed_at
		FROM pos_sessions WHERE id = $1::uuid`, first.SessionID).
		Scan(&register, &status, &openingFloat, &expectedCash, &openedBy, &closedBy, &closedAt); err != nil {
		t.Fatal(err)
	}
	if register != "main" || status != "open" || openingFloat != 0 || expectedCash != 0 ||
		openedBy == nil || *openedBy != fx.userID || closedBy != nil || closedAt != nil {
		t.Fatalf("stored session = %s %s float=%d cash=%d openedBy=%v closedBy=%v closedAt=%v, want human-opened defaults",
			register, status, openingFloat, expectedCash, openedBy, closedBy, closedAt)
	}
	if _, err := open(claims, PosOpenSessionInput{Register: "main"}); err == nil || err.Error() != "a register session is already open, close it first" {
		t.Fatalf("second open error = %v, want single-open guard", err)
	}
	agentClaims := authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "agent"}
	if _, err := open(agentClaims, PosOpenSessionInput{Register: "agent"}); err == nil || err.Error() != "a register session is already open, close it first" {
		t.Fatalf("agent open error = %v, want single-open guard", err)
	}

	closeOne := func(claims authbridge.CapabilityClaims, input PosCloseSessionInput) (PosCloseSessionOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, claims.OrganizationID, func(tx pgx.Tx) (PosCloseSessionOutput, error) {
			return posCloseSession(fx.ctx, tx, claims, input, now)
		})
	}
	closed, err := closeOne(claims, PosCloseSessionInput{SessionID: first.SessionID})
	if err != nil {
		t.Fatalf("posCloseSession: %v", err)
	}
	if encoded, err = marshalJS(closed); err != nil || string(encoded) != `{"expectedCashMinor":0,"varianceMinor":0,"flagged":false}` {
		t.Fatalf("posCloseSession output = %s, %v", encoded, err)
	}
	agentSession, err := open(agentClaims, PosOpenSessionInput{Register: "agent"})
	if err != nil {
		t.Fatalf("agent reopen: %v", err)
	}
	var agentOpenedBy *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT opened_by_user_id::text FROM pos_sessions WHERE id = $1::uuid`, agentSession.SessionID).Scan(&agentOpenedBy); err != nil {
		t.Fatal(err)
	}
	if agentOpenedBy != nil {
		t.Fatalf("agent session openedBy = %v, want null", *agentOpenedBy)
	}
	if _, err := closeOne(agentClaims, PosCloseSessionInput{SessionID: agentSession.SessionID}); err != nil {
		t.Fatalf("agent close before kiosk reopen: %v", err)
	}
	kioskSession, err := open(claims, PosOpenSessionInput{Register: "kiosk", OpeningFloatMinor: 2500})
	if err != nil {
		t.Fatalf("kiosk reopen: %v", err)
	}
	var kioskRegister string
	var kioskFloat int64
	var kioskOpenedBy *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT register, opening_float_minor, opened_by_user_id::text FROM pos_sessions WHERE id = $1::uuid`, kioskSession.SessionID).
		Scan(&kioskRegister, &kioskFloat, &kioskOpenedBy); err != nil {
		t.Fatal(err)
	}
	if kioskRegister != "kiosk" || kioskFloat != 2500 || kioskOpenedBy == nil || *kioskOpenedBy != fx.userID {
		t.Fatalf("kiosk session = %s %d openedBy=%v", kioskRegister, kioskFloat, kioskOpenedBy)
	}
	foreignClaims := authbridge.CapabilityClaims{OrganizationID: fx.otherOrgID, ActorType: "human"}
	foreignSession, err := open(foreignClaims, PosOpenSessionInput{Register: "main"})
	if err != nil {
		t.Fatalf("other org open: %v", err)
	}
	if got := fx.count(`SELECT count(*) FROM pos_sessions WHERE org_id = $1::uuid AND status = 'open'`, fx.orgID); got != 1 {
		t.Fatalf("main org open sessions = %d, want one kiosk drawer", got)
	}
	if got := fx.count(`SELECT count(*) FROM pos_sessions WHERE org_id = $1::uuid AND status = 'open'`, fx.otherOrgID); got != 1 {
		t.Fatalf("other org open sessions = %d, want one independent drawer", got)
	}
	if _, err := closeOne(claims, PosCloseSessionInput{SessionID: foreignSession.SessionID}); err == nil || err.Error() != "session not found" {
		t.Fatalf("foreign close error = %v, want tenant refusal", err)
	}
}

func TestPosSalesCompleteSalePostsInvoicePaymentStockAndDrawer(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPosSalesFixture(t, fx)
	seedPosAccounts(t, fx)
	goodsItemID := seedPosItem(t, fx, fx.orgID, "POS-1", "goods")
	seedPosStock(t, fx, fx.orgID, goodsItemID, 5000)
	serviceItemID := seedPosItem(t, fx, fx.orgID, "POS-SVC", "service")
	claims := posTestClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	sessionID := seedPosSession(t, fx, fx.orgID, "main", "open", 1000, 0)
	sell := func(input PosCompleteSaleInput) (PosCompleteSaleOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosCompleteSaleOutput, error) {
			return posCompleteSale(fx.ctx, tx, claims, input, now)
		})
	}

	sale, err := sell(PosCompleteSaleInput{
		SessionID:         sessionID,
		Lines:             []PosSaleLineInput{{Description: "Widget", Quantity: 2000, UnitPriceMinor: 1500, TaxMinor: 500, SKU: crmStringPointer("POS-1")}},
		Method:            "cash",
		CashReceivedMinor: crmInt64Pointer(4000),
	})
	if err != nil {
		t.Fatalf("posCompleteSale: %v", err)
	}
	encoded, err := marshalJS(sale)
	if err != nil || string(encoded) != fmt.Sprintf(`{"invoiceId":%q,"invoiceNumber":1,"totalMinor":3500,"tenderedMinor":4000,"changeGivenMinor":500,"tenders":[{"method":"cash","amountMinor":3500}]}`, sale.InvoiceID) {
		t.Fatalf("sale output JSON = %s, %v", encoded, err)
	}
	var number int64
	var status, currency, memo string
	var subtotal, tax, total, paid, credited int64
	var saleSession *string
	var issuedAt, dueAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, pos_session_id::text, issued_at, due_at, memo
		FROM invoices WHERE id = $1::uuid`, sale.InvoiceID).
		Scan(&number, &status, &currency, &subtotal, &tax, &total, &paid, &credited, &saleSession, &issuedAt, &dueAt, &memo); err != nil {
		t.Fatal(err)
	}
	if number != 1 || status != "paid" || currency != "USD" || subtotal != 3000 || tax != 500 || total != 3500 || paid != 3500 || credited != 0 ||
		saleSession == nil || *saleSession != sessionID || issuedAt == nil || !issuedAt.Equal(now) || dueAt != nil || memo != "POS (cash)" {
		t.Fatalf("stored invoice = #%d %s %s subtotal=%d tax=%d total=%d paid=%d credited=%d session=%v issued=%v due=%v memo=%q",
			number, status, currency, subtotal, tax, total, paid, credited, saleSession, issuedAt, dueAt, memo)
	}
	var lineDescription string
	var lineItem *string
	var quantity, unitPrice, lineTax int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT description, item_id::text, quantity, unit_price_minor, tax_minor
		FROM invoice_lines WHERE invoice_id = $1::uuid`, sale.InvoiceID).
		Scan(&lineDescription, &lineItem, &quantity, &unitPrice, &lineTax); err != nil {
		t.Fatal(err)
	}
	if lineDescription != "Widget" || lineItem == nil || *lineItem != goodsItemID || quantity != 2000 || unitPrice != 1500 || lineTax != 500 {
		t.Fatalf("stored invoice line = %q item=%v (%d,%d,%d)", lineDescription, lineItem, quantity, unitPrice, lineTax)
	}
	var paymentAmount int64
	var paymentMethod, paymentEntry string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT amount_minor, method, entry_id::text FROM payments WHERE invoice_id = $1::uuid`, sale.InvoiceID).
		Scan(&paymentAmount, &paymentMethod, &paymentEntry); err != nil {
		t.Fatal(err)
	}
	if paymentAmount != 3500 || paymentMethod != "cash" {
		t.Fatalf("stored payment = %d %s, want 3500 cash", paymentAmount, paymentMethod)
	}
	var entryMemo, entrySourceType, entrySourceID string
	var postedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, source_id::text, posted_at FROM journal_entries WHERE id = $1::uuid`, paymentEntry).
		Scan(&entryMemo, &entrySourceType, &entrySourceID, &postedAt); err != nil {
		t.Fatal(err)
	}
	if entryMemo != "POS sale #1 (cash)" || entrySourceType != "pos_sale" || entrySourceID != sale.InvoiceID || !postedAt.Equal(now) {
		t.Fatalf("stored entry = %q %s %s %v", entryMemo, entrySourceType, entrySourceID, postedAt)
	}
	if lines := posEntryLines(t, fx, paymentEntry); !posSameEntryLines(lines, map[string][2]int64{
		"1000": {3500, 0},
		"4000": {0, 3000},
		"2100": {0, 500},
	}) {
		t.Fatalf("sale entry lines = %+v, want cash debit with revenue and tax credits", lines)
	}
	var movementDelta int64
	var movementNote, movementRef string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT quantity_delta, note, ref_type FROM stock_movements
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND quantity_delta < 0`, fx.orgID, goodsItemID).
		Scan(&movementDelta, &movementNote, &movementRef); err != nil {
		t.Fatal(err)
	}
	if movementDelta != -2000 || movementNote != "POS sale #1" || movementRef != "invoice" {
		t.Fatalf("sale movement = %d %q %s", movementDelta, movementNote, movementRef)
	}
	var onHand int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity), 0) FROM stock_balances WHERE org_id = $1::uuid AND item_id = $2::uuid`,
		fx.orgID, goodsItemID).Scan(&onHand); err != nil {
		t.Fatal(err)
	}
	var drawer int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT expected_cash_minor FROM pos_sessions WHERE id = $1::uuid`, sessionID).Scan(&drawer); err != nil {
		t.Fatal(err)
	}
	if onHand != 3000 || drawer != 3500 {
		t.Fatalf("after sale A onHand=%d drawer=%d, want 3000 and 3500", onHand, drawer)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid AND name = 'Walk-in Customer'`, fx.orgID); got != 1 {
		t.Fatalf("walk-in customers = %d, want one created on demand", got)
	}
	if got := fx.count(`SELECT count(*) FROM doc_counters WHERE org_id = $1::uuid AND kind = 'invoice' AND "next" = 1`, fx.orgID); got != 1 {
		t.Fatalf("invoice counter rows = %d, want sequence resting at 1", got)
	}

	saleB, err := sell(PosCompleteSaleInput{
		SessionID: sessionID,
		Lines:     []PosSaleLineInput{{Description: "Repair", Quantity: 1000, UnitPriceMinor: 2000, SKU: crmStringPointer("POS-SVC")}},
		Tenders:   []PosTenderInput{{Method: "card", AmountMinor: 2000}},
	})
	if err != nil {
		t.Fatalf("service sale: %v", err)
	}
	if saleB.InvoiceNumber != 2 || saleB.TotalMinor != 2000 || saleB.TenderedMinor != 2000 || saleB.ChangeGivenMinor != 0 ||
		len(saleB.Tenders) != 1 || saleB.Tenders[0].Method != "card" {
		t.Fatalf("service sale output = %+v", saleB)
	}
	var serviceLineItem *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT item_id::text FROM invoice_lines WHERE invoice_id = $1::uuid`, saleB.InvoiceID).Scan(&serviceLineItem); err != nil {
		t.Fatal(err)
	}
	if serviceLineItem == nil || *serviceLineItem != serviceItemID {
		t.Fatalf("service line item = %v, want the service item linked without stock", serviceLineItem)
	}
	if got := fx.count(`SELECT count(*) FROM stock_movements WHERE item_id = $1::uuid`, serviceItemID); got != 0 {
		t.Fatalf("service movements = %d, want none", got)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT expected_cash_minor FROM pos_sessions WHERE id = $1::uuid`, sessionID).Scan(&drawer); err != nil {
		t.Fatal(err)
	}
	if drawer != 3500 {
		t.Fatalf("card tender moved the drawer to %d, want 3500", drawer)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid AND name = 'Walk-in Customer'`, fx.orgID); got != 1 {
		t.Fatalf("walk-in customers = %d, want the same one reused", got)
	}

	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_reservations (org_id, item_id, quantity_thousandths, reason, ref_type, ref_id, status, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 1000, 'fixture hold', 'fixture', NULL, 'open', 'human')`, fx.orgID, goodsItemID); err != nil {
		t.Fatal(err)
	}
	_, err = sell(PosCompleteSaleInput{
		SessionID: sessionID,
		Lines:     []PosSaleLineInput{{Description: "Too many", Quantity: 4000, UnitPriceMinor: 100, SKU: crmStringPointer("POS-1")}},
	})
	if err == nil || err.Error() != "insufficient stock for POS-1: 2000 thousandths available (on hand minus open reservations)" {
		t.Fatalf("oversell error = %v, want reservation-aware refusal", err)
	}
	if got := fx.count(`SELECT count(*) FROM invoices WHERE org_id = $1::uuid`, fx.orgID); got != 2 {
		t.Fatalf("refused oversell left %d invoices, want two", got)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		UPDATE stock_reservations SET status = 'released'
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND status = 'open'`, fx.orgID, goodsItemID); err != nil {
		t.Fatal(err)
	}
	saleC, err := sell(PosCompleteSaleInput{
		SessionID: sessionID,
		Lines:     []PosSaleLineInput{{Description: "Widget", Quantity: 3000, UnitPriceMinor: 100, SKU: crmStringPointer("POS-1")}},
		Method:    "cash",
	})
	if err != nil || saleC.InvoiceNumber != 3 || saleC.TotalMinor != 300 {
		t.Fatalf("sale after release = %+v, %v", saleC, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT expected_cash_minor FROM pos_sessions WHERE id = $1::uuid`, sessionID).Scan(&drawer); err != nil {
		t.Fatal(err)
	}
	if drawer != 3800 {
		t.Fatalf("drawer after sale C = %d, want 3800", drawer)
	}

	_, err = sell(PosCompleteSaleInput{
		SessionID: sessionID,
		Lines:     []PosSaleLineInput{{Description: "Ghost", Quantity: 1000, UnitPriceMinor: 100, SKU: crmStringPointer("GHOST")}},
	})
	if err == nil || err.Error() != "no stocked item with SKU GHOST" {
		t.Fatalf("unknown sku error = %v, want SKU refusal", err)
	}

	fx.setModuleList(`["pos"]`)
	degraded, err := sell(PosCompleteSaleInput{
		SessionID: sessionID,
		Lines:     []PosSaleLineInput{{Description: "Ghost", Quantity: 1000, UnitPriceMinor: 100, SKU: crmStringPointer("GHOST")}},
		Method:    "cash",
	})
	if err != nil || degraded.InvoiceNumber != 4 || degraded.TotalMinor != 100 {
		t.Fatalf("degraded sale = %+v, %v, want pure money sale without inventory", degraded, err)
	}
	var ghostItem *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT item_id::text FROM invoice_lines WHERE invoice_id = $1::uuid`, degraded.InvoiceID).Scan(&ghostItem); err != nil {
		t.Fatal(err)
	}
	if ghostItem != nil {
		t.Fatalf("degraded sale line item = %v, want null without item resolution", *ghostItem)
	}
	fx.setModuleList(`null`)

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosCloseSessionOutput, error) {
		return posCloseSession(fx.ctx, tx, claims, PosCloseSessionInput{SessionID: sessionID, CountedCashMinor: 4900}, now)
	})
	if err != nil {
		t.Fatalf("close for refusal: %v", err)
	}
	_, err = sell(PosCompleteSaleInput{
		SessionID: sessionID,
		Lines:     []PosSaleLineInput{{Description: "Late", Quantity: 1000, UnitPriceMinor: 100}},
	})
	if err == nil || err.Error() != "session is closed" {
		t.Fatalf("sale on closed session error = %v, want closed guard", err)
	}
	foreignSessionID := seedPosSession(t, fx, fx.otherOrgID, "main", "open", 0, 0)
	_, err = sell(PosCompleteSaleInput{
		SessionID: foreignSessionID,
		Lines:     []PosSaleLineInput{{Description: "Foreign", Quantity: 1000, UnitPriceMinor: 100}},
	})
	if err == nil || err.Error() != "session not found" {
		t.Fatalf("cross tenant sale error = %v, want tenant refusal", err)
	}
	if drift := posJournalDrift(t, fx); drift != 0 {
		t.Fatalf("journal drift after sales = %d, want balanced books", drift)
	}
}

func TestPosSalesCloseSessionRecordsVarianceHonesty(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPosSalesFixture(t, fx)
	seedPosAccounts(t, fx)
	goodsItemID := seedPosItem(t, fx, fx.orgID, "POS-1", "goods")
	seedPosStock(t, fx, fx.orgID, goodsItemID, 5000)
	claims := posTestClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	sessionID := seedPosSession(t, fx, fx.orgID, "main", "open", 1000, 0)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosCompleteSaleOutput, error) {
		return posCompleteSale(fx.ctx, tx, claims, PosCompleteSaleInput{
			SessionID: sessionID,
			Lines:     []PosSaleLineInput{{Description: "Widget", Quantity: 2000, UnitPriceMinor: 1500, TaxMinor: 500, SKU: crmStringPointer("POS-1")}},
			Method:    "cash",
		}, now)
	}); err != nil {
		t.Fatalf("sale before close: %v", err)
	}
	closeOne := func(input PosCloseSessionInput) (PosCloseSessionOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosCloseSessionOutput, error) {
			return posCloseSession(fx.ctx, tx, claims, input, now)
		})
	}
	if _, err := closeOne(PosCloseSessionInput{SessionID: sessionID, CountedCashMinor: 4000}); err == nil ||
		err.Error() != "a reason is required to record a drawer variance" {
		t.Fatalf("unexplained variance error = %v, want reason guard", err)
	}
	var status string
	var counted, variance *int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, counted_cash_minor, variance_minor FROM pos_sessions WHERE id = $1::uuid`, sessionID).
		Scan(&status, &counted, &variance); err != nil {
		t.Fatal(err)
	}
	if status != "open" || counted != nil || variance != nil {
		t.Fatalf("refused close mutated session = %s %v %v, want untouched open", status, counted, variance)
	}

	closed, err := closeOne(PosCloseSessionInput{SessionID: sessionID, CountedCashMinor: 4000, VarianceReason: crmStringPointer("drawer short")})
	if err != nil {
		t.Fatalf("posCloseSession: %v", err)
	}
	if encoded, err := marshalJS(closed); err != nil || string(encoded) != `{"expectedCashMinor":4500,"varianceMinor":-500,"flagged":true}` {
		t.Fatalf("posCloseSession output = %s, %v", encoded, err)
	}
	var countedCash, expectedCash, varianceMinor int64
	var varianceReason string
	var closedBy *string
	var closedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, counted_cash_minor, expected_cash_minor, variance_minor, variance_reason, closed_by_user_id::text, closed_at
		FROM pos_sessions WHERE id = $1::uuid`, sessionID).
		Scan(&status, &countedCash, &expectedCash, &varianceMinor, &varianceReason, &closedBy, &closedAt); err != nil {
		t.Fatal(err)
	}
	if status != "closed" || countedCash != 4000 || expectedCash != 4500 || varianceMinor != -500 ||
		varianceReason != "drawer short" || closedBy == nil || *closedBy != fx.userID || closedAt == nil || !closedAt.Equal(now) {
		t.Fatalf("closed session = %s counted=%d expected=%d variance=%d reason=%q closedBy=%v closedAt=%v",
			status, countedCash, expectedCash, varianceMinor, varianceReason, closedBy, closedAt)
	}
	if _, err := closeOne(PosCloseSessionInput{SessionID: sessionID, CountedCashMinor: 4000, VarianceReason: crmStringPointer("drawer short")}); err == nil ||
		err.Error() != "session already closed" {
		t.Fatalf("double close error = %v, want closed guard", err)
	}
	foreignSessionID := seedPosSession(t, fx, fx.otherOrgID, "main", "open", 0, 0)
	if _, err := closeOne(PosCloseSessionInput{SessionID: foreignSessionID, CountedCashMinor: 0}); err == nil || err.Error() != "session not found" {
		t.Fatalf("foreign close error = %v, want tenant refusal", err)
	}

	zeroSessionID := seedPosSession(t, fx, fx.orgID, "backup", "open", 2500, 0)
	even, err := closeOne(PosCloseSessionInput{SessionID: zeroSessionID, CountedCashMinor: 2500})
	if err != nil {
		t.Fatalf("even close: %v", err)
	}
	if encoded, err := marshalJS(even); err != nil || string(encoded) != `{"expectedCashMinor":2500,"varianceMinor":0,"flagged":false}` {
		t.Fatalf("even close output = %s, %v", encoded, err)
	}
	var zeroReason *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT variance_reason, status FROM pos_sessions WHERE id = $1::uuid`, zeroSessionID).
		Scan(&zeroReason, &status); err != nil {
		t.Fatal(err)
	}
	if zeroReason != nil || status != "closed" {
		t.Fatalf("even close stored reason=%v status=%s, want null reason and closed", zeroReason, status)
	}
}

func TestPosSalesReturnSaleMirrorsRestocksAndCaps(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPosSalesFixture(t, fx)
	seedPosAccounts(t, fx)
	goodsItemID := seedPosItem(t, fx, fx.orgID, "POS-1", "goods")
	seedPosStock(t, fx, fx.orgID, goodsItemID, 5000)
	seedPosItem(t, fx, fx.orgID, "POS-SVC", "service")
	claims := posTestClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	sessionID := seedPosSession(t, fx, fx.orgID, "main", "open", 1000, 0)
	sale, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosCompleteSaleOutput, error) {
		return posCompleteSale(fx.ctx, tx, claims, PosCompleteSaleInput{
			SessionID: sessionID,
			Lines: []PosSaleLineInput{
				{Description: "Widget", Quantity: 2000, UnitPriceMinor: 1500, TaxMinor: 500, SKU: crmStringPointer("POS-1")},
				{Description: "Repair", Quantity: 1000, UnitPriceMinor: 2000},
			},
		}, now)
	})
	if err != nil {
		t.Fatalf("sale before returns: %v", err)
	}
	if sale.TotalMinor != 5500 {
		t.Fatalf("sale total = %d, want 5500", sale.TotalMinor)
	}
	var goodsLineID, svcLineID string
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT description, id::text FROM invoice_lines WHERE invoice_id = $1::uuid ORDER BY description`, sale.InvoiceID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var description, lineID string
		if err := rows.Scan(&description, &lineID); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		if description == "Widget" {
			goodsLineID = lineID
		} else {
			svcLineID = lineID
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if goodsLineID == "" || svcLineID == "" {
		t.Fatalf("sale lines not seeded: goods=%q service=%q", goodsLineID, svcLineID)
	}
	returnSale := func(input PosReturnSaleInput) (PosReturnSaleOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosReturnSaleOutput, error) {
			return posReturnSale(fx.ctx, tx, claims, input, now)
		})
	}

	ret1, err := returnSale(PosReturnSaleInput{
		InvoiceID:    sale.InvoiceID,
		Reason:       "damaged goods",
		RefundMethod: "cash",
		Lines:        []PosReturnLineInput{{InvoiceLineID: goodsLineID, Quantity: 1000}},
	})
	if err != nil {
		t.Fatalf("posReturnSale: %v", err)
	}
	if encoded, err := marshalJS(ret1); err != nil ||
		string(encoded) != fmt.Sprintf(`{"refundEntryId":%q,"refundMinor":1750,"creditedMinor":1750,"restockedLines":1,"refundMethod":"cash"}`, ret1.RefundEntryID) {
		t.Fatalf("return output = %s, %v", encoded, err)
	}
	var entryMemo, entrySourceType string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type FROM journal_entries WHERE id = $1::uuid`, ret1.RefundEntryID).
		Scan(&entryMemo, &entrySourceType); err != nil {
		t.Fatal(err)
	}
	if entryMemo != "POS return on sale 1 to cash: damaged goods" || entrySourceType != "pos_return" {
		t.Fatalf("refund entry = %q %s", entryMemo, entrySourceType)
	}
	if lines := posEntryLines(t, fx, ret1.RefundEntryID); !posSameEntryLines(lines, map[string][2]int64{
		"1000": {0, 1750},
		"4000": {1500, 0},
		"2100": {250, 0},
	}) {
		t.Fatalf("refund entry lines = %+v, want mirrored cash credit with revenue and tax debits", lines)
	}
	var returnID, returnMethod, returnReason string
	var refundMinor int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text, refund_method, refund_minor, reason FROM pos_returns WHERE entry_id = $1::uuid`, ret1.RefundEntryID).
		Scan(&returnID, &returnMethod, &refundMinor, &returnReason); err != nil {
		t.Fatal(err)
	}
	if returnMethod != "cash" || refundMinor != 1750 || returnReason != "damaged goods" {
		t.Fatalf("stored return = %s %d %q", returnMethod, refundMinor, returnReason)
	}
	var returnQuantity, returnSubtotal, returnTax int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT quantity, subtotal_minor, tax_minor FROM pos_return_lines WHERE return_id = $1::uuid`, returnID).
		Scan(&returnQuantity, &returnSubtotal, &returnTax); err != nil {
		t.Fatal(err)
	}
	if returnQuantity != 1000 || returnSubtotal != 1500 || returnTax != 250 {
		t.Fatalf("stored return line = (%d,%d,%d), want (1000,1500,250)", returnQuantity, returnSubtotal, returnTax)
	}
	var creditedMinor int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT credited_minor FROM invoices WHERE id = $1::uuid`, sale.InvoiceID).Scan(&creditedMinor); err != nil {
		t.Fatal(err)
	}
	var drawer int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT expected_cash_minor FROM pos_sessions WHERE id = $1::uuid`, sessionID).Scan(&drawer); err != nil {
		t.Fatal(err)
	}
	var restockDelta int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT quantity_delta FROM stock_movements
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND ref_type = 'pos_return'`, fx.orgID, goodsItemID).Scan(&restockDelta); err != nil {
		t.Fatal(err)
	}
	var onHand int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity), 0) FROM stock_balances WHERE org_id = $1::uuid AND item_id = $2::uuid`,
		fx.orgID, goodsItemID).Scan(&onHand); err != nil {
		t.Fatal(err)
	}
	if creditedMinor != 1750 || drawer != 3750 || restockDelta != 1000 || onHand != 4000 {
		t.Fatalf("after return credited=%d drawer=%d restock=%d onHand=%d, want 1750 3750 1000 4000",
			creditedMinor, drawer, restockDelta, onHand)
	}

	_, err = returnSale(PosReturnSaleInput{
		InvoiceID: sale.InvoiceID,
		Reason:    "damaged goods",
		Lines:     []PosReturnLineInput{{InvoiceLineID: goodsLineID, Quantity: 2000}},
	})
	if err == nil || err.Error() != "return quantity exceeds the 1 remaining units for this item" {
		t.Fatalf("over return error = %v, want remaining quantity guard", err)
	}
	_, err = returnSale(PosReturnSaleInput{
		InvoiceID: sale.InvoiceID,
		Reason:    "damaged goods",
		Lines:     []PosReturnLineInput{{InvoiceLineID: goodsLineID, Quantity: 500}, {InvoiceLineID: goodsLineID, Quantity: 500}},
	})
	if err == nil || err.Error() != "choose each sale line only once" {
		t.Fatalf("duplicate return error = %v, want duplicate guard", err)
	}
	_, err = returnSale(PosReturnSaleInput{
		InvoiceID: executorUUID(t),
		Reason:    "damaged goods",
		Lines:     []PosReturnLineInput{{InvoiceLineID: goodsLineID, Quantity: 500}},
	})
	if err == nil || err.Error() != "sale not found" {
		t.Fatalf("unknown sale return error = %v, want sale not found", err)
	}

	ret2, err := returnSale(PosReturnSaleInput{
		InvoiceID:    sale.InvoiceID,
		Reason:       "changed mind",
		RefundMethod: "card",
		Lines:        []PosReturnLineInput{{InvoiceLineID: svcLineID, Quantity: 1000}},
	})
	if err != nil {
		t.Fatalf("card return: %v", err)
	}
	if ret2.RefundMinor != 2000 || ret2.CreditedMinor != 3750 || ret2.RestockedLines != 0 || ret2.RefundMethod != "card" {
		t.Fatalf("card return output = %+v", ret2)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT expected_cash_minor FROM pos_sessions WHERE id = $1::uuid`, sessionID).Scan(&drawer); err != nil {
		t.Fatal(err)
	}
	if drawer != 3750 {
		t.Fatalf("card refund moved the drawer to %d, want 3750", drawer)
	}

	ret3, err := returnSale(PosReturnSaleInput{InvoiceID: sale.InvoiceID, Reason: "final return", RefundMethod: "cash"})
	if err != nil {
		t.Fatalf("default full return: %v", err)
	}
	if ret3.RefundMinor != 1750 || ret3.CreditedMinor != 5500 || ret3.RestockedLines != 1 || ret3.RefundMethod != "cash" {
		t.Fatalf("default return output = %+v, want remaining goods line returned in cash", ret3)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT expected_cash_minor FROM pos_sessions WHERE id = $1::uuid`, sessionID).Scan(&drawer); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity), 0) FROM stock_balances WHERE org_id = $1::uuid AND item_id = $2::uuid`,
		fx.orgID, goodsItemID).Scan(&onHand); err != nil {
		t.Fatal(err)
	}
	if drawer != 2000 || onHand != 5000 {
		t.Fatalf("after full return drawer=%d onHand=%d, want 2000 and 5000", drawer, onHand)
	}
	_, err = returnSale(PosReturnSaleInput{InvoiceID: sale.InvoiceID, Reason: "again"})
	if err == nil || err.Error() != "sale has nothing left to return (total 5500 - credited 5500)" {
		t.Fatalf("exhausted return error = %v, want nothing-left guard", err)
	}
	if drift := posJournalDrift(t, fx); drift != 0 {
		t.Fatalf("journal drift after returns = %d, want balanced books", drift)
	}
	if got := fx.count(`SELECT count(*) FROM pos_returns WHERE org_id = $1::uuid AND invoice_id = $2::uuid`, fx.orgID, sale.InvoiceID); got != 3 {
		t.Fatalf("stored returns = %d, want three", got)
	}
}
func TestPosSalesShiftSummaryAggregatesSession(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPosSalesFixture(t, fx)
	seedPosAccounts(t, fx)
	goodsItemID := seedPosItem(t, fx, fx.orgID, "POS-1", "goods")
	seedPosStock(t, fx, fx.orgID, goodsItemID, 5000)
	seedPosItem(t, fx, fx.orgID, "POS-SVC", "service")
	claims := posTestClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	sessionID := seedPosSession(t, fx, fx.orgID, "main", "open", 1000, 0)
	sale, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosCompleteSaleOutput, error) {
		return posCompleteSale(fx.ctx, tx, claims, PosCompleteSaleInput{
			SessionID: sessionID,
			Lines:     []PosSaleLineInput{{Description: "Widget", Quantity: 2000, UnitPriceMinor: 1500, TaxMinor: 500, SKU: crmStringPointer("POS-1")}},
		}, now)
	})
	if err != nil {
		t.Fatalf("cash sale: %v", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosCompleteSaleOutput, error) {
		return posCompleteSale(fx.ctx, tx, claims, PosCompleteSaleInput{
			SessionID: sessionID,
			Lines:     []PosSaleLineInput{{Description: "Repair", Quantity: 1000, UnitPriceMinor: 2000, SKU: crmStringPointer("POS-SVC")}},
			Tenders:   []PosTenderInput{{Method: "card", AmountMinor: 2000}},
		}, now)
	}); err != nil {
		t.Fatalf("card sale: %v", err)
	}
	var goodsLineID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM invoice_lines WHERE invoice_id = $1::uuid AND item_id = $2::uuid`, sale.InvoiceID, goodsItemID).
		Scan(&goodsLineID); err != nil {
		t.Fatal(err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosReturnSaleOutput, error) {
		return posReturnSale(fx.ctx, tx, claims, PosReturnSaleInput{
			InvoiceID:    sale.InvoiceID,
			Reason:       "damaged goods",
			RefundMethod: "cash",
			Lines:        []PosReturnLineInput{{InvoiceLineID: goodsLineID, Quantity: 1000}},
		}, now)
	}); err != nil {
		t.Fatalf("return before summary: %v", err)
	}

	summary := func(sessionID string) (PosShiftSummaryOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosShiftSummaryOutput, error) {
			return posShiftSummary(fx.ctx, tx, fx.orgID, PosShiftSummaryInput{SessionID: sessionID})
		})
	}
	sum, err := summary(sessionID)
	if err != nil {
		t.Fatalf("posShiftSummary: %v", err)
	}
	encoded, err := marshalJS(sum)
	if err != nil {
		t.Fatal(err)
	}
	wantSummary := `{"register":"main","status":"open","salesCount":2,"takingsMinor":5500,"tenderTotals":[{"method":"card","amountMinor":2000},{"method":"cash","amountMinor":3500}],"refundTotals":[{"method":"cash","amountMinor":1750}],"expectedCashMinor":1750,"countedCashMinor":null,"varianceMinor":null}`
	if string(encoded) != wantSummary {
		t.Fatalf("shift summary JSON = %s, want %s", encoded, wantSummary)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosCloseSessionOutput, error) {
		return posCloseSession(fx.ctx, tx, claims, PosCloseSessionInput{SessionID: sessionID, CountedCashMinor: 2500, VarianceReason: crmStringPointer("drawer short")}, now)
	}); err != nil {
		t.Fatalf("close before summary: %v", err)
	}
	closedSummary, err := summary(sessionID)
	if err != nil {
		t.Fatalf("closed summary: %v", err)
	}
	if closedSummary.Status != "closed" || closedSummary.CountedCashMinor == nil || *closedSummary.CountedCashMinor != 2500 ||
		closedSummary.VarianceMinor == nil || *closedSummary.VarianceMinor != -250 {
		t.Fatalf("closed summary = %+v, want counted 2500 variance -250", closedSummary)
	}
	if _, err := summary(executorUUID(t)); err == nil || err.Error() != "session not found" {
		t.Fatalf("unknown session summary error = %v, want session not found", err)
	}
	foreignSessionID := seedPosSession(t, fx, fx.otherOrgID, "main", "open", 0, 0)
	if _, err := summary(foreignSessionID); err == nil || err.Error() != "session not found" {
		t.Fatalf("foreign session summary error = %v, want tenant refusal", err)
	}
}

func TestPosSalesLegacyFullStockReturn(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPosSalesFixture(t, fx)
	seedPosAccounts(t, fx)
	itemID := seedPosItem(t, fx, fx.orgID, "POS-2", "goods")
	customerID := seedPosCustomer(t, fx, fx.orgID, "Legacy POS fixture customer")
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	seedPosStock(t, fx, fx.orgID, itemID, 4000)
	var invoiceID, invoiceLineID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, issued_at)
		VALUES ($1::uuid, $2::uuid, 1, 'paid', 'USD', 4000, 0, 4000, 4000, $3)
		RETURNING id::text`, fx.orgID, customerID, now).Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoice_lines (invoice_id, item_id, description, quantity, unit_price_minor, tax_minor)
		VALUES ($1::uuid, NULL, 'Mystery goods', 4000, 1000, 0)
		RETURNING id::text`, invoiceID).Scan(&invoiceLineID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, ref_type, ref_id, unit_cost_minor, actor_type)
		VALUES ($1::uuid, $2::uuid, -4000, 'sale', 'invoice', $3::uuid, 800, 'human')`, fx.orgID, itemID, invoiceID); err != nil {
		t.Fatal(err)
	}
	// The entry completeness trigger fires at commit, so the entry and its
	// two lines must land in one transaction, exactly like postJournalEntry.
	seedTx, err := fx.owner.Begin(fx.ctx)
	if err != nil {
		t.Fatal(err)
	}
	var entryID string
	if err := seedTx.QueryRow(fx.ctx, `
		INSERT INTO journal_entries (org_id, memo, source_type, source_id, currency, posted_at, posted_by_actor_type)
		VALUES ($1::uuid, 'Legacy POS sale #1', 'pos_sale', $2::uuid, 'USD', $3, 'human')
		RETURNING id::text`, fx.orgID, invoiceID, now).Scan(&entryID); err != nil {
		_ = seedTx.Rollback(fx.ctx)
		t.Fatal(err)
	}
	if _, err := seedTx.Exec(fx.ctx, `
		INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor)
		SELECT $1::uuid, id, 4000, 0 FROM accounts WHERE org_id = $2::uuid AND code = '1000'`, entryID, fx.orgID); err != nil {
		_ = seedTx.Rollback(fx.ctx)
		t.Fatal(err)
	}
	if _, err := seedTx.Exec(fx.ctx, `
		INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor)
		SELECT $1::uuid, id, 0, 4000 FROM accounts WHERE org_id = $2::uuid AND code = '4000'`, entryID, fx.orgID); err != nil {
		_ = seedTx.Rollback(fx.ctx)
		t.Fatal(err)
	}
	if err := seedTx.Commit(fx.ctx); err != nil {
		t.Fatal(err)
	}
	claims := posTestClaims(fx)
	returnSale := func(input PosReturnSaleInput) (PosReturnSaleOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PosReturnSaleOutput, error) {
			return posReturnSale(fx.ctx, tx, claims, input, now)
		})
	}
	_, err = returnSale(PosReturnSaleInput{
		InvoiceID: invoiceID,
		Reason:    "damaged goods",
		Lines:     []PosReturnLineInput{{InvoiceLineID: invoiceLineID, Quantity: 1000}},
	})
	if err == nil || err.Error() != "this older sale does not link stock to individual lines; use its full return option" {
		t.Fatalf("legacy partial return error = %v, want full-return-only guard", err)
	}
	ret, err := returnSale(PosReturnSaleInput{InvoiceID: invoiceID, Reason: "damaged goods"})
	if err != nil {
		t.Fatalf("legacy full return: %v", err)
	}
	encoded, err := marshalJS(ret)
	if err != nil || string(encoded) != fmt.Sprintf(`{"refundEntryId":%q,"refundMinor":4000,"creditedMinor":4000,"restockedLines":1,"refundMethod":"cash"}`, ret.RefundEntryID) {
		t.Fatalf("legacy return output = %s, %v", encoded, err)
	}
	if lines := posEntryLines(t, fx, ret.RefundEntryID); !posSameEntryLines(lines, map[string][2]int64{
		"1000": {0, 4000},
		"4000": {4000, 0},
	}) {
		t.Fatalf("legacy refund entry lines = %+v, want mirrored cash and revenue legs", lines)
	}
	var unitCost *int64
	var restockDelta int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT unit_cost_minor, quantity_delta FROM stock_movements
		WHERE org_id = $1::uuid AND item_id = $2::uuid AND ref_type = 'pos_return'`, fx.orgID, itemID).
		Scan(&unitCost, &restockDelta); err != nil {
		t.Fatal(err)
	}
	if restockDelta != 4000 || unitCost == nil || *unitCost != 800 {
		t.Fatalf("legacy restock = %d unitCost=%v, want 4000 at the original cost 800", restockDelta, unitCost)
	}
	var onHand int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT COALESCE(SUM(quantity), 0) FROM stock_balances WHERE org_id = $1::uuid AND item_id = $2::uuid`,
		fx.orgID, itemID).Scan(&onHand); err != nil {
		t.Fatal(err)
	}
	if onHand != 4000 {
		t.Fatalf("legacy on hand = %d, want 4000 restored", onHand)
	}
	var creditedMinor int64
	if err := fx.owner.QueryRow(fx.ctx, `SELECT credited_minor FROM invoices WHERE id = $1::uuid`, invoiceID).Scan(&creditedMinor); err != nil {
		t.Fatal(err)
	}
	if creditedMinor != 4000 {
		t.Fatalf("legacy credited minor = %d, want 4000", creditedMinor)
	}
	_, err = returnSale(PosReturnSaleInput{InvoiceID: invoiceID, Reason: "again"})
	if err == nil || err.Error() != "sale has nothing left to return (total 4000 - credited 4000)" {
		t.Fatalf("legacy exhausted return error = %v, want nothing-left guard", err)
	}
	if drift := posJournalDrift(t, fx); drift != 0 {
		t.Fatalf("journal drift after legacy return = %d, want balanced books", drift)
	}
}
