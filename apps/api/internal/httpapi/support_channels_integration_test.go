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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSupportChannelsHandlerUsesRuntimeRLSAndAuthorization(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for Support channels integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for Support channels integration proof")
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
	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["support"]'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatalf("enable Support in restricted fixture organization: %v", err)
	}
	orgAToken := "support-channels-" + fixture.orgA + "-org-a-seed-token"
	orgBTokenSeed := "support-channels-" + fixture.orgB + "-org-b-seed-token"
	if _, err := owner.Exec(ctx, `
		INSERT INTO support_settings (org_id, embed_token, auto_reply_enabled, greeting)
		VALUES ($1::uuid, $2, true, 'Org A greeting'), ($3::uuid, $4, true, 'Org B greeting')`,
		fixture.orgA, orgAToken, fixture.orgB, orgBTokenSeed); err != nil {
		t.Fatalf("seed Support channel settings: %v", err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler, err := NewSupportChannelsHandler(runtime, resolver, capability.NewExecutor(runtime, "", "", ""), nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	requestSequence := 0
	requestWithKey := func(method, body, organizationID, intentID string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "https://app.example.test/api/support/channels", strings.NewReader(body))
		req.TLS = &tls.ConnectionState{}
		req.Host = "app.example.test"
		req.Header.Set("Origin", "https://app.example.test")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", intentID)
		req.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
		req.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: organizationID})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	request := func(method, body, organizationID string) *httptest.ResponseRecorder {
		requestSequence++
		intentID := fmt.Sprintf("40000000-0000-4000-8000-%012x", requestSequence)
		return requestWithKey(method, body, organizationID, intentID)
	}
	decode := func(response *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response %q: %v", response.Body.String(), err)
		}
		return body
	}

	adminRead := request(http.MethodGet, "", fixture.orgA)
	adminBody := decode(adminRead)
	if adminRead.Code != http.StatusOK || adminBody["greeting"] != "Org A greeting" || adminBody["embedToken"] != orgAToken || adminBody["canManage"] != true {
		t.Fatalf("admin GET status=%d body=%v, want org A settings and management access", adminRead.Code, adminBody)
	}
	if adminRead.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("admin GET Cache-Control=%q, want no-store", adminRead.Header().Get("Cache-Control"))
	}

	malformed := request(http.MethodPost, `{"greeting":"Should not persist","unknown":true}`, fixture.orgA)
	if malformed.Code != http.StatusBadRequest {
		t.Fatalf("malformed POST status=%d body=%s, want 400", malformed.Code, malformed.Body.String())
	}

	adminWriteKey := "40000000-0000-4000-8000-000000000099"
	adminWriteBodyJSON := `{"autoReplyEnabled":false,"greeting":"  Updated org A greeting  ","regenerateToken":true}`
	adminWrite := requestWithKey(http.MethodPost, adminWriteBodyJSON, fixture.orgA, adminWriteKey)
	adminWriteBody := decode(adminWrite)
	newToken, _ := adminWriteBody["embedToken"].(string)
	if adminWrite.Code != http.StatusOK || adminWriteBody["autoReplyEnabled"] != false || adminWriteBody["greeting"] != "Updated org A greeting" || adminWriteBody["canManage"] != true {
		t.Fatalf("admin POST status=%d body=%v, want persisted settings response", adminWrite.Code, adminWriteBody)
	}
	if len(newToken) != 64 || newToken == orgAToken {
		t.Fatalf("regenerated embed token length=%d equalPrevious=%t, want a new 32-byte hex token", len(newToken), newToken == orgAToken)
	}
	replayedWrite := requestWithKey(http.MethodPost, adminWriteBodyJSON, fixture.orgA, adminWriteKey)
	replayedBody := decode(replayedWrite)
	if replayedWrite.Code != http.StatusOK || replayedBody["embedToken"] != newToken {
		t.Fatalf("same-key replay status=%d body=%v, want the original generated token", replayedWrite.Code, replayedBody)
	}
	var savedEnabled bool
	var savedGreeting, savedToken string
	if err := owner.QueryRow(ctx, `SELECT auto_reply_enabled, greeting, embed_token FROM support_settings WHERE org_id=$1::uuid`, fixture.orgA).Scan(&savedEnabled, &savedGreeting, &savedToken); err != nil {
		t.Fatal(err)
	}
	if savedEnabled || savedGreeting != "Updated org A greeting" || savedToken != newToken {
		t.Fatalf("persisted org A settings enabled=%t greeting=%q tokenMatchesResponse=%t", savedEnabled, savedGreeting, savedToken == newToken)
	}

	restrictedRead := request(http.MethodGet, "", fixture.orgB)
	restrictedBody := decode(restrictedRead)
	if restrictedRead.Code != http.StatusOK || restrictedBody["greeting"] != "Org B greeting" || restrictedBody["canManage"] != false || restrictedBody["embedToken"] != nil {
		t.Fatalf("restricted GET status=%d body=%v, want org B greeting and hidden token", restrictedRead.Code, restrictedBody)
	}
	if strings.Contains(restrictedRead.Body.String(), "Org A greeting") || strings.Contains(restrictedRead.Body.String(), newToken) {
		t.Fatalf("restricted GET exposed foreign organization data: %s", restrictedRead.Body.String())
	}
	restrictedWrite := request(http.MethodPost, `{"greeting":"Unauthorized change"}`, fixture.orgB)
	if restrictedWrite.Code != http.StatusForbidden {
		t.Fatalf("restricted POST status=%d body=%s, want 403", restrictedWrite.Code, restrictedWrite.Body.String())
	}
	var orgBGreeting, orgBToken string
	if err := owner.QueryRow(ctx, `SELECT greeting, embed_token FROM support_settings WHERE org_id=$1::uuid`, fixture.orgB).Scan(&orgBGreeting, &orgBToken); err != nil {
		t.Fatal(err)
	}
	if orgBGreeting != "Org B greeting" || orgBToken != orgBTokenSeed {
		t.Fatalf("restricted org B settings changed after denied write: greeting=%q token=%q", orgBGreeting, orgBToken)
	}

	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["crm"]'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatalf("disable Support in org B: %v", err)
	}
	disabledRead := request(http.MethodGet, "", fixture.orgB)
	if disabledRead.Code != http.StatusNotFound {
		t.Fatalf("disabled module GET status=%d body=%s, want 404", disabledRead.Code, disabledRead.Body.String())
	}
	disabledWrite := request(http.MethodPost, `{"greeting":"Disabled module change"}`, fixture.orgB)
	if disabledWrite.Code != http.StatusNotFound {
		t.Fatalf("disabled module POST status=%d body=%s, want 404", disabledWrite.Code, disabledWrite.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT greeting FROM support_settings WHERE org_id=$1::uuid`, fixture.orgB).Scan(&orgBGreeting); err != nil || orgBGreeting != "Org B greeting" {
		t.Fatalf("disabled module write changed org B greeting=%q err=%v", orgBGreeting, err)
	}

	visibleForeignRows, err := dbx.WithOrgTx(ctx, runtime, fixture.orgA, func(tx pgx.Tx) (int, error) {
		var count int
		err := tx.QueryRow(ctx, `SELECT count(*) FROM support_settings WHERE org_id=$1::uuid`, fixture.orgB).Scan(&count)
		return count, err
	})
	if err != nil || visibleForeignRows != 0 {
		t.Fatalf("runtime role saw %d foreign support settings rows with org A context, err=%v", visibleForeignRows, err)
	}

	unavailablePool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	unavailablePool.Close()
	orgA := fixture.orgA
	unavailableUser := &session.ResolvedUser{UserID: fixture.userID, OrgID: &orgA, EmailVerified: true, Permissions: map[string]bool{"iam.admin": true}}
	unavailableHandler := newSupportChannelsHandler(newPgSupportChannelsStore(unavailablePool), supportChannelsTestResolver{resolved: unavailableUser}, nil, nil, logger)
	unavailable := requestSupportChannels(unavailableHandler, http.MethodGet, "", fixture.cookie, fixture.orgA)
	if unavailable.Code != http.StatusInternalServerError || unavailable.Body.String() != "{\"error\":\"internal error\"}\n" {
		t.Fatalf("unavailable database GET status=%d body=%s, want generic 500", unavailable.Code, unavailable.Body.String())
	}
}

func requestSupportChannels(handler http.Handler, method, body, signedCookie, organizationID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "https://app.example.test/api/support/channels", strings.NewReader(body))
	req.TLS = &tls.ConnectionState{}
	req.Host = "app.example.test"
	req.Header.Set("Origin", "https://app.example.test")
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: signedCookie})
	req.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: organizationID})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}
