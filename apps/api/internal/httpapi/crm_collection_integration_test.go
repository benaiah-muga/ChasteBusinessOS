package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
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

func TestCRMRoutesIntegrationUseRuntimeRLSAndCapabilities(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for the CRM routes integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for the CRM routes integration proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := orgParityEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
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
	crmRole := seedRole(t, owner, fixture.orgA, "crm-integration", "crm.read")
	for _, permission := range []string{"crm.write", "inventory.write"} {
		if _, err := owner.Exec(ctx,
			`INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, $2, $3::uuid)`,
			crmRole, permission, fixture.orgA); err != nil {
			t.Fatalf("grant %s: %v", permission, err)
		}
	}
	if _, err := owner.Exec(ctx,
		`INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
		fixture.userID, crmRole, fixture.orgA); err != nil {
		t.Fatalf("assign CRM role: %v", err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	executor := capability.NewExecutor(runtime, "", "", "")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	collection := NewCRMCollectionSessionHandler(resolver, executor, logger)
	importer := NewCRMImportSessionHandler(resolver, executor, logger)

	call := func(handler http.Handler, path, body, organizationID string) *httptest.ResponseRecorder {
		t.Helper()
		method := http.MethodPost
		if body == "" {
			method = http.MethodGet
		}
		req := httptest.NewRequest(method, "https://app.example.test"+path, strings.NewReader(body))
		req.TLS = &tls.ConnectionState{}
		req.Host = "app.example.test"
		req.Header.Set("Origin", "https://app.example.test")
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
		req.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: organizationID})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	decode := func(response *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response %q: %v", response.Body.String(), err)
		}
		return body
	}
	dataOf := func(response *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		body := decode(response)
		data, _ := body["data"].(map[string]any)
		if len(data) == 0 {
			t.Fatalf("response has no data object: %s", response.Body.String())
		}
		return data
	}

	created := call(collection, "/api/customers", `{"action":"create","name":"Integration Ada","email":"integration-ada@example.test"}`, fixture.orgA)
	if created.Code != http.StatusOK || decode(created)["ok"] != true {
		t.Fatalf("create customer status=%d body=%s", created.Code, created.Body.String())
	}
	customerID, _ := dataOf(created)["customerId"].(string)
	if !isUUID(customerID) {
		t.Fatalf("customerId=%q", customerID)
	}

	emptyViews := call(collection, "/api/crm/views", "", fixture.orgA)
	if emptyViews.Code != http.StatusOK {
		t.Fatalf("list views status=%d body=%s", emptyViews.Code, emptyViews.Body.String())
	}

	createDeal := call(collection, "/api/deals", fmt.Sprintf(`{"action":"create","title":"Integration deal","customerId":%q,"valueMinor":123400}`, customerID), fixture.orgA)
	if createDeal.Code != http.StatusOK {
		t.Fatalf("create deal status=%d body=%s", createDeal.Code, createDeal.Body.String())
	}
	dealID, _ := dataOf(createDeal)["dealId"].(string)
	if !isUUID(dealID) {
		t.Fatalf("dealId=%q", dealID)
	}
	orgADeals := decode(call(collection, "/api/deals", "", fixture.orgA))
	if raw, err := json.Marshal(orgADeals["deals"]); err != nil || !strings.Contains(string(raw), dealID) {
		t.Fatalf("org A deals=%s, want %s", raw, dealID)
	}

	orgBDeals := decode(call(collection, "/api/deals", "", fixture.orgB))
	if orgBDeals["deals"] != nil {
		if raw, _ := json.Marshal(orgBDeals["deals"]); strings.Contains(string(raw), dealID) {
			t.Fatalf("org B deal list leaked org A deal: %s", raw)
		}
	}
	orgBWrite := call(collection, "/api/deals", `{"action":"create","title":"Cross org deal","valueMinor":1}`, fixture.orgB)
	if orgBWrite.Code != http.StatusUnprocessableEntity || !strings.Contains(orgBWrite.Body.String(), "forbidden: missing permission: crm.write") {
		t.Fatalf("org B write status=%d body=%s, want capability refusal", orgBWrite.Code, orgBWrite.Body.String())
	}

	sku := fmt.Sprintf("INTEGRATION-%d", time.Now().UnixNano())
	productImport := call(importer, "/api/import", fmt.Sprintf(`{"entity":"products","rows":[{"name":"Integration Widget","sku":%q,"salePriceMinor":1000}]}`, sku), fixture.orgA)
	if productImport.Code != http.StatusOK {
		t.Fatalf("product import status=%d body=%s", productImport.Code, productImport.Body.String())
	}
	productBody := decode(productImport)
	if productBody["inserted"] != float64(1) || strings.Contains(productImport.Body.String(), "importIntentId") {
		t.Fatalf("product import body=%s", productImport.Body.String())
	}
	itemIDs, _ := productBody["createdIds"].([]any)
	if len(itemIDs) != 1 {
		t.Fatalf("product createdIds=%v", productBody["createdIds"])
	}
	productUndo := call(importer, "/api/import", fmt.Sprintf(`{"entity":"products","action":"undo","importIds":[%q]}`, itemIDs[0]), fixture.orgA)
	if productUndo.Code != http.StatusOK || decode(productUndo)["undone"] != float64(1) || decode(productUndo)["remaining"] != float64(0) {
		t.Fatalf("product undo status=%d body=%s", productUndo.Code, productUndo.Body.String())
	}

	customerImport := call(importer, "/api/import", `{"entity":"customers","rows":[{"name":"Bulk One"},{"name":"Bulk Two"}]}`, fixture.orgA)
	if customerImport.Code != http.StatusOK {
		t.Fatalf("customer import status=%d body=%s", customerImport.Code, customerImport.Body.String())
	}
	customerBody := decode(customerImport)
	importIntentID, _ := customerBody["importIntentId"].(string)
	createdIDs, _ := customerBody["createdIds"].([]any)
	if customerBody["inserted"] != float64(2) || !isUUID(importIntentID) || len(createdIDs) != 2 {
		t.Fatalf("customer import body=%s", customerImport.Body.String())
	}
	customerUndo := call(importer, "/api/import",
		fmt.Sprintf(`{"entity":"customers","action":"undo","importIds":[%q,%q],"importIntentId":%q}`, createdIDs[0], createdIDs[1], importIntentID), fixture.orgA)
	if customerUndo.Code != http.StatusOK || decode(customerUndo)["undone"] != float64(2) || decode(customerUndo)["remaining"] != float64(0) {
		t.Fatalf("customer undo status=%d body=%s", customerUndo.Code, customerUndo.Body.String())
	}
	var deactivated int
	if err := owner.QueryRow(ctx,
		`SELECT count(*) FROM customers WHERE id = ANY($1::uuid[]) AND deactivated_at IS NOT NULL`,
		[]string{createdIDs[0].(string), createdIDs[1].(string)}).Scan(&deactivated); err != nil {
		t.Fatalf("verify customer undo: %v", err)
	}
	if deactivated != 2 {
		t.Fatalf("deactivated customers=%d, want 2", deactivated)
	}
}
