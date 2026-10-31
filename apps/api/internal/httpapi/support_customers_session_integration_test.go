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

func TestSupportCustomersReaderUsesRuntimeRLSAndPermissionProjection(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to seed the Support customer fixture")
		}
		t.Skip("DATABASE_URL is required to seed the Support customer fixture")
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
	if _, err := owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Support picker fixture', $2), ($3::uuid, 'Support picker other fixture', $4)`, orgID, "go-support-customer-"+orgID[:8], otherOrgID, "go-support-customer-other-"+otherOrgID[:8]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM customers WHERE org_id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete Support customer fixtures: %v", err)
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete Support organization fixtures: %v", err)
		}
	})

	var activeID, inactiveID, foreignID string
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Amina') RETURNING id::text`, orgID).Scan(&activeID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name, deactivated_at) VALUES ($1::uuid, 'Inactive Amina', now()) RETURNING id::text`, orgID).Scan(&inactiveID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Foreign Amina') RETURNING id::text`, otherOrgID).Scan(&foreignID); err != nil {
		t.Fatal(err)
	}

	reader := postgresSupportCustomersReader{pool: runtime}
	crmRows, err := reader.Read(ctx, orgID, true)
	if err != nil {
		t.Fatalf("CRM customer picker read with runtime role: %v", err)
	}
	if len(crmRows.Customers) != 2 || crmRows.Customers[0].ID != activeID || crmRows.Customers[1].ID != inactiveID {
		t.Fatalf("CRM customer picker rows=%+v, want active and inactive tenant customers in name order", crmRows.Customers)
	}
	posRows, err := reader.Read(ctx, orgID, false)
	if err != nil {
		t.Fatalf("POS customer picker read with runtime role: %v", err)
	}
	if len(posRows.Customers) != 1 || posRows.Customers[0].ID != activeID {
		t.Fatalf("POS customer picker rows=%+v, want active tenant customer only", posRows.Customers)
	}
	for _, row := range crmRows.Customers {
		if row.ID == foreignID {
			t.Fatalf("foreign tenant customer %s leaked into picker results", foreignID)
		}
	}
}
