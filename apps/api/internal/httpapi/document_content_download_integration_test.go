package httpapi

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDocumentContentDownloadRuntimeRoleRLSAndTenantDenial(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for document content download integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for document content download integration proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, orgParityEnv(t))
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
	if _, err := owner.Exec(ctx, `UPDATE organizations SET enabled_modules='["documents"]'::jsonb WHERE id=$1::uuid`, fixture.orgA); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO role_permissions (role_id, permission_key, org_id)
		SELECT role_id, 'documents.read', org_id FROM user_roles WHERE user_id=$1::uuid AND org_id=$2::uuid
		ON CONFLICT DO NOTHING`, fixture.userID, fixture.orgA); err != nil {
		t.Fatal(err)
	}
	insertDocument := func(orgID, title string) string {
		t.Helper()
		var id string
		if err := owner.QueryRow(ctx, `
			INSERT INTO documents (org_id,title,source_type,mime_type,size_bytes,content_base64,created_by_actor_type,created_by_actor_id)
			VALUES ($1::uuid,$2,'upload','image/png',3,'AQID','user',$3::uuid)
			RETURNING id::text`, orgID, title, fixture.userID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	localDocument := insertDocument(fixture.orgA, "local.png")
	foreignDocument := insertDocument(fixture.orgB, "foreign.png")
	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewDocumentContentDownloadHandler(runtime, resolver, slog.New(slog.NewTextHandler(io.Discard, nil)))
	mux := MountGoDocumentContentDownloadRoute(http.NotFoundHandler(), handler)
	request := func(id, orgID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/go/documents/"+id+"/content", nil)
		r.TLS = &tls.ConnectionState{}
		r.Host = "app.example.test"
		r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
		r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, r)
		return response
	}

	local := request(localDocument, fixture.orgA)
	if local.Code != http.StatusOK || string(local.Body.Bytes()) != string([]byte{1, 2, 3}) || local.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("local document status=%d headers=%#v body=%v", local.Code, local.Header(), local.Body.Bytes())
	}
	foreign := request(foreignDocument, fixture.orgA)
	if foreign.Code != http.StatusNotFound || strings.Contains(foreign.Body.String(), "foreign") {
		t.Fatalf("cross-tenant document status=%d body=%q, want privacy-preserving 404", foreign.Code, foreign.Body.String())
	}
	wrongOrg := request(localDocument, fixture.orgB)
	if wrongOrg.Code != http.StatusForbidden {
		t.Fatalf("active organization mismatch status=%d body=%q, want 403", wrongOrg.Code, wrongOrg.Body.String())
	}
}
