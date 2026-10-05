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
	var localEmployeeID, foreignEmployeeID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO employees (org_id, name, title, monthly_salary_minor, annual_leave_days, tax_rate_bps, hired_at)
		VALUES ($1::uuid, 'Routine local employee', 'Accountant', 500000, 21, 1000, $2)
		RETURNING id::text`, orgID, localHistoryAt).Scan(&localEmployeeID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `
		INSERT INTO employees (org_id, name, monthly_salary_minor, annual_leave_days, hired_at)
		VALUES ($1::uuid, 'Routine foreign employee', 900000, 30, $2)
		RETURNING id::text`, otherOrgID, localHistoryAt).Scan(&foreignEmployeeID); err != nil {
		t.Fatal(err)
	}
	leaveYearStart := time.Date(time.Now().UTC().Year(), time.January, 1, 0, 0, 0, 0, time.UTC)
	if _, err := owner.Exec(ctx, `
		INSERT INTO leave_requests (org_id, employee_id, kind, start_date, end_date, calendar_days, status, requested_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'annual', $5, $6, 3, 'approved', 'human'),
		       ($3::uuid, $4::uuid, 'annual', $5, $6, 3, 'approved', 'human'),
		       ($1::uuid, $2::uuid, 'sick', $5, $5, 1, 'approved', 'human')`,
		orgID, localEmployeeID, otherOrgID, foreignEmployeeID, leaveYearStart, leaveYearStart.AddDate(0, 0, 2)); err != nil {
		t.Fatal(err)
	}
	var localLotItemID, foreignLotItemID string
	if err := owner.QueryRow(ctx, `INSERT INTO items (org_id, sku, name, kind) VALUES ($1::uuid, 'ROUTINE-LOT', 'Local routine lot item', 'goods') RETURNING id::text`, orgID).Scan(&localLotItemID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO items (org_id, sku, name, kind) VALUES ($1::uuid, 'ROUTINE-LOT', 'Foreign routine lot item', 'goods') RETURNING id::text`, otherOrgID).Scan(&foreignLotItemID); err != nil {
		t.Fatal(err)
	}
	var localLotID, foreignLotID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO lots (org_id, item_id, lot_code, expires_at, created_at)
		VALUES ($1::uuid, $2::uuid, 'LOT-LOCAL', '2027-01-31T00:00:00Z', $3)
		RETURNING id::text`, orgID, localLotItemID, localHistoryAt).Scan(&localLotID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `
		INSERT INTO lots (org_id, item_id, lot_code, created_at)
		VALUES ($1::uuid, $2::uuid, 'LOT-FOREIGN', $3)
		RETURNING id::text`, otherOrgID, foreignLotItemID, localHistoryAt).Scan(&foreignLotID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO stock_movements (org_id, item_id, lot_id, quantity_delta, reason, actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 4000, 'adjustment', 'human', $4),
		       ($5::uuid, $6::uuid, $7::uuid, 99000, 'adjustment', 'human', $4)`,
		orgID, localLotItemID, localLotID, localHistoryAt, otherOrgID, foreignLotItemID, foreignLotID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO stock_reservations (org_id, item_id, quantity_thousandths, reason, ref_type, status, created_by_actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, 1200, 'Routine local hold', 'sales_order', 'open', 'human', $4),
		       ($1::uuid, $2::uuid, 800, 'Routine local released hold', 'sales_order', 'released', 'human', $4),
		       ($3::uuid, $5::uuid, 99000, 'Foreign tenant hold', 'sales_order', 'open', 'human', $4)`,
		orgID, localHistoryItemID, otherOrgID, localHistoryAt, foreignHistoryItemID); err != nil {
		t.Fatal(err)
	}
	var localScenarioID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO budget_scenarios (org_id, scenario_key, name, fiscal_year, version, currency, assumptions, is_current, created_by_actor_type, created_at)
		VALUES ($1::uuid, 'base', 'Routine local base plan', 2026, 2, $2, '{"growthBps":500}'::jsonb, true, 'human', $3)
		RETURNING id::text`, orgID, baseCurrency, localHistoryAt).Scan(&localScenarioID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO budget_scenarios (org_id, scenario_key, name, fiscal_year, version, currency, is_current, created_by_actor_type, created_at)
		VALUES ($1::uuid, 'base', 'Foreign tenant plan', 2026, 9, 'CAD', true, 'human', $2),
		       ($1::uuid, 'expansion', 'Routine local expansion plan', 2025, 1, $3, false, 'human', $2)`,
		otherOrgID, localHistoryAt, baseCurrency); err != nil {
		t.Fatal(err)
	}
	seedPurchaseOrder := func(poOrgID, vendorID string) {
		t.Helper()
		var poID string
		if err := owner.QueryRow(ctx, `
			INSERT INTO purchase_orders (org_id, vendor_id, number, status, ordered_at, created_at)
			VALUES ($1::uuid, $2::uuid, 55, 'ordered', $3, $3) RETURNING id::text`, poOrgID, vendorID, localHistoryAt).Scan(&poID); err != nil {
			t.Fatal(err)
		}
		var poLineID string
		if err := owner.QueryRow(ctx, `
			INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, position)
			VALUES ($1::uuid, 'Routine ordered widget', 10000, 250, 1) RETURNING id::text`, poID).Scan(&poLineID); err != nil {
			t.Fatal(err)
		}
		var receiptID string
		if err := owner.QueryRow(ctx, `
			INSERT INTO goods_receipts (org_id, po_id, number, received_at, received_by_actor_type, note)
			VALUES ($1::uuid, $2::uuid, 1, $3, 'human', 'Routine first delivery') RETURNING id::text`, poOrgID, poID, localHistoryAt).Scan(&receiptID); err != nil {
			t.Fatal(err)
		}
		accepted, rejected := int64(7000), int64(0)
		if poOrgID == otherOrgID {
			accepted, rejected = 99000, 500
		}
		if _, err := owner.Exec(ctx, `
			INSERT INTO goods_receipt_lines (org_id, receipt_id, po_line_id, position, accepted_thousandths, rejected_thousandths, rejection_note)
			VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4, $5, NULL)`, poOrgID, receiptID, poLineID, accepted, rejected); err != nil {
			t.Fatal(err)
		}
	}
	seedPurchaseOrder(orgID, localVendorID)
	seedPurchaseOrder(otherOrgID, foreignVendorID)
	var localViewUserID string
	// The users table is not organization-scoped, so a leftover row from an
	// interrupted run would collide; a per-run address keeps the fixture
	// re-runnable without deleting rows outside the test's organizations.
	if err := owner.QueryRow(ctx, `
		INSERT INTO users (email, name) VALUES ($1, 'Routine views owner') RETURNING id::text`, tag+"-views@example.com").Scan(&localViewUserID); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := owner.Exec(context.Background(), `DELETE FROM users WHERE id=$1::uuid`, localViewUserID); err != nil {
			t.Errorf("delete routine customer-view user fixture: %v", err)
		}
	}()
	seedCustomerView := func(viewOrgID, userID, name string, shared, pinned bool) {
		t.Helper()
		if _, err := owner.Exec(ctx, `
			INSERT INTO crm_customer_views (org_id, name, filters, is_shared, is_pinned, created_by_user_id, updated_by_user_id, updated_at)
			VALUES ($1::uuid, $2, '{"status":"active","owner":"me","staleOnly":true,"duplicateOnly":false,"tag":"vip"}'::jsonb, $3, $4, $5::uuid, $5::uuid, $6)`,
			viewOrgID, name, shared, pinned, userID, updatedAt); err != nil {
			t.Fatal(err)
		}
	}
	seedCustomerView(orgID, localViewUserID, "Routine shared view", true, false)
	seedCustomerView(orgID, localViewUserID, "Routine pinned shared view", true, true)
	seedCustomerView(orgID, localViewUserID, "Routine private view", false, false)
	seedCustomerView(otherOrgID, localViewUserID, "Foreign tenant view", true, true)
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
			leaveBalanceArgs, err := json.Marshal(map[string]string{"employeeId": localEmployeeID})
			if err != nil {
				t.Errorf("encode HR leave balance arguments: %v", err)
				return
			}
			foreignLeaveBalanceArgs, err := json.Marshal(map[string]string{"employeeId": foreignEmployeeID})
			if err != nil {
				t.Errorf("encode foreign HR leave balance arguments: %v", err)
				return
			}
			providerResponse, err := json.Marshal(map[string]any{
				"choices": []any{map[string]any{"message": map[string]any{"content": nil, "tool_calls": []any{
					map[string]any{"id": "call-routine-1", "type": "function", "function": map[string]any{"name": "crm_listCustomers", "arguments": "{}"}},
					map[string]any{"id": "call-routine-tasks", "type": "function", "function": map[string]any{"name": "crm_listTasks", "arguments": `{"openOnly":true}`}},
					map[string]any{"id": "call-routine-crm-timeline", "type": "function", "function": map[string]any{"name": "crm_customerTimeline", "arguments": string(timelineArgs)}},
					map[string]any{"id": "call-routine-customer-views", "type": "function", "function": map[string]any{"name": "crm_listCustomerViews", "arguments": "{}"}},
					map[string]any{"id": "call-routine-employees", "type": "function", "function": map[string]any{"name": "hr_listEmployees", "arguments": "{}"}},
					map[string]any{"id": "call-routine-leave-balance", "type": "function", "function": map[string]any{"name": "hr_leaveBalance", "arguments": string(leaveBalanceArgs)}},
					map[string]any{"id": "call-routine-foreign-leave-balance", "type": "function", "function": map[string]any{"name": "hr_leaveBalance", "arguments": string(foreignLeaveBalanceArgs)}},
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
					map[string]any{"id": "call-routine-ap-aging", "type": "function", "function": map[string]any{"name": "purchasing_apAging", "arguments": "{}"}},
					map[string]any{"id": "call-routine-receipts", "type": "function", "function": map[string]any{"name": "purchasing_listReceipts", "arguments": `{"poNumber":55}`}},
					map[string]any{"id": "call-routine-budget-scenarios", "type": "function", "function": map[string]any{"name": "accounting_listBudgetScenarios", "arguments": `{"fiscalYear":2026}`}},
					map[string]any{"id": "call-routine-lots", "type": "function", "function": map[string]any{"name": "inventory_listLots", "arguments": "{}"}},
					map[string]any{"id": "call-routine-reservations", "type": "function", "function": map[string]any{"name": "inventory_listReservations", "arguments": "{}"}},
					map[string]any{"id": "call-routine-list", "type": "function", "function": map[string]any{"name": "routines_list", "arguments": `{"limit":100}`}},
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
		foundAPAgingResult := false
		foundTimelineResult := false
		foundCustomerViewsResult := false
		foundEmployeesResult := false
		foundLeaveBalanceResult := false
		foundForeignLeaveBalanceResult := false
		foundReceiptsResult := false
		foundBudgetScenariosResult := false
		foundLotsResult := false
		foundReservationsResult := false
		foundRoutineListResult := false
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
			case "call-routine-ap-aging":
				foundAPAgingResult = true
				var result struct {
					OK   bool                     `json:"ok"`
					Data capability.APAgingOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode purchasing.apAging tool result %s: %v", message.Content, err)
					continue
				}
				buckets := result.Data.Buckets
				if !result.OK || buckets.Current != 12345 || buckets.D30 != 0 || buckets.D60 != 0 || buckets.D90Plus != 0 || buckets.TotalOutstanding != 12345 {
					t.Errorf("purchasing.apAging result = %+v, want only the local bill totaling 12345 in the current bucket", result)
				}
			case "call-routine-receipts":
				foundReceiptsResult = true
				var result struct {
					OK   bool                          `json:"ok"`
					Data capability.ListReceiptsOutput `json:"data"`
					Err  string                        `json:"error"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode purchasing.listReceipts tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.OrderLines) != 1 || len(result.Data.Receipts) != 1 {
					t.Errorf("purchasing.listReceipts result = %+v, want one local purchase order line and receipt", result)
					continue
				}
				orderLine := result.Data.OrderLines[0]
				if orderLine.Position != 1 || orderLine.Description != "Routine ordered widget" || orderLine.OrderedThousandths != 10000 ||
					orderLine.AcceptedThousandths != 7000 || orderLine.RejectedThousandths != 0 || orderLine.ReturnedThousandths != 0 || orderLine.RemainingThousandths != 3000 {
					t.Errorf("purchasing.listReceipts order line = %+v, want 7000 accepted of 10000 ordered and 3000 remaining", orderLine)
				}
				receipt := result.Data.Receipts[0]
				if receipt.Number != 1 || receipt.Note == nil || *receipt.Note != "Routine first delivery" || len(receipt.Lines) != 1 ||
					receipt.Lines[0].AcceptedThousandths != 7000 || receipt.Lines[0].Description != "Routine ordered widget" {
					t.Errorf("purchasing.listReceipts receipt = %+v, want the seeded local receipt and accepted line", receipt)
				}
			case "call-routine-budget-scenarios":
				foundBudgetScenariosResult = true
				var result struct {
					OK   bool                                 `json:"ok"`
					Data capability.ListBudgetScenariosOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode accounting.listBudgetScenarios tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Scenarios) != 1 {
					t.Errorf("accounting.listBudgetScenarios result = %+v, want only the local 2026 scenario", result)
					continue
				}
				scenario := result.Data.Scenarios[0]
				if scenario.ID != localScenarioID || scenario.Key != "base" || scenario.Name != "Routine local base plan" || scenario.FiscalYear != 2026 ||
					scenario.Version != 2 || scenario.Currency != baseCurrency || !scenario.IsCurrent || scenario.CreatedAt != "2026-09-30T09:01:02.345Z" {
					t.Errorf("accounting.listBudgetScenarios scenario = %+v, want the seeded local plan without foreign tenants", scenario)
				}
			case "call-routine-customer-views":
				foundCustomerViewsResult = true
				var result struct {
					OK   bool                               `json:"ok"`
					Data capability.ListCustomerViewsOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode crm.listCustomerViews tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Views) != 2 {
					t.Errorf("crm.listCustomerViews result = %+v, want only the two shared local views", result)
					continue
				}
				first, second := result.Data.Views[0], result.Data.Views[1]
				if !first.IsPinned || first.Name != "Routine pinned shared view" || second.IsPinned || second.Name != "Routine shared view" {
					t.Errorf("crm.listCustomerViews order = %+v, want the pinned shared view first and no private or foreign view", result.Data.Views)
				}
				if first.CreatedByUserID != localViewUserID || first.UpdatedAt != "2026-09-30T10:11:12.345Z" ||
					first.Filters.Status != "active" || first.Filters.Owner != "me" || !first.Filters.StaleOnly || first.Filters.DuplicateOnly || first.Filters.Tag != "vip" {
					t.Errorf("crm.listCustomerViews view = %+v, want the seeded owner, filter, and timestamp", first)
				}
			case "call-routine-employees":
				foundEmployeesResult = true
				var result struct {
					OK   bool                             `json:"ok"`
					Data capability.HRListEmployeesOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode hr.listEmployees tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Employees) != 1 {
					t.Errorf("hr.listEmployees result = %+v, want only this organization's employee", result)
					continue
				}
				employee := result.Data.Employees[0]
				if employee.ID != localEmployeeID || employee.Name != "Routine local employee" || employee.Title == nil || *employee.Title != "Accountant" ||
					employee.MonthlySalaryMinor != 500000 || employee.TaxRateBps != 1000 || !employee.Active {
					t.Errorf("hr.listEmployees employee = %+v, want the seeded local employee", employee)
				}
			case "call-routine-leave-balance":
				foundLeaveBalanceResult = true
				var result struct {
					OK   bool                            `json:"ok"`
					Data capability.HRLeaveBalanceOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode hr.leaveBalance tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || result.Data.EntitlementDays != 21 || result.Data.TakenDays != 3 || result.Data.RemainingDays != 18 {
					t.Errorf("hr.leaveBalance result = %+v, want 21 entitlement, 3 annual days taken, 18 remaining", result)
				}
			case "call-routine-foreign-leave-balance":
				foundForeignLeaveBalanceResult = true
				var result struct {
					OK   bool                            `json:"ok"`
					Data capability.HRLeaveBalanceOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode foreign hr.leaveBalance tool result %s: %v", message.Content, err)
					continue
				}
				if result.OK || result.Data.EntitlementDays != 0 {
					t.Errorf("foreign hr.leaveBalance result = %+v, want the cross-tenant employee refused", result)
				}
			case "call-routine-lots":
				foundLotsResult = true
				var result struct {
					OK   bool                               `json:"ok"`
					Data capability.InventoryListLotsOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode inventory.listLots tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Lots) != 1 {
					t.Errorf("inventory.listLots result = %+v, want only this organization's lot", result)
					continue
				}
				lot := result.Data.Lots[0]
				if lot.ID != localLotID || lot.SKU != "ROUTINE-LOT" || lot.LotCode != "LOT-LOCAL" || lot.BalanceThousandths != 4000 {
					t.Errorf("inventory.listLots lot = %+v, want the seeded local lot and its balance", lot)
				}
			case "call-routine-reservations":
				foundReservationsResult = true
				var result struct {
					OK   bool                                       `json:"ok"`
					Data capability.InventoryListReservationsOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode inventory.listReservations tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Reservations) != 1 {
					t.Errorf("inventory.listReservations result = %+v, want only the open local reservation", result)
					continue
				}
				reservation := result.Data.Reservations[0]
				if reservation.SKU != "ROUTINE-HISTORY" || reservation.QuantityThousandths != 1200 || reservation.Status != "open" ||
					reservation.Reason != "Routine local hold" || reservation.ReleasedAt != nil {
					t.Errorf("inventory.listReservations reservation = %+v, want the seeded open local hold", reservation)
				}
			case "call-routine-list":
				foundRoutineListResult = true
				var result struct {
					OK   bool                          `json:"ok"`
					Data capability.RoutinesListOutput `json:"data"`
				}
				if err := json.Unmarshal(message.Content, &result); err != nil {
					t.Errorf("decode routines.list tool result %s: %v", message.Content, err)
					continue
				}
				if !result.OK || len(result.Data.Routines) != 1 {
					t.Errorf("routines.list result = %+v, want only this organization's routine", result)
					continue
				}
				routine := result.Data.Routines[0]
				if routine.Name != "Test digest" || routine.ScheduleLabel != "Daily at 08:00" || routine.TriggerType != "schedule" || !routine.Enabled {
					t.Errorf("routines.list item = %+v, want the seeded local schedule", routine)
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
		if !foundAPAgingResult {
			t.Errorf("follow-up provider request omitted the purchasing.apAging tool result")
		}
		if !foundReceiptsResult {
			t.Errorf("follow-up provider request omitted the purchasing.listReceipts tool result")
		}
		if !foundBudgetScenariosResult {
			t.Errorf("follow-up provider request omitted the accounting.listBudgetScenarios tool result")
		}
		if !foundCustomerViewsResult {
			t.Errorf("follow-up provider request omitted the crm.listCustomerViews tool result")
		}
		if !foundEmployeesResult {
			t.Errorf("follow-up provider request omitted the hr.listEmployees tool result")
		}
		if !foundLeaveBalanceResult {
			t.Errorf("follow-up provider request omitted the hr.leaveBalance tool result")
		}
		if !foundForeignLeaveBalanceResult {
			t.Errorf("follow-up provider request omitted the cross-tenant hr.leaveBalance tool result")
		}
		if !foundLotsResult {
			t.Errorf("follow-up provider request omitted the inventory.listLots tool result")
		}
		if !foundReservationsResult {
			t.Errorf("follow-up provider request omitted the inventory.listReservations tool result")
		}
		if !foundRoutineListResult {
			t.Errorf("follow-up provider request omitted the routines.list tool result")
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
	if _, err := owner.Exec(ctx, `INSERT INTO routines(org_id,name,prompt,schedule,enabled,trigger_type) VALUES($1::uuid,'Foreign routine sentinel','Must stay private', '{"kind":"daily","atTime":"08:00"}', true, 'schedule')`, otherOrgID); err != nil {
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
	for capabilityID, want := range map[string]int{
		"crm.listCustomerViews":          1,
		"hr.listEmployees":               1,
		"hr.leaveBalance":                1,
		"inventory.listLots":             1,
		"inventory.listReservations":     1,
		"accounting.listBudgetScenarios": 1,
		"purchasing.listReceipts":        1,
		"routines.list":                  1,
	} {
		if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id=$2 AND session_id=$3::uuid AND actor_type='system'`, orgID, capabilityID, sessionID); got != want {
			t.Errorf("session-linked %s system capability audit events=%d, want %d", capabilityID, got, want)
		}
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
