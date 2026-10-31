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

func TestModuleSettingsSessionHandlerRuntimeRLS(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for module settings session integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for module settings session integration proof")
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
	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["crm","iam","inventory"]'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatalf("enable required modules in reader organization: %v", err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO module_settings (org_id,module,settings) VALUES
		($1::uuid,'inventory','{"defaultUnitLabel":"each","defaultReorderPointUnits":7,"legacyExtra":"strip"}'::jsonb),
		($2::uuid,'inventory','{"defaultUnitLabel":"box","defaultReorderPointUnits":2}'::jsonb)`, fixture.orgA, fixture.orgB); err != nil {
		t.Fatalf("seed organization module settings: %v", err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewModuleSettingsSessionHandler(runtime, resolver, capability.NewExecutor(runtime, "", "", ""), slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := func(method, target, body, orgID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://app.example.test"+target, strings.NewReader(body))
		r.TLS = &tls.ConnectionState{}
		r.Host = "app.example.test"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://app.example.test")
		r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
		r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response
	}

	local := request(http.MethodGet, "/api/module-settings?module=inventory", "", fixture.orgA)
	var localBody struct {
		Module   string         `json:"module"`
		Settings map[string]any `json:"settings"`
	}
	if err := json.Unmarshal(local.Body.Bytes(), &localBody); err != nil || local.Code != http.StatusOK {
		t.Fatalf("local settings status=%d body=%s decodeErr=%v", local.Code, local.Body.String(), err)
	}
	if localBody.Module != "inventory" || localBody.Settings["defaultUnitLabel"] != "each" || localBody.Settings["defaultReorderPointUnits"] != float64(7) || localBody.Settings["legacyExtra"] != nil {
		t.Fatalf("local settings projection=%+v", localBody)
	}

	missing := request(http.MethodGet, "/api/module-settings?module=crm", "", fixture.orgA)
	if missing.Code != http.StatusOK || missing.Body.String() != `{"module":"crm","settings":{}}`+"\n" {
		t.Fatalf("missing settings row status=%d body=%s", missing.Code, missing.Body.String())
	}

	foreign := request(http.MethodGet, "/api/module-settings?module=inventory", "", fixture.orgB)
	var foreignBody struct {
		Settings map[string]any `json:"settings"`
	}
	if err := json.Unmarshal(foreign.Body.Bytes(), &foreignBody); err != nil || foreign.Code != http.StatusOK || foreignBody.Settings["defaultUnitLabel"] != "box" {
		t.Fatalf("foreign org settings status=%d body=%s decodeErr=%v", foreign.Code, foreign.Body.String(), err)
	}

	denied := request(http.MethodPost, "/api/module-settings", `{"module":"inventory","settings":{"defaultUnitLabel":"shelf","defaultReorderPointUnits":11},"intentId":"11111111-1111-4111-8111-111111111111"}`, fixture.orgB)
	if denied.Code != http.StatusUnprocessableEntity || !strings.Contains(denied.Body.String(), "iam.admin") {
		t.Fatalf("write without iam.admin status=%d body=%s", denied.Code, denied.Body.String())
	}
	var afterDenied string
	if err := owner.QueryRow(ctx, `SELECT settings->>'defaultUnitLabel' FROM module_settings WHERE org_id=$1::uuid AND module='inventory'`, fixture.orgB).Scan(&afterDenied); err != nil || afterDenied != "box" {
		t.Fatalf("settings after denied write=%q err=%v", afterDenied, err)
	}

	allowed := request(http.MethodPost, "/api/module-settings", `{"module":"inventory","settings":{"defaultUnitLabel":" shelf ","defaultReorderPointUnits":11},"intentId":"22222222-2222-4222-8222-222222222222"}`, fixture.orgA)
	if allowed.Code != http.StatusOK || !strings.Contains(allowed.Body.String(), `"ok":true`) || !strings.Contains(allowed.Body.String(), `"module":"inventory"`) {
		t.Fatalf("authorized write status=%d body=%s", allowed.Code, allowed.Body.String())
	}
	var savedLabel string
	var savedReorder int
	if err := owner.QueryRow(ctx, `SELECT settings->>'defaultUnitLabel', (settings->>'defaultReorderPointUnits')::int FROM module_settings WHERE org_id=$1::uuid AND module='inventory'`, fixture.orgA).Scan(&savedLabel, &savedReorder); err != nil || savedLabel != "shelf" || savedReorder != 11 {
		t.Fatalf("saved settings label=%q reorder=%d err=%v", savedLabel, savedReorder, err)
	}
	var auditCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id='iam.setModuleConfig'`, fixture.orgA).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("module settings audit count=%d err=%v", auditCount, err)
	}
}
