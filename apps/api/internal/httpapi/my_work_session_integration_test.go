package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dashboard"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresMyWorkSessionHandlerMatchesCardContractAndScopesOrganizations(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("GO_DATABASE_URL or DATABASE_URL is required for my-work integration coverage")
		}
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed my-work integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed my-work fixtures")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtimeConfig, err := pgxpool.ParseConfig(runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	runtimeConfig.MaxConns = 1
	runtime, err := pgxpool.NewWithConfig(ctx, runtimeConfig)
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
		($1::uuid, 'Go my-work fixture', $2),
		($3::uuid, 'Go my-work foreign fixture', $4)`,
		orgID, "go-my-work-"+orgID[:8], otherOrgID, "go-my-work-foreign-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete my-work fixture organizations: %v", err)
		}
	})

	createdAt := time.Date(2026, 10, 1, 10, 20, 30, 123_000_000, time.UTC)
	fixtures := []struct {
		orgID           string
		approvalID      string
		approvalReason  string
		poNumber        int
		lineQuantity    int
		accepted        int
		rejected        int
		returned        int
		linePosition    int
		lineDescription string
	}{
		{orgID: orgID, approvalID: integrationUUID(t), approvalReason: "local approval", poNumber: 17, lineQuantity: 10_000, accepted: 3_000, rejected: 500, returned: 250, linePosition: 2, lineDescription: "Local beans"},
		{orgID: otherOrgID, approvalID: integrationUUID(t), approvalReason: "foreign approval", poNumber: 23, lineQuantity: 5_000, linePosition: 1, lineDescription: "Foreign rice"},
	}
	for _, fixture := range fixtures {
		if _, err := owner.Exec(ctx, `
			INSERT INTO approvals (id, org_id, capability_id, risk_class, payload, rationale, status, created_at)
			VALUES ($1::uuid, $2::uuid, 'iam.setModules', 'identity', '{}'::jsonb, $3, 'pending', $4)`,
			fixture.approvalID, fixture.orgID, fixture.approvalReason, createdAt); err != nil {
			t.Fatal(err)
		}
		var vendorID, poID, lineID string
		if err := owner.QueryRow(ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, $2) RETURNING id::text`, fixture.orgID, "My Work Vendor "+fixture.orgID[:8]).Scan(&vendorID); err != nil {
			t.Fatal(err)
		}
		if err := owner.QueryRow(ctx, `
			INSERT INTO purchase_orders (org_id, vendor_id, number, status)
			VALUES ($1::uuid, $2::uuid, $3, 'partial') RETURNING id::text`, fixture.orgID, vendorID, fixture.poNumber).Scan(&poID); err != nil {
			t.Fatal(err)
		}
		if err := owner.QueryRow(ctx, `
			INSERT INTO po_lines (po_id, description, quantity, unit_price_minor, position)
			VALUES ($1::uuid, $2, $3, 100, $4) RETURNING id::text`,
			poID, fixture.lineDescription, fixture.lineQuantity, fixture.linePosition).Scan(&lineID); err != nil {
			t.Fatal(err)
		}
		if fixture.accepted+fixture.rejected+fixture.returned > 0 {
			var receiptID string
			if err := owner.QueryRow(ctx, `
				INSERT INTO goods_receipts (org_id, po_id, number, received_by_actor_type)
				VALUES ($1::uuid, $2::uuid, 1, 'human') RETURNING id::text`, fixture.orgID, poID).Scan(&receiptID); err != nil {
				t.Fatal(err)
			}
			if _, err := owner.Exec(ctx, `
				INSERT INTO goods_receipt_lines (org_id, receipt_id, po_line_id, position, accepted_thousandths, rejected_thousandths, returned_thousandths)
				VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
				fixture.orgID, receiptID, lineID, fixture.linePosition, fixture.accepted, fixture.rejected, fixture.returned); err != nil {
				t.Fatal(err)
			}
		}
	}

	reader := dashboard.NewMyWorkPostgresReader(runtime)
	for _, fixture := range fixtures {
		identity := directTestIdentity()
		identity.OrgID = &fixture.orgID
		identity.Permissions["iam.admin"] = true
		identity.Permissions["purchasing.read"] = true
		resolver := &fakeDirectSessionResolver{resolved: identity}
		handler := NewMyWorkSessionHandler(resolver, reader, &fakeDashboardExecutor{}, nil).(*MyWorkSessionHandler)
		handler.now = func() time.Time { return createdAt.Add(time.Hour) }
		request := httptest.NewRequest(http.MethodGet, "/api/my-work", nil)
		request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "my-work-integration-session"})
		request.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: fixture.orgID})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("org %s status=%d body=%s", fixture.orgID, response.Code, response.Body.String())
		}
		var got struct {
			Cards       []MyWorkCard `json:"cards"`
			GeneratedAt string       `json:"generatedAt"`
		}
		if err := json.NewDecoder(response.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		if len(got.Cards) != 2 {
			t.Fatalf("org %s got %d cards, want its approval and partial PO only: %+v", fixture.orgID, len(got.Cards), got.Cards)
		}
		approval, remainder := got.Cards[0], got.Cards[1]
		if approval.Kind != "approval" || approval.ID != fixture.approvalID || approval.Title != "Approval needed: iam.setModules" || approval.Detail != fixture.approvalReason || approval.CreatedAt == nil || *approval.CreatedAt != "2026-10-01T10:20:30.123Z" {
			t.Fatalf("org %s approval card differs from the legacy contract: %+v", fixture.orgID, approval)
		}
		remaining := fixture.lineQuantity - fixture.accepted - fixture.rejected + fixture.returned
		wantTitle := fmt.Sprintf("PO %d: %s still outstanding", fixture.poNumber, dashboard.FormatWorkThousandths(int64(remaining)))
		wantDetail := fmt.Sprintf("line %d \"%s\"", fixture.linePosition, fixture.lineDescription)
		if remainder.Kind != "receipt_remainder" || remainder.ID == fixture.approvalID || remainder.Title != wantTitle || remainder.Detail != wantDetail || remainder.ActionHref != fmt.Sprintf("/purchasing/receiving?poNumber=%d", fixture.poNumber) {
			t.Fatalf("org %s remainder card differs from the legacy contract: %+v", fixture.orgID, remainder)
		}
		if got.GeneratedAt != "2026-10-01T11:20:30.123Z" {
			t.Fatalf("org %s generatedAt=%q", fixture.orgID, got.GeneratedAt)
		}
	}
}
