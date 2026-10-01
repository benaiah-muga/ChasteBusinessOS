package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestGoPurchasingBillCreditNoteGovernedExecutorApprovalParity(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingLifecycleFixture(t, fx)
	seedPurchasingAccounts(t, fx)
	grantWavePermission(t, fx, "purchasing.write")
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)
	foreignVendorID := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)

	billEntryID := lifecycleInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Vendor bill 1", SourceType: "vendor_bill",
			Currency: "USD", PostedAt: now, ActorType: "human", ActorID: &fx.userID,
			Lines: []JournalEntryLineInput{
				{AccountCode: "6000", DebitMinor: 10_000},
				{AccountCode: "2000", CreditMinor: 10_000},
			},
		})
	})
	billID := seedLifecycleBill(t, fx, fx.orgID, vendorID, 1, "open", 10_000, 0, 0, &billEntryID)
	foreignBillID := seedLifecycleBill(t, fx, fx.otherOrgID, foreignVendorID, 90, "open", 9_000, 0, 0, nil)
	input := json.RawMessage(`{"billId":"` + billID + `","amountMinor":3000,"reason":"Damaged shipment"}`)

	deniedInput := json.RawMessage(`{"billId":"` + billID + `","amountMinor":3000,"reason":"Permission check"}`)
	denied, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, billCreditNoteCapabilityID, "crm.write", deniedInput, "human", "", "go-bill-credit-denied"),
		billCreditNoteCapabilityID, deniedInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: purchasing.write") {
		t.Fatalf("billCreditNote denied result=%+v err=%v, want permission failure", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='vendor_credit_note'`, fx.orgID); got != 0 {
		t.Fatalf("permission-denied request posted %d credit entries, want zero", got)
	}

	foreignInput := json.RawMessage(`{"billId":"` + foreignBillID + `","amountMinor":1000,"reason":"Tenant check"}`)
	foreignCreditsBefore := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='vendor_credit_note'`, fx.otherOrgID)
	foreign, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, billCreditNoteCapabilityID, "purchasing.write", foreignInput, "human", "", "go-bill-credit-foreign"),
		billCreditNoteCapabilityID, foreignInput)
	if err == nil || !strings.Contains(err.Error(), "bill not found") || foreign.OK {
		t.Fatalf("cross-organization bill result=%+v err=%v, want tenant-scoped refusal", foreign, err)
	}
	if got := fx.count(`SELECT count(*) FROM vendor_bills WHERE org_id=$1::uuid AND id=$2::uuid AND credited_minor=0`, fx.otherOrgID, foreignBillID); got != 1 {
		t.Fatalf("cross-organization request mutated foreign bill rows=%d, want one unchanged bill", got)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='vendor_credit_note'`, fx.otherOrgID); got != foreignCreditsBefore {
		t.Fatalf("cross-organization request created foreign credit entries=%d, before=%d", got, foreignCreditsBefore)
	}

	fx.addAgentSession()
	fx.addPolicy(billCreditNoteCapabilityID, "read", nil)
	pending, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, billCreditNoteCapabilityID, "purchasing.write", input, "agent", fx.agentSession, "go-bill-credit-approved"),
		billCreditNoteCapabilityID, input)
	if err != nil || pending.OK || !pending.PendingApproval {
		t.Fatalf("agent bill credit result=%+v err=%v, want pending approval", pending, err)
	}
	if got := fx.count(`SELECT count(*) FROM vendor_bills WHERE org_id=$1::uuid AND id=$2::uuid AND credited_minor=0`, fx.orgID, billID); got != 1 {
		t.Fatalf("pending bill credit mutated bill rows=%d, want one unchanged bill", got)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='vendor_credit_note'`, fx.orgID); got != 0 {
		t.Fatalf("pending bill credit created %d journal entries, want zero", got)
	}
	var approvalID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM approvals WHERE org_id=$1::uuid AND capability_id=$2 AND status='pending'
		ORDER BY created_at DESC LIMIT 1`, fx.orgID, billCreditNoteCapabilityID).Scan(&approvalID); err != nil {
		t.Fatal(err)
	}
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	decision, err := decider.Decide(fx.ctx,
		waveModuleClaims(fx, billCreditNoteCapabilityID, "purchasing.write", input, "human", "", ""),
		ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
	if err != nil || !decision.OK || decision.Status != "executed" || decision.Result == nil || !decision.Result.OK {
		t.Fatalf("bill credit approval result=%+v err=%v, want executed approval", decision, err)
	}
	approved := *decision.Result
	var output BillCreditNoteOutput
	if err := json.Unmarshal(approved.Data, &output); err != nil {
		t.Fatal(err)
	}
	if !isUUID(output.EntryID) || output.CreditedMinor != 3_000 || output.BillBalanceMinor != 7_000 {
		t.Fatalf("approved bill credit output=%+v, want credited 3000 and balance 7000", output)
	}
	var sourceType, currency string
	var sourceID, reversalOfID *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT source_type, source_id::text, reversal_of_id::text, currency
		FROM journal_entries WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, output.EntryID).
		Scan(&sourceType, &sourceID, &reversalOfID, &currency); err != nil {
		t.Fatal(err)
	}
	if sourceType != "vendor_credit_note" || sourceID == nil || *sourceID != billID ||
		reversalOfID == nil || *reversalOfID != billEntryID || currency != "USD" {
		t.Fatalf("approved credit entry source=%s/%v reversalOf=%v currency=%s", sourceType, sourceID, reversalOfID, currency)
	}
	assertPurchasingJournalLines(t, purchasingJournalLines(t, fx, output.EntryID), []JournalEntryLineInput{
		{AccountCode: "2000", DebitMinor: 3_000},
		{AccountCode: "6000", CreditMinor: 3_000},
	})
	if got := fx.count(`SELECT count(*) FROM vendor_bills WHERE org_id=$1::uuid AND id=$2::uuid AND credited_minor=3000`, fx.orgID, billID); got != 1 {
		t.Fatalf("credited bill rows=%d, want one with 3000 credited", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, billCreditNoteCapabilityID); got != 1 {
		t.Fatalf("bill credit approval events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, billCreditNoteCapabilityID); got != 1 {
		t.Fatalf("bill credit execution events=%d, want one", got)
	}
}
