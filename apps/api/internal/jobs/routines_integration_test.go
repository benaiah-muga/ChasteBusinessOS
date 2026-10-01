package jobs

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRoutineJobRunsGovernedAgentAndFinalizesOccurrence(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the Go routine agent database proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := envOr("CHASTE_APP_DB_PASSWORD", "chaste_app_dev_only")
	workerPassword := envOr("CHASTE_JOBS_WORKER_DB_PASSWORD", "chaste_jobs_worker_dev_only")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	appPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_app", appPassword))
	if err != nil {
		t.Fatal(err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", workerPassword))
	if err != nil {
		t.Fatal(err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, appPool); err != nil {
		t.Fatal(err)
	}
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatal(err)
	}
	tag := fmt.Sprintf("go-routine-agent-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	defer cleanupJobsTestOrgs(t, owner, orgID)
	otherOrgID := insertJobsTestOrg(t, ctx, owner, tag+"-other")
	defer cleanupJobsTestOrgs(t, owner, otherOrgID)
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		tx, err := owner.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("begin routine accounting fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		if _, err := tx.Exec(cleanupCtx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable routine accounting fixture cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id = ANY($1::uuid[]))`, []string{orgID, otherOrgID}); err != nil {
			t.Errorf("delete routine accounting fixture lines: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM journal_entries WHERE org_id = ANY($1::uuid[])`, []string{orgID, otherOrgID}); err != nil {
			t.Errorf("delete routine accounting fixture entries: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM accounts WHERE org_id = ANY($1::uuid[])`, []string{orgID, otherOrgID}); err != nil {
			t.Errorf("delete routine accounting fixture accounts: %v", err)
			return
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit routine accounting fixture cleanup: %v", err)
		}
	}()
	var localHistoryItemID, foreignHistoryItemID string
	if err := owner.QueryRow(ctx, `INSERT INTO items (org_id, sku, name, kind) VALUES ($1::uuid, 'ROUTINE-HISTORY', 'Local routine history item', 'goods') RETURNING id::text`, orgID).Scan(&localHistoryItemID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO items (org_id, sku, name, kind) VALUES ($1::uuid, 'ROUTINE-HISTORY', 'Foreign routine history item', 'goods') RETURNING id::text`, otherOrgID).Scan(&foreignHistoryItemID); err != nil {
		t.Fatal(err)
	}
	localHistoryAt := time.Date(2026, 9, 30, 9, 1, 2, 345000000, time.UTC)
	if _, err := owner.Exec(ctx, `INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, actor_type, created_at) VALUES ($1::uuid, $2::uuid, 5000, 'adjustment', 'Routine local stock count', 'human', $3)`, orgID, localHistoryItemID, localHistoryAt); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, note, actor_type, created_at) VALUES ($1::uuid, $2::uuid, 99000, 'adjustment', 'Foreign tenant sentinel', 'human', $3)`, otherOrgID, foreignHistoryItemID, localHistoryAt.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	for _, account := range []struct {
		orgID, code, name, kind string
	}{
		{orgID, "RT1000", "Routine cash", "asset"},
		{orgID, "RT4000", "Routine sales", "income"},
		{otherOrgID, "RT1000", "Foreign routine cash", "asset"},
		{otherOrgID, "RT4000", "Foreign routine sales", "income"},
	} {
		if _, err := owner.Exec(ctx, `INSERT INTO accounts (org_id, code, name, type) VALUES ($1::uuid, $2, $3, $4)`, account.orgID, account.code, account.name, account.kind); err != nil {
			t.Fatal(err)
		}
	}
	seedRoutineJournalEntry := func(entryOrgID, currency string) {
		t.Helper()
		tx, err := owner.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var entryID string
		if err := tx.QueryRow(ctx, `INSERT INTO journal_entries (org_id, memo, currency, entry_kind, posted_at, posted_by_actor_type) VALUES ($1::uuid, 'routine trial balance proof', $2, 'operational', $3, 'system') RETURNING id::text`, entryOrgID, currency, localHistoryAt).Scan(&entryID); err != nil {
			t.Fatal(err)
		}
		for _, line := range []struct {
			code          string
			debit, credit int64
		}{{"RT1000", 50000, 0}, {"RT4000", 0, 50000}} {
			if _, err := tx.Exec(ctx, `INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor) SELECT $1::uuid, id, $2, $3 FROM accounts WHERE org_id = $4::uuid AND code = $5`, entryID, line.debit, line.credit, entryOrgID, line.code); err != nil {
				t.Fatal(err)
			}
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var baseCurrency string
	if err := owner.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&baseCurrency); err != nil {
		t.Fatal(err)
	}
	seedRoutineJournalEntry(orgID, baseCurrency)
	seedRoutineJournalEntry(otherOrgID, "CAD")
	updatedAt := time.Date(2026, 9, 30, 10, 11, 12, 345000000, time.UTC)
	seedDocument := func(documentOrgID, title string) string {
		t.Helper()
		var id string
		if err := owner.QueryRow(ctx, `
			INSERT INTO authored_docs (org_id, title, content_json, html, status, created_by_actor_type, updated_at, folder,
			                          document_type, linked_record_type, linked_record_label)
			VALUES ($1::uuid, $2, '{}'::jsonb, '', 'draft', 'human', $3, 'Finance', 'invoice', 'customer', 'Acme')
			RETURNING id::text`, documentOrgID, title, updatedAt).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	localDocumentID := seedDocument(orgID, "Routine local proof")
	foreignDocumentID := seedDocument(otherOrgID, "Routine foreign proof")
	firstVersionAt := time.Date(2026, 9, 30, 10, 11, 12, 345000000, time.UTC)
	secondVersionAt := time.Date(2026, 9, 30, 10, 12, 13, 456000000, time.UTC)
	if _, err := owner.Exec(ctx, `
		INSERT INTO authored_doc_versions (org_id, document_id, version, content_json, html, note, created_by_actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, 1, '{"title":"Routine original version","sequence":1}'::jsonb, '<p>Original version</p>', NULL, 'human', $3),
		       ($1::uuid, $2::uuid, 2, '{"title":"Routine proof second version","sequence":2}'::jsonb, '<p>Updated version</p>', 'Routine proof second version', 'agent', $4)`, orgID, localDocumentID, firstVersionAt, secondVersionAt); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO authored_doc_versions (org_id, document_id, version, content_json, html, note, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 1, '{"title":"Foreign version","sequence":1}'::jsonb, '<p>Foreign</p>', 'Foreign version', 'human')`, otherOrgID, foreignDocumentID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO stock_locations (org_id, code, name)
		VALUES ($1::uuid, 'MAIN', 'Main warehouse'), ($2::uuid, 'MAIN', 'Foreign warehouse'), ($1::uuid, 'RETAIL', 'Retail floor')`, orgID, otherOrgID); err != nil {
		t.Fatal(err)
	}
	var localQuoteCustomerID, foreignQuoteCustomerID, otherStatementCustomerID string
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Routine local quote customer') RETURNING id::text`, orgID).Scan(&localQuoteCustomerID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Routine foreign quote customer') RETURNING id::text`, otherOrgID).Scan(&foreignQuoteCustomerID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Routine other statement customer') RETURNING id::text`, orgID).Scan(&otherStatementCustomerID); err != nil {
		t.Fatal(err)
	}
	statementIssuedAt := time.Date(2026, 9, 29, 8, 7, 6, 123000000, time.UTC)
	for _, invoice := range []struct {
		orgID, customerID string
		number            int
		totalMinor        int64
	}{
		{orgID, localQuoteCustomerID, 91, 76000},
		{orgID, otherStatementCustomerID, 92, 234000},
		{otherOrgID, foreignQuoteCustomerID, 93, 987000},
	} {
		if _, err := owner.Exec(ctx, `
			INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, issued_at)
			VALUES ($1::uuid, $2::uuid, $3, 'sent', $4, $5, 0, $5, 0, 0, $6)`,
			invoice.orgID, invoice.customerID, invoice.number, baseCurrency, invoice.totalMinor, statementIssuedAt); err != nil {
			t.Fatal(err)
		}
	}
	quoteCreatedAt := time.Date(2026, 9, 30, 10, 11, 12, 345000000, time.UTC)
	quoteExpiresAt := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	var localQuoteID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO quotes (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, expires_at, created_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 81, 'sent', 12000, 1500, 13500, $3, $4, 'human')
		RETURNING id::text`, orgID, localQuoteCustomerID, quoteExpiresAt, quoteCreatedAt).Scan(&localQuoteID); err != nil {
		t.Fatal(err)
	}
	var localAcceptedQuoteID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO quotes (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, created_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 82, 'accepted', 20000, 0, 20000, $3, 'human')
		RETURNING id::text`, orgID, localQuoteCustomerID, quoteCreatedAt.Add(time.Hour)).Scan(&localAcceptedQuoteID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO quotes (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, created_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 81, 'sent', 99000, 0, 99000, $3, 'human')`, otherOrgID, foreignQuoteCustomerID, quoteCreatedAt.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var localVendorID, foreignVendorID string
	if err := owner.QueryRow(ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Routine local supplier') RETURNING id::text`, orgID).Scan(&localVendorID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Routine foreign supplier') RETURNING id::text`, otherOrgID).Scan(&foreignVendorID); err != nil {
		t.Fatal(err)
	}
	statementAt := time.Date(2026, 9, 30, 9, 10, 11, 123000000, time.UTC)
	var localBillID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor, bill_date, created_at)
		VALUES ($1::uuid, $2::uuid, 71, 'open', 'USD', 12345, $3, $3)
		RETURNING id::text`, orgID, localVendorID, statementAt).Scan(&localBillID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO vendor_bills (org_id, vendor_id, number, status, currency, total_minor, bill_date, created_at)
		VALUES ($1::uuid, $2::uuid, 71, 'open', 'USD', 98765, $3, $3)`, otherOrgID, foreignVendorID, statementAt); err != nil {
		t.Fatal(err)
	}
	secret := "routine-test-encryption-secret"
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", secret)
	serverCalls := atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			t.Errorf("provider request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer integration-provider-key" {
			t.Errorf("provider authorization was not applied")
		}
		call := serverCalls.Add(1)
		if call%2 == 1 {
			quoteFilterArgs := `{"status":"sent"}`
			statementArgs, err := json.Marshal(map[string]string{"vendorId": localVendorID})
			if err != nil {
				t.Errorf("encode supplier statement arguments: %v", err)
				return
			}
			customerStatementArgs, err := json.Marshal(map[string]string{"customerId": localQuoteCustomerID})
			if err != nil {
				t.Errorf("encode customer statement arguments: %v", err)
				return
			}
			timelineArgs, err := json.Marshal(map[string]any{"customerId": localQuoteCustomerID, "limit": 20})
			if err != nil {
				t.Errorf("encode CRM customer timeline arguments: %v", err)
				return
			}
			localVersionArgs, err := json.Marshal(map[string]string{"documentId": localDocumentID})
			if err != nil {
				t.Errorf("encode local document version arguments: %v", err)
				return
			}
			foreignVersionArgs, err := json.Marshal(map[string]string{"documentId": foreignDocumentID})
			if err != nil {
				t.Errorf("encode foreign document version arguments: %v", err)
				return
			}
			localVersionDetailArgs, err := json.Marshal(map[string]any{"documentId": localDocumentID, "version": 2})
			if err != nil {
				t.Errorf("encode local document version detail arguments: %v", err)
				return
			}
			localNullNoteVersionDetailArgs, err := json.Marshal(map[string]any{"documentId": localDocumentID, "version": 1})
			if err != nil {
				t.Errorf("encode local null-note document version detail arguments: %v", err)
				return
			}
			foreignVersionDetailArgs, err := json.Marshal(map[string]any{"documentId": foreignDocumentID, "version": 1})
			if err != nil {
				t.Errorf("encode foreign document version detail arguments: %v", err)
				return
			}
			providerResponse, err := json.Marshal(map[string]any{
				"choices": []any{map[string]any{"message": map[string]any{"content": nil, "tool_calls": []any{
					map[string]any{"id": "call-routine-1", "type": "function", "function": map[string]any{"name": "crm_listCustomers", "arguments": "{}"}},
					map[string]any{"id": "call-routine-tasks", "type": "function", "function": map[string]any{"name": "crm_listTasks", "arguments": `{"openOnly":true}`}},
					map[string]any{"id": "call-routine-crm-timeline", "type": "function", "function": map[string]any{"name": "crm_customerTimeline", "arguments": string(timelineArgs)}},
					map[string]any{"id": "call-routine-accounting-quotes", "type": "function", "function": map[string]any{"name": "accounting_listQuotes", "arguments": quoteFilterArgs}},
					map[string]any{"id": "call-routine-ar-aging", "type": "function", "function": map[string]any{"name": "accounting_arAging", "arguments": "{}"}},
					map[string]any{"id": "call-routine-income-statement", "type": "function", "function": map[string]any{"name": "accounting_incomeStatement", "arguments": "{}"}},
					map[string]any{"id": "call-routine-trial-balance", "type": "function", "function": map[string]any{"name": "accounting_trialBalance", "arguments": "{}"}},
					map[string]any{"id": "call-routine-balance-sheet", "type": "function", "function": map[string]any{"name": "accounting_balanceSheet", "arguments": "{}"}},
					map[string]any{"id": "call-routine-cash-flow", "type": "function", "function": map[string]any{"name": "accounting_cashFlow", "arguments": `{"cashAccountCodes":["RT1000"]}`}},
					map[string]any{"id": "call-routine-customer-statement", "type": "function", "function": map[string]any{"name": "accounting_customerStatement", "arguments": string(customerStatementArgs)}},
					map[string]any{"id": "call-routine-inventory-locations", "type": "function", "function": map[string]any{"name": "inventory_listLocations", "arguments": "{}"}},
					map[string]any{"id": "call-routine-inventory", "type": "function", "function": map[string]any{"name": "inventory_stockReport", "arguments": `{"belowReorderOnly":false}`}},
					map[string]any{"id": "call-routine-item-history", "type": "function", "function": map[string]any{"name": "inventory_itemHistory", "arguments": `{"sku":"ROUTINE-HISTORY","limit":10}`}},
					map[string]any{"id": "call-routine-supplier-statement", "type": "function", "function": map[string]any{"name": "purchasing_supplierStatement", "arguments": string(statementArgs)}},
					map[string]any{"id": "call-routine-documents", "type": "function", "function": map[string]any{"name": "documents_listDocs", "arguments": "{}"}},
					map[string]any{"id": "call-routine-document-versions", "type": "function", "function": map[string]any{"name": "documents_listDocVersions", "arguments": string(localVersionArgs)}},
					map[string]any{"id": "call-routine-foreign-document-versions", "type": "function", "function": map[string]any{"name": "documents_listDocVersions", "arguments": string(foreignVersionArgs)}},
					map[string]any{"id": "call-routine-document-version-detail", "type": "function", "function": map[string]any{"name": "documents_getDocVersion", "arguments": string(localVersionDetailArgs)}},
					map[string]any{"id": "call-routine-document-version-detail-null-note", "type": "function", "function": map[string]any{"name": "documents_getDocVersion", "arguments": string(localNullNoteVersionDetailArgs)}},
					map[string]any{"id": "call-routine-foreign-document-version-detail", "type": "function", "function": map[string]any{"name": "documents_getDocVersion", "arguments": string(foreignVersionDetailArgs)}},
				}}}},
				"usage": map[string]int{"prompt_tokens": 12, "completion_tokens": 3},
			})
			if err != nil {
				t.Errorf("encode routine tool-call response: %v", err)
				return
			}
			_, _ = w.Write(providerResponse)
			return
		}
		var request struct {
			Messages []struct {
				Role       string          `json:"role"`
				ToolCallID string          `json:"tool_call_id"`
				Content    json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode routine follow-up request: %v", err)
			return
		}
		foundDocumentResult := false
		foundLocationResult := false
		foundInventoryHistoryResult := false
		foundIncomeStatementResult := false
		foundTrialBalanceResult := false
		foundBalanceSheetResult := false
		foundCashFlowResult := false
		foundCustomerStatementResult := false
		foundQuoteResult := false
		foundARAgingResult := false
		foundSupplierStatementResult := false
		foundTimelineResult := false
		foundLocalVersionResult := false
		foundForeignVersionResult := false
		foundLocalVersionDetailResult := false
		foundLocalNullNoteVersionDetailResult := false
		foundForeignVersionDetailResult := false
		for _, message := range request.Messages {
			if message.Role != "tool" {
				continue
			}
			switch message.ToolCallID {
			case "call-routine-supplier-statement":
				foundSupplierStatementResult = true
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						ClosingBalanceMinor int64 `json:"closingBalanceMinor"`
						Rows                []struct {
							Date         string `json:"date"`
							Kind         string `json:"kind"`
							Ref          string `json:"ref"`
							AmountMinor  int64  `json:"amountMinor"`
							BalanceMinor int64  `json:"balanceMinor"`
						} `json:"rows"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode purchasing.supplierStatement tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || result.Data.ClosingBalanceMinor != 12345 || len(result.Data.Rows) != 1 {
					t.Errorf("purchasing.supplierStatement result = %+v, want one local bill and closing balance 12345", result)
					continue
				}
				row := result.Data.Rows[0]
				if row.Date != "2026-09-30T09:10:11.123Z" || row.Kind != "bill" || row.Ref != "Bill #71" || row.AmountMinor != 12345 || row.BalanceMinor != 12345 {
					t.Errorf("purchasing.supplierStatement row = %+v, want the seeded local bill", row)
				}
			case "call-routine-documents":
				foundDocumentResult = true
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						Documents []struct {
							ID        string  `json:"id"`
							Title     string  `json:"title"`
							Status    string  `json:"status"`
							Versions  int     `json:"versions"`
							Template  *string `json:"templateId"`
							Folder    *string `json:"folder"`
							DocType   *string `json:"documentType"`
							Linked    *string `json:"linkedRecordType"`
							Label     *string `json:"linkedRecordLabel"`
							UpdatedAt string  `json:"updatedAt"`
						} `json:"documents"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode documents.listDocs tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Documents) != 1 {
					t.Errorf("documents.listDocs result = %+v, want only this organization's document", result)
					continue
				}
				document := result.Data.Documents[0]
				if document.ID != localDocumentID || document.Title != "Routine local proof" || document.Status != "draft" ||
					document.Versions != 2 || document.Template != nil || document.Folder == nil || *document.Folder != "Finance" ||
					document.DocType == nil || *document.DocType != "invoice" || document.Linked == nil || *document.Linked != "customer" ||
					document.Label == nil || *document.Label != "Acme" || document.UpdatedAt != "2026-09-30T10:11:12.345Z" {
					t.Errorf("documents.listDocs document = %+v, want the seeded metadata and version count", document)
				}
			case "call-routine-accounting-quotes":
				foundQuoteResult = true
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						Quotes []struct {
							ID         string  `json:"id"`
							Number     int64   `json:"number"`
							Status     string  `json:"status"`
							TotalMinor int64   `json:"totalMinor"`
							CustomerID string  `json:"customerId"`
							CreatedAt  *string `json:"createdAt"`
							ExpiresAt  *string `json:"expiresAt"`
							InvoiceID  *string `json:"invoiceId"`
						} `json:"quotes"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode accounting.listQuotes tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Quotes) != 1 {
					t.Errorf("accounting.listQuotes result = %+v, want only this organization's matching sent quote", result)
					continue
				}
				quote := result.Data.Quotes[0]
				if quote.ID != localQuoteID || quote.Number != 81 || quote.Status != "sent" || quote.TotalMinor != 13500 || quote.CustomerID != localQuoteCustomerID ||
					quote.CreatedAt == nil || *quote.CreatedAt != "2026-09-30T10:11:12.345Z" || quote.ExpiresAt == nil || *quote.ExpiresAt != "2026-12-31T00:00:00.000Z" || quote.InvoiceID != nil {
					t.Errorf("accounting.listQuotes quote = %+v, want matching local quote and nullable invoice", quote)
				}
			case "call-routine-ar-aging":
				foundARAgingResult = true
				var result struct {
					OK   bool                     `json:"ok"`
					Data capability.ArAgingOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode accounting.arAging tool result %s: %v", message.Content, err)
					continue
				}
				buckets := result.Data.Buckets
				if !result.OK || buckets.TotalOutstanding != 310000 || buckets.Current+buckets.D30+buckets.D60+buckets.D90Plus != 310000 || len(result.Data.Invoices) != 2 {
					t.Errorf("accounting.arAging result = %+v, want only the two local outstanding invoices totaling 310000", result)
					continue
				}
				if result.Data.Invoices[0].Number != 91 || result.Data.Invoices[0].OutstandingMinor != 76000 ||
					result.Data.Invoices[1].Number != 92 || result.Data.Invoices[1].OutstandingMinor != 234000 {
					t.Errorf("accounting.arAging invoices = %+v, want local 91/92 without the foreign invoice", result.Data.Invoices)
				}
			case "call-routine-crm-timeline":
				foundTimelineResult = true
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						Entries []struct {
							Kind    string `json:"kind"`
							Date    string `json:"date"`
							RefID   string `json:"refId"`
							Summary string `json:"summary"`
						} `json:"entries"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode crm.customerTimeline tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Entries) != 3 {
					t.Errorf("crm.customerTimeline result = %+v, want this customer's invoice and two quote entries", result)
					continue
				}
				newestEntry, middleEntry, oldestEntry := result.Data.Entries[0], result.Data.Entries[1], result.Data.Entries[2]
				if newestEntry.Kind != "quote" || newestEntry.RefID != localAcceptedQuoteID || newestEntry.Summary != "Quote #82 (accepted, 200.00)" || newestEntry.Date != "2026-09-30T11:11:12.345Z" ||
					middleEntry.Kind != "quote" || middleEntry.RefID != localQuoteID || middleEntry.Summary != "Quote #81 (sent, 135.00)" || middleEntry.Date != "2026-09-30T10:11:12.345Z" ||
					oldestEntry.Kind != "invoice" || oldestEntry.Date != "2026-09-29T08:07:06.123Z" || oldestEntry.Summary != "Invoice #91 (sent, 760.00)" {
					t.Errorf("crm.customerTimeline entries = %+v, want this customer's invoice and quotes in reverse chronological order", result.Data.Entries)
				}
			case "call-routine-inventory-locations":
				foundLocationResult = true
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						Locations []struct {
							Code string `json:"code"`
							Name string `json:"name"`
						} `json:"locations"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode inventory.listLocations tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Locations) != 2 {
					t.Errorf("inventory.listLocations result = %+v, want only this organization's two locations", result)
					continue
				}
				locations := result.Data.Locations
				if locations[0].Code != "MAIN" || locations[0].Name != "Main warehouse" ||
					locations[1].Code != "RETAIL" || locations[1].Name != "Retail floor" {
					t.Errorf("inventory.listLocations result = %+v, want ordered local locations without the foreign same-code row", locations)
				}
			case "call-routine-item-history":
				foundInventoryHistoryResult = true
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						Movements []struct {
							QuantityDelta int64  `json:"quantityDelta"`
							Reason        string `json:"reason"`
							Note          string `json:"note"`
							ActorType     string `json:"actorType"`
							CreatedAt     string `json:"createdAt"`
						} `json:"movements"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode inventory.itemHistory tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Movements) != 1 {
					t.Errorf("inventory.itemHistory result = %+v, want only this organization's one movement", result)
					continue
				}
				movement := result.Data.Movements[0]
				if movement.QuantityDelta != 5000 || movement.Reason != "adjustment" || movement.Note != "Routine local stock count" ||
					movement.ActorType != "human" || movement.CreatedAt != "2026-09-30T09:01:02.345Z" {
					t.Errorf("inventory.itemHistory movement = %+v, want local stock count details without foreign sentinel", movement)
				}
			case "call-routine-trial-balance":
				foundTrialBalanceResult = true
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						Lines    []capability.TrialBalanceLine `json:"lines"`
						Balanced bool                          `json:"balanced"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode accounting.trialBalance tool result %s: %v", message.Content, err)
					continue
				}
				wantLines := []capability.TrialBalanceLine{
					{Code: "RT1000", Name: "Routine cash", Currency: baseCurrency, DebitMinor: 50000},
					{Code: "RT4000", Name: "Routine sales", Currency: baseCurrency, CreditMinor: 50000},
				}
				matchesExpectedLines := len(result.Data.Lines) == len(wantLines)
				if matchesExpectedLines {
					for index := range wantLines {
						if result.Data.Lines[index] != wantLines[index] {
							matchesExpectedLines = false
							break
						}
					}
				}
				if !result.OK || !result.Data.Balanced || !matchesExpectedLines {
					t.Errorf("accounting.trialBalance result = %+v, want balanced local base-currency totals without foreign CAD entries", result)
				}
			case "call-routine-income-statement":
				foundIncomeStatementResult = true
				var result struct {
					OK   bool                             `json:"ok"`
					Data capability.IncomeStatementOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode accounting.incomeStatement tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || result.Data.RevenueMinor != 50000 || result.Data.ExpenseMinor != 0 || result.Data.NetIncomeMinor != 50000 ||
					len(result.Data.Lines) != 1 || result.Data.Lines[0].Code != "RT4000" || result.Data.Lines[0].AmountMinor != 50000 {
					t.Errorf("accounting.incomeStatement result = %+v, want local 50000 revenue with no foreign entries", result)
				}
			case "call-routine-balance-sheet":
				foundBalanceSheetResult = true
				var result struct {
					OK   bool                          `json:"ok"`
					Data capability.BalanceSheetOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode accounting.balanceSheet tool result %s: %v", message.Content, err)
					continue
				}
				want := capability.BalanceSheetOutput{AssetsMinor: 50000, RetainedResultMinor: 50000, Balanced: true}
				if !result.OK || result.Data != want {
					t.Errorf("accounting.balanceSheet result = %+v, want local balanced base-currency totals without foreign CAD entries", result)
				}
			case "call-routine-cash-flow":
				foundCashFlowResult = true
				var result struct {
					OK   bool                      `json:"ok"`
					Data capability.CashFlowOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode accounting.cashFlow tool result %s: %v", message.Content, err)
					continue
				}
				wantOperating := capability.CashFlowCategoryTotal{InflowMinor: 50000, NetMinor: 50000, Entries: 1}
				if !result.OK || result.Data.OpeningMinor != 0 || result.Data.ClosingMinor != 50000 || result.Data.NetMinor != 50000 ||
					result.Data.CashBalanceMinor != 50000 || !result.Data.Ties || len(result.Data.UnsupportedCurrencies) != 0 || result.Data.Operating != wantOperating ||
					result.Data.Investing != (capability.CashFlowCategoryTotal{}) || result.Data.Financing != (capability.CashFlowCategoryTotal{}) {
					t.Errorf("accounting.cashFlow result = %+v, want the tenant's tied 50000 cash movement without the foreign CAD entry", result)
				}
			case "call-routine-customer-statement":
				foundCustomerStatementResult = true
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						Currencies []struct {
							Currency            string `json:"currency"`
							OpeningBalanceMinor int64  `json:"openingBalanceMinor"`
							ClosingBalanceMinor int64  `json:"closingBalanceMinor"`
							Rows                []struct {
								Date         string `json:"date"`
								Kind         string `json:"kind"`
								Ref          string `json:"ref"`
								AmountMinor  int64  `json:"amountMinor"`
								BalanceMinor int64  `json:"balanceMinor"`
							} `json:"rows"`
						} `json:"currencies"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode accounting.customerStatement tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Currencies) != 1 {
					t.Errorf("accounting.customerStatement result = %+v, want only the selected local customer's currency", result)
					continue
				}
				statement := result.Data.Currencies[0]
				if statement.Currency != baseCurrency || statement.OpeningBalanceMinor != 0 || statement.ClosingBalanceMinor != 76000 || len(statement.Rows) != 1 {
					t.Errorf("accounting.customerStatement currency = %+v, want one local 76000 invoice", statement)
					continue
				}
				row := statement.Rows[0]
				if row.Date != "2026-09-29T08:07:06.123Z" || row.Kind != "invoice" || row.Ref != "Invoice #91" || row.AmountMinor != 76000 || row.BalanceMinor != 76000 {
					t.Errorf("accounting.customerStatement row = %+v, want the selected customer's local invoice", row)
				}
			case "call-routine-document-versions", "call-routine-foreign-document-versions":
				var result struct {
					OK   bool `json:"ok"`
					Data struct {
						Versions []struct {
							Version   int     `json:"version"`
							Note      *string `json:"note"`
							CreatedBy *string `json:"createdBy"`
							CreatedAt string  `json:"createdAt"`
						} `json:"versions"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode documents.listDocVersions tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK {
					t.Errorf("documents.listDocVersions result = %+v, want a successful read", result)
					continue
				}
				if message.ToolCallID == "call-routine-document-versions" {
					foundLocalVersionResult = true
					versions := result.Data.Versions
					if len(versions) != 2 || versions[0].Version != 1 || versions[0].Note != nil || versions[0].CreatedBy != nil ||
						versions[0].CreatedAt != "2026-09-30T10:11:12.345Z" || versions[1].Version != 2 || versions[1].Note == nil ||
						*versions[1].Note != "Routine proof second version" || versions[1].CreatedBy == nil || *versions[1].CreatedBy != "workmate" ||
						versions[1].CreatedAt != "2026-09-30T10:12:13.456Z" {
						t.Errorf("documents.listDocVersions local result = %+v, want ordered nullable and agent-authored summaries", versions)
					}
				} else {
					foundForeignVersionResult = true
					if len(result.Data.Versions) != 0 {
						t.Errorf("documents.listDocVersions leaked foreign tenant data: %+v", result.Data.Versions)
					}
				}
			case "call-routine-document-version-detail", "call-routine-document-version-detail-null-note", "call-routine-foreign-document-version-detail":
				var result struct {
					OK    bool   `json:"ok"`
					Error string `json:"error"`
					Data  struct {
						Version   int             `json:"version"`
						Content   json.RawMessage `json:"content"`
						HTML      string          `json:"html"`
						Note      json.RawMessage `json:"note"`
						CreatedAt string          `json:"createdAt"`
					} `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode documents.getDocVersion tool result %s: %v", message.Content, err)
					continue
				}
				switch message.ToolCallID {
				case "call-routine-document-version-detail":
					foundLocalVersionDetailResult = true
					var note *string
					if len(result.Data.Note) == 0 || string(result.Data.Note) == "null" || json.Unmarshal(result.Data.Note, &note) != nil {
						t.Errorf("documents.getDocVersion non-null note = %s, want a string", result.Data.Note)
						continue
					}
					var content struct {
						Title    string `json:"title"`
						Sequence int    `json:"sequence"`
					}
					if err := json.Unmarshal(result.Data.Content, &content); err != nil {
						t.Errorf("decode documents.getDocVersion content %s: %v", result.Data.Content, err)
						continue
					}
					if !result.OK || result.Data.Version != 2 || content.Title != "Routine proof second version" || content.Sequence != 2 ||
						result.Data.HTML != "<p>Updated version</p>" || note == nil || *note != "Routine proof second version" ||
						result.Data.CreatedAt != "2026-09-30T10:12:13.456Z" {
						t.Errorf("documents.getDocVersion local result = %+v content=%+v, want version 2 content and exact metadata", result.Data, content)
					}
				case "call-routine-document-version-detail-null-note":
					foundLocalNullNoteVersionDetailResult = true
					var content struct {
						Title    string `json:"title"`
						Sequence int    `json:"sequence"`
					}
					if err := json.Unmarshal(result.Data.Content, &content); err != nil {
						t.Errorf("decode null-note documents.getDocVersion content %s: %v", result.Data.Content, err)
						continue
					}
					if !result.OK || result.Data.Version != 1 || content.Title != "Routine original version" || content.Sequence != 1 ||
						result.Data.HTML != "<p>Original version</p>" || string(result.Data.Note) != "null" ||
						result.Data.CreatedAt != "2026-09-30T10:11:12.345Z" {
						t.Errorf("documents.getDocVersion null-note local result = %+v content=%+v, want version 1 content and nullable note", result.Data, content)
					}
				default:
					foundForeignVersionDetailResult = true
					if result.OK || result.Error == "" || result.Data.Content != nil {
						t.Errorf("documents.getDocVersion exposed a foreign document version: %+v", result)
					}
				}
			}
		}
		if !foundDocumentResult {
			t.Errorf("follow-up provider request omitted the documents.listDocs tool result")
		}
		if !foundLocationResult {
			t.Errorf("follow-up provider request omitted the inventory.listLocations tool result")
		}
		if !foundInventoryHistoryResult {
			t.Errorf("follow-up provider request omitted the inventory.itemHistory tool result")
		}
		if !foundTrialBalanceResult {
			t.Errorf("follow-up provider request omitted the accounting.trialBalance tool result")
		}
		if !foundIncomeStatementResult {
			t.Errorf("follow-up provider request omitted the accounting.incomeStatement tool result")
		}
		if !foundBalanceSheetResult {
			t.Errorf("follow-up provider request omitted the accounting.balanceSheet tool result")
		}
		if !foundCashFlowResult {
			t.Errorf("follow-up provider request omitted the accounting.cashFlow tool result")
		}
		if !foundCustomerStatementResult {
			t.Errorf("follow-up provider request omitted the accounting.customerStatement tool result")
		}
		if !foundARAgingResult {
			t.Errorf("follow-up provider request omitted the accounting.arAging tool result")
		}
		if !foundQuoteResult {
			t.Errorf("follow-up provider request omitted the accounting.listQuotes tool result")
		}
		if !foundSupplierStatementResult {
			t.Errorf("follow-up provider request omitted the purchasing.supplierStatement tool result")
		}
		if !foundTimelineResult {
			t.Errorf("follow-up provider request omitted the crm.customerTimeline tool result")
		}
		if !foundLocalVersionResult || !foundForeignVersionResult {
			t.Errorf("follow-up provider request omitted document version tool results, local=%v foreign=%v", foundLocalVersionResult, foundForeignVersionResult)
		}
		if !foundLocalVersionDetailResult || !foundLocalNullNoteVersionDetailResult || !foundForeignVersionDetailResult {
			t.Errorf("follow-up provider request omitted document version detail tool results, local=%v null-note-local=%v foreign=%v", foundLocalVersionDetailResult, foundLocalNullNoteVersionDetailResult, foundForeignVersionDetailResult)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Routine reviewed customers, follow-up tasks, customer history, invoices, quotes, income statement, trial balance, balance sheet, warehouse locations, stock movements, and authored document version history."}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`))
	}))
	defer server.Close()
	settings, err := json.Marshal(map[string]any{"ai": map[string]any{"provider": "custom", "baseUrl": server.URL + "/v1", "models": map[string]string{"primary": "routine-test-model", "fast": "routine-test-model", "reasoning": "routine-test-model", "embeddings": "routine-test-model"}, "encryptedApiKey": encryptRoutineKey(t, secret, "integration-provider-key"), "keyHint": "••••key", "updatedAt": time.Now().UTC().Format(time.RFC3339)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `UPDATE organizations SET settings=$2::jsonb WHERE id=$1::uuid`, orgID, string(settings)); err != nil {
		t.Fatal(err)
	}
	var routineID, occurrenceID string
	if err := owner.QueryRow(ctx, `INSERT INTO routines(org_id,name,prompt,schedule,enabled,trigger_type) VALUES($1::uuid,'Test digest','Count customers', '{"kind":"daily","atTime":"08:00"}', true, 'schedule') RETURNING id::text`, orgID).Scan(&routineID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO routine_occurrences(org_id,routine_id,scheduled_at,status) VALUES($1::uuid,$2::uuid,clock_timestamp(),'queued') RETURNING id::text`, orgID, routineID).Scan(&occurrenceID); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(routinePayload{RoutineID: routineID, Trigger: "schedule", OccurrenceID: &occurrenceID})
	jobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, payload, 3, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC))
	executor := capability.NewExecutor(appPool, "", "", "")
	runner := newRoutineAgent(appPool, executor)
	runner.client = server.Client()
	worker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "go-routine-agent-integration", LeaseDuration: time.Second, RoutineRunner: runner, RoutineAgentRunner: true})
	if err != nil {
		t.Fatal(err)
	}
	worked, err := worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("routine worker worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, jobID, "done", 1)
	if got := serverCalls.Load(); got != 2 {
		t.Fatalf("provider calls=%d, want one tool turn and one final turn", got)
	}
	var status, lastError string
	if err := owner.QueryRow(ctx, `SELECT last_status,COALESCE(last_error,'') FROM routines WHERE id=$1::uuid AND org_id=$2::uuid`, routineID, orgID).Scan(&status, &lastError); err != nil {
		t.Fatal(err)
	}
	if status != "ok" || lastError != "" {
		t.Fatalf("routine outcome status=%q error=%q", status, lastError)
	}
	var occurrenceStatus string
	if err := owner.QueryRow(ctx, `SELECT status FROM routine_occurrences WHERE id=$1::uuid AND org_id=$2::uuid`, occurrenceID, orgID).Scan(&occurrenceStatus); err != nil {
		t.Fatal(err)
	}
	if occurrenceStatus != "done" {
		t.Fatalf("scheduled occurrence status=%q", occurrenceStatus)
	}
	var sessionID string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM agent_sessions WHERE org_id=$1::uuid AND title='Routine: Test digest' ORDER BY created_at DESC LIMIT 1`, orgID).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM session_events WHERE session_id=$1::uuid AND role IN ('user','assistant')`, sessionID); got != 2 {
		t.Fatalf("routine session events=%d, want user and assistant", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='crm.listCustomers' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked CRM system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='crm.listTasks' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked CRM task-list system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='crm.customerTimeline' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked CRM customer-timeline system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='inventory.listLocations' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked inventory location-list system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='accounting.listQuotes' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked accounting quote-list system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='purchasing.supplierStatement' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked purchasing supplier-statement system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='inventory.stockReport' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked inventory system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='documents.listDocs' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked document-list system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='documents.listDocVersions' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 2 {
		t.Fatalf("session-linked document-version system capability audit events=%d, want local and tenant-scoped empty reads", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='documents.getDocVersion' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 2 {
		t.Fatalf("session-linked document-version detail system capability audit events=%d, want both successful local reads", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND kind='routine.run' AND href='/sessions'`, orgID); got != 1 {
		t.Fatalf("routine finding notifications=%d", got)
	}
	var inputUsage, outputUsage int
	if err := owner.QueryRow(ctx, `SELECT (token_usage->>'input')::int,(token_usage->>'output')::int FROM agent_sessions WHERE id=$1::uuid`, sessionID).Scan(&inputUsage, &outputUsage); err != nil {
		t.Fatal(err)
	}
	if inputUsage != 22 || outputUsage != 8 {
		t.Fatalf("routine token usage in=%d out=%d", inputUsage, outputUsage)
	}
	manualPayload, _ := json.Marshal(routinePayload{RoutineID: routineID, Trigger: "manual"})
	manualJobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, manualPayload, 3, time.Date(1901, 1, 1, 0, 0, 0, 0, time.UTC))
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("manual routine worker worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, manualJobID, "done", 1)
	if got := serverCalls.Load(); got != 4 {
		t.Fatalf("provider calls after manual run=%d, want two tool turns and two final turns", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND kind='routine.run' AND href='/sessions'`, orgID); got != 2 {
		t.Fatalf("scheduled plus manual notifications=%d, want two", got)
	}
	var disabledRoutineID, disabledOccurrenceID string
	if err := owner.QueryRow(ctx, `INSERT INTO routines(org_id,name,prompt,schedule,enabled,trigger_type) VALUES($1::uuid,'Disabled digest','Do not run','{"kind":"daily","atTime":"08:00"}',false,'schedule') RETURNING id::text`, orgID).Scan(&disabledRoutineID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO routine_occurrences(org_id,routine_id,scheduled_at,status) VALUES($1::uuid,$2::uuid,clock_timestamp(),'queued') RETURNING id::text`, orgID, disabledRoutineID).Scan(&disabledOccurrenceID); err != nil {
		t.Fatal(err)
	}
	disabledPayload, _ := json.Marshal(routinePayload{RoutineID: disabledRoutineID, Trigger: "schedule", OccurrenceID: &disabledOccurrenceID})
	disabledJobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, disabledPayload, 3, time.Date(1902, 1, 1, 0, 0, 0, 0, time.UTC))
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("disabled schedule worker worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, disabledJobID, "done", 1)
	var disabledRoutineStatus, disabledOccurrenceStatus string
	if err := owner.QueryRow(ctx, `SELECT last_status FROM routines WHERE id=$1::uuid`, disabledRoutineID).Scan(&disabledRoutineStatus); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM routine_occurrences WHERE id=$1::uuid`, disabledOccurrenceID).Scan(&disabledOccurrenceStatus); err != nil {
		t.Fatal(err)
	}
	if disabledRoutineStatus != "cancelled" || disabledOccurrenceStatus != "cancelled" {
		t.Fatalf("disabled scheduled routine outcome status=%q occurrence=%q", disabledRoutineStatus, disabledOccurrenceStatus)
	}
	if got := serverCalls.Load(); got != 4 {
		t.Fatalf("disabled routine called provider, count=%d", got)
	}
}

func encryptRoutineKey(t *testing.T, secret, plain string) string {
	t.Helper()
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	tag := sealed[len(sealed)-gcm.Overhead():]
	ciphertext := sealed[:len(sealed)-gcm.Overhead()]
	return "v1:" + base64.RawURLEncoding.EncodeToString(iv) + ":" + base64.RawURLEncoding.EncodeToString(tag) + ":" + base64.RawURLEncoding.EncodeToString(ciphertext)
}
