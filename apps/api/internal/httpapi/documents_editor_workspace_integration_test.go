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

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDocumentsEditorWorkspaceRuntimeRLSAutosaveAndRelease(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for document workspace integration proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for document workspace integration proof")
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
	insertDoc := func(orgID, title string) string {
		t.Helper()
		var id string
		if err := owner.QueryRow(ctx, `INSERT INTO authored_docs (org_id,title,content_json,created_by_actor_type,created_by_actor_id) VALUES ($1::uuid,$2,'{}'::jsonb,'user',$3::uuid) RETURNING id::text`, orgID, title, fixture.userID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	docA := insertDoc(fixture.orgA, "Workspace A")
	docB := insertDoc(fixture.orgB, "Workspace B")
	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewDocumentsEditorWorkspaceHandler(runtime, resolver, slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := func(method, id, body, orgID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://app.example.test/api/docs/"+id+"/workspace", strings.NewReader(body))
		r.TLS = &tls.ConnectionState{}
		r.Host = "app.example.test"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://app.example.test")
		r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: fixture.cookie})
		r.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: orgID})
		response := httptest.NewRecorder()
		mux := MountGoDocumentsEditorWorkspaceRoute(http.NotFoundHandler(), handler)
		mux.ServeHTTP(response, r)
		return response
	}

	response := request(http.MethodPost, docA, `{}`, fixture.orgA)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"draft":null`) || !strings.Contains(response.Body.String(), `"mine":true`) {
		t.Fatalf("heartbeat status=%d body=%s", response.Code, response.Body.String())
	}
	var presenceCount, draftCount int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM doc_presence WHERE document_id=$1::uuid AND user_id=$2::uuid`, docA, fixture.userID).Scan(&presenceCount); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM doc_drafts WHERE document_id=$1::uuid`, docA).Scan(&draftCount); err != nil {
		t.Fatal(err)
	}
	if presenceCount != 1 || draftCount != 0 {
		t.Fatalf("heartbeat created presence=%d drafts=%d, want 1 and 0", presenceCount, draftCount)
	}

	const settings = `"pageSettings":{"size":"Letter","orientation":"landscape","margin":"wide"}`
	response = request(http.MethodPost, docA, `{"content":{"type":"doc","blocks":[]},`+settings+`,"intentId":"ignored-intent"}`, fixture.orgA)
	var saved struct {
		SavedRev int `json:"savedRev"`
		Draft    struct {
			Rev          int             `json:"rev"`
			Content      json.RawMessage `json:"content"`
			PageSettings json.RawMessage `json:"pageSettings"`
			UpdatedAt    string          `json:"updatedAt"`
		} `json:"draft"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil || response.Code != http.StatusOK || saved.SavedRev != 1 || saved.Draft.Rev != 1 || !strings.Contains(string(saved.Draft.PageSettings), `"Letter"`) || saved.Draft.UpdatedAt == "" {
		t.Fatalf("first save status=%d response=%+v err=%v body=%s", response.Code, saved, err, response.Body.String())
	}
	response = request(http.MethodPost, docA, `{"content":{"type":"doc","blocks":[1]},"rev":1}`, fixture.orgA)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"savedRev":2`) {
		t.Fatalf("second save status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(http.MethodPost, docA, `{"content":{"stale":true},"rev":1}`, fixture.orgA)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"conflict":true`) || !strings.Contains(response.Body.String(), `"rev":2`) {
		t.Fatalf("revision conflict status=%d body=%s", response.Code, response.Body.String())
	}
	for _, body := range []string{`{"unexpected":true}`, `{"content":`} {
		response = request(http.MethodPost, docA, body, fixture.orgA)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid body %q status=%d body=%s", body, response.Code, response.Body.String())
		}
	}
	const otherUserID = "77777777-7777-4777-8777-777777777777"
	if _, err := owner.Exec(ctx, `UPDATE doc_drafts SET locked_by_user_id=$2::uuid,locked_by_name='Other editor',lock_until=now()+interval '20 seconds' WHERE document_id=$1::uuid`, docA, otherUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO doc_presence (org_id,document_id,user_id,display_name,seen_at) VALUES ($1::uuid,$2::uuid,$3::uuid,'Other editor',now()) ON CONFLICT (document_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,seen_at=EXCLUDED.seen_at`, fixture.orgA, docA, otherUserID); err != nil {
		t.Fatal(err)
	}
	response = request(http.MethodPost, docA, `{"content":{"mustNotSave":true},"rev":2}`, fixture.orgA)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"heldBy":"Other editor"`) || strings.Contains(response.Body.String(), `"draft"`) || strings.Contains(response.Body.String(), `"savedRev"`) {
		t.Fatalf("other user's lock response status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(http.MethodPost, docB, `{}`, fixture.orgA)
	if response.Code != http.StatusNotFound {
		t.Fatalf("cross-organization document status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(http.MethodDelete, docA, "", fixture.orgA)
	if response.Code != http.StatusOK {
		t.Fatalf("release while another user owns lock status=%d body=%s", response.Code, response.Body.String())
	}
	var lockOwner *string
	if err := owner.QueryRow(ctx, `SELECT locked_by_user_id::text FROM doc_drafts WHERE document_id=$1::uuid`, docA).Scan(&lockOwner); err != nil {
		t.Fatal(err)
	}
	if lockOwner == nil || *lockOwner != otherUserID {
		t.Fatalf("release cleared another user's lock: owner=%v", lockOwner)
	}
	if _, err := owner.Exec(ctx, `UPDATE doc_drafts SET locked_by_user_id=$2::uuid,locked_by_name='Parity',lock_until=now()+interval '20 seconds' WHERE document_id=$1::uuid`, docA, fixture.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO doc_presence (org_id,document_id,user_id,display_name,seen_at) VALUES ($1::uuid,$2::uuid,$3::uuid,'Parity',now()) ON CONFLICT (document_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,seen_at=EXCLUDED.seen_at`, fixture.orgA, docA, fixture.userID); err != nil {
		t.Fatal(err)
	}

	response = request(http.MethodDelete, docA, "", fixture.orgA)
	if response.Code != http.StatusOK || response.Body.String() != `{"ok":true}`+"\n" {
		t.Fatalf("release status=%d body=%s", response.Code, response.Body.String())
	}
	var releasedPresence int
	var lockedBy *string
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM doc_presence WHERE document_id=$1::uuid AND user_id=$2::uuid`, docA, fixture.userID).Scan(&releasedPresence); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT locked_by_user_id::text FROM doc_drafts WHERE document_id=$1::uuid`, docA).Scan(&lockedBy); err != nil {
		t.Fatal(err)
	}
	if releasedPresence != 0 || lockedBy != nil {
		t.Fatalf("release left presence=%d lock=%v", releasedPresence, lockedBy)
	}
}
