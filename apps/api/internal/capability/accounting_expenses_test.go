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

func TestAccountingExpensesParsersMirrorZodContracts(t *testing.T) {
	claimID := "22222222-2222-4222-8222-222222222222"
	documentID := "33333333-3333-4333-8333-333333333333"
	submitRaw := `{"amountMinor":25000,"memo":"Taxi to client meeting","accountCode":"6000","category":"travel","documentId":"` + documentID + `","unknown":true}`
	submitted, err := ParseSubmitExpenseClaimInput(json.RawMessage(submitRaw))
	if err != nil {
		t.Fatal(err)
	}
	wantSubmit := SubmitExpenseClaimInput{
		AmountMinor: 25000,
		Memo:        "Taxi to client meeting",
		AccountCode: crmStringPointer("6000"),
		Category:    crmStringPointer("travel"),
		DocumentID:  crmStringPointer(documentID),
	}
	if submitted.AmountMinor != wantSubmit.AmountMinor || submitted.Memo != wantSubmit.Memo ||
		submitted.AccountCode == nil || *submitted.AccountCode != *wantSubmit.AccountCode ||
		submitted.Category == nil || *submitted.Category != *wantSubmit.Category ||
		submitted.DocumentID == nil || *submitted.DocumentID != *wantSubmit.DocumentID {
		t.Fatalf("ParseSubmitExpenseClaimInput() = %+v, want %+v", submitted, wantSubmit)
	}
	encoded, err := marshalJS(submitted)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"amountMinor":25000,"memo":"Taxi to client meeting","accountCode":"6000","category":"travel","documentId":"`+documentID+`"}` {
		t.Fatalf("ParseSubmitExpenseClaimInput() JSON = %s", encoded)
	}
	minimal, err := ParseSubmitExpenseClaimInput(json.RawMessage(`{"amountMinor":1,"memo":"abc"}`))
	if err != nil || minimal.AccountCode != nil || minimal.Category != nil || minimal.DocumentID != nil {
		t.Fatalf("minimal submit input=%+v err=%v, want absent optionals", minimal, err)
	}
	if encoded, err = marshalJS(minimal); err != nil || string(encoded) != `{"amountMinor":1,"memo":"abc"}` {
		t.Fatalf("minimal submit JSON = %s, %v", encoded, err)
	}

	decided, err := ParseDecideExpenseClaimInput(json.RawMessage(`{"claimId":"` + claimID + `","decision":"rejected","reason":"duplicate receipt","unknown":2}`))
	if err != nil {
		t.Fatal(err)
	}
	wantDecide := DecideExpenseClaimInput{ClaimID: claimID, Decision: "rejected", Reason: crmStringPointer("duplicate receipt")}
	if decided.ClaimID != wantDecide.ClaimID || decided.Decision != wantDecide.Decision ||
		decided.Reason == nil || *decided.Reason != *wantDecide.Reason {
		t.Fatalf("ParseDecideExpenseClaimInput() = %+v, want %+v", decided, wantDecide)
	}
	bareDecide, err := ParseDecideExpenseClaimInput(json.RawMessage(`{"claimId":"` + claimID + `","decision":"approved"}`))
	if err != nil || bareDecide.Reason != nil {
		t.Fatalf("bare decide input=%+v err=%v, want absent reason", bareDecide, err)
	}
	if encoded, err = marshalJS(bareDecide); err != nil || string(encoded) != `{"claimId":"`+claimID+`","decision":"approved"}` {
		t.Fatalf("bare decide JSON = %s, %v", encoded, err)
	}

	paid, err := ParsePayExpenseClaimInput(json.RawMessage(`{"claimId":"` + claimID + `","amountMinor":25000}`))
	if err != nil || paid != (PayExpenseClaimInput{ClaimID: claimID, AmountMinor: 25000}) {
		t.Fatalf("ParsePayExpenseClaimInput() = %+v, %v", paid, err)
	}
	listed, err := ParseListExpenseClaimsInput(json.RawMessage(`{"status":"submitted"}`))
	if err != nil || listed.Status == nil || *listed.Status != "submitted" {
		t.Fatalf("ParseListExpenseClaimsInput() = %+v, %v", listed, err)
	}
	if encoded, err = marshalJS(listed); err != nil || string(encoded) != `{"status":"submitted"}` {
		t.Fatalf("ParseListExpenseClaimsInput() JSON = %s, %v", encoded, err)
	}
	if listed, err = ParseListExpenseClaimsInput(json.RawMessage(`{}`)); err != nil || listed.Status != nil {
		t.Fatalf("ParseListExpenseClaimsInput({}) = %+v, %v, want absent status", listed, err)
	}

	longMemo := strings.Repeat("m", 501)
	longCategory := strings.Repeat("c", 41)
	longReason := strings.Repeat("r", 501)
	for _, raw := range []string{
		`[]`,
		`"x"`,
		`{}`,
		`{"amountMinor":null,"memo":"abc"}`,
		`{"amountMinor":1.5,"memo":"abc"}`,
		`{"amountMinor":0,"memo":"abc"}`,
		`{"amountMinor":-100,"memo":"abc"}`,
		`{"amountMinor":100}`,
		`{"amountMinor":100,"memo":null}`,
		`{"amountMinor":100,"memo":42}`,
		`{"amountMinor":100,"memo":"ab"}`,
		`{"amountMinor":100,"memo":"` + longMemo + `"}`,
		`{"amountMinor":100,"memo":"abc","accountCode":null}`,
		`{"amountMinor":100,"memo":"abc","accountCode":5}`,
		`{"amountMinor":100,"memo":"abc","category":null}`,
		`{"amountMinor":100,"memo":"abc","category":"` + longCategory + `"}`,
		`{"amountMinor":100,"memo":"abc","documentId":"nope"}`,
		`{"amountMinor":100,"memo":"abc","documentId":null}`,
	} {
		if _, err := ParseSubmitExpenseClaimInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseSubmitExpenseClaimInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"claimId":null,"decision":"approved"}`,
		`{"claimId":"not-a-uuid","decision":"approved"}`,
		`{"claimId":"11111111-1111-1111-1111-111111111111","decision":"approved"}`,
		`{"claimId":"` + claimID + `"}`,
		`{"claimId":"` + claimID + `","decision":null}`,
		`{"claimId":"` + claimID + `","decision":"pending"}`,
		`{"claimId":"` + claimID + `","decision":"APPROVED"}`,
		`{"claimId":"` + claimID + `","decision":"approved","reason":null}`,
		`{"claimId":"` + claimID + `","decision":"approved","reason":"` + longReason + `"}`,
	} {
		if _, err := ParseDecideExpenseClaimInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseDecideExpenseClaimInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{}`,
		`{"claimId":"not-a-uuid","amountMinor":1}`,
		`{"claimId":"` + claimID + `"}`,
		`{"claimId":"` + claimID + `","amountMinor":0}`,
		`{"claimId":"` + claimID + `","amountMinor":-1}`,
		`{"claimId":"` + claimID + `","amountMinor":null}`,
	} {
		if _, err := ParsePayExpenseClaimInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParsePayExpenseClaimInput accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{"status":"bogus"}`,
		`{"status":null}`,
		`{"status":5}`,
		`{"status":"SUBMITTED"}`,
	} {
		if _, err := ParseListExpenseClaimsInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseListExpenseClaimsInput accepted %s", raw)
		}
	}

	validByCapability := map[string]string{
		submitExpenseClaimCapabilityID: `{"amountMinor":1,"memo":"abc"}`,
		decideExpenseClaimCapabilityID: `{"claimId":"` + claimID + `","decision":"approved"}`,
		payExpenseClaimCapabilityID:    `{"claimId":"` + claimID + `","amountMinor":1}`,
		listExpenseClaimsCapabilityID:  `{}`,
	}
	for capabilityID, raw := range validByCapability {
		if _, err := parseAccountingExpenseInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parseAccountingExpenseInput(%s) rejected %s: %v", capabilityID, raw, err)
		}
	}
	if _, err := parseAccountingExpenseInput("accounting.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("parseAccountingExpenseInput accepted an unsupported capability")
	}
}

func TestSliceUTF16CodeUnitsMatchesJavaScriptStringSlice(t *testing.T) {
	if got, want := sliceUTF16CodeUnits(strings.Repeat("😀", 41), 80), strings.Repeat("😀", 40); got != want {
		t.Fatalf("80 UTF-16 code units = %q, want %q", got, want)
	}
	// JavaScript slice(0, 80) retains the high surrogate here. When encoded as
	// UTF-8 for PostgreSQL, that unpaired surrogate becomes U+FFFD.
	if got, want := sliceUTF16CodeUnits(strings.Repeat("x", 79)+"😀", 80), strings.Repeat("x", 79)+"�"; got != want {
		t.Fatalf("slice ending inside astral rune = %q, want %q", got, want)
	}
}

func TestAccountingExpensesCategorySuggestionAndPolicyVerdict(t *testing.T) {
	for memo, want := range map[string]string{
		"Taxi to client meeting":       "travel",
		"Team lunch at the bistro":     "meals",
		"Figma subscription renewal":   "software",
		"Printer paper restock":        "supplies",
		"Mystery item":                 "other",
		"Hotel and flight for OFFSITE": "travel",
	} {
		if got := suggestExpenseCategory(memo); got != want {
			t.Errorf("suggestExpenseCategory(%q) = %q, want %q", memo, got, want)
		}
		if got := suggestExpenseCategory(strings.ToLower(memo)); got != want {
			t.Errorf("suggestExpenseCategory is case sensitive for %q", memo)
		}
	}

	policies := []expensePolicyRow{{category: "meals", limitMinor: 5000}}
	verdict := evaluateExpensePolicy("meals", 5000, policies)
	if verdict.overLimit || verdict.limitMinor == nil || *verdict.limitMinor != 5000 {
		t.Fatalf("evaluateExpensePolicy(meals, 5000) = %+v, want within the 5000 limit", verdict)
	}
	verdict = evaluateExpensePolicy("meals", 5001, policies)
	if !verdict.overLimit || verdict.limitMinor == nil || *verdict.limitMinor != 5000 {
		t.Fatalf("evaluateExpensePolicy(meals, 5001) = %+v, want over the 5000 limit", verdict)
	}
	verdict = evaluateExpensePolicy("other", 999999, policies)
	if verdict.overLimit || verdict.limitMinor != nil {
		t.Fatalf("evaluateExpensePolicy(other, 999999) = %+v, want no policy hit", verdict)
	}
}

type seedExpenseClaimRow struct {
	ClaimantUserID string
	AmountMinor    int64
	Currency       string
	Memo           string
	AccountCode    *string
	Category       string
	Status         string
	DecisionReason *string
	CreatedAt      time.Time
}

func seedExpenseClaim(t *testing.T, fx *executorFixture, orgID string, row seedExpenseClaimRow) string {
	t.Helper()
	if row.Currency == "" {
		row.Currency = "USD"
	}
	if row.Category == "" {
		row.Category = "other"
	}
	if row.Status == "" {
		row.Status = "submitted"
	}
	var claimID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO expense_claims (org_id, claimant_user_id, amount_minor, currency, memo, account_code, category, status, decision_reason, created_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id::text`, orgID, row.ClaimantUserID, row.AmountMinor, row.Currency, row.Memo,
		row.AccountCode, row.Category, row.Status, row.DecisionReason, row.CreatedAt).Scan(&claimID)
	if err != nil {
		t.Fatal(err)
	}
	return claimID
}

func seedExpensePolicy(t *testing.T, fx *executorFixture, orgID, category string, limitMinor int64) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO expense_policies (org_id, category, limit_minor) VALUES ($1::uuid, $2, $3)
		ON CONFLICT (org_id, category) DO UPDATE SET limit_minor = $3`, orgID, category, limitMinor); err != nil {
		t.Fatal(err)
	}
}

func seedExpenseAccounts(t *testing.T, fx *executorFixture) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO accounts (org_id, code, name, type) VALUES
		($1::uuid, '1000', 'Cash', 'asset'),
		($1::uuid, '6000', 'Travel Expense', 'expense'),
		($1::uuid, '6900', 'Miscellaneous Expense', 'expense')`, fx.orgID); err != nil {
		t.Fatal(err)
	}
}

func expenseTestClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "human", ActorID: &actorID}
}

// cleanupExpenseFixtureLedger removes posted ledger rows and expense rows in
// reverse dependency order: journal lines before entries, entries before the
// claims that reference them. Posted rows refuse DELETE unless the
// transaction enables app.ledger_maintenance first.
func cleanupExpenseFixtureLedger(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin expense fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable expense fixture ledger cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id=$1::uuid)`, fx.orgID); err != nil {
			t.Errorf("delete expense fixture journal lines: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM journal_entries WHERE org_id=$1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete expense fixture journal entries: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM expense_claims WHERE org_id=$1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete expense fixture claims: %v", err)
			return
		}
		if _, err := tx.Exec(fx.ctx, `DELETE FROM expense_policies WHERE org_id=$1::uuid`, fx.orgID); err != nil {
			t.Errorf("delete expense fixture policies: %v", err)
			return
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit expense fixture cleanup: %v", err)
		}
	})
}

type expenseJournalLineSummary struct {
	code   string
	debit  int64
	credit int64
}

func expenseEntryLines(t *testing.T, fx *executorFixture, entryID string) []expenseJournalLineSummary {
	t.Helper()
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT a.code, jl.debit_minor, jl.credit_minor
		FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
		WHERE jl.entry_id = $1::uuid ORDER BY a.code`, entryID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	lines := make([]expenseJournalLineSummary, 0, 2)
	for rows.Next() {
		var line expenseJournalLineSummary
		if err := rows.Scan(&line.code, &line.debit, &line.credit); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

func TestAccountingExpensesSubmitPersistsCategoryPolicyAndDefaults(t *testing.T) {
	fx := newExecutorFixture(t)
	seedExpensePolicy(t, fx, fx.orgID, "travel", 50_000)
	seedExpensePolicy(t, fx, fx.orgID, "meals", 5_000)
	claims := expenseTestClaims(fx)

	travel, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SubmitExpenseClaimOutput, error) {
		return submitExpenseClaim(fx.ctx, tx, claims, SubmitExpenseClaimInput{
			AmountMinor: 40_000, Memo: "Taxi to client meeting", AccountCode: crmStringPointer("6000"),
			DocumentID: crmStringPointer("33333333-3333-4333-8333-333333333333"),
		})
	})
	if err != nil {
		t.Fatalf("submitExpenseClaim: %v", err)
	}
	if !isUUID(travel.ClaimID) || travel.Status != "submitted" || travel.Category != "travel" || travel.OverPolicyLimit || travel.PolicyLimitMinor == nil || *travel.PolicyLimitMinor != 50_000 {
		t.Fatalf("submitExpenseClaim output = %+v, want travel claim inside the 50000 limit", travel)
	}
	encoded, err := marshalJS(travel)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := fmt.Sprintf(`{"claimId":%q,"status":"submitted","category":"travel","overPolicyLimit":false,"policyLimitMinor":50000}`, travel.ClaimID)
	if string(encoded) != wantJSON {
		t.Fatalf("submitExpenseClaim output JSON = %s, want %s", encoded, wantJSON)
	}
	var claimantID, currency, memo, accountCode, category, status string
	var amountMinor int64
	var documentID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT claimant_user_id::text, currency, memo, account_code, category, status, amount_minor, document_id::text
		FROM expense_claims WHERE id = $1::uuid AND org_id = $2::uuid`, travel.ClaimID, fx.orgID).
		Scan(&claimantID, &currency, &memo, &accountCode, &category, &status, &amountMinor, &documentID); err != nil {
		t.Fatal(err)
	}
	if claimantID != fx.userID || currency != "USD" || memo != "Taxi to client meeting" || accountCode != "6000" ||
		category != "travel" || status != "submitted" || amountMinor != 40_000 || documentID == nil {
		t.Fatalf("stored claim = claimant=%s currency=%s memo=%q account=%s category=%s status=%s amount=%d document=%v",
			claimantID, currency, memo, accountCode, category, status, amountMinor, documentID)
	}

	other, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SubmitExpenseClaimOutput, error) {
		return submitExpenseClaim(fx.ctx, tx, claims, SubmitExpenseClaimInput{AmountMinor: 6_000, Memo: "Mystery item"})
	})
	if err != nil {
		t.Fatalf("submitExpenseClaim(other): %v", err)
	}
	if other.Category != "other" || other.OverPolicyLimit || other.PolicyLimitMinor != nil {
		t.Fatalf("uncategorized submit output = %+v, want other with no policy ceiling", other)
	}

	overridden, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SubmitExpenseClaimOutput, error) {
		return submitExpenseClaim(fx.ctx, tx, claims, SubmitExpenseClaimInput{
			AmountMinor: 5_001, Memo: "Printer paper restock", Category: crmStringPointer("meals"),
		})
	})
	if err != nil {
		t.Fatalf("submitExpenseClaim(overridden): %v", err)
	}
	if overridden.Category != "meals" || !overridden.OverPolicyLimit || overridden.PolicyLimitMinor == nil || *overridden.PolicyLimitMinor != 5_000 {
		t.Fatalf("overridden submit output = %+v, want meals claim over the 5000 limit", overridden)
	}

	if got := fx.count(`SELECT count(*) FROM expense_claims WHERE org_id = $1::uuid`, fx.orgID); got != 3 {
		t.Fatalf("expense claims stored = %d, want three including the over-limit advisory claim", got)
	}
	var fallbackCategory string
	var fallbackAccountCode *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT category, account_code FROM expense_claims WHERE id = $1::uuid`, other.ClaimID).Scan(&fallbackCategory, &fallbackAccountCode); err != nil {
		t.Fatal(err)
	}
	if fallbackCategory != "other" || fallbackAccountCode != nil {
		t.Fatalf("fallback claim category=%q account_code=%v, want other with null account", fallbackCategory, fallbackAccountCode)
	}
}

func TestAccountingExpensesDecideGuardsAndRecordsDecision(t *testing.T) {
	fx := newExecutorFixture(t)
	base := time.Date(2026, 9, 25, 9, 0, 0, 0, time.UTC)
	claims := expenseTestClaims(fx)
	submitted := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{ClaimantUserID: fx.userID, AmountMinor: 12_000, Memo: "Airport taxi", CreatedAt: base})
	noReason := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{ClaimantUserID: fx.userID, AmountMinor: 3_000, Memo: "Team coffee", CreatedAt: base})
	approved := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{ClaimantUserID: fx.userID, AmountMinor: 4_000, Memo: "Already decided", Status: "approved", CreatedAt: base})
	foreignClaim := seedExpenseClaim(t, fx, fx.otherOrgID, seedExpenseClaimRow{ClaimantUserID: fx.userID, AmountMinor: 9_000, Memo: "Foreign claim", CreatedAt: base})

	decided, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (DecideExpenseClaimOutput, error) {
		return decideExpenseClaim(fx.ctx, tx, claims, DecideExpenseClaimInput{ClaimID: submitted, Decision: "approved", Reason: crmStringPointer("receipts verified")})
	})
	if err != nil {
		t.Fatalf("decideExpenseClaim: %v", err)
	}
	if decided.ClaimID != submitted || decided.Status != "approved" {
		t.Fatalf("decideExpenseClaim output = %+v, want approved claim", decided)
	}
	encoded, err := marshalJS(decided)
	if err != nil || string(encoded) != fmt.Sprintf(`{"claimId":%q,"status":"approved"}`, submitted) {
		t.Fatalf("decideExpenseClaim output JSON = %s, %v", encoded, err)
	}
	var status, actorType, actorID, decisionReason string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, decided_by_actor_type, decided_by_actor_id::text, decision_reason
		FROM expense_claims WHERE id = $1::uuid`, submitted).Scan(&status, &actorType, &actorID, &decisionReason); err != nil {
		t.Fatal(err)
	}
	if status != "approved" || actorType != "human" || actorID != fx.userID || decisionReason != "receipts verified" {
		t.Fatalf("decided claim = status=%s actor=%s/%s reason=%q", status, actorType, actorID, decisionReason)
	}

	rejected, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (DecideExpenseClaimOutput, error) {
		return decideExpenseClaim(fx.ctx, tx, claims, DecideExpenseClaimInput{ClaimID: noReason, Decision: "rejected"})
	})
	if err != nil || rejected.Status != "rejected" {
		t.Fatalf("decideExpenseClaim(reject) = %+v, %v", rejected, err)
	}
	var nullReason *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status, decision_reason FROM expense_claims WHERE id = $1::uuid`, noReason).Scan(&status, &nullReason); err != nil {
		t.Fatal(err)
	}
	if status != "rejected" || nullReason != nil {
		t.Fatalf("rejected claim = status=%s reason=%v, want rejected with null reason", status, nullReason)
	}

	for _, claimID := range []string{submitted, approved, foreignClaim, executorUUID(t)} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (DecideExpenseClaimOutput, error) {
			return decideExpenseClaim(fx.ctx, tx, claims, DecideExpenseClaimInput{ClaimID: claimID, Decision: "rejected"})
		})
		if err == nil || err.Error() != "claim not found or already decided" {
			t.Fatalf("decideExpenseClaim(%s) error = %v, want guard refusal", claimID, err)
		}
	}
	if got := fx.count(`SELECT count(*) FROM expense_claims WHERE org_id = $1::uuid AND decided_by_actor_type IS NOT NULL`, fx.orgID); got != 2 {
		t.Fatalf("decided claims = %d, want exactly the two successful decisions", got)
	}
	if got := fx.count(`SELECT count(*) FROM expense_claims WHERE id = $1::uuid AND status = 'submitted' AND decided_by_actor_type IS NULL`, foreignClaim); got != 1 {
		t.Fatalf("foreign claim mutated by decide, rows=%d", got)
	}
}

func TestAccountingExpensesPayPostsBalancedJournalAndMarksPaid(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupExpenseFixtureLedger(t, fx)
	seedExpenseAccounts(t, fx)
	claims := expenseTestClaims(fx)
	now := time.Date(2026, 9, 27, 15, 0, 0, 0, time.UTC)
	defaultCode := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{
		ClaimantUserID: fx.userID, AmountMinor: 25_000, Memo: "Client site taxi and hotel", Status: "approved", CreatedAt: now.Add(-time.Hour),
	})
	overrideCode := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{
		ClaimantUserID: fx.userID, AmountMinor: 8_000, Memo: "Team lunch", AccountCode: crmStringPointer("6000"),
		Status: "approved", CreatedAt: now.Add(-30 * time.Minute),
	})
	longMemo := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{
		ClaimantUserID: fx.userID, AmountMinor: 1_500, Memo: strings.Repeat("x", 90), Status: "approved", CreatedAt: now.Add(-time.Minute),
	})
	astralMemo := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{
		ClaimantUserID: fx.userID, AmountMinor: 1_600, Memo: strings.Repeat("😀", 41), Status: "approved", CreatedAt: now.Add(-30 * time.Second),
	})
	mismatch := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{
		ClaimantUserID: fx.userID, AmountMinor: 7_500, Memo: "Wrong amount offered", Status: "approved", CreatedAt: now.Add(-45 * time.Second),
	})
	submitted := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{ClaimantUserID: fx.userID, AmountMinor: 2_000, Memo: "Not yet approved", CreatedAt: now})
	foreignClaim := seedExpenseClaim(t, fx, fx.otherOrgID, seedExpenseClaimRow{ClaimantUserID: fx.userID, AmountMinor: 9_500, Status: "approved", CreatedAt: now})

	paidOut, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayExpenseClaimOutput, error) {
		return payExpenseClaim(fx.ctx, tx, claims, PayExpenseClaimInput{ClaimID: defaultCode, AmountMinor: 25_000}, now)
	})
	if err != nil {
		t.Fatalf("payExpenseClaim: %v", err)
	}
	if paidOut.ClaimID != defaultCode || !isUUID(paidOut.EntryID) || paidOut.PaidMinor != 25_000 {
		t.Fatalf("payExpenseClaim output = %+v, want paid 25000 with a journal entry", paidOut)
	}
	encoded, err := marshalJS(paidOut)
	if err != nil || string(encoded) != fmt.Sprintf(`{"claimId":%q,"entryId":%q,"paidMinor":25000}`, defaultCode, paidOut.EntryID) {
		t.Fatalf("payExpenseClaim output JSON = %s, %v", encoded, err)
	}
	var entryMemo, sourceType, currency, actorType string
	var sourceID, postedByActorID *string
	var postedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT memo, source_type, source_id::text, currency, posted_at, posted_by_actor_type, posted_by_actor_id::text
		FROM journal_entries WHERE id = $1::uuid AND org_id = $2::uuid`, paidOut.EntryID, fx.orgID).
		Scan(&entryMemo, &sourceType, &sourceID, &currency, &postedAt, &actorType, &postedByActorID); err != nil {
		t.Fatal(err)
	}
	if entryMemo != "Expense reimbursement: Client site taxi and hotel" || sourceType != "expense_claim" ||
		sourceID == nil || *sourceID != defaultCode || currency != "USD" || !postedAt.Equal(now) ||
		actorType != "human" || postedByActorID == nil || *postedByActorID != fx.userID {
		t.Fatalf("posted entry = memo=%q source=%s/%v currency=%s posted=%v actor=%s/%v",
			entryMemo, sourceType, sourceID, currency, postedAt, actorType, postedByActorID)
	}
	if lines := expenseEntryLines(t, fx, paidOut.EntryID); len(lines) != 2 ||
		lines[0] != (expenseJournalLineSummary{code: "1000", debit: 0, credit: 25_000}) ||
		lines[1] != (expenseJournalLineSummary{code: "6900", debit: 25_000, credit: 0}) {
		t.Fatalf("default journal lines = %+v, want 1000 credited and 6900 debited at 25000", expenseEntryLines(t, fx, paidOut.EntryID))
	}

	overridePay, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayExpenseClaimOutput, error) {
		return payExpenseClaim(fx.ctx, tx, claims, PayExpenseClaimInput{ClaimID: overrideCode, AmountMinor: 8_000}, now)
	})
	if err != nil {
		t.Fatalf("payExpenseClaim(override): %v", err)
	}
	if lines := expenseEntryLines(t, fx, overridePay.EntryID); len(lines) != 2 ||
		lines[1] != (expenseJournalLineSummary{code: "6000", debit: 8_000, credit: 0}) {
		t.Fatalf("override journal lines = %+v, want the claim account 6000 debited at 8000", lines)
	}

	longMemoPay, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayExpenseClaimOutput, error) {
		return payExpenseClaim(fx.ctx, tx, claims, PayExpenseClaimInput{ClaimID: longMemo, AmountMinor: 1_500}, now)
	})
	if err != nil {
		t.Fatalf("payExpenseClaim(longMemo): %v", err)
	}
	var longMemoEntry string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT memo FROM journal_entries WHERE id = $1::uuid`, longMemoPay.EntryID).Scan(&longMemoEntry); err != nil {
		t.Fatal(err)
	}
	wantMemo := "Expense reimbursement: " + strings.Repeat("x", 80)
	if longMemoEntry != wantMemo {
		t.Fatalf("long memo entry = %d chars, want truncated %d chars", len([]rune(longMemoEntry)), len([]rune(wantMemo)))
	}
	astralMemoPay, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayExpenseClaimOutput, error) {
		return payExpenseClaim(fx.ctx, tx, claims, PayExpenseClaimInput{ClaimID: astralMemo, AmountMinor: 1_600}, now)
	})
	if err != nil {
		t.Fatalf("payExpenseClaim(astralMemo): %v", err)
	}
	var astralMemoEntry string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT memo FROM journal_entries WHERE id = $1::uuid`, astralMemoPay.EntryID).Scan(&astralMemoEntry); err != nil {
		t.Fatal(err)
	}
	if want := "Expense reimbursement: " + strings.Repeat("😀", 40); astralMemoEntry != want {
		t.Fatalf("astral memo entry = %q, want 40 emoji after the reimbursement prefix", astralMemoEntry)
	}

	for _, bad := range []struct {
		claimID string
		amount  int64
		wantErr string
	}{
		{defaultCode, 25_000, "claim is paid, not approved"},
		{submitted, 2_000, "claim is submitted, not approved"},
		{mismatch, 7_499, "amount mismatch: approved 7500"},
		{executorUUID(t), 1, "claim not found"},
		{foreignClaim, 9_500, "claim not found"},
	} {
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayExpenseClaimOutput, error) {
			return payExpenseClaim(fx.ctx, tx, claims, PayExpenseClaimInput{ClaimID: bad.claimID, AmountMinor: bad.amount}, now)
		})
		if err == nil || err.Error() != bad.wantErr {
			t.Fatalf("payExpenseClaim(%s, %d) error = %v, want %q", bad.claimID, bad.amount, err, bad.wantErr)
		}
	}
	var drift int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT coalesce(sum(jl.debit_minor - jl.credit_minor), 0)
		FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
		WHERE je.org_id = $1::uuid`, fx.orgID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Fatalf("journal drift after payments = %d, want balanced books", drift)
	}
	if got := fx.count(`SELECT count(*) FROM expense_claims WHERE org_id = $1::uuid AND status = 'paid'`, fx.orgID); got != 4 {
		t.Fatalf("paid claims = %d, want only the four successful payments", got)
	}
	if got := fx.count(`SELECT count(*) FROM expense_claims WHERE id = $1::uuid AND status = 'submitted'`, submitted); got != 1 {
		t.Fatalf("refused payment mutated claim state, rows=%d", got)
	}
}

func TestAccountingExpensesConcurrentPaymentIsExactOnce(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupExpenseFixtureLedger(t, fx)
	seedExpenseAccounts(t, fx)
	claims := expenseTestClaims(fx)
	now := time.Now().UTC().Truncate(time.Millisecond)
	claimID := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{
		ClaimantUserID: fx.userID, AmountMinor: 31_500, Memo: "Concurrent reimbursement", Status: "approved", CreatedAt: now.Add(-time.Minute),
	})
	input := PayExpenseClaimInput{ClaimID: claimID, AmountMinor: 31_500}

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
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayExpenseClaimOutput, error) {
			out, err := payExpenseClaim(fx.ctx, tx, claims, input, now)
			if err != nil {
				return PayExpenseClaimOutput{}, err
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
		t.Fatal("first payment did not reach the held transaction")
	}

	secondStarted := make(chan struct{})
	secondDone := make(chan error, 1)
	go func() {
		close(secondStarted)
		_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (PayExpenseClaimOutput, error) {
			_, err := payExpenseClaim(fx.ctx, tx, claims, input, now)
			return PayExpenseClaimOutput{}, err
		})
		secondDone <- err
	}()
	<-secondStarted
	select {
	case err := <-secondDone:
		t.Fatalf("second payment returned before the first transaction released its row lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatalf("first payment transaction failed: %v", err)
	}
	if err := <-secondDone; err == nil || err.Error() != "claim is paid, not approved" {
		t.Fatalf("second payment error = %v, want paid-state rejection", err)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='expense_claim' AND source_id=$2::uuid`, fx.orgID, claimID); got != 1 {
		t.Fatalf("payment journal entries = %d, want exactly one", got)
	}
	if got := fx.count(`SELECT count(*) FROM expense_claims WHERE id=$1::uuid AND org_id=$2::uuid AND status='paid' AND payment_entry_id IS NOT NULL`, claimID, fx.orgID); got != 1 {
		t.Fatalf("paid claim rows = %d, want one paid claim with its payment entry", got)
	}
}

func TestAccountingExpensesListFiltersOrdersAndScopesTenants(t *testing.T) {
	fx := newExecutorFixture(t)
	base := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	oldest := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{ClaimantUserID: fx.userID, AmountMinor: 10_000, Memo: "Oldest submitted", CreatedAt: base})
	middle := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{ClaimantUserID: fx.userID, AmountMinor: 20_000, Memo: "Middle approved", Status: "approved", CreatedAt: base.Add(time.Hour)})
	newest := seedExpenseClaim(t, fx, fx.orgID, seedExpenseClaimRow{ClaimantUserID: fx.userID, AmountMinor: 30_000, Memo: "Newest paid", Status: "paid", CreatedAt: base.Add(2 * time.Hour)})
	seedExpenseClaim(t, fx, fx.otherOrgID, seedExpenseClaimRow{ClaimantUserID: fx.userID, AmountMinor: 99_000, Memo: "Foreign claim", CreatedAt: base.Add(3 * time.Hour)})

	all, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListExpenseClaimsOutput, error) {
		return listExpenseClaims(fx.ctx, tx, fx.orgID, ListExpenseClaimsInput{})
	})
	if err != nil {
		t.Fatalf("listExpenseClaims: %v", err)
	}
	if len(all.Claims) != 3 || all.Claims[0].ID != newest || all.Claims[1].ID != middle || all.Claims[2].ID != oldest {
		t.Fatalf("listExpenseClaims order = %+v, want newest first tenant-scoped rows", all.Claims)
	}
	firstEncoded, err := marshalJS(all.Claims[0])
	if err != nil {
		t.Fatal(err)
	}
	wantFirst := fmt.Sprintf(`{"id":%q,"claimantUserId":%q,"amountMinor":30000,"status":"paid","memo":"Newest paid"}`, newest, fx.userID)
	if string(firstEncoded) != wantFirst {
		t.Fatalf("listExpenseClaims row JSON = %s, want %s", firstEncoded, wantFirst)
	}

	paidStatus := crmStringPointer("paid")
	filtered, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListExpenseClaimsOutput, error) {
		return listExpenseClaims(fx.ctx, tx, fx.orgID, ListExpenseClaimsInput{Status: paidStatus})
	})
	if err != nil {
		t.Fatalf("listExpenseClaims(paid): %v", err)
	}
	if len(filtered.Claims) != 1 || filtered.Claims[0].ID != newest {
		t.Fatalf("listExpenseClaims(paid) = %+v, want only the paid row", filtered.Claims)
	}
	submittedStatus := crmStringPointer("submitted")
	submittedOnly, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListExpenseClaimsOutput, error) {
		return listExpenseClaims(fx.ctx, tx, fx.orgID, ListExpenseClaimsInput{Status: submittedStatus})
	})
	if err != nil {
		t.Fatalf("listExpenseClaims(submitted): %v", err)
	}
	if len(submittedOnly.Claims) != 1 || submittedOnly.Claims[0].ID != oldest {
		t.Fatalf("listExpenseClaims(submitted) = %+v, want only the submitted row", submittedOnly.Claims)
	}
	rejectedStatus := crmStringPointer("rejected")
	empty, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListExpenseClaimsOutput, error) {
		return listExpenseClaims(fx.ctx, tx, fx.orgID, ListExpenseClaimsInput{Status: rejectedStatus})
	})
	if err != nil {
		t.Fatalf("listExpenseClaims(rejected): %v", err)
	}
	emptyEncoded, err := marshalJS(empty)
	if err != nil || string(emptyEncoded) != `{"claims":[]}` {
		t.Fatalf("empty listExpenseClaims JSON = %s, %v", emptyEncoded, err)
	}
}
