package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestGoWave3InvoiceOpsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin wave3 fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable wave3 fixture ledger cleanup: %v", err)
			return
		}
		for _, stmt := range []string{
			`DELETE FROM invoice_shares WHERE org_id=$1::uuid`,
			`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id=$1::uuid)`,
			`DELETE FROM journal_entries WHERE org_id=$1::uuid`,
			`DELETE FROM invoices WHERE org_id=$1::uuid`,
			`DELETE FROM doc_counters WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("wave3 fixture cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit wave3 fixture cleanup: %v", err)
		}
	})
	grantWavePermission(t, fx, "accounting.write")
	grantWavePermission(t, fx, "accounting.post")
	seedQuoteAccounts(t, fx)
	customerID := seedQuoteCustomer(t, fx, fx.orgID, nil)
	invoiceInput := json.RawMessage(`{"customerId":"` + customerID + `","memo":"Wave3 invoice","lines":[{"description":"Setup","quantity":1000,"unitPriceMinor":150000}]}`)
	created, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, createInvoiceCapabilityID, "accounting.write", invoiceInput, "human", "", "wave3-inv-create"), createInvoiceCapabilityID, invoiceInput)
	if err != nil || !created.OK {
		t.Fatalf("createInvoice result=%+v err=%v", created, err)
	}
	var invoice CreateInvoiceOutput
	if err := json.Unmarshal(created.Data, &invoice); err != nil {
		t.Fatal(err)
	}
	if !isUUID(invoice.InvoiceID) || invoice.InvoiceNumber != 1 || !isUUID(invoice.EntryID) {
		t.Fatalf("createInvoice output=%+v, want numbered invoice with posted entry", invoice)
	}

	shareInput := json.RawMessage(`{"invoiceNumber":1,"revoke":false}`)
	shared, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, shareInvoiceCapabilityID, "accounting.write", shareInput, "human", "", "wave3-inv-share"), shareInvoiceCapabilityID, shareInput)
	if err != nil || !shared.OK {
		t.Fatalf("shareInvoice result=%+v err=%v", shared, err)
	}
	var share ShareInvoiceOutput
	if err := json.Unmarshal(shared.Data, &share); err != nil {
		t.Fatal(err)
	}
	if share.Token == nil || *share.Token == "" || share.URLPath == nil || !strings.HasPrefix(*share.URLPath, "/portal/") {
		t.Fatalf("shareInvoice output=%+v, want token and share url path", share)
	}
	replay, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, shareInvoiceCapabilityID, "accounting.write", shareInput, "human", "", "wave3-inv-share"), shareInvoiceCapabilityID, shareInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("shareInvoice replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	creditDeniedInput := json.RawMessage(`{"invoiceId":"` + invoice.InvoiceID + `","amountMinor":25000,"reason":"Damaged goods"}`)
	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, creditNoteCapabilityID, "crm.write", creditDeniedInput, "human", "", "wave3-credit-denied"), creditNoteCapabilityID, creditDeniedInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.post") {
		t.Fatalf("creditNote denied result=%+v err=%v, want permission failure", denied, err)
	}

	fx.addAgentSession()
	fx.addPolicy(creditNoteCapabilityID, "read", nil)
	creditInput := json.RawMessage(`{"invoiceId":"` + invoice.InvoiceID + `","amountMinor":25000,"reason":"Damaged goods"}`)
	approved := approveModuleWrite(t, fx, creditNoteCapabilityID, "accounting.post", creditInput)
	var credit CreditNoteOutput
	if err := json.Unmarshal(approved.Data, &credit); err != nil {
		t.Fatal(err)
	}
	if !isUUID(credit.EntryID) || credit.CreditedMinor != 25000 || credit.InvoiceBalanceMinor != 125000 {
		t.Fatalf("creditNote output=%+v, want 25000 credited against 125000 remaining", credit)
	}

	var standaloneEntryID string
	if _, err := dbx.WithOrgTx(fx.ctx, fx.owner, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		id, err := postJournalEntry(fx.ctx, tx, PostJournalEntryInput{
			OrgID:      fx.orgID,
			Memo:       "Wave3 manual adjustment",
			SourceType: "manual_adjustment",
			Currency:   invoice.Currency,
			PostedAt:   time.Now().UTC(),
			ActorType:  "human",
			Lines: []JournalEntryLineInput{
				{AccountCode: "1100", DebitMinor: 10000},
				{AccountCode: "4000", CreditMinor: 10000},
			},
		})
		standaloneEntryID = id
		return struct{}{}, err
	}); err != nil {
		t.Fatal(err)
	}

	reverseInput := json.RawMessage(`{"entryId":"` + standaloneEntryID + `"}`)
	reversed := approveModuleWrite(t, fx, reverseEntryCapabilityID, "accounting.post", reverseInput)
	var reversal ReverseEntryOutput
	if err := json.Unmarshal(reversed.Data, &reversal); err != nil {
		t.Fatal(err)
	}
	if !isUUID(reversal.ReversalEntryID) {
		t.Fatalf("reverseEntry output=%+v, want a reversal entry id", reversal)
	}
	if got := fx.count(`SELECT count(*) FROM journal_entries WHERE org_id=$1::uuid AND reversal_of_id=$2::uuid`, fx.orgID, standaloneEntryID); got != 1 {
		t.Fatalf("reversal entries=%d, want one against the manual entry", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, creditNoteCapabilityID); got != 1 {
		t.Fatalf("creditNote audit events=%d, want one", got)
	}
}

func TestGoWave3BankingGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin wave3 banking cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		for _, stmt := range []string{
			`DELETE FROM bank_transactions WHERE org_id=$1::uuid`,
			`DELETE FROM bank_accounts WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("wave3 banking cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit wave3 banking cleanup: %v", err)
		}
	})
	grantWavePermission(t, fx, "accounting.write")
	grantWavePermission(t, fx, "accounting.read")

	accountInput := json.RawMessage(`{"name":"Ops Account","balanceMinor":500000}`)
	claims := waveModuleClaims(fx, addBankAccountCapabilityID, "accounting.write", accountInput, "human", "", "wave3-bank-open")
	first, err := fx.executor.Execute(fx.ctx, claims, addBankAccountCapabilityID, accountInput)
	if err != nil || !first.OK {
		t.Fatalf("addBankAccount result=%+v err=%v", first, err)
	}
	var account AddBankAccountOutput
	if err := json.Unmarshal(first.Data, &account); err != nil {
		t.Fatal(err)
	}
	if !isUUID(account.BankAccountID) {
		t.Fatalf("addBankAccount output=%+v, want UUID bankAccountId", account)
	}
	replay, err := fx.executor.Execute(fx.ctx, claims, addBankAccountCapabilityID, accountInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("addBankAccount replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	feedInput := json.RawMessage(`{"bankAccountId":"` + account.BankAccountID + `","rows":[` +
		`{"postedAt":"2026-09-20","amountMinor":-45000,"description":"Utility bill"},` +
		`{"postedAt":"2026-09-21","amountMinor":-12000,"description":"Courier"}]}`)
	fed, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, importBankFeedCapabilityID, "accounting.write", feedInput, "human", "", "wave3-bank-feed"), importBankFeedCapabilityID, feedInput)
	if err != nil || !fed.OK {
		t.Fatalf("importBankFeed result=%+v err=%v", fed, err)
	}
	var feed ImportBankFeedOutput
	if err := json.Unmarshal(fed.Data, &feed); err != nil || feed.Inserted != 2 {
		t.Fatalf("importBankFeed output=%+v err=%v, want two inserted rows", feed, err)
	}

	var excludedID, deleteID string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM bank_transactions WHERE org_id=$1::uuid AND description='Utility bill'`, fx.orgID).Scan(&excludedID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT id::text FROM bank_transactions WHERE org_id=$1::uuid AND description='Courier'`, fx.orgID).Scan(&deleteID); err != nil {
		t.Fatal(err)
	}
	excludeInput := json.RawMessage(`{"transactionId":"` + excludedID + `"}`)
	excluded, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, excludeBankTransactionCapabilityID, "accounting.write", excludeInput, "human", "", "wave3-bank-exclude"), excludeBankTransactionCapabilityID, excludeInput)
	if err != nil || !excluded.OK {
		t.Fatalf("excludeBankTransaction result=%+v err=%v", excluded, err)
	}
	unexcluded, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, unexcludeBankTransactionCapabilityID, "accounting.write", excludeInput, "human", "", "wave3-bank-unexclude"), unexcludeBankTransactionCapabilityID, excludeInput)
	if err != nil || !unexcluded.OK {
		t.Fatalf("unexcludeBankTransaction result=%+v err=%v", unexcluded, err)
	}
	deleted, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, deleteBankTransactionCapabilityID, "accounting.write", json.RawMessage(`{"transactionId":"`+deleteID+`"}`), "human", "", "wave3-bank-delete"), deleteBankTransactionCapabilityID, json.RawMessage(`{"transactionId":"`+deleteID+`"}`))
	if err != nil || !deleted.OK {
		t.Fatalf("deleteBankTransaction result=%+v err=%v", deleted, err)
	}
	if got := fx.count(`SELECT count(*) FROM bank_transactions WHERE org_id=$1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("bank transactions=%d, want one after delete", got)
	}

	summary, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, bankSummaryCapabilityID, "accounting.read", json.RawMessage(`{}`), "human", "", "wave3-bank-summary"), bankSummaryCapabilityID, json.RawMessage(`{}`))
	if err != nil || !summary.OK {
		t.Fatalf("bankSummary result=%+v err=%v", summary, err)
	}
	var summaryOut BankSummaryOutput
	if err := json.Unmarshal(summary.Data, &summaryOut); err != nil {
		t.Fatal(err)
	}
	if len(summaryOut.Accounts) != 1 || summaryOut.Accounts[0].Name != "Ops Account" {
		t.Fatalf("bankSummary output=%+v, want one Ops Account row", summaryOut)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, addBankAccountCapabilityID, "crm.write", accountInput, "human", "", "wave3-bank-denied"), addBankAccountCapabilityID, accountInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.write") {
		t.Fatalf("addBankAccount denied result=%+v err=%v, want permission failure", denied, err)
	}
}

func TestGoWave3PurchasingRequestsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin wave3 purchasing cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		for _, stmt := range []string{
			`DELETE FROM purchase_orders WHERE org_id=$1::uuid`,
			`DELETE FROM rfqs WHERE org_id=$1::uuid`,
			`DELETE FROM purchase_requests WHERE org_id=$1::uuid`,
			`DELETE FROM doc_counters WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("wave3 purchasing cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit wave3 purchasing cleanup: %v", err)
		}
	})
	grantWavePermission(t, fx, "purchasing.write")
	vendorID := seedPurchasingVendor(t, fx, fx.orgID, nil)

	requestInput := json.RawMessage(`{"title":"Forklift battery","justification":"Current cell failed load test","estimatedAmountMinor":800000}`)
	requestClaims := waveModuleClaims(fx, createPurchaseRequestCapabilityID, "purchasing.write", requestInput, "human", "", "wave3-pr-create")
	requested, err := fx.executor.Execute(fx.ctx, requestClaims, createPurchaseRequestCapabilityID, requestInput)
	if err != nil || !requested.OK {
		t.Fatalf("createPurchaseRequest result=%+v err=%v", requested, err)
	}
	var request CreatePurchaseRequestOutput
	if err := json.Unmarshal(requested.Data, &request); err != nil {
		t.Fatal(err)
	}
	if !isUUID(request.RequestID) {
		t.Fatalf("createPurchaseRequest output=%+v, want UUID requestId", request)
	}
	replay, err := fx.executor.Execute(fx.ctx, requestClaims, createPurchaseRequestCapabilityID, requestInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createPurchaseRequest replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	decideInput := json.RawMessage(`{"requestId":"` + request.RequestID + `","decision":"approve","reason":"Budget line open"}`)
	decided, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, decidePurchaseRequestCapabilityID, "purchasing.write", decideInput, "human", "", "wave3-pr-decide"), decidePurchaseRequestCapabilityID, decideInput)
	if err != nil || !decided.OK {
		t.Fatalf("decidePurchaseRequest result=%+v err=%v", decided, err)
	}

	rfqInput := json.RawMessage(`{"requestId":"` + request.RequestID + `","vendorIds":["` + vendorID + `"]}`)
	rfq, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, createRfqCapabilityID, "purchasing.write", rfqInput, "human", "", "wave3-rfq-create"), createRfqCapabilityID, rfqInput)
	if err != nil || !rfq.OK {
		t.Fatalf("createRfq result=%+v err=%v", rfq, err)
	}
	var rfqOut CreateRfqOutput
	if err := json.Unmarshal(rfq.Data, &rfqOut); err != nil {
		t.Fatal(err)
	}
	if len(rfqOut.RFQIDs) != 1 || !isUUID(rfqOut.RFQIDs[0]) {
		t.Fatalf("createRfq output=%+v, want one RFQ row for the vendor", rfqOut)
	}

	quoteInput := json.RawMessage(`{"rfqId":"` + rfqOut.RFQIDs[0] + `","amountMinor":750000,"leadTimeDays":14}`)
	quoted, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, recordQuoteCapabilityID, "purchasing.write", quoteInput, "human", "", "wave3-quote-record"), recordQuoteCapabilityID, quoteInput)
	if err != nil || !quoted.OK {
		t.Fatalf("recordQuote result=%+v err=%v", quoted, err)
	}
	awardInput := json.RawMessage(`{"rfqId":"` + rfqOut.RFQIDs[0] + `"}`)
	awarded, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, selectWinningQuoteCapabilityID, "purchasing.write", awardInput, "human", "", "wave3-quote-award"), selectWinningQuoteCapabilityID, awardInput)
	if err != nil || !awarded.OK {
		t.Fatalf("selectWinningQuote result=%+v err=%v", awarded, err)
	}
	var award SelectWinningQuoteOutput
	if err := json.Unmarshal(awarded.Data, &award); err != nil {
		t.Fatal(err)
	}
	if award.PONumber != 1 || award.VendorID != vendorID || award.QuoteAmountMinor != 750000 {
		t.Fatalf("selectWinningQuote output=%+v, want purchase order one at 750000 minor", award)
	}
	if got := fx.count(`SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid AND vendor_id=$2::uuid`, fx.orgID, vendorID); got != 1 {
		t.Fatalf("purchase orders=%d, want one raised by the award", got)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, createRfqCapabilityID, "crm.write", rfqInput, "human", "", "wave3-rfq-denied"), createRfqCapabilityID, rfqInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: purchasing.write") {
		t.Fatalf("createRfq denied result=%+v err=%v, want permission failure", denied, err)
	}
}

func TestGoWave3InventoryItemsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin wave3 inventory cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		for _, stmt := range []string{
			`DELETE FROM items WHERE org_id=$1::uuid`,
			`DELETE FROM stock_locations WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("wave3 inventory cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit wave3 inventory cleanup: %v", err)
		}
	})
	grantWavePermission(t, fx, "inventory.write")
	grantWavePermission(t, fx, "inventory.read")

	itemInput := json.RawMessage(`{"sku":"SKU-W1","name":"Widget","kind":"goods","unitLabel":"pc","salePriceMinor":5000,"reorderPointThousandths":10000,"tags":["core"],"barcode":"BC-W1"}`)
	itemClaims := waveModuleClaims(fx, inventoryCreateItemCapabilityID, "inventory.write", itemInput, "human", "", "wave3-item-create")
	created, err := fx.executor.Execute(fx.ctx, itemClaims, inventoryCreateItemCapabilityID, itemInput)
	if err != nil || !created.OK {
		t.Fatalf("createItem result=%+v err=%v", created, err)
	}
	var item InventoryCreateItemOutput
	if err := json.Unmarshal(created.Data, &item); err != nil {
		t.Fatal(err)
	}
	if !isUUID(item.ItemID) {
		t.Fatalf("createItem output=%+v, want UUID itemId", item)
	}
	replay, err := fx.executor.Execute(fx.ctx, itemClaims, inventoryCreateItemCapabilityID, itemInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createItem replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	patchInput := json.RawMessage(`{"sku":"SKU-W1","name":"Widget Pro"}`)
	patched, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryUpdateItemCapabilityID, "inventory.write", patchInput, "human", "", "wave3-item-update"), inventoryUpdateItemCapabilityID, patchInput)
	if err != nil || !patched.OK {
		t.Fatalf("updateItem result=%+v err=%v", patched, err)
	}
	if got := fx.count(`SELECT count(*) FROM items WHERE org_id=$1::uuid AND sku='SKU-W1' AND name='Widget Pro'`, fx.orgID); got != 1 {
		t.Fatalf("patched items=%d, want one renamed row", got)
	}

	lookup, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryLookupByBarcodeCapabilityID, "inventory.read", json.RawMessage(`{"barcode":"BC-W1"}`), "human", "", "wave3-item-lookup"), inventoryLookupByBarcodeCapabilityID, json.RawMessage(`{"barcode":"BC-W1"}`))
	if err != nil || !lookup.OK {
		t.Fatalf("lookupByBarcode result=%+v err=%v", lookup, err)
	}
	var found InventoryLookupByBarcodeOutput
	if err := json.Unmarshal(lookup.Data, &found); err != nil {
		t.Fatal(err)
	}
	if found.Item == nil || found.Item.SKU != "SKU-W1" {
		t.Fatalf("lookupByBarcode output=%+v, want the Widget item", found)
	}

	archiveInput := json.RawMessage(`{"sku":"SKU-W1","archive":true}`)
	archived, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryArchiveItemCapabilityID, "inventory.write", archiveInput, "human", "", "wave3-item-archive"), inventoryArchiveItemCapabilityID, archiveInput)
	if err != nil || !archived.OK {
		t.Fatalf("archiveItem result=%+v err=%v", archived, err)
	}
	if got := fx.count(`SELECT count(*) FROM items WHERE org_id=$1::uuid AND sku='SKU-W1' AND archived_at IS NOT NULL`, fx.orgID); got != 1 {
		t.Fatalf("archived items=%d, want one", got)
	}

	locationInput := json.RawMessage(`{"code":"MAIN","name":"Main Store"}`)
	location, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryCreateLocationCapabilityID, "inventory.write", locationInput, "human", "", "wave3-location-create"), inventoryCreateLocationCapabilityID, locationInput)
	if err != nil || !location.OK {
		t.Fatalf("createLocation result=%+v err=%v", location, err)
	}
	listing, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryListLocationsCapabilityID, "inventory.read", json.RawMessage(`{}`), "human", "", "wave3-location-list"), inventoryListLocationsCapabilityID, json.RawMessage(`{}`))
	if err != nil || !listing.OK {
		t.Fatalf("listLocations result=%+v err=%v", listing, err)
	}
	var locations InventoryListLocationsOutput
	if err := json.Unmarshal(listing.Data, &locations); err != nil {
		t.Fatal(err)
	}
	if len(locations.Locations) != 1 || locations.Locations[0].Code != "MAIN" {
		t.Fatalf("listLocations output=%+v, want one MAIN row", locations)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, inventoryCreateItemCapabilityID, "sales.write", itemInput, "human", "", "wave3-item-denied"), inventoryCreateItemCapabilityID, itemInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: inventory.write") {
		t.Fatalf("createItem denied result=%+v err=%v, want permission failure", denied, err)
	}
}
