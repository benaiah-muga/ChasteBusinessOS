package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func paymentRunsInOrgTx[T any](t *testing.T, fx *executorFixture, orgID string, run func(tx pgx.Tx) (T, error)) T {
	t.Helper()
	output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, run)
	if err != nil {
		t.Fatalf("payment runs transaction: %v", err)
	}
	return output
}

func paymentRunsExpectError(t *testing.T, fx *executorFixture, orgID, wantErr string, run func(tx pgx.Tx) error) {
	t.Helper()
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, run(tx)
	}); err == nil || err.Error() != wantErr {
		t.Fatalf("payment runs error = %v, want %q", err, wantErr)
	}
}

func seedPaymentRunsBill(t *testing.T, fx *executorFixture, orgID, vendorID string, number int64, status, currency string, vendorRef *string, totalMinor, paidMinor, creditedMinor int64) string {
	t.Helper()
	var billID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, vendor_ref, total_minor, paid_minor, credited_minor, bill_date)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id::text`, orgID, vendorID, number, status, currency, vendorRef, totalMinor, paidMinor, creditedMinor,
		time.Date(2026, 9, 21, 8, 0, 0, 0, time.UTC)).Scan(&billID); err != nil {
		t.Fatal(err)
	}
	return billID
}

func seedPaymentRunsRun(t *testing.T, fx *executorFixture, orgID, reference, currency string, totalMinor int64, status string, createdAt time.Time, instructedAt, confirmedAt *time.Time) string {
	t.Helper()
	var runID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO payment_runs (org_id, reference, currency, total_minor, status, created_at, instructed_at, confirmed_at, created_by_actor_type)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'human')
		RETURNING id::text`, orgID, reference, currency, totalMinor, status, createdAt, instructedAt, confirmedAt).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	return runID
}

func seedPaymentRunsRunLine(t *testing.T, fx *executorFixture, orgID, runID, billID string, amountMinor int64) string {
	t.Helper()
	var lineID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO payment_run_lines (org_id, payment_run_id, vendor_bill_id, amount_minor)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
		RETURNING id::text`, orgID, runID, billID, amountMinor).Scan(&lineID); err != nil {
		t.Fatal(err)
	}
	return lineID
}

func cleanupPaymentRunsFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin payment runs fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable payment runs fixture ledger cleanup: %v", err)
			return
		}
		steps := []string{
			`DELETE FROM vendor_payments WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM payment_run_lines WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM payment_runs WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid))`,
			`DELETE FROM journal_entries WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM vendor_bill_lines WHERE bill_id IN (SELECT id FROM vendor_bills WHERE org_id IN ($1::uuid, $2::uuid))`,
			`DELETE FROM vendor_bills WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM doc_counters WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM vendors WHERE org_id IN ($1::uuid, $2::uuid)`,
			`DELETE FROM accounts WHERE org_id IN ($1::uuid, $2::uuid)`,
		}
		for _, step := range steps {
			if _, err := tx.Exec(fx.ctx, step, fx.orgID, fx.otherOrgID); err != nil {
				t.Errorf("payment runs fixture cleanup step failed: %v", err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit payment runs fixture cleanup: %v", err)
		}
	})
}

func TestPurchasingPaymentRunsParsersMirrorZodContracts(t *testing.T) {
	billUUID := "22222222-2222-4222-8222-222222222222"
	runUUID := "33333333-3333-4333-8333-333333333333"
	line := `{"billId":"` + billUUID + `","amountMinor":500}`

	created, err := ParseCreatePaymentRunInput(json.RawMessage(`{"memo":"August supplier payout","lines":[` + line + `],"unknown":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if created.Memo == nil || *created.Memo != "August supplier payout" || len(created.Lines) != 1 ||
		created.Lines[0].BillID != billUUID || created.Lines[0].AmountMinor != 500 {
		t.Fatalf("ParseCreatePaymentRunInput() = %+v, want memo and one line", created)
	}
	if encoded, err := marshalJS(created); err != nil || string(encoded) != `{"memo":"August supplier payout","lines":[{"billId":"`+billUUID+`","amountMinor":500}]}` {
		t.Fatalf("ParseCreatePaymentRunInput() JSON = %s, %v", encoded, err)
	}
	minimal, err := ParseCreatePaymentRunInput(json.RawMessage(`{"lines":[{"billId":"` + billUUID + `","amountMinor":1}]}`))
	if err != nil || minimal.Memo != nil || len(minimal.Lines) != 1 {
		t.Fatalf("minimal createPaymentRun input=%+v err=%v, want absent memo", minimal, err)
	}
	longMemo := strings.Repeat("x", 500)
	if accepted, err := ParseCreatePaymentRunInput(json.RawMessage(`{"memo":"` + longMemo + `","lines":[` + line + `]}`)); err != nil || accepted.Memo == nil {
		t.Fatalf("ParseCreatePaymentRunInput(500 char memo) = %+v, %v, want accepted", accepted, err)
	}
	manyLines := make([]string, 0, 101)
	for range 101 {
		manyLines = append(manyLines, line)
	}
	for _, raw := range []string{
		`{}`,
		`{"lines":[]}`,
		`{"lines":null}`,
		`{"lines":"x"}`,
		`{"lines":[5]}`,
		`{"lines":["` + line + `"]}`,
		`{"memo":null,"lines":[` + line + `]}`,
		`{"memo":"` + strings.Repeat("x", 501) + `","lines":[` + line + `]}`,
		`{"lines":[` + strings.Join(manyLines, ",") + `]}`,
		`{"lines":[{"billId":"nope","amountMinor":1}]}`,
		`{"lines":[{"billId":null,"amountMinor":1}]}`,
		`{"lines":[{"amountMinor":1}]}`,
		`{"lines":[{"billId":"` + billUUID + `"}]}`,
		`{"lines":[{"billId":"` + billUUID + `","amountMinor":0}]}`,
		`{"lines":[{"billId":"` + billUUID + `","amountMinor":-2}]}`,
		`{"lines":[{"billId":"` + billUUID + `","amountMinor":1.5}]}`,
	} {
		if _, err := ParseCreatePaymentRunInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreatePaymentRunInput accepted %s", raw)
		}
	}

	for _, parse := range []func(json.RawMessage) (PaymentRunIDInput, error){
		ParseCancelPaymentRunDraftInput, ParseRestorePaymentRunDraftInput, ParseInstructPaymentRunInput,
	} {
		accepted, err := parse(json.RawMessage(`{"paymentRunId":"` + runUUID + `","unknown":1}`))
		if err != nil || accepted.PaymentRunID != runUUID {
			t.Fatalf("%T() = %+v, %v, want the run id", parse, accepted, err)
		}
		for _, raw := range []string{
			`{}`,
			`{"paymentRunId":null}`,
			`{"paymentRunId":"not-a-uuid"}`,
			`{"paymentRunId":5}`,
		} {
			if _, err := parse(json.RawMessage(raw)); err == nil {
				t.Errorf("%T accepted %s", parse, raw)
			}
		}
	}

	astral := "a\U0001F600"
	reversed, err := ParseReversePaymentRunInput(json.RawMessage(`{"paymentRunId":"` + runUUID + `","reason":"` + astral + `","unknown":true}`))
	if err != nil || reversed.PaymentRunID != runUUID || reversed.Reason != astral {
		t.Fatalf("ParseReversePaymentRunInput() = %+v, %v, want utf16 length 3 accepted", reversed, err)
	}
	if _, err := ParseReversePaymentRunInput(json.RawMessage(`{"paymentRunId":"` + runUUID + `","reason":"` + strings.Repeat("x", 500) + `"}`)); err != nil {
		t.Fatalf("ParseReversePaymentRunInput(500 chars) err = %v, want accepted", err)
	}
	for _, raw := range []string{
		`{}`,
		`{"paymentRunId":"` + runUUID + `"}`,
		`{"paymentRunId":"nope","reason":"valid reason"}`,
		`{"paymentRunId":"` + runUUID + `","reason":"ab"}`,
		`{"paymentRunId":"` + runUUID + `","reason":"` + strings.Repeat("x", 501) + `"}`,
		`{"paymentRunId":"` + runUUID + `","reason":null}`,
	} {
		if _, err := ParseReversePaymentRunInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseReversePaymentRunInput accepted %s", raw)
		}
	}

	if _, err := ParseListPaymentRunsInput(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("ParseListPaymentRunsInput({}) err = %v", err)
	}
	if _, err := ParseListPaymentRunsInput(json.RawMessage(`[]`)); err == nil {
		t.Fatalf("ParseListPaymentRunsInput([]) accepted a non-object")
	}
	if _, err := ParseListPaymentRunBillsInput(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("ParseListPaymentRunBillsInput({}) err = %v", err)
	}
	if _, err := ParseListPaymentRunBillsInput(json.RawMessage(`[]`)); err == nil {
		t.Fatal("ParseListPaymentRunBillsInput([]) accepted a non-object")
	}

	if _, err := parsePurchasingPaymentRunInput("purchasing.unknown", json.RawMessage(`{}`)); err == nil || err.Error() != "unsupported purchasing payment run capability" {
		t.Fatalf("parsePurchasingPaymentRunInput(unknown) err = %v, want dispatcher refusal", err)
	}
	for capabilityID, raw := range map[string]string{
		createPaymentRunCapabilityID:       `{"lines":[` + line + `]}`,
		cancelPaymentRunDraftCapabilityID:  `{"paymentRunId":"` + runUUID + `"}`,
		restorePaymentRunDraftCapabilityID: `{"paymentRunId":"` + runUUID + `"}`,
		instructPaymentRunCapabilityID:     `{"paymentRunId":"` + runUUID + `"}`,
		reversePaymentRunCapabilityID:      `{"paymentRunId":"` + runUUID + `","reason":"undo it"}`,
		listPaymentRunsCapabilityID:        `{}`,
		listPaymentRunBillsCapabilityID:    `{}`,
	} {
		if _, err := parsePurchasingPaymentRunInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parsePurchasingPaymentRunInput(%s) err = %v", capabilityID, err)
		}
	}
}

func TestPurchasingPaymentRunsCreateValidatesAndPersistsDraft(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPaymentRunsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	foreignVendorID := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	claims := purchasingBillsClaims(fx)

	openBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 1, "open", "USD", nil, 10_000, 0, 0)
	creditedBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 2, "open", "USD", crmStringPointer("SUP-77"), 8_000, 0, 3_000)
	eurBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 3, "open", "EUR", nil, 5_000, 0, 0)
	voidBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 4, "void", "USD", nil, 6_000, 0, 0)
	settledBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 5, "paid", "USD", nil, 4_000, 4_000, 0)
	voidedAtBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 6, "open", "USD", nil, 2_000, 0, 0)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE vendor_bills SET voided_at = $2 WHERE id = $1::uuid`, voidedAtBillID, time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	foreignBillID := seedPaymentRunsBill(t, fx, fx.otherOrgID, foreignVendorID, 90, "open", "USD", nil, 9_000, 0, 0)

	for _, testCase := range []struct {
		name    string
		lines   []CreatePaymentRunLineInput
		wantErr string
	}{
		{name: "foreign bill", lines: []CreatePaymentRunLineInput{{BillID: foreignBillID, AmountMinor: 100}}, wantErr: fmt.Sprintf("bill %s is unavailable for payment", foreignBillID)},
		{name: "void bill", lines: []CreatePaymentRunLineInput{{BillID: voidBillID, AmountMinor: 100}}, wantErr: fmt.Sprintf("bill %s is unavailable for payment", voidBillID)},
		{name: "voided bill", lines: []CreatePaymentRunLineInput{{BillID: voidedAtBillID, AmountMinor: 100}}, wantErr: fmt.Sprintf("bill %s is unavailable for payment", voidedAtBillID)},
		{name: "settled bill", lines: []CreatePaymentRunLineInput{{BillID: settledBillID, AmountMinor: 100}}, wantErr: fmt.Sprintf("bill %s has no payable balance", settledBillID)},
		{name: "mixed currency", lines: []CreatePaymentRunLineInput{{BillID: openBillID, AmountMinor: 100}, {BillID: eurBillID, AmountMinor: 100}}, wantErr: "all bills in a payment run must use the same currency"},
		{name: "overpayment", lines: []CreatePaymentRunLineInput{{BillID: openBillID, AmountMinor: 10_001}}, wantErr: fmt.Sprintf("payment for bill %s exceeds its outstanding balance", openBillID)},
		{name: "duplicate bill", lines: []CreatePaymentRunLineInput{{BillID: openBillID, AmountMinor: 100}, {BillID: openBillID, AmountMinor: 200}}, wantErr: "a bill can appear only once in a payment run"},
	} {
		paymentRunsExpectError(t, fx, fx.orgID, testCase.wantErr, func(tx pgx.Tx) error {
			_, err := createPaymentRun(fx.ctx, tx, claims, CreatePaymentRunInput{Lines: testCase.lines})
			return err
		})
	}
	if got := fx.count(`SELECT count(*) FROM payment_runs WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("refused payment runs stored %d rows, want 0", got)
	}

	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreatePaymentRunOutput, error) {
		return createPaymentRun(fx.ctx, tx, claims, CreatePaymentRunInput{
			Lines: []CreatePaymentRunLineInput{
				{BillID: openBillID, AmountMinor: 4_000},
				{BillID: creditedBillID, AmountMinor: 5_000},
			},
		})
	})
	if err != nil {
		t.Fatalf("createPaymentRun: %v", err)
	}
	if !isUUID(created.PaymentRunID) || created.Reference != "PR-000001" || created.Currency != "USD" || created.TotalMinor != 9_000 || created.BillCount != 2 {
		t.Fatalf("createPaymentRun output = %+v, want PR-000001 totaling 9000", created)
	}
	if encoded, err := marshalJS(created); err != nil {
		t.Fatal(err)
	} else if string(encoded) != fmt.Sprintf(`{"paymentRunId":%q,"reference":"PR-000001","currency":"USD","totalMinor":9000,"billCount":2}`, created.PaymentRunID) {
		t.Fatalf("createPaymentRun output JSON = %s", encoded)
	}
	var memo *string
	var reference, currency, status, actorType string
	var totalMinor int64
	var actorID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT reference, currency, total_minor, status, memo, created_by_actor_type, created_by_actor_id::text
		FROM payment_runs WHERE id = $1::uuid`, created.PaymentRunID).Scan(&reference, &currency, &totalMinor, &status, &memo, &actorType, &actorID); err != nil {
		t.Fatal(err)
	}
	if reference != "PR-000001" || currency != "USD" || totalMinor != 9_000 || status != "draft" || memo != nil || actorType != "human" || actorID == nil || *actorID != fx.userID {
		t.Fatalf("stored run = %s %s total=%d status=%s memo=%v actor=%s/%v", reference, currency, totalMinor, status, memo, actorType, actorID)
	}
	lineRows, err := fx.owner.Query(fx.ctx, `
		SELECT vendor_bill_id::text, amount_minor FROM payment_run_lines
		WHERE payment_run_id = $1::uuid ORDER BY vendor_bill_id`, created.PaymentRunID)
	if err != nil {
		t.Fatal(err)
	}
	type storedLine struct {
		billID      string
		amountMinor int64
	}
	stored := make([]storedLine, 0, 2)
	for lineRows.Next() {
		var line storedLine
		if err := lineRows.Scan(&line.billID, &line.amountMinor); err != nil {
			lineRows.Close()
			t.Fatal(err)
		}
		stored = append(stored, line)
	}
	if err := lineRows.Err(); err != nil {
		lineRows.Close()
		t.Fatal(err)
	}
	lineRows.Close()
	byBillID := make(map[string]int64, len(stored))
	for _, line := range stored {
		byBillID[line.billID] = line.amountMinor
	}
	if len(stored) != 2 || len(byBillID) != 2 || byBillID[openBillID] != 4_000 || byBillID[creditedBillID] != 5_000 {
		t.Fatalf("stored run lines = %+v, want the selected bills at their pay amounts", stored)
	}
	if got := fx.count(`SELECT "next" FROM doc_counters WHERE org_id = $1::uuid AND kind = 'payment_run'`, fx.orgID); got != 1 {
		t.Fatalf("payment_run counter = %d, want sequence resting at 1", got)
	}

	detailed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreatePaymentRunOutput, error) {
		return createPaymentRun(fx.ctx, tx, claims, CreatePaymentRunInput{
			Memo:  crmStringPointer("August supplier payout"),
			Lines: []CreatePaymentRunLineInput{{BillID: eurBillID, AmountMinor: 1_000}},
		})
	})
	if err != nil {
		t.Fatalf("second createPaymentRun: %v", err)
	}
	if detailed.Reference != "PR-000002" || detailed.Currency != "EUR" || detailed.TotalMinor != 1_000 {
		t.Fatalf("second createPaymentRun output = %+v, want PR-000002 in EUR", detailed)
	}
	var storedMemo *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT memo FROM payment_runs WHERE id = $1::uuid`, detailed.PaymentRunID).Scan(&storedMemo); err != nil {
		t.Fatal(err)
	}
	if storedMemo == nil || *storedMemo != "August supplier payout" {
		t.Fatalf("second run memo = %v, want the input memo", storedMemo)
	}
	if got := fx.count(`SELECT "next" FROM doc_counters WHERE org_id = $1::uuid AND kind = 'payment_run'`, fx.orgID); got != 2 {
		t.Fatalf("payment_run counter = %d, want sequence resting at 2", got)
	}
}

func TestPurchasingPaymentRunsCancelAndRestoreDraftStateMachines(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPaymentRunsFixture(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	claims := purchasingBillsClaims(fx)
	draftBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 1, "open", "USD", nil, 2_000, 0, 0)

	created := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (CreatePaymentRunOutput, error) {
		return createPaymentRun(fx.ctx, tx, claims, CreatePaymentRunInput{
			Lines: []CreatePaymentRunLineInput{{BillID: draftBillID, AmountMinor: 1_000}},
		})
	})

	cancelled := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (PaymentRunIDOutput, error) {
		return cancelPaymentRunDraft(fx.ctx, tx, fx.orgID, PaymentRunIDInput{PaymentRunID: created.PaymentRunID})
	})
	if cancelled.PaymentRunID != created.PaymentRunID {
		t.Fatalf("cancel output = %+v, want the run id", cancelled)
	}
	if encoded, err := marshalJS(cancelled); err != nil || string(encoded) != fmt.Sprintf(`{"paymentRunId":%q}`, created.PaymentRunID) {
		t.Fatalf("cancel output JSON = %s, %v", encoded, err)
	}
	paymentRunsExpectError(t, fx, fx.orgID, "draft payment run not found", func(tx pgx.Tx) error {
		_, err := cancelPaymentRunDraft(fx.ctx, tx, fx.orgID, PaymentRunIDInput{PaymentRunID: created.PaymentRunID})
		return err
	})

	restored := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (PaymentRunIDOutput, error) {
		return restorePaymentRunDraft(fx.ctx, tx, fx.orgID, PaymentRunIDInput{PaymentRunID: created.PaymentRunID})
	})
	if restored.PaymentRunID != created.PaymentRunID {
		t.Fatalf("restore output = %+v, want the run id", restored)
	}
	var status string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM payment_runs WHERE id = $1::uuid`, created.PaymentRunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "draft" {
		t.Fatalf("restored run status = %s, want draft", status)
	}
	paymentRunsExpectError(t, fx, fx.orgID, "cancelled draft payment run not found", func(tx pgx.Tx) error {
		_, err := restorePaymentRunDraft(fx.ctx, tx, fx.orgID, PaymentRunIDInput{PaymentRunID: created.PaymentRunID})
		return err
	})

	paymentRunsExpectError(t, fx, fx.orgID, "draft payment run not found", func(tx pgx.Tx) error {
		_, err := cancelPaymentRunDraft(fx.ctx, tx, fx.orgID, PaymentRunIDInput{PaymentRunID: executorUUID(t)})
		return err
	})
	paymentRunsExpectError(t, fx, fx.orgID, "cancelled draft payment run not found", func(tx pgx.Tx) error {
		_, err := restorePaymentRunDraft(fx.ctx, tx, fx.orgID, PaymentRunIDInput{PaymentRunID: executorUUID(t)})
		return err
	})
	paymentRunsExpectError(t, fx, fx.otherOrgID, "draft payment run not found", func(tx pgx.Tx) error {
		_, err := cancelPaymentRunDraft(fx.ctx, tx, fx.otherOrgID, PaymentRunIDInput{PaymentRunID: created.PaymentRunID})
		return err
	})
}

func TestPurchasingPaymentRunsInstructApprovesPostsAndSettlesBills(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPaymentRunsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	partialBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 1, "open", "USD", nil, 10_000, 0, 0)
	fullBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 2, "open", "USD", nil, 5_000, 0, 0)

	paymentRunsExpectError(t, fx, fx.orgID, "only a draft payment run can be approved", func(tx pgx.Tx) error {
		_, err := instructPaymentRun(fx.ctx, tx, claims, PaymentRunIDInput{PaymentRunID: executorUUID(t)}, now)
		return err
	})

	created := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (CreatePaymentRunOutput, error) {
		return createPaymentRun(fx.ctx, tx, claims, CreatePaymentRunInput{
			Lines: []CreatePaymentRunLineInput{
				{BillID: partialBillID, AmountMinor: 4_000},
				{BillID: fullBillID, AmountMinor: 5_000},
			},
		})
	})

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE payment_runs SET total_minor = 9001 WHERE id = $1::uuid`, created.PaymentRunID); err != nil {
		t.Fatal(err)
	}
	paymentRunsExpectError(t, fx, fx.orgID, "payment run total changed; cancel this draft and review the current bills", func(tx pgx.Tx) error {
		_, err := instructPaymentRun(fx.ctx, tx, claims, PaymentRunIDInput{PaymentRunID: created.PaymentRunID}, now)
		return err
	})
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE payment_runs SET total_minor = 9000 WHERE id = $1::uuid`, created.PaymentRunID); err != nil {
		t.Fatal(err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE vendor_bills SET status = 'void' WHERE id = $1::uuid`, partialBillID); err != nil {
		t.Fatal(err)
	}
	paymentRunsExpectError(t, fx, fx.orgID, "a selected bill is no longer payable", func(tx pgx.Tx) error {
		_, err := instructPaymentRun(fx.ctx, tx, claims, PaymentRunIDInput{PaymentRunID: created.PaymentRunID}, now)
		return err
	})
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE vendor_bills SET status = 'open' WHERE id = $1::uuid`, partialBillID); err != nil {
		t.Fatal(err)
	}

	instructed := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InstructPaymentRunOutput, error) {
		return instructPaymentRun(fx.ctx, tx, claims, PaymentRunIDInput{PaymentRunID: created.PaymentRunID}, now)
	})
	if instructed.PaymentRunID != created.PaymentRunID || instructed.Reference != "PR-000001" || instructed.Currency != "USD" ||
		instructed.TotalMinor != 9_000 || instructed.BillCount != 2 || instructed.Status != "instructed" || !isUUID(instructed.EntryID) {
		t.Fatalf("instructPaymentRun output = %+v, want the approved run", instructed)
	}
	if encoded, err := marshalJS(instructed); err != nil {
		t.Fatal(err)
	} else if string(encoded) != fmt.Sprintf(`{"paymentRunId":%q,"reference":"PR-000001","currency":"USD","totalMinor":9000,"entryId":%q,"billCount":2,"status":"instructed"}`, instructed.PaymentRunID, instructed.EntryID) {
		t.Fatalf("instructPaymentRun output JSON = %s", encoded)
	}
	paymentRunsExpectError(t, fx, fx.orgID, "only a draft payment run can be approved", func(tx pgx.Tx) error {
		_, err := instructPaymentRun(fx.ctx, tx, claims, PaymentRunIDInput{PaymentRunID: created.PaymentRunID}, now)
		return err
	})

	var memo, sourceType, entryCurrency string
	var sourceID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, source_id::text, currency
		FROM journal_entries WHERE id = $1::uuid`, instructed.EntryID).Scan(&memo, &sourceType, &sourceID, &entryCurrency); err != nil {
		t.Fatal(err)
	}
	if memo != "Supplier payment run PR-000001" || sourceType != "supplier_payment_run" || sourceID == nil || *sourceID != created.PaymentRunID || entryCurrency != "USD" {
		t.Fatalf("instruction entry = %q %s source=%v currency=%s", memo, sourceType, sourceID, entryCurrency)
	}
	lines := purchasingJournalLines(t, fx, instructed.EntryID)
	wantLines := []JournalEntryLineInput{
		{AccountCode: "2000", DebitMinor: 9_000},
		{AccountCode: "1000", CreditMinor: 9_000},
	}
	if len(lines) != len(wantLines) {
		t.Fatalf("instruction journal lines = %+v, want %+v", lines, wantLines)
	}
	assertPurchasingJournalLines(t, lines, wantLines)

	paymentQuery, err := fx.owner.Query(fx.ctx, `
		SELECT bill_id::text, amount_minor, method, status, entry_id::text, id::text, paid_at
		FROM vendor_payments WHERE payment_run_id = $1::uuid ORDER BY bill_id::text`, created.PaymentRunID)
	if err != nil {
		t.Fatal(err)
	}
	type storedPayment struct {
		billID      string
		amountMinor int64
		method      string
		status      string
		entryID     string
		paymentID   string
		paidAt      time.Time
	}
	payments := make([]storedPayment, 0, 2)
	for paymentQuery.Next() {
		var payment storedPayment
		if err := paymentQuery.Scan(&payment.billID, &payment.amountMinor, &payment.method, &payment.status, &payment.entryID, &payment.paymentID, &payment.paidAt); err != nil {
			paymentQuery.Close()
			t.Fatal(err)
		}
		payments = append(payments, payment)
	}
	if err := paymentQuery.Err(); err != nil {
		paymentQuery.Close()
		t.Fatal(err)
	}
	paymentQuery.Close()
	if len(payments) != 2 {
		t.Fatalf("stored payments = %+v, want one per selected bill", payments)
	}
	for _, payment := range payments {
		wantBill := partialBillID
		wantAmount := int64(4_000)
		if payment.billID == fullBillID {
			wantBill = fullBillID
			wantAmount = 5_000
		}
		if payment.billID != wantBill || payment.amountMinor != wantAmount || payment.method != "bank_transfer" ||
			payment.status != "instructed" || payment.entryID != instructed.EntryID || !payment.paidAt.Equal(now) {
			t.Fatalf("stored payment = %+v, want instructed bank_transfer against entry %s at %v", payment, instructed.EntryID, now)
		}
	}
	lineCount := fx.count(`SELECT count(*) FROM payment_run_lines WHERE payment_run_id = $1::uuid AND vendor_payment_id IS NOT NULL`, created.PaymentRunID)
	if lineCount != 2 {
		t.Fatalf("run lines linked to payments = %d, want 2", lineCount)
	}

	var partialPaid, fullPaid int64
	var partialStatus, fullStatus string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT paid_minor, status FROM vendor_bills WHERE id = $1::uuid`, partialBillID).Scan(&partialPaid, &partialStatus); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT paid_minor, status FROM vendor_bills WHERE id = $1::uuid`, fullBillID).Scan(&fullPaid, &fullStatus); err != nil {
		t.Fatal(err)
	}
	if partialPaid != 4_000 || partialStatus != "open" || fullPaid != 5_000 || fullStatus != "paid" {
		t.Fatalf("bills after instruction = partial %d/%s full %d/%s, want 4000 open and 5000 paid", partialPaid, partialStatus, fullPaid, fullStatus)
	}
	var runStatus, runEntryID string
	var instructedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, journal_entry_id::text, instructed_at
		FROM payment_runs WHERE id = $1::uuid`, created.PaymentRunID).Scan(&runStatus, &runEntryID, &instructedAt); err != nil {
		t.Fatal(err)
	}
	if runStatus != "instructed" || runEntryID != instructed.EntryID || !instructedAt.Equal(now) {
		t.Fatalf("run after instruction = %s entry=%s at=%v", runStatus, runEntryID, instructedAt)
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after instruction = %d, want balanced books", drift)
	}
}

func TestPurchasingPaymentRunsReverseMirrorsLedgerAndRestoresBalances(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPaymentRunsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	partialBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 1, "open", "USD", nil, 10_000, 0, 0)
	fullBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 2, "open", "USD", nil, 5_000, 0, 0)
	draftBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 3, "open", "USD", nil, 3_000, 0, 0)
	confirmedBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 4, "open", "USD", nil, 6_000, 0, 0)
	driftBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 5, "open", "USD", nil, 8_000, 0, 0)

	createRun := func(billID string, amountMinor int64) CreatePaymentRunOutput {
		return paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (CreatePaymentRunOutput, error) {
			return createPaymentRun(fx.ctx, tx, claims, CreatePaymentRunInput{
				Lines: []CreatePaymentRunLineInput{{BillID: billID, AmountMinor: amountMinor}},
			})
		})
	}
	instructRun := func(runID string) InstructPaymentRunOutput {
		return paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InstructPaymentRunOutput, error) {
			return instructPaymentRun(fx.ctx, tx, claims, PaymentRunIDInput{PaymentRunID: runID}, now)
		})
	}

	created := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (CreatePaymentRunOutput, error) {
		return createPaymentRun(fx.ctx, tx, claims, CreatePaymentRunInput{
			Lines: []CreatePaymentRunLineInput{
				{BillID: partialBillID, AmountMinor: 4_000},
				{BillID: fullBillID, AmountMinor: 5_000},
			},
		})
	})
	instructed := instructRun(created.PaymentRunID)

	draftRun := createRun(draftBillID, 1_000)
	paymentRunsExpectError(t, fx, fx.orgID, "only an instructed, unconfirmed run can be reversed; confirmed payments require a refund or bank correction", func(tx pgx.Tx) error {
		_, err := reversePaymentRun(fx.ctx, tx, claims, ReversePaymentRunInput{PaymentRunID: draftRun.PaymentRunID, Reason: "still a draft"}, now)
		return err
	})
	paymentRunsExpectError(t, fx, fx.orgID, "only an instructed, unconfirmed run can be reversed; confirmed payments require a refund or bank correction", func(tx pgx.Tx) error {
		_, err := reversePaymentRun(fx.ctx, tx, claims, ReversePaymentRunInput{PaymentRunID: executorUUID(t), Reason: "unknown run"}, now)
		return err
	})

	reversed := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ReversePaymentRunOutput, error) {
		return reversePaymentRun(fx.ctx, tx, claims, ReversePaymentRunInput{PaymentRunID: created.PaymentRunID, Reason: "duplicate instruction"}, now)
	})
	if reversed.PaymentRunID != created.PaymentRunID || reversed.Status != "reversed" || !isUUID(reversed.ReversalEntryID) {
		t.Fatalf("reversePaymentRun output = %+v, want the reversed run", reversed)
	}
	if encoded, err := marshalJS(reversed); err != nil {
		t.Fatal(err)
	} else if string(encoded) != fmt.Sprintf(`{"paymentRunId":%q,"reversalEntryId":%q,"status":"reversed"}`, reversed.PaymentRunID, reversed.ReversalEntryID) {
		t.Fatalf("reversePaymentRun output JSON = %s", encoded)
	}
	paymentRunsExpectError(t, fx, fx.orgID, "only an instructed, unconfirmed run can be reversed; confirmed payments require a refund or bank correction", func(tx pgx.Tx) error {
		_, err := reversePaymentRun(fx.ctx, tx, claims, ReversePaymentRunInput{PaymentRunID: created.PaymentRunID, Reason: "second reversal"}, now)
		return err
	})

	var memo, sourceType, currency string
	var sourceID, reversalOfID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, source_id::text, reversal_of_id::text, currency
		FROM journal_entries WHERE id = $1::uuid`, reversed.ReversalEntryID).Scan(&memo, &sourceType, &sourceID, &reversalOfID, &currency); err != nil {
		t.Fatal(err)
	}
	if memo != "Reverse payment run PR-000001: duplicate instruction" || sourceType != "supplier_payment_run_reversal" ||
		sourceID == nil || *sourceID != created.PaymentRunID || reversalOfID == nil || *reversalOfID != instructed.EntryID || currency != "USD" {
		t.Fatalf("reversal entry = %q %s source=%v reversal_of=%v currency=%s", memo, sourceType, sourceID, reversalOfID, currency)
	}
	lines := purchasingJournalLines(t, fx, reversed.ReversalEntryID)
	wantLines := []JournalEntryLineInput{
		{AccountCode: "1000", DebitMinor: 9_000},
		{AccountCode: "2000", CreditMinor: 9_000},
	}
	if len(lines) != len(wantLines) {
		t.Fatalf("reversal journal lines = %+v, want %+v", lines, wantLines)
	}
	assertPurchasingJournalLines(t, lines, wantLines)

	reversedPayments := fx.count(`SELECT count(*) FROM vendor_payments WHERE payment_run_id = $1::uuid AND status = 'reversed' AND reversal_entry_id = $2::uuid AND reversed_at = $3`, created.PaymentRunID, reversed.ReversalEntryID, now)
	if reversedPayments != 2 {
		t.Fatalf("reversed payments = %d, want both run payments marked reversed", reversedPayments)
	}
	var partialPaid, fullPaid int64
	var partialStatus, fullStatus string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT paid_minor, status FROM vendor_bills WHERE id = $1::uuid`, partialBillID).Scan(&partialPaid, &partialStatus); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT paid_minor, status FROM vendor_bills WHERE id = $1::uuid`, fullBillID).Scan(&fullPaid, &fullStatus); err != nil {
		t.Fatal(err)
	}
	if partialPaid != 0 || partialStatus != "open" || fullPaid != 0 || fullStatus != "open" {
		t.Fatalf("bills after reversal = partial %d/%s full %d/%s, want both open at zero", partialPaid, partialStatus, fullPaid, fullStatus)
	}
	var runStatus string
	var runReversalEntryID *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, reversal_entry_id::text FROM payment_runs WHERE id = $1::uuid`, created.PaymentRunID).Scan(&runStatus, &runReversalEntryID); err != nil {
		t.Fatal(err)
	}
	if runStatus != "reversed" || runReversalEntryID == nil || *runReversalEntryID != reversed.ReversalEntryID {
		t.Fatalf("run after reversal = %s entry=%v, want reversed with the mirror entry", runStatus, runReversalEntryID)
	}

	confirmedRun := instructRun(createRun(confirmedBillID, 6_000).PaymentRunID)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE payment_runs SET status = 'confirmed', confirmed_at = $2 WHERE id = $1::uuid`, confirmedRun.PaymentRunID, now); err != nil {
		t.Fatal(err)
	}
	paymentRunsExpectError(t, fx, fx.orgID, "only an instructed, unconfirmed run can be reversed; confirmed payments require a refund or bank correction", func(tx pgx.Tx) error {
		_, err := reversePaymentRun(fx.ctx, tx, claims, ReversePaymentRunInput{PaymentRunID: confirmedRun.PaymentRunID, Reason: "bank already settled"}, now)
		return err
	})

	driftRun := instructRun(createRun(driftBillID, 8_000).PaymentRunID)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE vendor_bills SET paid_minor = 0 WHERE id = $1::uuid`, driftBillID); err != nil {
		t.Fatal(err)
	}
	paymentRunsExpectError(t, fx, fx.orgID, "bill payment balance changed; the run cannot be reversed safely", func(tx pgx.Tx) error {
		_, err := reversePaymentRun(fx.ctx, tx, claims, ReversePaymentRunInput{PaymentRunID: driftRun.PaymentRunID, Reason: "drifted bill"}, now)
		return err
	})

	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after reversals = %d, want balanced books", drift)
	}
}

func TestPurchasingPaymentRunsListReturnsRunsAndRemittanceLines(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPaymentRunsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	claims := purchasingBillsClaims(fx)
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)

	empty := paymentRunsInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (ListPaymentRunsOutput, error) {
		return listPaymentRuns(fx.ctx, tx, fx.otherOrgID, ListPaymentRunsInput{})
	})
	if encoded, err := marshalJS(empty); err != nil || string(encoded) != `{"runs":[]}` {
		t.Fatalf("empty list = %s, %v, want an empty runs array", encoded, err)
	}

	partialBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 1, "open", "USD", crmStringPointer("SUP-1"), 10_000, 0, 0)
	fullBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 2, "open", "USD", nil, 5_000, 0, 0)
	created := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (CreatePaymentRunOutput, error) {
		return createPaymentRun(fx.ctx, tx, claims, CreatePaymentRunInput{
			Lines: []CreatePaymentRunLineInput{
				{BillID: partialBillID, AmountMinor: 4_000},
				{BillID: fullBillID, AmountMinor: 5_000},
			},
		})
	})
	instructed := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (InstructPaymentRunOutput, error) {
		return instructPaymentRun(fx.ctx, tx, claims, PaymentRunIDInput{PaymentRunID: created.PaymentRunID}, now)
	})

	oldInstructed := time.Date(2026, 9, 21, 8, 0, 0, 0, time.UTC)
	oldConfirmed := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	seededRunID := seedPaymentRunsRun(t, fx, fx.orgID, "PR-SEED-000001", "USD", 1_500, "confirmed", time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC), &oldInstructed, &oldConfirmed)
	highNumberBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 101, "open", "USD", crmStringPointer("REF-X"), 800, 0, 0)
	lowNumberBillID := seedPaymentRunsBill(t, fx, fx.orgID, vendorID, 100, "open", "USD", nil, 700, 0, 0)
	seedPaymentRunsRunLine(t, fx, fx.orgID, seededRunID, highNumberBillID, 800)
	seedPaymentRunsRunLine(t, fx, fx.orgID, seededRunID, lowNumberBillID, 700)

	foreignRunID := seedPaymentRunsRun(t, fx, fx.otherOrgID, "PR-FOREIGN", "USD", 9_999, "draft", time.Date(2026, 9, 27, 8, 0, 0, 0, time.UTC), nil, nil)

	listed := paymentRunsInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (ListPaymentRunsOutput, error) {
		return listPaymentRuns(fx.ctx, tx, fx.orgID, ListPaymentRunsInput{})
	})
	if len(listed.Runs) != 2 {
		t.Fatalf("listed runs = %+v, want the two organization runs", listed.Runs)
	}
	first := listed.Runs[0]
	if first.ID != created.PaymentRunID || first.Reference != "PR-000001" || first.Currency != "USD" || first.TotalMinor != 9_000 ||
		first.Status != "instructed" || first.EntryID == nil || *first.EntryID != instructed.EntryID ||
		first.ConfirmedAt != nil || first.InstructedAt == nil || *first.InstructedAt != "2026-09-28T12:00:00.000Z" {
		t.Fatalf("first listed run = %+v, want the instructed run at noon", first)
	}
	if len(first.Lines) != 2 {
		t.Fatalf("first run lines = %+v, want two remittance lines", first.Lines)
	}
	if first.Lines[0].BillID != partialBillID || first.Lines[0].BillNumber != 1 || first.Lines[0].VendorName != "Purchasing fixture vendor" ||
		first.Lines[0].VendorRef == nil || *first.Lines[0].VendorRef != "SUP-1" || first.Lines[0].AmountMinor != 4_000 {
		t.Fatalf("first remittance line = %+v, want bill 1 with SUP-1 at 4000", first.Lines[0])
	}
	if first.Lines[1].BillID != fullBillID || first.Lines[1].BillNumber != 2 || first.Lines[1].VendorName != "Purchasing fixture vendor" ||
		first.Lines[1].VendorRef != nil || first.Lines[1].AmountMinor != 5_000 {
		t.Fatalf("second remittance line = %+v, want bill 2 without a vendor reference at 5000", first.Lines[1])
	}
	second := listed.Runs[1]
	if second.ID != seededRunID || second.Reference != "PR-SEED-000001" || second.Status != "confirmed" ||
		second.EntryID != nil || second.ConfirmedAt == nil || *second.ConfirmedAt != "2026-09-22T08:00:00.000Z" {
		t.Fatalf("second listed run = %+v, want the seeded confirmed run without an entry", second)
	}
	seededJSON, err := marshalJS(second)
	if err != nil {
		t.Fatal(err)
	}
	wantSeeded := fmt.Sprintf(`{"id":%q,"reference":"PR-SEED-000001","currency":"USD","totalMinor":1500,"status":"confirmed","createdAt":"2026-09-20T08:00:00.000Z","instructedAt":"2026-09-21T08:00:00.000Z","confirmedAt":"2026-09-22T08:00:00.000Z","entryId":null,"lines":[{"billId":%q,"billNumber":100,"vendorName":"Purchasing fixture vendor","vendorRef":null,"amountMinor":700},{"billId":%q,"billNumber":101,"vendorName":"Purchasing fixture vendor","vendorRef":"REF-X","amountMinor":800}]}`,
		seededRunID, lowNumberBillID, highNumberBillID)
	if string(seededJSON) != wantSeeded {
		t.Fatalf("seeded run JSON = %s, want %s", seededJSON, wantSeeded)
	}
	for _, run := range listed.Runs {
		if run.ID == foreignRunID {
			t.Fatalf("foreign organization run %s leaked into the list", foreignRunID)
		}
	}
}

func TestGoPurchasingPaymentRunBillsExecutorIsOrgScopedAndReturnsOnlyPositiveOpenBalances(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPaymentRunsFixture(t, fx)
	grantWavePermission(t, fx, "purchasing.read")
	localVendor := seedPurchasingVendor(t, fx, fx.orgID, nil)
	foreignVendor := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	partiallyPaid := seedPaymentRunsBill(t, fx, fx.orgID, localVendor, 21, "open", "UGX", crmStringPointer("REF-21"), 10_000, 2_000, 1_000)
	seedPaymentRunsBill(t, fx, fx.orgID, localVendor, 22, "open", "UGX", nil, 10_000, 7_000, 3_000)
	seedPaymentRunsBill(t, fx, fx.orgID, localVendor, 23, "void", "UGX", nil, 10_000, 0, 0)
	seedPaymentRunsBill(t, fx, fx.otherOrgID, foreignVendor, 24, "open", "UGX", nil, 10_000, 0, 0)

	input := json.RawMessage(`{}`)
	claims := waveModuleClaims(fx, listPaymentRunBillsCapabilityID, "purchasing.read", input, "human", "", "wave4-open-bills-list")
	result, err := fx.executor.Execute(fx.ctx, claims, listPaymentRunBillsCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("listPaymentRunBills result=%+v err=%v", result, err)
	}
	var output ListPaymentRunBillsOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if len(output.Bills) != 1 {
		t.Fatalf("eligible bills = %+v, want only the local open bill with remaining balance", output.Bills)
	}
	bill := output.Bills[0]
	if bill.ID != partiallyPaid || bill.Number != 21 || bill.VendorName != "Purchasing fixture vendor" || bill.VendorRef == nil || *bill.VendorRef != "REF-21" || bill.Currency != "UGX" || bill.DueMinor != 7_000 {
		t.Fatalf("eligible bill = %+v, want bill 21 with 7000 remaining", bill)
	}
	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, listPaymentRunBillsCapabilityID, "crm.read", input, "human", "", "wave4-open-bills-denied"), listPaymentRunBillsCapabilityID, input)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: purchasing.read") {
		t.Fatalf("listPaymentRunBills denied result=%+v err=%v, want purchasing.read refusal", denied, err)
	}
}
