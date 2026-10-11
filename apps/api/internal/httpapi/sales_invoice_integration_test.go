package httpapi

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoSalesInvoiceReadUsesRuntimeRLS(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to seed the sales invoice integration fixture")
		}
		t.Skip("DATABASE_URL is required to seed the sales invoice integration fixture")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
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

	orgID, otherOrgID := integrationUUID(t), integrationUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go sales invoice fixture', $2),
		($3::uuid, 'Go foreign invoice fixture', $4)`,
		orgID, "go-sales-invoice-"+orgID[:8], otherOrgID, "go-sales-invoice-other-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete sales invoice organization fixtures: %v", err)
		}
	})

	var customerID, otherCustomerID string
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name, email, payment_term_days) VALUES ($1::uuid, 'Invoice buyer', 'buyer@example.test', 30) RETURNING id::text`, orgID).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name, email, payment_term_days) VALUES ($1::uuid, 'Foreign buyer', 'foreign@example.test', 14) RETURNING id::text`, otherOrgID).Scan(&otherCustomerID); err != nil {
		t.Fatal(err)
	}
	createdAt := time.Date(2026, 10, 11, 8, 30, 0, 0, time.UTC)
	var orderID, otherOrderID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO sales_orders (org_id, number, customer_id, status, note, created_at)
		VALUES ($1::uuid, 73, $2::uuid, 'confirmed', 'Invoice note', $3)
		RETURNING id::text`, orgID, customerID, createdAt).Scan(&orderID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `
		INSERT INTO sales_orders (org_id, number, customer_id, status, created_at)
		VALUES ($1::uuid, 99, $2::uuid, 'confirmed', $3)
		RETURNING id::text`, otherOrgID, otherCustomerID, createdAt).Scan(&otherOrderID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO sales_order_lines (org_id, order_id, description, quantity, unit_price_minor, tax_minor)
		VALUES ($1::uuid, $2::uuid, 'Consulting', 2000, 12500, 2500),
		       ($3::uuid, $4::uuid, 'Foreign service', 1000, 9900, 0)`, orgID, orderID, otherOrgID, otherOrderID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO org_branding (org_id, logo_data_url, accent_color, invoice_footer, layout) VALUES ($1::uuid, 'data:image/png;base64,fixture', '#123456', 'Thank you', 'modern')`, orgID); err != nil {
		t.Fatal(err)
	}

	data, err := loadSalesInvoice(ctx, runtime, orgID, orderID)
	if err != nil {
		t.Fatalf("load invoice through runtime RLS: %v", err)
	}
	if data == nil || data.Order.Number != 73 || data.Order.CustomerName != "Invoice buyer" || data.Order.CustomerEmail == nil || *data.Order.CustomerEmail != "buyer@example.test" || data.Order.PaymentTermDays == nil || *data.Order.PaymentTermDays != 30 || data.Order.OrgName != "Go sales invoice fixture" || !data.Order.CreatedAt.Equal(createdAt) {
		t.Fatalf("invoice order = %+v, want seeded org-scoped row", data)
	}
	if len(data.Lines) != 1 || data.Lines[0] != (salesInvoiceLine{Description: "Consulting", Quantity: 2000, UnitPriceMinor: 12500, TaxMinor: 2500}) {
		t.Fatalf("invoice lines = %+v, want only seeded tenant line", data.Lines)
	}
	if data.Branding == nil || data.Branding.LogoDataURL == nil || *data.Branding.LogoDataURL != "data:image/png;base64,fixture" || data.Branding.Layout == nil || *data.Branding.Layout != "modern" {
		t.Fatalf("invoice branding = %+v, want seeded tenant branding", data.Branding)
	}

	foreign, err := loadSalesInvoice(ctx, runtime, orgID, otherOrderID)
	if err != nil {
		t.Fatalf("read foreign invoice through runtime RLS: %v", err)
	}
	if foreign != nil {
		t.Fatalf("foreign invoice leaked into org %s: %+v", orgID, foreign)
	}
	var unscopedCount int
	if err := runtime.QueryRow(ctx, `SELECT count(*) FROM sales_orders WHERE id = $1::uuid`, orderID).Scan(&unscopedCount); err != nil {
		t.Fatalf("query sales orders without org context: %v", err)
	}
	if unscopedCount != 0 {
		t.Fatalf("unscoped runtime query saw %d sales orders, want RLS to hide all rows", unscopedCount)
	}
}
