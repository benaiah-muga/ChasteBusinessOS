package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

func TestGoPurchasingConcurrentBillPaymentsCannotOverpay(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingBillsFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	grantWavePermission(t, fx, "purchasing.post")
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	const billNumber int64 = 7042
	const billTotal int64 = 10_000
	const paymentAmount int64 = 7_000
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	entryID := lifecycleInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Vendor bill for concurrency proof", SourceType: "vendor_bill",
			Currency: "USD", PostedAt: now, ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "6000", DebitMinor: billTotal},
				{AccountCode: "2000", CreditMinor: billTotal},
			},
		})
	})
	billID := seedLifecycleBill(t, fx, fx.orgID, vendorID, billNumber, "open", billTotal, 0, 0, &entryID)
	input := json.RawMessage(fmt.Sprintf(`{"billNumber":%d,"amountMinor":%d,"method":"bank_transfer"}`, billNumber, paymentAmount))
	claims := []authbridge.CapabilityClaims{
		waveModuleClaims(fx, payBillCapabilityID, "purchasing.post", input, "human", "", "go-pay-bill-race-a"),
		waveModuleClaims(fx, payBillCapabilityID, "purchasing.post", input, "human", "", "go-pay-bill-race-b"),
	}

	start := make(chan struct{})
	ready := make(chan struct{}, len(claims))
	type completion struct {
		result Result
		err    error
	}
	results := make(chan completion, len(claims))
	for _, claim := range claims {
		go func(claim authbridge.CapabilityClaims) {
			ready <- struct{}{}
			<-start
			result, err := fx.executor.Execute(fx.ctx, claim, payBillCapabilityID, input)
			results <- completion{result: result, err: err}
		}(claim)
	}
	for range claims {
		<-ready
	}
	close(start)

	outcomes := make([]completion, 0, len(claims))
	for range claims {
		outcomes = append(outcomes, <-results)
	}

	succeeded, rejected := 0, 0
	for _, outcome := range outcomes {
		if outcome.err != nil {
			if !strings.Contains(outcome.err.Error(), "overpayment: outstanding is 3000 minor") {
				t.Fatalf("concurrent payBill error=%v, want overpayment refusal", outcome.err)
			}
			rejected++
			continue
		}
		if outcome.result.OK {
			succeeded++
			continue
		}
		if !strings.Contains(outcome.result.Error, "overpayment: outstanding is 3000 minor") {
			t.Fatalf("concurrent payBill result=%+v, want overpayment refusal", outcome.result)
		}
		rejected++
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("concurrent bill payment outcomes: succeeded=%d rejected=%d, want one of each", succeeded, rejected)
	}
	if got := fx.count(`SELECT count(*) FROM vendor_payments WHERE org_id=$1::uuid AND bill_id=$2::uuid`, fx.orgID, billID); got != 1 {
		t.Fatalf("vendor payment rows=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='vendor_payment'`, fx.orgID); got != 1 {
		t.Fatalf("vendor payment journal entries=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM vendor_bills WHERE org_id=$1::uuid AND id=$2::uuid AND status='open' AND paid_minor=$3`, fx.orgID, billID, paymentAmount); got != 1 {
		t.Fatalf("bill balance after concurrent payment rows=%d, want one open bill with 7000 paid", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, payBillCapabilityID); got != 1 {
		t.Fatalf("successful payBill audit events=%d, want one", got)
	}
}
