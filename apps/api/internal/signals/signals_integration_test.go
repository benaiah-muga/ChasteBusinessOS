package signals

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

type signalsFixture struct {
	t          *testing.T
	ctx        context.Context
	owner      *pgxpool.Pool
	runtime    *pgxpool.Pool
	orgID      string
	otherOrgID string
	userID     string
	now        time.Time
}

func newSignalsFixture(t *testing.T) *signalsFixture {
	t.Helper()
	ctx := context.Background()
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed signals fixtures")
		}
		t.Skip("DATABASE_URL is required to seed signals fixtures")
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	fx := &signalsFixture{
		t:          t,
		ctx:        ctx,
		owner:      owner,
		runtime:    runtime,
		orgID:      signalsUUID(t),
		otherOrgID: signalsUUID(t),
		userID:     signalsUUID(t),
		now:        time.Now().UTC().Truncate(time.Millisecond),
	}
	fx.mustExec(`
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go signals fixture', $2), ($3::uuid, 'Go signals other fixture', $4)`,
		fx.orgID, "go-signals-"+fx.orgID[:8], fx.otherOrgID, "go-signals-other-"+fx.otherOrgID[:8])
	fx.mustExec(`INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Go signals user')`,
		fx.userID, "go-signals-"+fx.userID[:8]+"@fixture.test")
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		tx, err := owner.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("begin signals fixture cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("enable signals fixture cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("delete signals fixture organizations: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM users WHERE id = $1::uuid`, fx.userID); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("delete signals fixture user: %v", err)
			return
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit signals fixture cleanup: %v", err)
		}
	})
	return fx
}

func signalsUUID(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

func (fx *signalsFixture) mustExec(query string, args ...any) {
	fx.t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, query, args...); err != nil {
		fx.t.Fatalf("exec %q: %v", strings.Split(strings.TrimSpace(query), "\n")[0], err)
	}
}

func (fx *signalsFixture) daysAgo(days int) time.Time {
	return fx.now.Add(-time.Duration(days) * 24 * time.Hour)
}

func (fx *signalsFixture) daysFromNow(days int) time.Time {
	return fx.now.Add(time.Duration(days) * 24 * time.Hour)
}

func (fx *signalsFixture) insertItem(sku, name string, reorderPoint int64, createdAt time.Time) string {
	fx.t.Helper()
	id := signalsUUID(fx.t)
	fx.mustExec(`
		INSERT INTO items (id, org_id, sku, name, reorder_point_thousandths, created_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`, id, fx.orgID, sku, name, reorderPoint, createdAt)
	return id
}

func (fx *signalsFixture) insertMovement(itemID string, delta int64, reason string, createdAt time.Time) string {
	fx.t.Helper()
	id := signalsUUID(fx.t)
	fx.mustExec(`
		INSERT INTO stock_movements (id, org_id, item_id, quantity_delta, reason, actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'human', $6)`, id, fx.orgID, itemID, delta, reason, createdAt)
	return id
}

func (fx *signalsFixture) assertSignalIDs(signals []capability.BusinessSignal, want ...string) map[string]capability.BusinessSignal {
	fx.t.Helper()
	byID := map[string]capability.BusinessSignal{}
	for _, signal := range signals {
		if _, duplicate := byID[signal.ID]; duplicate {
			fx.t.Fatalf("duplicate signal id %q", signal.ID)
		}
		byID[signal.ID] = signal
	}
	sortedWant := append([]string(nil), want...)
	sort.Strings(sortedWant)
	sortedGot := make([]string, 0, len(byID))
	for id := range byID {
		sortedGot = append(sortedGot, id)
	}
	sort.Strings(sortedGot)
	if !reflect.DeepEqual(sortedGot, sortedWant) {
		fx.t.Fatalf("signal ids = %v, want %v", sortedGot, sortedWant)
	}
	return byID
}

func (fx *signalsFixture) requireRef(t *testing.T, signal capability.BusinessSignal, refType, refID string) {
	t.Helper()
	if signal.Evidence == nil || signal.Evidence.RefType != refType {
		t.Fatalf("signal %s evidence = %+v, want refType %q", signal.ID, signal.Evidence, refType)
	}
	if signal.Evidence.RefID == nil || *signal.Evidence.RefID != refID {
		t.Fatalf("signal %s refId = %v, want %q", signal.ID, signal.Evidence.RefID, refID)
	}
}

func decodeDraft[T any](t *testing.T, signal capability.BusinessSignal) T {
	t.Helper()
	if signal.SuggestedAction == nil {
		t.Fatalf("signal %s has no suggested action", signal.ID)
	}
	var draft T
	if err := json.Unmarshal(signal.SuggestedAction.InputDraft, &draft); err != nil {
		t.Fatalf("signal %s draft decode: %v", signal.ID, err)
	}
	return draft
}

func TestInventoryProducerSignals(t *testing.T) {
	fx := newSignalsFixture(t)

	reorderItem := fx.insertItem("SIG-REORDER", "Cement 25kg", 5_000, fx.daysAgo(10))
	fx.insertMovement(reorderItem, 3_000, "purchase", fx.daysAgo(10))
	deadItem := fx.insertItem("SIG-DEAD", "Stale Bolt", 0, fx.daysAgo(220))
	fx.insertMovement(deadItem, 2_000, "purchase", fx.daysAgo(200))
	fx.insertMovement(deadItem, -500, "sale", fx.daysAgo(150))
	anomalyItem := fx.insertItem("SIG-ANOM", "Anomaly Widget", 0, fx.daysAgo(5))
	fx.insertMovement(anomalyItem, 100, "purchase", fx.daysAgo(5))
	anomalyMovement := fx.insertMovement(anomalyItem, 600, "adjustment", fx.daysAgo(2))
	okItem := fx.insertItem("SIG-OK", "Healthy Gasket", 1_000, fx.daysAgo(5))
	fx.insertMovement(okItem, 5_000, "purchase", fx.daysAgo(5))
	equalItem := fx.insertItem("SIG-EQ", "Boundary Bracket", 2_000, fx.daysAgo(5))
	fx.insertMovement(equalItem, 2_000, "purchase", fx.daysAgo(5))
	fx.insertItem("SIG-QUIET", "Dormant Spool", 0, fx.daysAgo(5))

	otherItem := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO items (id, org_id, sku, name, reorder_point_thousandths, created_at)
		VALUES ($1::uuid, $2::uuid, 'OTHER-1', 'Other org item', 5000, $3)`, otherItem, fx.otherOrgID, fx.daysAgo(10))
	fx.mustExec(`
		INSERT INTO stock_movements (id, org_id, item_id, quantity_delta, reason, actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 1000, 'purchase', 'human', $4)`,
		signalsUUID(t), fx.otherOrgID, otherItem, fx.daysAgo(10))

	signals, err := NewInventoryProducer(fx.runtime)(fx.ctx, fx.orgID, fx.now)
	if err != nil {
		t.Fatal(err)
	}
	byID := fx.assertSignalIDs(signals,
		"inventory.reorder:SIG-REORDER",
		"inventory.reorder:SIG-EQ",
		"inventory.dead-stock:SIG-DEAD",
		"inventory.anomalous-adjustment:"+anomalyMovement,
	)

	reorder := byID["inventory.reorder:SIG-REORDER"]
	if reorder.Severity != "orange" || reorder.Module != "inventory" {
		t.Errorf("reorder severity/module = %s/%s", reorder.Severity, reorder.Module)
	}
	if reorder.Subject != "Cement 25kg is at or below its reorder point" {
		t.Errorf("reorder subject = %q", reorder.Subject)
	}
	if reorder.Detail != "3.000 on hand against a reorder point of 5.000." {
		t.Errorf("reorder detail = %q", reorder.Detail)
	}
	fx.requireRef(t, reorder, "item", reorderItem)
	draft := decodeDraft[reorderDraft](t, reorder)
	if reorder.SuggestedAction.CapabilityID != "purchasing.createPurchaseOrder" {
		t.Errorf("reorder suggested action = %q", reorder.SuggestedAction.CapabilityID)
	}
	if draft.Memo != "Replenish SIG-REORDER" || len(draft.Lines) != 1 ||
		draft.Lines[0].Description != "SIG-REORDER replenishment" || draft.Lines[0].Quantity != 2_000 {
		t.Errorf("reorder draft = %+v", draft)
	}

	boundary := byID["inventory.reorder:SIG-EQ"]
	boundaryDraft := decodeDraft[reorderDraft](t, boundary)
	if boundaryDraft.Lines[0].Quantity != 0 {
		t.Errorf("boundary draft quantity = %d, want 0", boundaryDraft.Lines[0].Quantity)
	}

	dead := byID["inventory.dead-stock:SIG-DEAD"]
	if dead.Subject != "Stale Bolt has not moved in 150 days" {
		t.Errorf("dead stock subject = %q", dead.Subject)
	}
	if dead.Detail != "1.500 on hand with no outbound movement since 5 months - cash sitting on a shelf." {
		t.Errorf("dead stock detail = %q", dead.Detail)
	}
	if dead.SuggestedAction != nil {
		t.Errorf("dead stock should not suggest an action")
	}

	anomaly := byID["inventory.anomalous-adjustment:"+anomalyMovement]
	if anomaly.Severity != "red" {
		t.Errorf("anomaly severity = %q, want red", anomaly.Severity)
	}
	if anomaly.Subject != "Unusual adjustment on Anomaly Widget" {
		t.Errorf("anomaly subject = %q", anomaly.Subject)
	}
	if anomaly.Detail != "A single adjustment of 0.600 is more than half the current on-hand (0.700) - worth a look." {
		t.Errorf("anomaly detail = %q", anomaly.Detail)
	}
	fx.requireRef(t, anomaly, "stock_movement", anomalyMovement)
}

func TestAccountingProducerSignals(t *testing.T) {
	fx := newSignalsFixture(t)

	customer := signalsUUID(t)
	fx.mustExec(`INSERT INTO customers (id, org_id, name) VALUES ($1::uuid, $2::uuid, 'Acme Receivables')`,
		customer, fx.orgID)

	overdueOrange := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO invoices (id, org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, issued_at, due_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 101, 'sent', 10000, 0, 10000, 2000, 1000, $4, $5)`,
		overdueOrange, fx.orgID, customer, fx.daysAgo(100), fx.daysAgo(45))
	overdueRed := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO invoices (id, org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at, due_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 102, 'sent', 5000, 0, 5000, $4, $5)`,
		overdueRed, fx.orgID, customer, fx.daysAgo(90), fx.daysAgo(75))
	settled := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO invoices (id, org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, paid_minor, issued_at, due_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 103, 'sent', 3000, 0, 3000, 3000, $4, $5)`,
		settled, fx.orgID, customer, fx.daysAgo(100), fx.daysAgo(100))
	futureDue := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO invoices (id, org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at, due_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 104, 'sent', 4000, 0, 4000, $4, $5)`,
		futureDue, fx.orgID, customer, fx.daysAgo(100), fx.daysFromNow(5))
	voided := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO invoices (id, org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at, due_at, voided_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 105, 'sent', 9999, 0, 9999, $4, $5, $6)`,
		voided, fx.orgID, customer, fx.daysAgo(100), fx.daysAgo(100), fx.daysAgo(50))

	paymentA := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO payments (id, org_id, invoice_id, amount_minor, received_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 5000, $4)`, paymentA, fx.orgID, overdueOrange, fx.daysAgo(3))
	paymentB := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO payments (id, org_id, invoice_id, amount_minor, received_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 5000, $4)`, paymentB, fx.orgID, overdueOrange, fx.daysAgo(1))
	fx.mustExec(`
		INSERT INTO payments (id, org_id, invoice_id, amount_minor, received_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 5000, $4)`, signalsUUID(t), fx.orgID, overdueOrange, fx.daysAgo(30))
	fx.mustExec(`
		INSERT INTO payments (id, org_id, invoice_id, amount_minor, received_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 5000, $4)`, signalsUUID(t), fx.orgID, overdueRed, fx.daysAgo(2))

	lapsedQuote := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO quotes (id, org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, expires_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 201, 'sent', 1000, 0, 1000, $4, 'human')`,
		lapsedQuote, fx.orgID, customer, fx.daysAgo(10))
	acceptedQuote := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO quotes (id, org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, expires_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 202, 'accepted', 1000, 0, 1000, $4, 'human')`,
		acceptedQuote, fx.orgID, customer, fx.daysAgo(10))
	expiredQuote := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO quotes (id, org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, expires_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 203, 'expired', 1000, 0, 1000, $4, 'human')`,
		expiredQuote, fx.orgID, customer, fx.daysAgo(10))
	freshQuote := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO quotes (id, org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, expires_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 204, 'sent', 1000, 0, 1000, $4, 'human')`,
		freshQuote, fx.orgID, customer, fx.daysFromNow(10))

	claimOne := signalsUUID(t)
	claimTwo := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO expense_claims (id, org_id, claimant_user_id, amount_minor, memo, category, status, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 4000, 'Client dinner', 'meals', 'submitted', $4)`,
		claimOne, fx.orgID, fx.userID, fx.daysAgo(2))
	fx.mustExec(`
		INSERT INTO expense_claims (id, org_id, claimant_user_id, amount_minor, memo, category, status, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 4000, 'Client dinner again', 'meals', 'submitted', $4)`,
		claimTwo, fx.orgID, fx.userID, fx.daysAgo(1))
	oldClaim := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO expense_claims (id, org_id, claimant_user_id, amount_minor, memo, category, status, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 4000, 'Old dinner', 'meals', 'submitted', $4)`,
		oldClaim, fx.orgID, fx.userID, fx.daysAgo(10))
	fx.mustExec(`
		INSERT INTO expense_claims (id, org_id, claimant_user_id, amount_minor, memo, category, status, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 5000, 'Flight', 'travel', 'submitted', $4)`,
		signalsUUID(t), fx.orgID, fx.userID, fx.daysAgo(1))
	fx.mustExec(`INSERT INTO expense_policies (id, org_id, category, limit_minor) VALUES ($1::uuid, $2::uuid, 'meals', 3000)`,
		signalsUUID(t), fx.orgID)
	fx.mustExec(`INSERT INTO expense_policies (id, org_id, category, limit_minor) VALUES ($1::uuid, $2::uuid, 'travel', 100000)`,
		signalsUUID(t), fx.orgID)

	otherCustomer := signalsUUID(t)
	fx.mustExec(`INSERT INTO customers (id, org_id, name) VALUES ($1::uuid, $2::uuid, 'Other org customer')`,
		otherCustomer, fx.otherOrgID)
	otherInvoice := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO invoices (id, org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at, due_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 900, 'sent', 7000, 0, 7000, $4, $5)`,
		otherInvoice, fx.otherOrgID, otherCustomer, fx.daysAgo(100), fx.daysAgo(100))
	fx.mustExec(`
		INSERT INTO payments (id, org_id, invoice_id, amount_minor, received_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 7000, $4)`, signalsUUID(t), fx.otherOrgID, otherInvoice, fx.daysAgo(2))
	fx.mustExec(`
		INSERT INTO payments (id, org_id, invoice_id, amount_minor, received_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 7000, $4)`, signalsUUID(t), fx.otherOrgID, otherInvoice, fx.daysAgo(1))

	signals, err := NewAccountingProducer(fx.runtime)(fx.ctx, fx.orgID, fx.now)
	if err != nil {
		t.Fatal(err)
	}
	paymentIDA, paymentIDB := paymentA, paymentB
	if paymentIDB < paymentIDA {
		paymentIDA, paymentIDB = paymentIDB, paymentIDA
	}
	claimIDA, claimIDB := claimOne, claimTwo
	if claimIDB < claimIDA {
		claimIDA, claimIDB = claimIDB, claimIDA
	}
	byID := fx.assertSignalIDs(signals,
		"accounting.overdue:"+overdueOrange,
		"accounting.overdue:"+overdueRed,
		"accounting.quoteExpired:"+lapsedQuote,
		"accounting.duplicatePayment:"+paymentIDA+":"+paymentIDB,
		"accounting.duplicateClaim:"+claimIDA+":"+claimIDB,
		"accounting.policyOverrun:"+claimOne,
		"accounting.policyOverrun:"+claimTwo,
		"accounting.policyOverrun:"+oldClaim,
	)

	orange := byID["accounting.overdue:"+overdueOrange]
	if orange.Severity != "orange" || orange.Subject != "Invoice #101 is 45 days past due" {
		t.Errorf("orange overdue = %s / %q", orange.Severity, orange.Subject)
	}
	if orange.Detail != "70.00 minor-major units outstanding of 100.00 - due 45 days ago." {
		t.Errorf("orange overdue detail = %q", orange.Detail)
	}
	fx.requireRef(t, orange, "invoice", overdueOrange)
	paymentDraft := decodeDraft[recordPaymentDraft](t, orange)
	if orange.SuggestedAction.CapabilityID != "accounting.recordPayment" || paymentDraft.InvoiceID != overdueOrange {
		t.Errorf("overdue draft = %+v", paymentDraft)
	}

	red := byID["accounting.overdue:"+overdueRed]
	if red.Severity != "red" || red.Subject != "Invoice #102 is 75 days past due" {
		t.Errorf("red overdue = %s / %q", red.Severity, red.Subject)
	}

	quote := byID["accounting.quoteExpired:"+lapsedQuote]
	if quote.Severity != "red" || quote.Subject != "Quote #201 expired without a decision" {
		t.Errorf("quote signal = %s / %q", quote.Severity, quote.Subject)
	}
	lapsedAt := fx.daysAgo(10).Format("2006-01-02")
	if quote.Detail != "Validity lapsed "+lapsedAt+". Decline it to keep the pipeline truthful, or issue a fresh quote if the customer is still warm." {
		t.Errorf("quote detail = %q", quote.Detail)
	}
	quoteDraft := decodeDraft[declineQuoteDraft](t, quote)
	if quote.SuggestedAction.CapabilityID != "accounting.declineQuote" || quoteDraft.QuoteID != lapsedQuote {
		t.Errorf("quote draft = %+v", quoteDraft)
	}

	duplicate := byID["accounting.duplicatePayment:"+paymentIDA+":"+paymentIDB]
	if duplicate.Subject != "Suspected duplicate payment on invoice (50.00, 2 days apart)" {
		t.Errorf("duplicate payment subject = %q", duplicate.Subject)
	}
	if duplicate.Detail != fmt.Sprintf("Payments %s and %s hit the same invoice for the same amount 2 days apart. Could be a double click or an installment that matches by coincidence - verify and refund or reconcile.", shortID(paymentIDA), shortID(paymentIDB)) {
		t.Errorf("duplicate payment detail = %q", duplicate.Detail)
	}
	fx.requireRef(t, duplicate, "invoice", overdueOrange)
	if duplicate.SuggestedAction != nil {
		t.Error("duplicate payment should not suggest an action")
	}

	duplicateClaim := byID["accounting.duplicateClaim:"+claimIDA+":"+claimIDB]
	if duplicateClaim.Subject != "Suspected duplicate expense claim (40.00, 1 day apart)" {
		t.Errorf("duplicate claim subject = %q", duplicateClaim.Subject)
	}
	fx.requireRef(t, duplicateClaim, "expense_claim", claimIDA)

	policy := byID["accounting.policyOverrun:"+claimOne]
	if policy.Subject != "Expense claim over policy: 40.00 in meals (limit 30.00)" {
		t.Errorf("policy subject = %q", policy.Subject)
	}
	if policy.Detail != "The category ceiling is 30.00; this pending claim exceeds it. Approve deliberately or send back with a reason." {
		t.Errorf("policy detail = %q", policy.Detail)
	}
}

func TestCRMProducerSignals(t *testing.T) {
	fx := newSignalsFixture(t)

	stalledDeal := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO deals (id, org_id, title, stage, value_minor, updated_at)
		VALUES ($1::uuid, $2::uuid, 'Renewal package', 'proposal', 250000, $3)`,
		stalledDeal, fx.orgID, fx.daysAgo(15))
	fx.mustExec(`
		INSERT INTO deals (id, org_id, title, stage, value_minor, updated_at)
		VALUES ($1::uuid, $2::uuid, 'Won deal', 'won', 100000, $3)`,
		signalsUUID(t), fx.orgID, fx.daysAgo(100))
	fx.mustExec(`
		INSERT INTO deals (id, org_id, title, stage, value_minor, updated_at)
		VALUES ($1::uuid, $2::uuid, 'Fresh lead', 'lead', 50000, $3)`,
		signalsUUID(t), fx.orgID, fx.daysAgo(13))

	overdueTask := signalsUUID(t)
	fx.mustExec(`INSERT INTO tasks (id, org_id, title, due_at) VALUES ($1::uuid, $2::uuid, 'Send proposal', $3)`,
		overdueTask, fx.orgID, fx.daysAgo(5))
	fx.mustExec(`INSERT INTO tasks (id, org_id, title, due_at, done_at) VALUES ($1::uuid, $2::uuid, 'Done task', $3, $4)`,
		signalsUUID(t), fx.orgID, fx.daysAgo(5), fx.daysAgo(4))
	fx.mustExec(`INSERT INTO tasks (id, org_id, title, due_at) VALUES ($1::uuid, $2::uuid, 'Future task', $3)`,
		signalsUUID(t), fx.orgID, fx.daysFromNow(3))

	signals, err := NewCRMProducer(fx.runtime)(fx.ctx, fx.orgID, fx.now)
	if err != nil {
		t.Fatal(err)
	}
	byID := fx.assertSignalIDs(signals, "crm.stalled:"+stalledDeal, "crm.taskOverdue:"+overdueTask)

	stalled := byID["crm.stalled:"+stalledDeal]
	if stalled.Severity != "orange" || stalled.Subject != `Deal "Renewal package" has gone quiet for 15 days` {
		t.Errorf("stalled signal = %s / %q", stalled.Severity, stalled.Subject)
	}
	if stalled.Detail != `Sat in "proposal" with 2500.00 attached - a nudge now is cheaper than a loss later.` {
		t.Errorf("stalled detail = %q", stalled.Detail)
	}
	fx.requireRef(t, stalled, "deal", stalledDeal)
	dealDraft := decodeDraft[moveDealStageDraft](t, stalled)
	if stalled.SuggestedAction.CapabilityID != "crm.moveDealStage" || dealDraft.DealID != stalledDeal {
		t.Errorf("stalled draft = %+v", dealDraft)
	}

	task := byID["crm.taskOverdue:"+overdueTask]
	if task.Severity != "red" || task.Subject != `Task "Send proposal" is 5 days overdue` {
		t.Errorf("task signal = %s / %q", task.Severity, task.Subject)
	}
	dueDate := fx.daysAgo(5).Format("2006-01-02")
	if task.Detail != "Due "+dueDate+" and still open. Close it or renegotiate the date - silent slippage is how trust erodes." {
		t.Errorf("task detail = %q", task.Detail)
	}
	taskDraft := decodeDraft[completeTaskDraft](t, task)
	if task.SuggestedAction.CapabilityID != "crm.completeTask" || taskDraft.TaskID != overdueTask {
		t.Errorf("task draft = %+v", taskDraft)
	}
}

func TestHRProducerSignals(t *testing.T) {
	fx := newSignalsFixture(t)

	ada := signalsUUID(t)
	fx.mustExec(`INSERT INTO employees (id, org_id, name, monthly_salary_minor) VALUES ($1::uuid, $2::uuid, 'Ada Lovelace', 500000)`,
		ada, fx.orgID)
	for _, days := range []int{1, 2, 3} {
		fx.mustExec(`
			INSERT INTO time_entries (id, org_id, employee_id, work_date, minutes, clocked_in_at, late)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 480, $4, true)`,
			signalsUUID(t), fx.orgID, ada, fx.daysAgo(days))
	}
	fx.mustExec(`
		INSERT INTO time_entries (id, org_id, employee_id, work_date, minutes, clocked_in_at, late)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 480, $4, false)`,
		signalsUUID(t), fx.orgID, ada, fx.daysAgo(4))

	grace := signalsUUID(t)
	fx.mustExec(`INSERT INTO employees (id, org_id, name, monthly_salary_minor) VALUES ($1::uuid, $2::uuid, 'Grace Hopper', 500000)`,
		grace, fx.orgID)
	for i := 0; i < 3; i++ {
		fx.mustExec(`
			INSERT INTO time_entries (id, org_id, employee_id, work_date, minutes, clocked_in_at, late)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 480, $4, true)`,
			signalsUUID(t), fx.orgID, grace, fx.daysAgo(7))
	}

	linus := signalsUUID(t)
	fx.mustExec(`INSERT INTO employees (id, org_id, name, monthly_salary_minor) VALUES ($1::uuid, $2::uuid, 'Linus Torvalds', 500000)`,
		linus, fx.orgID)
	for _, days := range []int{1, 2} {
		fx.mustExec(`
			INSERT INTO time_entries (id, org_id, employee_id, work_date, minutes, clocked_in_at, late)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 480, $4, true)`,
			signalsUUID(t), fx.orgID, linus, fx.daysAgo(days))
	}

	older := signalsUUID(t)
	fx.mustExec(`INSERT INTO employees (id, org_id, name, monthly_salary_minor) VALUES ($1::uuid, $2::uuid, 'Old Habits', 500000)`,
		older, fx.orgID)
	for _, days := range []int{8, 9, 10} {
		fx.mustExec(`
			INSERT INTO time_entries (id, org_id, employee_id, work_date, minutes, clocked_in_at, late)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 480, $4, true)`,
			signalsUUID(t), fx.orgID, older, fx.daysAgo(days))
	}

	signals, err := NewHRProducer(fx.runtime)(fx.ctx, fx.orgID, fx.now)
	if err != nil {
		t.Fatal(err)
	}
	byID := fx.assertSignalIDs(signals, "hr.lateStreak:"+ada, "hr.lateStreak:"+grace)

	streak := byID["hr.lateStreak:"+ada]
	if streak.Severity != "orange" || streak.Subject != "Ada Lovelace clocked in late 3 times in the last 7 days" {
		t.Errorf("late streak = %s / %q", streak.Severity, streak.Subject)
	}
	if streak.Detail != "Pattern, not one-off - worth a conversation before it becomes a culture." {
		t.Errorf("late streak detail = %q", streak.Detail)
	}
	fx.requireRef(t, streak, "employee", ada)
	if streak.SuggestedAction != nil {
		t.Error("late streak should not suggest an action")
	}
}

func TestSupportProducerSignals(t *testing.T) {
	fx := newSignalsFixture(t)

	breached := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO support_conversations (id, org_id, subject, status, ticket_number, priority, sla_due_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'Refund request', 'open', 9, 'high', $3, 'human')`,
		breached, fx.orgID, fx.daysAgo(3))
	fx.mustExec(`
		INSERT INTO support_conversations (id, org_id, subject, status, ticket_number, priority, sla_due_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'Resolved thread', 'resolved', 10, 'normal', $3, 'human')`,
		signalsUUID(t), fx.orgID, fx.daysAgo(3))
	unnumbered := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO support_conversations (id, org_id, subject, status, priority, sla_due_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'Widget visitor', 'open', 'low', $3, 'human')`,
		unnumbered, fx.orgID, fx.daysAgo(1))
	fx.mustExec(`
		INSERT INTO support_conversations (id, org_id, subject, status, ticket_number, priority, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'No SLA', 'open', 11, 'normal', 'human')`,
		signalsUUID(t), fx.orgID)
	fx.mustExec(`
		INSERT INTO support_conversations (id, org_id, subject, status, ticket_number, priority, sla_due_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'Future SLA', 'open', 12, 'normal', $3, 'human')`,
		signalsUUID(t), fx.orgID, fx.daysFromNow(2))

	signals, err := NewSupportProducer(fx.runtime)(fx.ctx, fx.orgID, fx.now)
	if err != nil {
		t.Fatal(err)
	}
	byID := fx.assertSignalIDs(signals, "support.slaBreach:"+breached, "support.slaBreach:"+unnumbered)

	ticket := byID["support.slaBreach:"+breached]
	if ticket.Severity != "red" || ticket.Subject != "Ticket #9 breached its SLA 3 days ago" {
		t.Errorf("breach = %s / %q", ticket.Severity, ticket.Subject)
	}
	if ticket.Detail != "Open high-priority ticket past its due date. Resolve it or renegotiate the deadline with the customer today." {
		t.Errorf("breach detail = %q", ticket.Detail)
	}
	fx.requireRef(t, ticket, "support_conversation", breached)

	widget := byID["support.slaBreach:"+unnumbered]
	if widget.Subject != "Ticket #? breached its SLA 1 day ago" {
		t.Errorf("unnumbered subject = %q", widget.Subject)
	}
}

func TestDocumentsProducerSignals(t *testing.T) {
	fx := newSignalsFixture(t)

	expired := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO documents (id, org_id, title, source_type, status, expires_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'Trade License', 'upload', 'parsed', $3, 'human')`,
		expired, fx.orgID, fx.daysAgo(2))
	recent := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO documents (id, org_id, title, source_type, status, expires_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'Insurance', 'upload', 'parsed', $3, 'human')`,
		recent, fx.orgID, fx.daysAgo(1))
	fx.mustExec(`
		INSERT INTO documents (id, org_id, title, source_type, status, expires_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'Expires right now', 'upload', 'parsed', $3, 'human')`,
		signalsUUID(t), fx.orgID, fx.now)
	fx.mustExec(`
		INSERT INTO documents (id, org_id, title, source_type, status, expires_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'Future contract', 'upload', 'parsed', $3, 'human')`,
		signalsUUID(t), fx.orgID, fx.daysFromNow(30))
	fx.mustExec(`
		INSERT INTO documents (id, org_id, title, source_type, status, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'No expiry', 'upload', 'parsed', 'human')`,
		signalsUUID(t), fx.orgID)

	awaiting := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO documents (id, org_id, title, source_type, status, created_at, created_by_actor_type, parsed_markdown)
		VALUES ($1::uuid, $2::uuid, 'Copper invoice', 'text', 'parsed', $3, 'human', 'Copper wire 40 spools')`,
		awaiting, fx.orgID, fx.daysAgo(3))
	fx.mustExec(`
		INSERT INTO document_suggestions (org_id, document_id, description, suggested_account_code)
		VALUES ($1::uuid, $2::uuid, 'Copper wire', '6000')`, fx.orgID, awaiting)
	recentAwaiting := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO documents (id, org_id, title, source_type, status, created_at, created_by_actor_type, parsed_markdown)
		VALUES ($1::uuid, $2::uuid, 'Fresh invoice', 'text', 'parsed', $3, 'human', 'Fresh')`,
		recentAwaiting, fx.orgID, fx.daysAgo(1))
	fx.mustExec(`
		INSERT INTO document_suggestions (org_id, document_id, description, suggested_account_code)
		VALUES ($1::uuid, $2::uuid, 'Fresh supplies', '6000')`, fx.orgID, recentAwaiting)
	linked := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO documents (id, org_id, title, source_type, status, created_at, created_by_actor_type, parsed_markdown, ref_type, ref_id)
		VALUES ($1::uuid, $2::uuid, 'Already billed', 'text', 'parsed', $3, 'human', 'Billed', 'vendor_bill', $4)`,
		linked, fx.orgID, fx.daysAgo(3), signalsUUID(t))
	fx.mustExec(`
		INSERT INTO document_suggestions (org_id, document_id, description, suggested_account_code)
		VALUES ($1::uuid, $2::uuid, 'Already billed line', '6000')`, fx.orgID, linked)
	dismissed := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO documents (id, org_id, title, source_type, status, created_at, created_by_actor_type, parsed_markdown)
		VALUES ($1::uuid, $2::uuid, 'Dismissed invoice', 'text', 'parsed', $3, 'human', 'Dismissed')`,
		dismissed, fx.orgID, fx.daysAgo(3))
	fx.mustExec(`
		INSERT INTO document_suggestions (org_id, document_id, description, suggested_account_code, status)
		VALUES ($1::uuid, $2::uuid, 'Dismissed line', '6000', 'dismissed')`, fx.orgID, dismissed)

	signals, err := NewDocumentsProducer(fx.runtime)(fx.ctx, fx.orgID, fx.now)
	if err != nil {
		t.Fatal(err)
	}
	byID := fx.assertSignalIDs(signals, "documents.expired:"+expired, "documents.expired:"+recent, "documents.awaitingAction:"+awaiting)
	review := byID["documents.awaitingAction:"+awaiting]
	if review.Severity != "orange" || review.Subject != `Document "Copper invoice" is parsed but not recorded` {
		t.Errorf("awaiting review = %s / %q", review.Severity, review.Subject)
	}
	if review.Detail != "1 coded line is waiting for review. Create the supplier bill from the extracted lines, or dismiss the document so the queue stays honest." {
		t.Errorf("awaiting review detail = %q", review.Detail)
	}
	fx.requireRef(t, review, "document", awaiting)
	if _, exists := byID["documents.awaitingAction:"+recentAwaiting]; exists {
		t.Error("a document inside the review grace period was queued")
	}
	if _, exists := byID["documents.awaitingAction:"+linked]; exists {
		t.Error("a document already linked to a bill was queued")
	}
	if _, exists := byID["documents.awaitingAction:"+dismissed]; exists {
		t.Error("a document with only dismissed suggestions was queued")
	}

	license := byID["documents.expired:"+expired]
	if license.Severity != "red" || license.Subject != `Document "Trade License" expired 2 days ago` {
		t.Errorf("expired document = %s / %q", license.Severity, license.Subject)
	}
	expiryDate := fx.daysAgo(2).Format("2006-01-02")
	if license.Detail != "Past its validity date ("+expiryDate+"). Renew it, or archive it so it stops looking current." {
		t.Errorf("expired document detail = %q", license.Detail)
	}
	fx.requireRef(t, license, "document", expired)

	insurance := byID["documents.expired:"+recent]
	if insurance.Subject != `Document "Insurance" expired 1 day ago` {
		t.Errorf("singular subject = %q", insurance.Subject)
	}
}

func TestPurchasingProducerSignals(t *testing.T) {
	fx := newSignalsFixture(t)

	vendor := signalsUUID(t)
	fx.mustExec(`INSERT INTO vendors (id, org_id, name, payment_term_days) VALUES ($1::uuid, $2::uuid, 'CopperWire GmbH', 30)`,
		vendor, fx.orgID)
	delayed := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO purchase_orders (id, org_id, vendor_id, number, status, promised_at, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 41, 'partial', $4, $5)`,
		delayed, fx.orgID, vendor, fx.daysAgo(10), fx.daysAgo(20))
	onTime := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO purchase_orders (id, org_id, vendor_id, number, status, promised_at, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 42, 'ordered', $4, $5)`,
		onTime, fx.orgID, vendor, fx.daysFromNow(3), fx.daysAgo(1))
	closed := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO purchase_orders (id, org_id, vendor_id, number, status, promised_at, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 43, 'closed', $4, $5)`,
		closed, fx.orgID, vendor, fx.daysAgo(10), fx.daysAgo(20))

	overdue := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO vendor_bills (id, org_id, vendor_id, number, status, total_minor, due_at, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 71, 'open', 72000, $4, $5)`,
		overdue, fx.orgID, vendor, fx.daysAgo(45), fx.daysAgo(60))
	veryOverdue := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO vendor_bills (id, org_id, vendor_id, number, status, total_minor, paid_minor, due_at, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 72, 'open', 50000, 10000, $4, $5)`,
		veryOverdue, fx.orgID, vendor, fx.daysAgo(75), fx.daysAgo(90))
	settled := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO vendor_bills (id, org_id, vendor_id, number, status, total_minor, paid_minor, due_at, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 73, 'paid', 10000, 10000, $4, $5)`,
		settled, fx.orgID, vendor, fx.daysAgo(45), fx.daysAgo(60))
	future := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO vendor_bills (id, org_id, vendor_id, number, status, total_minor, due_at, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 74, 'open', 20000, $4, $5)`,
		future, fx.orgID, vendor, fx.daysFromNow(10), fx.daysAgo(1))

	otherVendor := signalsUUID(t)
	fx.mustExec(`INSERT INTO vendors (id, org_id, name) VALUES ($1::uuid, $2::uuid, 'Foreign supplier')`,
		otherVendor, fx.otherOrgID)
	fx.mustExec(`
		INSERT INTO vendor_bills (id, org_id, vendor_id, number, status, total_minor, due_at, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 900, 'open', 99000, $4, $5)`,
		signalsUUID(t), fx.otherOrgID, otherVendor, fx.daysAgo(100), fx.daysAgo(120))

	signals, err := NewPurchasingProducer(fx.runtime)(fx.ctx, fx.orgID, fx.now)
	if err != nil {
		t.Fatal(err)
	}
	byID := fx.assertSignalIDs(signals,
		"purchasing.orderDelayed:"+delayed,
		"purchasing.billOverdue:"+overdue,
		"purchasing.billOverdue:"+veryOverdue,
	)
	supply := byID["purchasing.orderDelayed:"+delayed]
	if supply.Severity != "red" || supply.Subject != "Purchase order #41 is 10 days past its promised date" {
		t.Errorf("delayed order = %s / %q", supply.Severity, supply.Subject)
	}
	fx.requireRef(t, supply, "purchase_order", delayed)
	draft := decodeDraft[getPurchaseOrderDraft](t, supply)
	if supply.SuggestedAction.CapabilityID != "purchasing.getPurchaseOrder" || draft.PONumber != 41 {
		t.Errorf("delayed order draft = %+v", draft)
	}

	bill := byID["purchasing.billOverdue:"+overdue]
	if bill.Severity != "orange" || bill.Subject != "Supplier bill #71 is 45 days past due" {
		t.Errorf("overdue bill = %s / %q", bill.Severity, bill.Subject)
	}
	if bill.Detail != "720.00 is still owed to \"CopperWire GmbH\" (due "+fx.daysAgo(45).Format("2006-01-02")+"). Review the cash position and pay it, or record why it is being withheld." {
		t.Errorf("overdue bill detail = %q", bill.Detail)
	}
	fx.requireRef(t, bill, "bill", overdue)
	if byID["purchasing.billOverdue:"+veryOverdue].Severity != "red" {
		t.Errorf("a 75 day bill should be red")
	}
}

func TestAccountingExpenseAnomalySignal(t *testing.T) {
	fx := newSignalsFixture(t)

	for index, amount := range []int64{10_000, 12_000, 14_000} {
		fx.mustExec(`
			INSERT INTO expense_claims (id, org_id, claimant_user_id, amount_minor, memo, category, status, created_at)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'Approved travel', 'travel', 'approved', $5)`,
			signalsUUID(t), fx.orgID, fx.userID, amount, fx.daysAgo(30+index))
	}
	flagged := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO expense_claims (id, org_id, claimant_user_id, amount_minor, memo, category, status, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 120000, 'Business class upgrade', 'travel', 'submitted', $4)`,
		flagged, fx.orgID, fx.userID, fx.daysAgo(1))
	ordinary := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO expense_claims (id, org_id, claimant_user_id, amount_minor, memo, category, status, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 13000, 'Ordinary trip', 'travel', 'submitted', $4)`,
		ordinary, fx.orgID, fx.userID, fx.daysAgo(1))
	thin := signalsUUID(t)
	fx.mustExec(`
		INSERT INTO expense_claims (id, org_id, claimant_user_id, amount_minor, memo, category, status, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 900000, 'First ever office buy', 'office', 'submitted', $4)`,
		thin, fx.orgID, fx.userID, fx.daysAgo(1))

	signals, err := NewAccountingProducer(fx.runtime)(fx.ctx, fx.orgID, fx.now)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]capability.BusinessSignal{}
	for _, signal := range signals {
		byID[signal.ID] = signal
	}
	anomaly, ok := byID["accounting.unusualClaim:"+flagged]
	if !ok {
		t.Fatalf("missing unusual claim signal; got %v", byID)
	}
	if anomaly.Severity != "orange" || anomaly.Subject != "Unusual expense claim: 1200.00 in travel" {
		t.Errorf("anomaly = %s / %q", anomaly.Severity, anomaly.Subject)
	}
	if anomaly.Detail != "The claim is 1200.00 against a 120.00 median across 3 approved claims in this category over the last 180 days. Approve deliberately or ask for the receipt before it reaches the books." {
		t.Errorf("anomaly detail = %q", anomaly.Detail)
	}
	fx.requireRef(t, anomaly, "expense_claim", flagged)
	if _, exists := byID["accounting.unusualClaim:"+ordinary]; exists {
		t.Error("an ordinary claim was flagged as unusual")
	}
	if _, exists := byID["accounting.unusualClaim:"+thin]; exists {
		t.Error("a category with thin history was flagged")
	}
}
