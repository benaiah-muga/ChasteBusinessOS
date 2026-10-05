package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

const testSessionDetailID = "44444444-4444-4444-8444-444444444444"

type fakeSessionDetailReader struct {
	data    sessionDetailData
	found   bool
	err     error
	orgID   string
	session string
	userID  string
	admin   bool
	calls   int
}

func (f *fakeSessionDetailReader) Read(_ context.Context, orgID, sessionID, userID string, admin bool) (sessionDetailReadResult, error) {
	f.calls++
	f.orgID, f.session = orgID, sessionID
	f.userID, f.admin = userID, admin
	found := f.found && (admin || f.data.Session.UserID != nil && *f.data.Session.UserID == userID)
	return sessionDetailReadResult{Data: f.data, Found: found}, f.err
}

func TestSessionsDetailHandlerReturnsLegacyDetailEnvelopeAndScopesOwner(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeSessionDetailReader{
		found: true,
		data: sessionDetailData{
			Session: sessionDetailRecord{ID: testSessionDetailID, OrgID: *identity.OrgID, UserID: &identity.UserID, Mode: "assist", Status: "open", CreatedAt: "2026-01-02T03:04:05.000Z", UpdatedAt: "2026-01-02T03:04:06.000Z"},
			Events:  []sessionDetailEvent{{Seq: 1, Role: "user", Content: json.RawMessage(`{"text":"hello"}`), At: "2026-01-02T03:04:07.000Z"}},
		},
	}
	resolver := &fakeDirectSessionResolver{resolved: identity}
	request := httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionDetailID, nil)
	response := httptest.NewRecorder()
	(&SessionsDetailHandler{resolver: resolver, reader: reader}).ServeHTTP(response, request)

	if response.Code != http.StatusOK || resolver.resolveCalls != 1 || reader.orgID != *identity.OrgID || reader.session != testSessionDetailID || reader.userID != identity.UserID {
		t.Fatalf("status=%d resolver=%+v reader=%+v body=%s", response.Code, resolver, reader, response.Body.String())
	}
	var body struct {
		Session sessionDetailRecord  `json:"session"`
		Events  []sessionDetailEvent `json:"events"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Session.ID != testSessionDetailID || body.Session.Mode != "assist" || len(body.Events) != 1 || body.Events[0].Seq != 1 || body.Events[0].At == "" {
		t.Fatalf("unexpected legacy detail response: %+v", body)
	}
}

func TestSessionsDetailHandlerHidesColleagueSessionButAllowsAdminReplay(t *testing.T) {
	identity := directTestIdentity()
	owner := "55555555-5555-4555-8555-555555555555"
	reader := &fakeSessionDetailReader{
		found: true,
		data: sessionDetailData{
			Session: sessionDetailRecord{ID: testSessionDetailID, OrgID: *identity.OrgID, UserID: &owner},
			Events: []sessionDetailEvent{
				{Seq: 1, Role: "tool_call", Content: json.RawMessage(`{"name":"lookup","args":{"q":"x"}}`)},
				{Seq: 2, Role: "tool", Content: json.RawMessage(`{"name":"lookup","result":"found"}`)},
				{Seq: 3, Role: "assistant", Content: json.RawMessage(`{"text":"done"}`)},
			},
		},
	}
	handler := &SessionsDetailHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, reader: reader}
	path := "/api/sessions/" + testSessionDetailID
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("non-owner status=%d body=%s", response.Code, response.Body.String())
	}

	identity.Permissions["iam.admin"] = true
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path+"/replay", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("admin replay status=%d body=%s", response.Code, response.Body.String())
	}
	if !reader.admin {
		t.Fatal("iam.admin was not propagated to the scoped reader")
	}
	var body struct {
		Trace replayDetailTrace `json:"trace"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode replay response: %v", err)
	}
	if body.Trace.EventCount != 3 || body.Trace.FinalMessage != "done" || len(body.Trace.Observations) != 1 || body.Trace.Observations[0].Name != "lookup" || len(body.Trace.Messages) != 3 {
		t.Fatalf("unexpected replay trace: %+v", body.Trace)
	}
	if body.Trace.Messages[1].ToolCallID == nil || *body.Trace.Messages[1].ToolCallID != "replay-1" {
		t.Fatalf("tool result was not correlated with its call: %+v", body.Trace.Messages[1])
	}
}

func TestSessionsDetailHandlerWildcardPermissionReadsColleagueDetailAndReplay(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions = map[string]bool{"*": true}
	owner := "55555555-5555-4555-8555-555555555555"
	reader := &fakeSessionDetailReader{
		found: true,
		data: sessionDetailData{
			Session: sessionDetailRecord{ID: testSessionDetailID, OrgID: *identity.OrgID, UserID: &owner},
			Events:  []sessionDetailEvent{{Seq: 1, Role: "assistant", Content: json.RawMessage(`{"text":"done"}`)}},
		},
	}
	handler := &SessionsDetailHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, reader: reader}
	path := "/api/sessions/" + testSessionDetailID
	for _, route := range []string{path, path + "/replay"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, route, nil))
		if response.Code != http.StatusOK {
			t.Errorf("wildcard access to %s returned %d: %s", route, response.Code, response.Body.String())
		}
	}
	if !reader.admin {
		t.Fatal("wildcard permission was not propagated as cross-user visibility")
	}
}

func TestSessionsDetailHandlerRejectsMissingIdentityBadPathsAndWrongMethods(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeSessionDetailReader{found: true, data: sessionDetailData{Session: sessionDetailRecord{UserID: &identity.UserID}}}
	resolver := &fakeDirectSessionResolver{resolved: identity, err: errors.New("no session")}
	handler := &SessionsDetailHandler{resolver: resolver, reader: reader}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionDetailID, nil))
	if response.Code != http.StatusUnauthorized || reader.calls != 0 {
		t.Fatalf("unauthenticated status=%d reader calls=%d", response.Code, reader.calls)
	}

	resolver.err = nil
	for _, path := range []string{
		"/api/sessions/not-a-uuid",
		"/api/sessions/" + testSessionDetailID + "/extra",
		"/api/sessions/" + testSessionDetailID + "/replay/extra",
	} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Errorf("path %q status=%d, want 404", path, response.Code)
		}
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/sessions/"+testSessionDetailID, nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("wrong method status=%d allow=%q", response.Code, response.Header().Get("Allow"))
	}
}

func TestSessionsDetailHandlerBoundsAndValidatesReplayEvents(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeSessionDetailReader{found: true, data: sessionDetailData{Session: sessionDetailRecord{UserID: &identity.UserID}}, err: errSessionDetailTooLarge}
	handler := &SessionsDetailHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, reader: reader}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionDetailID, nil))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status=%d body=%s", response.Code, response.Body.String())
	}

	badEvents := []sessionDetailEvent{{Seq: 1, Role: "tool_call", Content: json.RawMessage(`{"args":{}}`)}}
	reader.err = nil
	reader.data.Events = badEvents
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionDetailID+"/replay", nil))
	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), "session replay failed") {
		t.Fatalf("invalid replay status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSessionsDetailHandlerCapsEncodedResponseBytes(t *testing.T) {
	identity := directTestIdentity()
	events := make([]sessionDetailEvent, 32)
	content := json.RawMessage(`"` + strings.Repeat("x", 256*1024-2) + `"`)
	for i := range events {
		events[i] = sessionDetailEvent{Seq: int64(i + 1), Role: "assistant", Content: content, At: "2026-01-01T00:00:00.000Z"}
	}
	reader := &fakeSessionDetailReader{found: true, data: sessionDetailData{
		Session: sessionDetailRecord{UserID: &identity.UserID}, Events: events,
	}}
	handler := &SessionsDetailHandler{resolver: &fakeDirectSessionResolver{resolved: identity}, reader: reader}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sessions/"+testSessionDetailID, nil))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized encoded response status=%d bytes=%d", response.Code, response.Body.Len())
	}
}

func TestPostgresSessionDetailReaderPreflightsOversizedEventContent(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("chaste_app runtime database role is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed session detail integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed session detail integration fixtures")
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
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	orgID, sessionID := integrationUUID(t), integrationUUID(t)
	if _, err := owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Session detail preflight fixture', $2)`, orgID, "session-preflight-"+orgID[:8]); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO agent_sessions (id, org_id, user_id, mode, status) VALUES ($1::uuid, $2::uuid, NULL, 'assist', 'open')`, sessionID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO session_events (session_id, seq, role, content) VALUES ($1::uuid, 1, 'assistant', to_jsonb(repeat('x', $2)))`, sessionID, sessionDetailEventBytesLimit+1); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id = $1::uuid`, orgID); err != nil {
			t.Errorf("delete session detail fixture organization: %v", err)
		}
	})

	_, err = (postgresSessionDetailReader{pool: runtime}).Read(ctx, orgID, sessionID, integrationUUID(t), true)
	if !errors.Is(err, errSessionDetailTooLarge) {
		t.Fatalf("oversized event error=%v, want preflight limit error", err)
	}
}

func TestLegacySessionTimeUsesJavaScriptMillisecondPrecision(t *testing.T) {
	got := legacySessionTime(time.Date(2026, 10, 4, 1, 2, 3, 123456789, time.FixedZone("EAT", 3*60*60)))
	if got != "2026-10-03T22:02:03.123Z" {
		t.Fatalf("legacySessionTime() = %q", got)
	}
}
