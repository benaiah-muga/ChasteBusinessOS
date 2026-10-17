package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
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

func TestManufacturingCollectionIntegrationServesTheWorkbench(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for the Manufacturing collection integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for the Manufacturing collection integration proof")
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
	keySuffix := strings.ReplaceAll(readContractUUID(t), "-", "")[:12]

	grantRole := func(orgID, permission string) {
		t.Helper()
		roleID := seedRole(t, owner, orgID, "manufacturing-"+permission+"-"+keySuffix, permission)
		if _, err := owner.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
			fixture.userID, roleID, orgID); err != nil {
			t.Fatal(err)
		}
	}
	grantRole(fixture.orgA, "manufacturing.read")
	grantRole(fixture.orgA, "manufacturing.write")

	var deskID, legID string
	if err := owner.QueryRow(ctx, `INSERT INTO items (org_id, sku, name, kind) VALUES ($1::uuid, 'DESK-INT', 'Desk', 'goods') RETURNING id::text`,
		fixture.orgA).Scan(&deskID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO items (org_id, sku, name, kind) VALUES ($1::uuid, 'LEG-INT', 'Leg', 'goods') RETURNING id::text`,
		fixture.orgA).Scan(&legID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO bom_lines (org_id, assembly_item_id, component_item_id, quantity_thousandths, scrap_pct_thousandths)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 4000, 0)`, fixture.orgA, deskID, legID); err != nil {
		t.Fatal(err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewManufacturingCollectionHandler(resolver, capability.NewExecutor(runtime, "", "", ""), logger)
	request := func(method, target, body, organizationID, cookie string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "https://app.example.test"+target, strings.NewReader(body))
		req.TLS = &tls.ConnectionState{}
		req.Host = "app.example.test"
		req.Header.Set("Origin", "https://app.example.test")
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: cookie})
		}
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

	unauthenticated := request(http.MethodGet, "/api/manufacturing", "", fixture.orgA, "")
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", unauthenticated.Code, unauthenticated.Body.String())
	}

	moduleDisabled := request(http.MethodGet, "/api/manufacturing", "", fixture.orgB, fixture.cookie)
	if moduleDisabled.Code != http.StatusNotFound {
		t.Fatalf("module disabled status=%d body=%s", moduleDisabled.Code, moduleDisabled.Body.String())
	}

	overview := request(http.MethodGet, "/api/manufacturing", "", fixture.orgA, fixture.cookie)
	overviewBody := decode(overview)
	if overview.Code != http.StatusOK {
		t.Fatalf("overview status=%d body=%s", overview.Code, overview.Body.String())
	}
	if _, enveloped := overviewBody["ok"]; enveloped {
		t.Fatalf("overview must be a bare payload: %s", overview.Body.String())
	}
	boms, _ := overviewBody["boms"].([]any)
	if len(boms) != 1 {
		t.Fatalf("overview boms=%v body=%s", overviewBody["boms"], overview.Body.String())
	}
	edge, _ := boms[0].(map[string]any)
	if edge["assemblySku"] != "DESK-INT" || edge["componentSku"] != "LEG-INT" || edge["quantityThousandths"] != float64(4000) {
		t.Fatalf("bom edge=%v", edge)
	}

	skuOnly := request(http.MethodGet, "/api/manufacturing?sku=DESK-INT", "", fixture.orgA, fixture.cookie)
	skuOnlyBody := decode(skuOnly)
	if skuOnly.Code != http.StatusOK {
		t.Fatalf("sku-only status=%d body=%s", skuOnly.Code, skuOnly.Body.String())
	}
	if _, ok := skuOnlyBody["boms"]; !ok {
		t.Fatalf("sku without lot code must stay on the overview: %s", skuOnly.Body.String())
	}

	missingLot := request(http.MethodGet, "/api/manufacturing?sku=DESK-INT&lotCode=NOPE", "", fixture.orgA, fixture.cookie)
	missingLotBody := decode(missingLot)
	if missingLot.Code != http.StatusUnprocessableEntity || missingLotBody["ok"] != false {
		t.Fatalf("missing lot status=%d body=%s", missingLot.Code, missingLot.Body.String())
	}
	if message, _ := missingLotBody["error"].(string); !strings.Contains(message, "no lot") {
		t.Fatalf("missing lot error=%v", missingLotBody["error"])
	}

	tree := request(http.MethodPost, "/api/manufacturing", `{"action":"bomTree","assemblySku":"DESK-INT"}`, fixture.orgA, fixture.cookie)
	treeBody := decode(tree)
	if tree.Code != http.StatusOK || treeBody["ok"] != true {
		t.Fatalf("bom tree status=%d body=%s", tree.Code, tree.Body.String())
	}
	treeData, _ := treeBody["data"].(map[string]any)
	root, _ := treeData["root"].(map[string]any)
	if treeData["hasBom"] != true || root["sku"] != "DESK-INT" {
		t.Fatalf("bom tree data=%v", treeBody["data"])
	}

	unknown := request(http.MethodPost, "/api/manufacturing", `{"action":"explode"}`, fixture.orgA, fixture.cookie)
	unknownBody := decode(unknown)
	if unknown.Code != http.StatusBadRequest || unknownBody["error"] != "invalid action" {
		t.Fatalf("unknown action status=%d body=%s", unknown.Code, unknown.Body.String())
	}

	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["manufacturing"]'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatal(err)
	}
	grantRole(fixture.orgB, "manufacturing.read")
	grantRole(fixture.orgB, "manufacturing.write")
	isolated := request(http.MethodGet, "/api/manufacturing", "", fixture.orgB, fixture.cookie)
	isolatedBody := decode(isolated)
	if isolated.Code != http.StatusOK || len(isolatedBody["boms"].([]any)) != 0 {
		t.Fatalf("cross-org overview status=%d body=%s", isolated.Code, isolated.Body.String())
	}
	crossOrgTree := request(http.MethodPost, "/api/manufacturing", `{"action":"bomTree","assemblySku":"DESK-INT"}`, fixture.orgB, fixture.cookie)
	crossOrgTreeBody := decode(crossOrgTree)
	if crossOrgTree.Code != http.StatusUnprocessableEntity {
		t.Fatalf("cross-org bom tree status=%d body=%s", crossOrgTree.Code, crossOrgTree.Body.String())
	}
	if message, _ := crossOrgTreeBody["error"].(string); !strings.Contains(message, "no item with SKU") {
		t.Fatalf("cross-org bom tree error=%v", crossOrgTreeBody["error"])
	}

	missingWrite := request(http.MethodPost, "/api/manufacturing", `{"action":"bomTree","assemblySku":"DESK-INT"}`, fixture.orgA, "")
	if missingWrite.Code != http.StatusUnauthorized {
		t.Fatalf("missing session POST status=%d body=%s", missingWrite.Code, missingWrite.Body.String())
	}
}
