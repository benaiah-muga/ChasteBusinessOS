package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSCIMRemainingCollectionDeleteMethodRefusalWithoutDatabase(t *testing.T) {
	handler := &scimCollectionDeleteHandler{read: &scimReadHandler{limiter: NewSCIMRateLimiter()}}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/scim/v2/Users", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodDelete {
		t.Fatalf("status=%d allow=%q body=%s", response.Code, response.Header().Get("Allow"), response.Body.String())
	}
	var envelope scimErrorResponse
	if json.Unmarshal(response.Body.Bytes(), &envelope) != nil || envelope.Status != "405" {
		t.Fatalf("envelope=%+v body=%s", envelope, response.Body.String())
	}

	exhausted := &scimCollectionDeleteHandler{read: &scimReadHandler{limiter: NewSCIMRateLimiter()}}
	for exhausted.read.limiter.allow("192.0.2.60") {
	}
	request := httptest.NewRequest(http.MethodDelete, "/api/scim/v2/Users", nil)
	request.RemoteAddr = "192.0.2.60:51234"
	request.Header.Set("Authorization", "Bearer token")
	response = httptest.NewRecorder()
	exhausted.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("exhausted limiter status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSCIMRemainingCollectionDeleteRequiresTokenAndRefusesDeletion(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if err != nil {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		t.Skip("DATABASE_URL is required to seed SCIM fixtures")
	}
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
		t.Fatalf("verify runtime role: %v", err)
	}

	orgID := readContractUUID(t)
	rawToken := "scim-collection-delete-fixture-" + readContractUUID(t)
	digest := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(digest[:])
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id = $1::uuid`, orgID); err != nil {
			t.Errorf("delete SCIM collection delete fixture organization: %v", err)
		}
	})
	if _, err := owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'SCIM delete fixture', $2)`,
		orgID, "scim-del-"+orgID[:8]); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO scim_tokens (org_id, token_hash, label, active, expires_at)
		VALUES ($1::uuid, $2, 'SCIM delete fixture', true, clock_timestamp() + interval '1 hour')`, orgID, tokenHash); err != nil {
		t.Fatal(err)
	}

	route, err := NewSCIMCollectionDeleteHandler(runtime, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	handler := MountGoSCIMCollectionDeleteRoute(http.NotFoundHandler(), route)
	request := func(method, path, token string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr = "192.0.2.61:51234"
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}

	missing := request(http.MethodDelete, "/api/scim/v2/Users", "")
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("missing token status=%d body=%s", missing.Code, missing.Body.String())
	}
	wrong := request(http.MethodDelete, "/api/scim/v2/Users", "wrong-token")
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token status=%d body=%s", wrong.Code, wrong.Body.String())
	}
	refusal := request(http.MethodDelete, "/api/scim/v2/Users", rawToken)
	if refusal.Code != http.StatusMethodNotAllowed || refusal.Header().Get("Allow") != "GET, POST" {
		t.Fatalf("valid token status=%d allow=%q body=%s", refusal.Code, refusal.Header().Get("Allow"), refusal.Body.String())
	}
	var envelope scimErrorResponse
	if json.Unmarshal(refusal.Body.Bytes(), &envelope) != nil ||
		envelope.Status != "405" || envelope.Detail != "the SCIM user collection cannot be deleted; delete individual users instead" ||
		len(envelope.Schemas) != 1 || envelope.Schemas[0] != "urn:ietf:params:scim:api:messages:2.0:Error" {
		t.Fatalf("envelope=%+v body=%s", envelope, refusal.Body.String())
	}

	item := request(http.MethodDelete, "/api/scim/v2/Users/"+readContractUUID(t), rawToken)
	if item.Code != http.StatusNotFound {
		t.Fatalf("item delete fell through status=%d body=%s", item.Code, item.Body.String())
	}
	read := request(http.MethodGet, "/api/scim/v2/Users", rawToken)
	if read.Code != http.StatusNotFound {
		t.Fatalf("collection read ownership changed status=%d body=%s", read.Code, read.Body.String())
	}
}
