package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestInventoryValuationSummaryGovernedExecutorPostsReplaysAndReverses(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupInventoryValuationFixture(t, fx)
	grantWavePermission(t, fx, "inventory.write")
	seedInventoryValuationAccounts(t, fx, fx.orgID)
	seedInventoryValuationAccounts(t, fx, fx.otherOrgID)
	itemID := seedInventoryValuationItem(t, fx, fx.orgID, "SKU-VALUATION-EXEC", "goods", 0, 0, nil)
	foreignItemID := seedInventoryValuationItem(t, fx, fx.otherOrgID, "SKU-VALUATION-FOREIGN", "goods", 0, 0, nil)
	postedAt := time.Date(2026, 9, 21, 9, 0, 0, 0, time.UTC)
	seedInventoryValuationMovement(t, fx, fx.orgID, itemID, 10_000, "purchase", inventoryValuationIntPointer(1_500), nil, nil, "system", postedAt.Add(-time.Hour))
	seedInventoryValuationMovement(t, fx, fx.otherOrgID, foreignItemID, 50_000, "purchase", inventoryValuationIntPointer(9_000), nil, nil, "system", postedAt.Add(-time.Hour))
	inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.orgID, Memo: "Opening inventory control balance", SourceType: "manual",
			Currency: "USD", PostedAt: postedAt.Add(-time.Minute), ActorType: "human",
			Lines: []JournalEntryLineInput{{AccountCode: "1200", DebitMinor: 10_000}, {AccountCode: "5000", CreditMinor: 10_000}},
		})
		return struct{}{}, err
	})
	foreignEntryID := inventoryInOrgTx(t, fx, fx.otherOrgID, func(tx pgx.Tx) (string, error) {
		return postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID: fx.otherOrgID, Memo: "Foreign inventory valuation close", SourceType: inventoryValuationSourceType,
			Currency: "USD", PostedAt: postedAt, ActorType: "human",
			Lines: []JournalEntryLineInput{{AccountCode: "1200", DebitMinor: 6_000}, {AccountCode: "5000", CreditMinor: 6_000}},
		})
	})

	input := json.RawMessage(`{"memo":"Executor valuation close"}`)
	denied, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, inventoryPostValuationSummaryCapabilityID, "inventory.read", input, "human", "", "valuation-wrong-permission"),
		inventoryPostValuationSummaryCapabilityID,
		input,
	)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: inventory.write") {
		t.Fatalf("valuation wrong-permission result=%+v err=%v, want inventory.write denial", denied, err)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='inventory-valuation'`, fx.orgID); got != 0 {
		t.Fatalf("denied valuation journal entries=%d, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, inventoryPostValuationSummaryCapabilityID); got != 0 {
		t.Fatalf("denied valuation execution audits=%d, want none", got)
	}

	foreignReverseInput := json.RawMessage(`{"entryId":"` + foreignEntryID + `"}`)
	foreignReverse, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, inventoryReverseValuationSummaryCapabilityID, "inventory.write", foreignReverseInput, "human", "", "valuation-foreign-reverse"),
		inventoryReverseValuationSummaryCapabilityID,
		foreignReverseInput,
	)
	if err == nil || foreignReverse.OK || !strings.Contains(err.Error(), "no journal entry "+foreignEntryID) {
		t.Fatalf("foreign valuation reversal result=%+v err=%v, want tenant-scoped not-found refusal", foreignReverse, err)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND reversal_of_id=$2::uuid`, fx.otherOrgID, foreignEntryID); got != 0 {
		t.Fatalf("foreign valuation reversal entries=%d, want none", got)
	}

	claims := waveModuleClaims(fx, inventoryPostValuationSummaryCapabilityID, "inventory.write", input, "human", "", "valuation-executor-post")
	result, err := fx.executor.Execute(fx.ctx, claims, inventoryPostValuationSummaryCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("postValuationSummary result=%+v err=%v", result, err)
	}
	var posted InventoryPostValuationSummaryOutput
	if err := json.Unmarshal(result.Data, &posted); err != nil {
		t.Fatalf("decode valuation output %s: %v", result.Data, err)
	}
	if !posted.Posted || posted.EntryID == nil || !isUUID(*posted.EntryID) || posted.LedgerValueMinor != 15_000 || posted.GLBalanceMinor != 10_000 || posted.VarianceMinor != 5_000 {
		t.Fatalf("valuation output=%+v, want a 5000 minor adjustment from ledger 15000 vs GL 10000", posted)
	}
	if lines := inventoryValuationGLLines(t, fx, *posted.EntryID); lines["1200"] != [2]int64{5_000, 0} || lines["5000"] != [2]int64{0, 5_000} {
		t.Fatalf("valuation journal lines=%v, want DR 1200 5000 / CR 5000 5000", lines)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, inventoryPostValuationSummaryCapabilityID); got != 1 {
		t.Fatalf("valuation execution audits=%d, want one human execution", got)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='inventory-valuation'`, fx.otherOrgID); got != 1 {
		t.Fatalf("foreign valuation summary entries=%d, want one unchanged foreign entry", got)
	}

	replay, err := fx.executor.Execute(fx.ctx, claims, inventoryPostValuationSummaryCapabilityID, input)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("valuation replay=%+v err=%v, want the recorded execution receipt", replay, err)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND source_type='inventory-valuation'`, fx.orgID); got != 1 {
		t.Fatalf("valuation replay created %d summary entries, want one", got)
	}

	reverseInput := json.RawMessage(`{"entryId":"` + *posted.EntryID + `"}`)
	reversed, err := fx.executor.Execute(
		fx.ctx,
		waveModuleClaims(fx, inventoryReverseValuationSummaryCapabilityID, "inventory.write", reverseInput, "human", "", "valuation-executor-reverse"),
		inventoryReverseValuationSummaryCapabilityID,
		reverseInput,
	)
	if err != nil || !reversed.OK {
		t.Fatalf("reverseValuationSummary result=%+v err=%v", reversed, err)
	}
	var reversal InventoryReverseValuationSummaryOutput
	if err := json.Unmarshal(reversed.Data, &reversal); err != nil {
		t.Fatalf("decode valuation reversal %s: %v", reversed.Data, err)
	}
	if !reversal.Reversed || !isUUID(reversal.ReversalEntryID) {
		t.Fatalf("valuation reversal=%+v, want a posted reversal entry", reversal)
	}
	if lines := inventoryValuationGLLines(t, fx, reversal.ReversalEntryID); lines["1200"] != [2]int64{0, 5_000} || lines["5000"] != [2]int64{5_000, 0} {
		t.Fatalf("valuation reversal lines=%v, want DR 5000 5000 / CR 1200 5000", lines)
	}
	balance := inventoryInOrgTx(t, fx, fx.orgID, func(tx pgx.Tx) (int64, error) {
		return inventoryGLAccountBalanceMinor(fx.ctx, tx, fx.orgID, "1200")
	})
	if balance != 10_000 {
		t.Fatalf("inventory control balance after reversal=%d, want original 10000", balance)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, inventoryReverseValuationSummaryCapabilityID); got != 1 {
		t.Fatalf("valuation reversal execution audits=%d, want one human execution", got)
	}
}
