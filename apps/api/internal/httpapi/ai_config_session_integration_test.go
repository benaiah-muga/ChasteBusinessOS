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

func TestAIConfigSessionHandlerRuntimeRLSAndGovernedWrite(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for AI config session integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for AI config session integration proof")
	}
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "ai-config-route-integration-encryption-secret")
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
	if _, err := owner.Exec(ctx, `UPDATE organizations SET settings='{"branding":{"layout":"preserve-a"},"ai":{"provider":"custom","baseUrl":"https://a.example/v1","models":{"primary":"a-p","fast":"a-f","reasoning":"a-r","embeddings":"a-e"},"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-10-11T00:00:00Z"}}'::jsonb WHERE id=$1::uuid`, fixture.orgA); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `UPDATE organizations SET settings='{"ai":{"provider":"openai","baseUrl":"https://api.openai.com/v1","models":{"primary":"b-p","fast":"b-f","reasoning":"b-r","embeddings":"b-e"},"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-10-11T00:00:00Z"}}'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatal(err)
	}
	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAIConfigSessionHandler(runtime, resolver, capability.NewExecutor(runtime, "", "", ""), slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := func(method, body, orgID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://app.example.test/api/ai-config", strings.NewReader(body))
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
	for _, test := range []struct{ orgID, provider string }{{fixture.orgA, "custom"}, {fixture.orgB, "openai"}} {
		response := request(http.MethodGet, "", test.orgID)
		var body aiConfigDTO
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusOK || body.Provider != test.provider || body.Source != "workspace" {
			t.Fatalf("org=%s GET status=%d DTO=%+v err=%v body=%s", test.orgID, response.Code, body, err, response.Body.String())
		}
	}
	const intentB = "55555555-5555-4555-8555-555555555555"
	deniedBody := `{"provider":"openai","baseUrl":"https://api.openai.com/v1","models":{"primary":"p","fast":"f","reasoning":"r","embeddings":"e"},"apiKey":"denied-key","intentId":"` + intentB + `","updatedAt":"2026-10-11T00:00:00Z"}`
	denied := request(http.MethodPost, deniedBody, fixture.orgB)
	if denied.Code != http.StatusUnprocessableEntity || !strings.Contains(denied.Body.String(), "iam.admin") {
		t.Fatalf("non-admin AI config write status=%d body=%s", denied.Code, denied.Body.String())
	}
	var unchanged string
	if err := owner.QueryRow(ctx, `SELECT settings->'ai'->>'provider' FROM organizations WHERE id=$1::uuid`, fixture.orgB).Scan(&unchanged); err != nil || unchanged != "openai" {
		t.Fatalf("denied workspace config provider=%q err=%v", unchanged, err)
	}
	const intentA = "66666666-6666-4666-8666-666666666666"
	if _, err := owner.Exec(ctx, `INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, requires_approval_for) VALUES ($1::uuid,'settings.configureAiProvider','write','["secret"]'::jsonb)`, fixture.orgA); err != nil {
		t.Fatal(err)
	}
	pendingBody := `{"provider":"custom","baseUrl":"https://models.example/v1","models":{"primary":"pending-p","fast":"pending-f","reasoning":"pending-r","embeddings":"pending-e"},"apiKey":"pending-provider-secret","intentId":"77777777-7777-4777-8777-777777777777","updatedAt":"2026-10-11T00:00:00Z"}`
	pendingFirst := request(http.MethodPost, pendingBody, fixture.orgA)
	var pendingFirstBody map[string]json.RawMessage
	if err := json.Unmarshal(pendingFirst.Body.Bytes(), &pendingFirstBody); err != nil || pendingFirst.Code != http.StatusAccepted || string(pendingFirstBody["pendingApproval"]) != "true" {
		t.Fatalf("first approval request status=%d body=%s err=%v", pendingFirst.Code, pendingFirst.Body.String(), err)
	}
	var firstApprovalID string
	if err := json.Unmarshal(pendingFirstBody["approvalId"], &firstApprovalID); err != nil || firstApprovalID == "" {
		t.Fatalf("first approval response=%s err=%v", pendingFirst.Body.String(), err)
	}
	pendingSecond := request(http.MethodPost, pendingBody, fixture.orgA)
	var pendingSecondBody map[string]json.RawMessage
	if err := json.Unmarshal(pendingSecond.Body.Bytes(), &pendingSecondBody); err != nil || pendingSecond.Code != http.StatusAccepted {
		t.Fatalf("retried approval request status=%d body=%s err=%v", pendingSecond.Code, pendingSecond.Body.String(), err)
	}
	var secondApprovalID string
	if err := json.Unmarshal(pendingSecondBody["approvalId"], &secondApprovalID); err != nil || secondApprovalID != firstApprovalID {
		t.Fatalf("same-intent retry approval id=%q want=%q body=%s err=%v", secondApprovalID, firstApprovalID, pendingSecond.Body.String(), err)
	}
	if _, err := owner.Exec(ctx, `DELETE FROM policies WHERE org_id=$1::uuid AND capability_pattern='settings.configureAiProvider'`, fixture.orgA); err != nil {
		t.Fatal(err)
	}
	allowedBody := `{"provider":"custom","baseUrl":"https://models.example/v1","models":{"primary":"p","fast":"f","reasoning":"r","embeddings":"e"},"apiKey":"integration-provider-secret","intentId":"` + intentA + `","updatedAt":"2026-10-11T00:00:00Z"}`
	allowed := request(http.MethodPost, allowedBody, fixture.orgA)
	if allowed.Code != http.StatusOK || !strings.Contains(allowed.Body.String(), `"ok":true`) || strings.Contains(allowed.Body.String(), "integration-provider-secret") || strings.Contains(allowed.Body.String(), "encryptedApiKey") {
		t.Fatalf("authorized AI config write status=%d body=%s", allowed.Code, allowed.Body.String())
	}
	var storedKey, sibling string
	if err := owner.QueryRow(ctx, `SELECT settings->'ai'->>'encryptedApiKey', settings->'branding'->>'layout' FROM organizations WHERE id=$1::uuid`, fixture.orgA).Scan(&storedKey, &sibling); err != nil || storedKey == "" || sibling != "preserve-a" {
		t.Fatalf("saved ciphertext present=%t sibling=%q err=%v", storedKey != "", sibling, err)
	}
	if plain, err := decryptAIProviderKey(storedKey); err != nil || plain != "integration-provider-secret" {
		t.Fatalf("stored provider key decrypt=%q err=%v", plain, err)
	}
	replayed := request(http.MethodPost, allowedBody, fixture.orgA)
	if replayed.Code != http.StatusOK || !strings.Contains(replayed.Body.String(), `"ok":true`) {
		t.Fatalf("retry of same intent status=%d body=%s", replayed.Code, replayed.Body.String())
	}
	var auditCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id='settings.configureAiProvider'`, fixture.orgA).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("AI config audit count=%d err=%v", auditCount, err)
	}
}
