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

type financeSalesIntegrationEnv struct {
	ctx      context.Context
	owner    *pgxpool.Pool
	runtime  *pgxpool.Pool
	fixture  orgParityFixture
	resolver *session.Resolver
	executor *capability.Executor
	logger   *slog.Logger
}

func financeSalesIntegrationSetup(t *testing.T, permissions ...string) *financeSalesIntegrationEnv {
	t.Helper()
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for the finance sales integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for the finance sales integration proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := orgParityEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
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
	if len(permissions) > 0 {
		financeSalesIntegrationGrant(t, ctx, owner, fixture, fixture.orgA, permissions)
	}
	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	return &financeSalesIntegrationEnv{
		ctx:      ctx,
		owner:    owner,
		runtime:  runtime,
		fixture:  fixture,
		resolver: resolver,
		executor: capability.NewExecutor(runtime, "", "", ""),
		logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func financeSalesIntegrationGrant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, fixture orgParityFixture, organizationID string, permissions []string) {
	t.Helper()
	roleKey := fmt.Sprintf("finance-sales-%d", time.Now().UnixNano())
	roleID := seedRole(t, pool, organizationID, roleKey, permissions[0])
	for _, permission := range permissions[1:] {
		if _, err := pool.Exec(ctx,
			`INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, $2, $3::uuid)`,
			roleID, permission, organizationID); err != nil {
			t.Fatalf("grant %s: %v", permission, err)
		}
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
		fixture.userID, roleID, organizationID); err != nil {
		t.Fatalf("assign finance sales role: %v", err)
	}
}

func (env *financeSalesIntegrationEnv) do(t *testing.T, handler http.Handler, method, path, body, cookie, organizationID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "https://app.example.test"+path, strings.NewReader(body))
	req.TLS = &tls.ConnectionState{}
	req.Host = "app.example.test"
	req.Header.Set("Origin", "https://app.example.test")
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: cookie})
	req.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: organizationID})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}

func (env *financeSalesIntegrationEnv) call(t *testing.T, handler http.Handler, method, path, body, organizationID string) *httptest.ResponseRecorder {
	t.Helper()
	return env.do(t, handler, method, path, body, env.fixture.cookie, organizationID)
}

func financeSalesIntegrationDecode(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
	return body
}

func financeSalesIntegrationData(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	data, _ := financeSalesIntegrationDecode(t, response)["data"].(map[string]any)
	if len(data) == 0 {
		t.Fatalf("response has no data object: %s", response.Body.String())
	}
	return data
}

func (env *financeSalesIntegrationEnv) seedCustomer(t *testing.T, organizationID, name string) string {
	t.Helper()
	var customerID string
	if err := env.owner.QueryRow(env.ctx,
		`INSERT INTO customers (org_id, name, email) VALUES ($1::uuid, $2, $3) RETURNING id`,
		organizationID, name, fmt.Sprintf("finance-sales-%d@example.test", time.Now().UnixNano())).Scan(&customerID); err != nil {
		t.Fatalf("seed customer: %v", err)
	}
	return customerID
}

type financeSalesIntegrationQuote struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func (env *financeSalesIntegrationEnv) quoteList(t *testing.T, response *httptest.ResponseRecorder) []financeSalesIntegrationQuote {
	t.Helper()
	var body struct {
		Quotes []financeSalesIntegrationQuote `json:"quotes"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode quote list %q: %v", response.Body.String(), err)
	}
	return body.Quotes
}

func financeSalesIntegrationHasQuote(quotes []financeSalesIntegrationQuote, quoteID, status string) bool {
	for _, quote := range quotes {
		if quote.ID == quoteID && quote.Status == status {
			return true
		}
	}
	return false
}

func TestQuoteCollectionIntegration(t *testing.T) {
	env := financeSalesIntegrationSetup(t, "accounting.read", "accounting.write")
	handler := NewQuotesSessionHandler(env.resolver, env.executor, env.logger)
	customerID := env.seedCustomer(t, env.fixture.orgA, "Quote Integration Customer")

	empty := env.call(t, handler, http.MethodGet, "/api/quotes", "", env.fixture.orgA)
	if empty.Code != http.StatusOK || len(env.quoteList(t, empty)) != 0 {
		t.Fatalf("empty quote list status=%d body=%s", empty.Code, empty.Body.String())
	}

	create := env.call(t, handler, http.MethodPost, "/api/quotes",
		fmt.Sprintf(`{"action":"create","customerId":%q,"memo":"Integration quote","lines":[{"description":"Consulting","quantity":2,"unitPriceMinor":12500}]}`, customerID),
		env.fixture.orgA)
	if create.Code != http.StatusOK {
		t.Fatalf("create quote status=%d body=%s", create.Code, create.Body.String())
	}
	createData := financeSalesIntegrationData(t, create)
	quoteID, _ := createData["quoteId"].(string)
	if !isUUID(quoteID) {
		t.Fatalf("quoteId=%q", quoteID)
	}
	if number, ok := createData["quoteNumber"].(float64); !ok || number < 1 {
		t.Fatalf("quoteNumber=%v", createData["quoteNumber"])
	}

	sent := env.call(t, handler, http.MethodGet, "/api/quotes?status=sent", "", env.fixture.orgA)
	if sent.Code != http.StatusOK || !financeSalesIntegrationHasQuote(env.quoteList(t, sent), quoteID, "sent") {
		t.Fatalf("sent list status=%d body=%s", sent.Code, sent.Body.String())
	}
	unsupported := env.call(t, handler, http.MethodGet, "/api/quotes?status=bogus", "", env.fixture.orgA)
	if unsupported.Code != http.StatusOK || !financeSalesIntegrationHasQuote(env.quoteList(t, unsupported), quoteID, "sent") {
		t.Fatalf("unsupported filter list status=%d body=%s", unsupported.Code, unsupported.Body.String())
	}

	decline := env.call(t, handler, http.MethodPost, "/api/quotes",
		fmt.Sprintf(`{"action":"decline","quoteId":%q}`, quoteID), env.fixture.orgA)
	if decline.Code != http.StatusOK || financeSalesIntegrationData(t, decline)["status"] != "declined" {
		t.Fatalf("decline status=%d body=%s", decline.Code, decline.Body.String())
	}
	declined := env.call(t, handler, http.MethodGet, "/api/quotes?status=declined", "", env.fixture.orgA)
	if !financeSalesIntegrationHasQuote(env.quoteList(t, declined), quoteID, "declined") {
		t.Fatalf("declined list body=%s", declined.Body.String())
	}
	stillSent := env.call(t, handler, http.MethodGet, "/api/quotes?status=sent", "", env.fixture.orgA)
	if financeSalesIntegrationHasQuote(env.quoteList(t, stillSent), quoteID, "sent") {
		t.Fatalf("declined quote stayed in sent list: %s", stillSent.Body.String())
	}

	crossOrg := env.call(t, handler, http.MethodGet, "/api/quotes", "", env.fixture.orgB)
	if crossOrg.Code != http.StatusForbidden {
		t.Fatalf("cross-org quote list status=%d body=%s", crossOrg.Code, crossOrg.Body.String())
	}
	unverified := env.do(t, handler, http.MethodGet, "/api/quotes", "", env.fixture.unverified, env.fixture.orgA)
	if unverified.Code != http.StatusUnauthorized {
		t.Fatalf("unverified quote list status=%d body=%s", unverified.Code, unverified.Body.String())
	}
}

type financeSalesIntegrationTemplate struct {
	ID        string `json:"id"`
	Active    bool   `json:"active"`
	Frequency string `json:"frequency"`
}

func (env *financeSalesIntegrationEnv) templateList(t *testing.T, response *httptest.ResponseRecorder) []financeSalesIntegrationTemplate {
	t.Helper()
	var body struct {
		Templates []financeSalesIntegrationTemplate `json:"templates"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode template list %q: %v", response.Body.String(), err)
	}
	return body.Templates
}

func TestRecurringCollectionIntegration(t *testing.T) {
	env := financeSalesIntegrationSetup(t, "accounting.read", "accounting.write")
	handler := NewRecurringSessionHandler(env.resolver, env.executor, env.logger)
	customerID := env.seedCustomer(t, env.fixture.orgA, "Recurring Integration Customer")

	create := env.call(t, handler, http.MethodPost, "/api/recurring",
		fmt.Sprintf(`{"action":"create","customerId":%q,"frequency":"monthly","memo":"Retainer","lines":[{"description":"Support","quantity":1,"unitPriceMinor":50000}]}`, customerID),
		env.fixture.orgA)
	if create.Code != http.StatusOK {
		t.Fatalf("create template status=%d body=%s", create.Code, create.Body.String())
	}
	createData := financeSalesIntegrationData(t, create)
	templateID, _ := createData["templateId"].(string)
	if !isUUID(templateID) {
		t.Fatalf("templateId=%q", templateID)
	}
	if nextRunAt, _ := createData["nextRunAt"].(string); nextRunAt == "" {
		t.Fatalf("nextRunAt=%v", createData["nextRunAt"])
	}

	list := env.call(t, handler, http.MethodGet, "/api/recurring", "", env.fixture.orgA)
	templates := env.templateList(t, list)
	if list.Code != http.StatusOK || len(templates) != 1 || templates[0].ID != templateID || !templates[0].Active || templates[0].Frequency != "monthly" {
		t.Fatalf("template list status=%d body=%s", list.Code, list.Body.String())
	}

	pause := env.call(t, handler, http.MethodPost, "/api/recurring",
		fmt.Sprintf(`{"action":"pause","templateId":%q}`, templateID), env.fixture.orgA)
	if pause.Code != http.StatusOK || financeSalesIntegrationData(t, pause)["active"] != false {
		t.Fatalf("pause status=%d body=%s", pause.Code, pause.Body.String())
	}
	paused := env.templateList(t, env.call(t, handler, http.MethodGet, "/api/recurring", "", env.fixture.orgA))
	if len(paused) != 1 || paused[0].Active {
		t.Fatalf("paused list body=%v", paused)
	}

	resume := env.call(t, handler, http.MethodPost, "/api/recurring",
		fmt.Sprintf(`{"action":"resume","templateId":%q}`, templateID), env.fixture.orgA)
	if resume.Code != http.StatusOK || financeSalesIntegrationData(t, resume)["active"] != true {
		t.Fatalf("resume status=%d body=%s", resume.Code, resume.Body.String())
	}

	crossOrg := env.call(t, handler, http.MethodGet, "/api/recurring", "", env.fixture.orgB)
	if crossOrg.Code != http.StatusForbidden {
		t.Fatalf("cross-org template list status=%d body=%s", crossOrg.Code, crossOrg.Body.String())
	}
}

func TestReportsRouteIntegration(t *testing.T) {
	env := financeSalesIntegrationSetup(t, "accounting.read")
	handler := NewReportsSessionHandler(env.resolver, env.executor, env.logger)

	report := env.call(t, handler, http.MethodGet, "/api/reports", "", env.fixture.orgA)
	if report.Code != http.StatusOK {
		t.Fatalf("reports status=%d body=%s", report.Code, report.Body.String())
	}
	body := financeSalesIntegrationDecode(t, report)
	if body["baseCurrency"] != "USD" {
		t.Fatalf("baseCurrency=%v", body["baseCurrency"])
	}
	pnl, _ := body["pnl"].(map[string]any)
	if pnl == nil {
		t.Fatalf("pnl missing: %s", report.Body.String())
	}
	if _, ok := pnl["revenueMinor"]; !ok {
		t.Fatalf("pnl revenueMinor missing: %s", report.Body.String())
	}
	balanceSheet, _ := body["balanceSheet"].(map[string]any)
	if balanceSheet == nil || balanceSheet["balanced"] != true {
		t.Fatalf("balanceSheet=%v", body["balanceSheet"])
	}

	financeSalesIntegrationGrant(t, env.ctx, env.owner, env.fixture, env.fixture.orgB, []string{"accounting.read"})
	restricted := env.call(t, handler, http.MethodGet, "/api/reports", "", env.fixture.orgB)
	if restricted.Code != http.StatusForbidden || !strings.Contains(restricted.Body.String(), "accounting module is disabled") {
		t.Fatalf("restricted reports status=%d body=%s", restricted.Code, restricted.Body.String())
	}
}

type financeSalesIntegrationOrder struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func (env *financeSalesIntegrationEnv) orderList(t *testing.T, response *httptest.ResponseRecorder) []financeSalesIntegrationOrder {
	t.Helper()
	var body struct {
		Orders []financeSalesIntegrationOrder `json:"orders"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode order list %q: %v", response.Body.String(), err)
	}
	return body.Orders
}

func financeSalesIntegrationHasOrder(orders []financeSalesIntegrationOrder, orderID, status string) bool {
	for _, order := range orders {
		if order.ID == orderID && order.Status == status {
			return true
		}
	}
	return false
}

func TestSalesCollectionIntegration(t *testing.T) {
	env := financeSalesIntegrationSetup(t, "sales.read", "sales.write")
	writer := NewSalesOrdersWriteSessionHandler(env.resolver, env.executor, env.logger)
	reader := NewSalesOrdersSessionHandler(env.resolver, env.executor, env.logger)
	customerID := env.seedCustomer(t, env.fixture.orgA, "Sales Integration Customer")

	create := env.call(t, writer, http.MethodPost, "/api/sales",
		fmt.Sprintf(`{"action":"create","customerId":%q,"note":"Integration order","lines":[{"description":"Consulting","quantity":2,"unitPriceMinor":1000}]}`, customerID),
		env.fixture.orgA)
	if create.Code != http.StatusOK {
		t.Fatalf("create order status=%d body=%s", create.Code, create.Body.String())
	}
	orderID, _ := financeSalesIntegrationData(t, create)["orderId"].(string)
	if !isUUID(orderID) {
		t.Fatalf("orderId=%q", orderID)
	}

	confirm := env.call(t, writer, http.MethodPost, "/api/sales",
		fmt.Sprintf(`{"action":"confirm","orderId":%q,"allowBackorder":true}`, orderID), env.fixture.orgA)
	if confirm.Code != http.StatusOK || financeSalesIntegrationData(t, confirm)["confirmed"] != true {
		t.Fatalf("confirm order status=%d body=%s", confirm.Code, confirm.Body.String())
	}
	confirmed := env.orderList(t, env.call(t, reader, http.MethodGet, "/api/sales?status=confirmed", "", env.fixture.orgA))
	if !financeSalesIntegrationHasOrder(confirmed, orderID, "confirmed") {
		t.Fatalf("confirmed order missing: %v", confirmed)
	}

	cancel := env.call(t, writer, http.MethodPost, "/api/sales",
		fmt.Sprintf(`{"action":"cancel","orderId":%q}`, orderID), env.fixture.orgA)
	if cancel.Code != http.StatusOK || financeSalesIntegrationData(t, cancel)["status"] != "cancelled" {
		t.Fatalf("cancel order status=%d body=%s", cancel.Code, cancel.Body.String())
	}
	cancelled := env.orderList(t, env.call(t, reader, http.MethodGet, "/api/sales?status=cancelled", "", env.fixture.orgA))
	if !financeSalesIntegrationHasOrder(cancelled, orderID, "cancelled") {
		t.Fatalf("cancelled order missing: %v", cancelled)
	}

	crossOrg := env.call(t, writer, http.MethodPost, "/api/sales",
		fmt.Sprintf(`{"action":"create","customerId":%q,"lines":[{"description":"Cross org","quantity":1,"unitPriceMinor":1}]}`, customerID), env.fixture.orgB)
	if crossOrg.Code != http.StatusForbidden {
		t.Fatalf("cross-org sales write status=%d body=%s", crossOrg.Code, crossOrg.Body.String())
	}
}

func TestInventoryCollectionIntegration(t *testing.T) {
	env := financeSalesIntegrationSetup(t, "inventory.read", "inventory.write")
	handler := NewInventoryWriteSessionHandler(env.resolver, env.executor, env.logger)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	sku := "INTEGRATION-SKU-" + suffix
	barcode := "INTEGRATION-BAR-" + suffix

	create := env.call(t, handler, http.MethodPost, "/api/inventory",
		fmt.Sprintf(`{"action":"createItem","sku":%q,"name":"Integration Widget","barcode":%q,"salePriceMinor":5000,"tags":["integration"]}`, sku, barcode),
		env.fixture.orgA)
	if create.Code != http.StatusOK {
		t.Fatalf("create item status=%d body=%s", create.Code, create.Body.String())
	}
	if itemID, _ := financeSalesIntegrationData(t, create)["itemId"].(string); !isUUID(itemID) {
		t.Fatalf("itemId=%q", itemID)
	}

	adjust := env.call(t, handler, http.MethodPost, "/api/inventory",
		fmt.Sprintf(`{"action":"adjustStock","sku":%q,"quantityDelta":6000,"note":"opening stock"}`, sku), env.fixture.orgA)
	if adjust.Code != http.StatusOK || financeSalesIntegrationData(t, adjust)["onHandThousandths"] != float64(6000) {
		t.Fatalf("adjust stock status=%d body=%s", adjust.Code, adjust.Body.String())
	}

	history := env.call(t, handler, http.MethodPost, "/api/inventory",
		fmt.Sprintf(`{"action":"stockHistory","sku":%q}`, sku), env.fixture.orgA)
	if history.Code != http.StatusOK {
		t.Fatalf("stock history status=%d body=%s", history.Code, history.Body.String())
	}
	movements, _ := financeSalesIntegrationData(t, history)["movements"].([]any)
	if len(movements) == 0 {
		t.Fatalf("stock history body=%s", history.Body.String())
	}

	lookup := env.call(t, handler, http.MethodPost, "/api/inventory",
		fmt.Sprintf(`{"action":"lookupByBarcode","barcode":%q}`, barcode), env.fixture.orgA)
	if lookup.Code != http.StatusOK {
		t.Fatalf("lookup barcode status=%d body=%s", lookup.Code, lookup.Body.String())
	}
	item, _ := financeSalesIntegrationData(t, lookup)["item"].(map[string]any)
	if item == nil || item["sku"] != sku {
		t.Fatalf("lookup item=%v", item)
	}

	reserve := env.call(t, handler, http.MethodPost, "/api/inventory",
		fmt.Sprintf(`{"action":"reserveStock","sku":%q,"quantityThousandths":1000,"reason":"integration hold"}`, sku), env.fixture.orgA)
	if reserve.Code != http.StatusOK {
		t.Fatalf("reserve stock status=%d body=%s", reserve.Code, reserve.Body.String())
	}
	reservationID, _ := financeSalesIntegrationData(t, reserve)["reservationId"].(string)
	if !isUUID(reservationID) {
		t.Fatalf("reservationId=%q", reservationID)
	}
	release := env.call(t, handler, http.MethodPost, "/api/inventory",
		fmt.Sprintf(`{"action":"releaseReservation","reservationId":%q}`, reservationID), env.fixture.orgA)
	if release.Code != http.StatusOK || financeSalesIntegrationData(t, release)["released"] != true {
		t.Fatalf("release reservation status=%d body=%s", release.Code, release.Body.String())
	}

	count := env.call(t, handler, http.MethodPost, "/api/inventory",
		fmt.Sprintf(`{"action":"createCycleCount","note":"integration count","skus":[%q]}`, sku), env.fixture.orgA)
	if count.Code != http.StatusOK {
		t.Fatalf("create cycle count status=%d body=%s", count.Code, count.Body.String())
	}
	countID, _ := financeSalesIntegrationData(t, count)["countId"].(string)
	if !isUUID(countID) {
		t.Fatalf("countId=%q", countID)
	}
	record := env.call(t, handler, http.MethodPost, "/api/inventory",
		fmt.Sprintf(`{"action":"recordCycleCounts","countId":%q,"counts":[{"sku":%q,"countedThousandths":6000}]}`, countID, sku), env.fixture.orgA)
	if record.Code != http.StatusOK || financeSalesIntegrationData(t, record)["recorded"] != float64(1) {
		t.Fatalf("record cycle counts status=%d body=%s", record.Code, record.Body.String())
	}
	post := env.call(t, handler, http.MethodPost, "/api/inventory",
		fmt.Sprintf(`{"action":"postCycleCount","countId":%q}`, countID), env.fixture.orgA)
	if post.Code != http.StatusOK || financeSalesIntegrationData(t, post)["posted"] != true {
		t.Fatalf("post cycle count status=%d body=%s", post.Code, post.Body.String())
	}

	valuation := env.call(t, handler, http.MethodPost, "/api/inventory",
		`{"action":"postValuationSummary","memo":"Integration valuation"}`, env.fixture.orgA)
	if valuation.Code != http.StatusOK {
		t.Fatalf("post valuation status=%d body=%s", valuation.Code, valuation.Body.String())
	}
	valuationData := financeSalesIntegrationData(t, valuation)
	if valuationData["posted"] != false || valuationData["varianceMinor"] != float64(0) {
		t.Fatalf("uncosted valuation must be a no-op: %s", valuation.Body.String())
	}

	crossOrg := env.call(t, handler, http.MethodPost, "/api/inventory",
		fmt.Sprintf(`{"action":"adjustStock","sku":%q,"quantityDelta":1000,"note":"cross org"}`, sku), env.fixture.orgB)
	if crossOrg.Code != http.StatusForbidden {
		t.Fatalf("cross-org inventory write status=%d body=%s", crossOrg.Code, crossOrg.Body.String())
	}
}
