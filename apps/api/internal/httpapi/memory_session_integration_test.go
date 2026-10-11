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

func TestMemorySessionHandlerRuntimeRLS(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for memory session integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for memory session integration proof")
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
	if _, err := owner.Exec(ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		SELECT role_id, 'documents.write', org_id FROM user_roles WHERE user_id=$1::uuid AND org_id=$2::uuid`,
		fixture.userID, fixture.orgA); err != nil {
		t.Fatalf("grant documents.write in org A: %v", err)
	}
	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["crm","documents"]'::jsonb WHERE id=$1::uuid`, fixture.orgB); err != nil {
		t.Fatalf("enable documents in org B fixture: %v", err)
	}
	localID, err := seedMemoryProjection(owner, ctx, fixture.orgA, "sop", "Needle-Source.txt", "Local profile contains scheduling notes")
	if err != nil {
		t.Fatal(err)
	}
	secondLocalID, err := seedMemoryProjection(owner, ctx, fixture.orgA, "decision", "minutes.md", "Needle appears in an old decision")
	if err != nil {
		t.Fatal(err)
	}
	foreignID, err := seedMemoryProjection(owner, ctx, fixture.orgB, "sop", "foreign.md", "Foreign organization needle")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := owner.Exec(context.Background(), `DELETE FROM memories WHERE id = ANY($1::uuid[])`, []string{localID, secondLocalID, foreignID}); err != nil {
			t.Errorf("delete memory route fixture rows: %v", err)
		}
	})

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewMemorySessionHandler(runtime, resolver, capability.NewExecutor(runtime, "", "", ""), slog.New(slog.NewTextHandler(io.Discard, nil)))
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

	allLocal := request(http.MethodGet, "/api/memory", "", fixture.orgA)
	var allBody struct {
		Memories []map[string]any `json:"memories"`
		Total    int              `json:"total"`
		CanEdit  bool             `json:"canEdit"`
	}
	if err := json.Unmarshal(allLocal.Body.Bytes(), &allBody); err != nil || allLocal.Code != http.StatusOK {
		t.Fatalf("blank query response status=%d body=%s decodeErr=%v", allLocal.Code, allLocal.Body.String(), err)
	}
	if len(allBody.Memories) != 2 || allBody.Total != 2 || !allBody.CanEdit {
		t.Fatalf("blank query response=%+v, want two local rows, total=2, canEdit=true", allBody)
	}

	oneCharacter := request(http.MethodGet, "/api/memory?q=x", "", fixture.orgA)
	var oneBody struct {
		Memories []map[string]any `json:"memories"`
		Total    int              `json:"total"`
	}
	if err := json.Unmarshal(oneCharacter.Body.Bytes(), &oneBody); err != nil || oneCharacter.Code != http.StatusOK {
		t.Fatalf("one-character search status=%d body=%s decodeErr=%v", oneCharacter.Code, oneCharacter.Body.String(), err)
	}
	if len(oneBody.Memories) != 1 || oneBody.Total != 2 || oneBody.Memories[0]["id"] != localID {
		t.Fatalf("one-character source search=%+v, want source-only local row and pre-filter total=2", oneBody)
	}

	sourceSearch := request(http.MethodGet, "/api/memory?q=source", "", fixture.orgA)
	if sourceSearch.Code != http.StatusOK || !strings.Contains(sourceSearch.Body.String(), localID) || strings.Contains(sourceSearch.Body.String(), secondLocalID) {
		t.Fatalf("source search status=%d body=%s", sourceSearch.Code, sourceSearch.Body.String())
	}

	foreignSearch := request(http.MethodGet, "/api/memory?q=needle", "", fixture.orgB)
	if foreignSearch.Code != http.StatusOK || !strings.Contains(foreignSearch.Body.String(), foreignID) || strings.Contains(foreignSearch.Body.String(), localID) || strings.Contains(foreignSearch.Body.String(), secondLocalID) {
		t.Fatalf("foreign org search leaked rows: status=%d body=%s", foreignSearch.Code, foreignSearch.Body.String())
	}
	var foreignBody struct {
		Memories []map[string]any `json:"memories"`
		CanEdit  bool             `json:"canEdit"`
	}
	if err := json.Unmarshal(foreignSearch.Body.Bytes(), &foreignBody); err != nil || foreignBody.CanEdit {
		t.Fatalf("foreign org canEdit=%t, decodeErr=%v body=%s", foreignBody.CanEdit, err, foreignSearch.Body.String())
	}

	deniedDelete := request(http.MethodPost, "/api/memory", `{"action":"delete","memoryId":"`+localID+`","intentId":"11111111-1111-4111-8111-111111111111"}`, fixture.orgB)
	if deniedDelete.Code != http.StatusUnprocessableEntity || !strings.Contains(deniedDelete.Body.String(), "documents.write") {
		t.Fatalf("unauthorized org B deletion status=%d body=%s", deniedDelete.Code, deniedDelete.Body.String())
	}
	var stillThere int
	if err := owner.QueryRow(ctx, `SELECT count(*)::int FROM memories WHERE id=$1::uuid`, localID).Scan(&stillThere); err != nil || stillThere != 1 {
		t.Fatalf("org A memory count after org B denial=%d error=%v", stillThere, err)
	}

	allowedDelete := request(http.MethodPost, "/api/memory", `{"action":"delete","memoryId":"`+localID+`","intentId":"22222222-2222-4222-8222-222222222222"}`, fixture.orgA)
	if allowedDelete.Code != http.StatusOK || !strings.Contains(allowedDelete.Body.String(), `"ok":true`) || !strings.Contains(allowedDelete.Body.String(), `"deleted":true`) {
		t.Fatalf("authorized org A deletion status=%d body=%s", allowedDelete.Code, allowedDelete.Body.String())
	}
}

func seedMemoryProjection(pool *pgxpool.Pool, ctx context.Context, orgID, kind, source, content string) (string, error) {
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO memories (org_id, kind, source, content, metadata)
		VALUES ($1::uuid,$2,$3,$4,'{}'::jsonb)
		RETURNING id::text`, orgID, kind, source, content).Scan(&id)
	return id, err
}
