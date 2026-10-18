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
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDocumentsRoutesRuntimeRoleRLSAndTenantDenial(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for documents route integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for documents route integration proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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
		SELECT role_id, permission_key, org_id FROM user_roles
		CROSS JOIN (VALUES ('documents.read'), ('documents.write')) AS granted(permission_key)
		WHERE user_id=$1::uuid AND org_id=$2::uuid
		ON CONFLICT DO NOTHING`, fixture.userID, fixture.orgA); err != nil {
		t.Fatal(err)
	}

	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	executor := capability.NewExecutor(runtime, "", "", "")
	collection := MountGoDocumentsCollectionRoute(http.NotFoundHandler(), NewDocumentsCollectionHandler(resolver, executor, logger))
	ingest := MountGoDocumentsIngestRoute(http.NotFoundHandler(), NewDocumentsIngestHandler(runtime, resolver, executor, logger))
	content := MountGoLegacyDocumentContentRoute(http.NotFoundHandler(), NewDocumentContentDownloadHandler(runtime, resolver, logger))

	do := func(mux http.Handler, method, target, orgID, cookie, body string, withOrigin bool) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, target, strings.NewReader(body))
		r.TLS = &tls.ConnectionState{}
		r.Host = "app.example.test"
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		if withOrigin {
			r.Header.Set("Origin", "https://app.example.test")
		}
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: cookie})
		}
		r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, r)
		return response
	}

	if response := do(collection, http.MethodGet, "/api/docs", fixture.orgA, "", "", false); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous gallery status=%d body=%s", response.Code, response.Body.String())
	}

	create := do(collection, http.MethodPost, "/api/docs", fixture.orgA, fixture.cookie,
		`{"action":"create","title":"RLS Doc","content":{"type":"doc","content":[]},"html":"<p>one</p>","intentId":"integration-doc"}`, true)
	if create.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	var created struct {
		DocumentID string `json:"documentId"`
	}
	if json.Unmarshal(create.Body.Bytes(), &created) != nil || created.DocumentID == "" {
		t.Fatalf("create body=%s", create.Body.String())
	}
	documentID := created.DocumentID

	publish := do(collection, http.MethodPost, "/api/docs/"+documentID, fixture.orgA, fixture.cookie,
		`{"action":"publish","content":{"type":"doc","content":[]},"html":"<p>two</p>"}`, true)
	if publish.Code != http.StatusOK || !strings.Contains(publish.Body.String(), `"version":1`) {
		t.Fatalf("publish status=%d body=%s", publish.Code, publish.Body.String())
	}
	version := do(collection, http.MethodGet, "/api/docs/"+documentID+"?version=1", fixture.orgA, fixture.cookie, "", false)
	if version.Code != http.StatusOK || !strings.Contains(version.Body.String(), `"version":1`) {
		t.Fatalf("version status=%d body=%s", version.Code, version.Body.String())
	}
	detail := do(collection, http.MethodGet, "/api/docs/"+documentID, fixture.orgA, fixture.cookie, "", false)
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), "RLS Doc") || !strings.Contains(detail.Body.String(), `"versions":[`) {
		t.Fatalf("detail status=%d body=%s", detail.Code, detail.Body.String())
	}

	var foreignID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO authored_docs (org_id,title,content_json,html,created_by_actor_type)
		VALUES ($1::uuid,'Foreign Doc','{"type":"doc"}','','system') RETURNING id::text`, fixture.orgB).Scan(&foreignID); err != nil {
		t.Fatal(err)
	}
	foreign := do(collection, http.MethodGet, "/api/docs/"+foreignID, fixture.orgA, fixture.cookie, "", false)
	if foreign.Code != http.StatusNotFound || strings.Contains(foreign.Body.String(), "Foreign Doc") {
		t.Fatalf("cross-org document status=%d body=%s, want privacy-preserving 404", foreign.Code, foreign.Body.String())
	}
	gallery := do(collection, http.MethodGet, "/api/docs", fixture.orgA, fixture.cookie, "", false)
	if gallery.Code != http.StatusOK || !strings.Contains(gallery.Body.String(), documentID) || strings.Contains(gallery.Body.String(), "Foreign Doc") {
		t.Fatalf("gallery status=%d body=%s", gallery.Code, gallery.Body.String())
	}

	withoutOrigin := do(collection, http.MethodPost, "/api/docs", fixture.orgA, fixture.cookie,
		`{"action":"delete","documentId":"`+documentID+`"}`, false)
	if withoutOrigin.Code != http.StatusForbidden {
		t.Fatalf("missing origin status=%d body=%s", withoutOrigin.Code, withoutOrigin.Body.String())
	}
	wrongOrg := do(collection, http.MethodPost, "/api/docs", fixture.orgB, fixture.cookie,
		`{"action":"create","title":"Nope","content":{"type":"doc"},"html":""}`, true)
	if wrongOrg.Code != http.StatusForbidden {
		t.Fatalf("wrong org status=%d body=%s", wrongOrg.Code, wrongOrg.Body.String())
	}
	if malformed := do(collection, http.MethodGet, "/api/docs/not-a-uuid", fixture.orgA, fixture.cookie, "", false); malformed.Code != http.StatusBadRequest {
		t.Fatalf("malformed id status=%d body=%s", malformed.Code, malformed.Body.String())
	}

	number := do(collection, http.MethodGet, "/api/docs/next-number?kind=invoice", fixture.orgA, fixture.cookie, "", false)
	if number.Code != http.StatusOK {
		t.Fatalf("next-number status=%d body=%s", number.Code, number.Body.String())
	}
	var numberBody struct {
		Number string `json:"number"`
	}
	if json.Unmarshal(number.Body.Bytes(), &numberBody) != nil || !regexp.MustCompile(`^INV-\d{4}-\d{4}$`).MatchString(numberBody.Number) {
		t.Fatalf("next-number body=%s", number.Body.String())
	}

	records := do(collection, http.MethodGet, "/api/docs/records?type=customer", fixture.orgA, fixture.cookie, "", false)
	if records.Code != http.StatusOK || strings.TrimSpace(records.Body.String()) != `{"records":[]}` {
		t.Fatalf("records status=%d body=%s", records.Code, records.Body.String())
	}

	if folder := do(collection, http.MethodPost, "/api/docs/folders", fixture.orgA, fixture.cookie, `{"action":"create","path":"Integration/Legal"}`, true); folder.Code != http.StatusOK {
		t.Fatalf("folder create status=%d body=%s", folder.Code, folder.Body.String())
	}
	if folders := do(collection, http.MethodGet, "/api/docs/folders", fixture.orgA, fixture.cookie, "", false); folders.Code != http.StatusOK || !strings.Contains(folders.Body.String(), "Integration/Legal") {
		t.Fatalf("folder list status=%d body=%s", folders.Code, folders.Body.String())
	}
	if rename := do(collection, http.MethodPost, "/api/docs/folders", fixture.orgA, fixture.cookie, `{"action":"rename","path":"Integration/Legal","newPath":"Integration/Archive"}`, true); rename.Code != http.StatusOK {
		t.Fatalf("folder rename status=%d body=%s", rename.Code, rename.Body.String())
	}
	if remove := do(collection, http.MethodPost, "/api/docs/folders", fixture.orgA, fixture.cookie, `{"action":"delete","path":"Integration/Archive"}`, true); remove.Code != http.StatusOK {
		t.Fatalf("folder delete status=%d body=%s", remove.Code, remove.Body.String())
	}

	ingestCreate := do(ingest, http.MethodPost, "/api/documents", fixture.orgA, fixture.cookie,
		`{"action":"create","title":"Invoice scan","text":"Total 100 USD"}`, true)
	if ingestCreate.Code != http.StatusOK || !strings.Contains(ingestCreate.Body.String(), `"ok":true`) {
		t.Fatalf("ingest create status=%d body=%s", ingestCreate.Code, ingestCreate.Body.String())
	}
	var ingestCreated struct {
		Data struct {
			DocumentID string `json:"documentId"`
		} `json:"data"`
	}
	if json.Unmarshal(ingestCreate.Body.Bytes(), &ingestCreated) != nil || ingestCreated.Data.DocumentID == "" {
		t.Fatalf("ingest create body=%s", ingestCreate.Body.String())
	}
	ingestID := ingestCreated.Data.DocumentID
	if list := do(ingest, http.MethodGet, "/api/documents", fixture.orgA, fixture.cookie, "", false); list.Code != http.StatusOK || !strings.Contains(list.Body.String(), ingestID) {
		t.Fatalf("ingest list status=%d body=%s", list.Code, list.Body.String())
	}
	if detail := do(ingest, http.MethodGet, "/api/documents?id="+ingestID, fixture.orgA, fixture.cookie, "", false); detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), "Invoice scan") {
		t.Fatalf("ingest detail status=%d body=%s", detail.Code, detail.Body.String())
	}

	async := do(ingest, http.MethodPost, "/api/documents", fixture.orgA, fixture.cookie, `{"action":"parse","documentId":"`+ingestID+`"}`, true)
	if async.Code != http.StatusOK || !strings.Contains(async.Body.String(), `"queued":true`) {
		t.Fatalf("async parse status=%d body=%s", async.Code, async.Body.String())
	}
	var queuedStatus string
	if err := owner.QueryRow(ctx, `SELECT status FROM documents WHERE id=$1::uuid`, ingestID).Scan(&queuedStatus); err != nil || queuedStatus != "queued" {
		t.Fatalf("queued status=%q err=%v", queuedStatus, err)
	}
	var jobCount int64
	if err := owner.QueryRow(ctx, `
		SELECT count(*) FROM jobs
		WHERE org_id=$1::uuid AND type='documents.parseDocument' AND payload->>'documentId'=$2`,
		fixture.orgA, ingestID).Scan(&jobCount); err != nil || jobCount < 1 {
		t.Fatalf("parse job rows=%d err=%v", jobCount, err)
	}
	if _, err := owner.Exec(ctx, `
		DELETE FROM jobs
		WHERE org_id=$1::uuid AND type='documents.parseDocument' AND payload->>'documentId'=$2`,
		fixture.orgA, ingestID); err != nil {
		t.Fatalf("clean up parse job rows: %v", err)
	}

	sync := do(ingest, http.MethodPost, "/api/documents", fixture.orgA, fixture.cookie, `{"action":"parse","documentId":"`+ingestID+`","sync":true}`, true)
	if sync.Code != http.StatusOK || !strings.Contains(sync.Body.String(), `"status":"parsed"`) {
		t.Fatalf("sync parse status=%d body=%s", sync.Code, sync.Body.String())
	}
	var parsedStatus string
	if err := owner.QueryRow(ctx, `SELECT status FROM documents WHERE id=$1::uuid`, ingestID).Scan(&parsedStatus); err != nil || parsedStatus != "parsed" {
		t.Fatalf("parsed status=%q err=%v", parsedStatus, err)
	}
	if remove := do(ingest, http.MethodPost, "/api/documents", fixture.orgA, fixture.cookie, `{"action":"delete","documentId":"`+ingestID+`"}`, true); remove.Code != http.StatusOK || !strings.Contains(remove.Body.String(), `"deleted":true`) {
		t.Fatalf("ingest delete status=%d body=%s", remove.Code, remove.Body.String())
	}

	insertUpload := func(orgID, title string) string {
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
	localUpload := insertUpload(fixture.orgA, "local.png")
	foreignUpload := insertUpload(fixture.orgB, "foreign.png")
	if local := do(content, http.MethodGet, "/api/documents/"+localUpload+"/content", fixture.orgA, fixture.cookie, "", false); local.Code != http.StatusOK || string(local.Body.Bytes()) != string([]byte{1, 2, 3}) {
		t.Fatalf("content local status=%d body=%v", local.Code, local.Body.Bytes())
	}
	if foreign := do(content, http.MethodGet, "/api/documents/"+foreignUpload+"/content", fixture.orgA, fixture.cookie, "", false); foreign.Code != http.StatusNotFound {
		t.Fatalf("content foreign status=%d body=%s", foreign.Code, foreign.Body.String())
	}
	if wrongOrg := do(content, http.MethodGet, "/api/documents/"+localUpload+"/content", fixture.orgB, fixture.cookie, "", false); wrongOrg.Code != http.StatusForbidden {
		t.Fatalf("content wrong org status=%d body=%s", wrongOrg.Code, wrongOrg.Body.String())
	}
}
