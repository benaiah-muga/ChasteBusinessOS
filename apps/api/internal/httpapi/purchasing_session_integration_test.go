package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPurchasingSessionRoutesRuntimeRLSAndGovernedWrites(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for purchasing session integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for purchasing session integration proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := orgParityEnv(t)
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

	fixture := seedOrgParityFixture(t, owner, secret)
	seedPurchasingPermissions(t, owner, fixture.orgA)
	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["crm","purchasing"]'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatalf("enable purchasing in reader organization: %v", err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) SELECT id, 'purchasing.read', $1::uuid FROM roles WHERE org_id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatalf("grant purchasing read in reader organization: %v", err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	executor := capability.NewExecutor(runtime, "", "", "")
	api := http.Handler(http.NotFoundHandler())
	api = MountGoPurchasingCollectionRoute(api, NewPurchasingCollectionSessionHandler(resolver, executor, nil))
	api = MountGoPurchasingPaymentRunsRoute(api, NewPurchasingPaymentRunsSessionHandler(resolver, executor, nil))

	request := func(method, path, body, cookie, orgID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://app.example.test"+path, strings.NewReader(body))
		r.TLS = &tls.ConnectionState{}
		r.Host = "app.example.test"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://app.example.test")
		r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: cookie})
		r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
		response := httptest.NewRecorder()
		api.ServeHTTP(response, r)
		return response
	}

	unauthorized := request(http.MethodGet, "/api/purchasing", "", "", fixture.orgA)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("missing session status=%d body=%s", unauthorized.Code, unauthorized.Body.String())
	}

	var workspace struct {
		BaseCurrency string `json:"baseCurrency"`
		Vendors      []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"vendors"`
		Orders   []json.RawMessage `json:"orders"`
		Bills    []json.RawMessage `json:"bills"`
		Requests []json.RawMessage `json:"requests"`
	}
	initial := request(http.MethodGet, "/api/purchasing", "", fixture.cookie, fixture.orgA)
	if initial.Code != http.StatusOK || json.Unmarshal(initial.Body.Bytes(), &workspace) != nil || workspace.BaseCurrency != "USD" || len(workspace.Vendors) != 0 {
		t.Fatalf("initial workspace status=%d body=%s", initial.Code, initial.Body.String())
	}

	malformed := request(http.MethodPost, "/api/purchasing", `{"action":"createVendor","intentId":"vendor-malformed","name":"No Such Vendor","extra":true}`, fixture.cookie, fixture.orgA)
	if malformed.Code != http.StatusBadRequest {
		t.Fatalf("malformed body status=%d body=%s", malformed.Code, malformed.Body.String())
	}
	var vendorCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM vendors WHERE org_id=$1::uuid`, fixture.orgA).Scan(&vendorCount); err != nil || vendorCount != 0 {
		t.Fatalf("vendors after malformed request=%d err=%v", vendorCount, err)
	}

	vendorName := "Integration Vendor " + time.Now().UTC().Format("150405.000000000")
	createVendor := `{"action":"createVendor","intentId":"integration-vendor-1","name":"` + vendorName + `"}`
	created := request(http.MethodPost, "/api/purchasing", createVendor, fixture.cookie, fixture.orgA)
	var createdBody struct {
		OK   bool `json:"ok"`
		Data struct {
			VendorID string `json:"vendorId"`
		} `json:"data"`
	}
	if created.Code != http.StatusOK || json.Unmarshal(created.Body.Bytes(), &createdBody) != nil || !createdBody.OK || !isUUID(createdBody.Data.VendorID) {
		t.Fatalf("create vendor status=%d body=%s", created.Code, created.Body.String())
	}

	replayed := request(http.MethodPost, "/api/purchasing", createVendor, fixture.cookie, fixture.orgA)
	if replayed.Code != http.StatusOK {
		t.Fatalf("replayed vendor status=%d body=%s", replayed.Code, replayed.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM vendors WHERE org_id=$1::uuid`, fixture.orgA).Scan(&vendorCount); err != nil || vendorCount != 1 {
		t.Fatalf("vendors after replay=%d err=%v", vendorCount, err)
	}

	afterCreate := request(http.MethodGet, "/api/purchasing", "", fixture.cookie, fixture.orgA)
	if afterCreate.Code != http.StatusOK || json.Unmarshal(afterCreate.Body.Bytes(), &workspace) != nil || len(workspace.Vendors) != 1 || workspace.Vendors[0].ID != createdBody.Data.VendorID {
		t.Fatalf("workspace after create status=%d body=%s", afterCreate.Code, afterCreate.Body.String())
	}

	isolated := request(http.MethodGet, "/api/purchasing", "", fixture.cookie, fixture.orgB)
	if isolated.Code != http.StatusOK || strings.Contains(isolated.Body.String(), vendorName) || strings.Contains(isolated.Body.String(), createdBody.Data.VendorID) {
		t.Fatalf("cross-org read status=%d body=%s", isolated.Code, isolated.Body.String())
	}
	deniedWrite := request(http.MethodPost, "/api/purchasing", `{"action":"createVendor","intentId":"integration-vendor-2","name":"Intruder"}`, fixture.cookie, fixture.orgB)
	if deniedWrite.Code != http.StatusForbidden {
		t.Fatalf("cross-org write status=%d body=%s", deniedWrite.Code, deniedWrite.Body.String())
	}

	if _, err := owner.Exec(ctx, `INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, money_threshold_minor, requires_approval_for)
		VALUES ($1::uuid, 'purchasing.payBill', 'money', 0, '["money"]'::jsonb)`, fixture.orgA); err != nil {
		t.Fatalf("seed payBill approval policy: %v", err)
	}
	pending := request(http.MethodPost, "/api/purchasing", `{"action":"payBill","intentId":"integration-paybill-1","billNumber":1,"amountMinor":100000}`, fixture.cookie, fixture.orgA)
	var pendingBody struct {
		OK              bool   `json:"ok"`
		PendingApproval bool   `json:"pendingApproval"`
		Reason          string `json:"reason"`
	}
	if pending.Code != http.StatusAccepted || json.Unmarshal(pending.Body.Bytes(), &pendingBody) != nil || pendingBody.OK || !pendingBody.PendingApproval || !strings.Contains(pendingBody.Reason, "exceeds") {
		t.Fatalf("payBill approval status=%d body=%s", pending.Code, pending.Body.String())
	}
	var approvalCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND capability_id='purchasing.payBill' AND status='pending'`, fixture.orgA).Scan(&approvalCount); err != nil || approvalCount != 1 {
		t.Fatalf("pending approvals=%d err=%v", approvalCount, err)
	}

	var billID string
	if err := owner.QueryRow(ctx, `INSERT INTO vendor_bills (org_id, vendor_id, number, currency, total_minor, status)
		VALUES ($1::uuid, $2::uuid, 1, 'USD', 5000, 'open') RETURNING id::text`, fixture.orgA, createdBody.Data.VendorID).Scan(&billID); err != nil {
		t.Fatalf("seed vendor bill: %v", err)
	}
	runCreated := request(http.MethodPost, "/api/purchasing/payment-runs", `{"action":"create","intentId":"integration-run-1","memo":"Integration batch","lines":[{"billId":"`+billID+`","amountMinor":5000}]}`, fixture.cookie, fixture.orgA)
	var runBody struct {
		OK   bool `json:"ok"`
		Data struct {
			PaymentRunID string `json:"paymentRunId"`
			Reference    string `json:"reference"`
		} `json:"data"`
	}
	if runCreated.Code != http.StatusOK || json.Unmarshal(runCreated.Body.Bytes(), &runBody) != nil || !runBody.OK || !isUUID(runBody.Data.PaymentRunID) || runBody.Data.Reference != "PR-000001" {
		t.Fatalf("create payment run status=%d body=%s", runCreated.Code, runCreated.Body.String())
	}

	var runs struct {
		OK   bool `json:"ok"`
		Data struct {
			Runs []struct {
				ID        string `json:"id"`
				Reference string `json:"reference"`
				Status    string `json:"status"`
			} `json:"runs"`
		} `json:"data"`
	}
	listed := request(http.MethodGet, "/api/purchasing/payment-runs", "", fixture.cookie, fixture.orgA)
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &runs) != nil || !runs.OK || len(runs.Data.Runs) != 1 || runs.Data.Runs[0].ID != runBody.Data.PaymentRunID || runs.Data.Runs[0].Status != "draft" {
		t.Fatalf("list payment runs status=%d body=%s", listed.Code, listed.Body.String())
	}
	runsFellow := request(http.MethodGet, "/api/purchasing/payment-runs", "", fixture.cookie, fixture.orgB)
	if runsFellow.Code != http.StatusOK || strings.Contains(runsFellow.Body.String(), runBody.Data.PaymentRunID) {
		t.Fatalf("cross-org payment runs status=%d body=%s", runsFellow.Code, runsFellow.Body.String())
	}

	cancelled := request(http.MethodPost, "/api/purchasing/payment-runs", `{"action":"cancel","intentId":"integration-run-cancel-1","paymentRunId":"`+runBody.Data.PaymentRunID+`"}`, fixture.cookie, fixture.orgA)
	if cancelled.Code != http.StatusOK {
		t.Fatalf("cancel payment run status=%d body=%s", cancelled.Code, cancelled.Body.String())
	}
	restored := request(http.MethodPost, "/api/purchasing/payment-runs", `{"action":"restore","intentId":"integration-run-restore-1","paymentRunId":"`+runBody.Data.PaymentRunID+`"}`, fixture.cookie, fixture.orgA)
	if restored.Code != http.StatusOK {
		t.Fatalf("restore payment run status=%d body=%s", restored.Code, restored.Body.String())
	}

	var auditCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id='purchasing.createVendor'`, fixture.orgA).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("createVendor audit count=%d err=%v", auditCount, err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id='purchasing.createPaymentRun'`, fixture.orgA).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("createPaymentRun audit count=%d err=%v", auditCount, err)
	}
}

func seedPurchasingPermissions(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	for _, permission := range []string{"purchasing.read", "purchasing.write", "purchasing.post"} {
		if _, err := pool.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) SELECT id, $2, $1::uuid FROM roles WHERE org_id=$1::uuid`, orgID, permission); err != nil {
			t.Fatalf("grant %s: %v", permission, err)
		}
	}
}
