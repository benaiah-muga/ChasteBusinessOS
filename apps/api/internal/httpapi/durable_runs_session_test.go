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

type fakeDurableRunsSessionReader struct {
	runs         []durableRunListRow
	detail       *durableRunDetail
	err          error
	listCalls    int
	detailCalls  int
	orgID        string
	userID       string
	admin        bool
	requestedRun string
	sessionOwner *string
}

func (f *fakeDurableRunsSessionReader) ListForUser(_ context.Context, orgID, userID string, admin bool) ([]durableRunListRow, error) {
	f.listCalls++
	f.orgID, f.userID, f.admin = orgID, userID, admin
	return f.runs, f.err
}

func (f *fakeDurableRunsSessionReader) DetailForUser(_ context.Context, orgID, runID, userID string, admin bool) (*durableRunDetail, error) {
	f.detailCalls++
	f.orgID, f.userID, f.admin, f.requestedRun = orgID, userID, admin, runID
	if f.detail == nil || admin {
		return f.detail, f.err
	}
	if f.detail.Run.InitiatedByActorID != nil && *f.detail.Run.InitiatedByActorID == userID {
		return f.detail, f.err
	}
	if f.detail.Run.SessionID != nil && f.sessionOwner != nil && *f.sessionOwner == userID {
		return f.detail, f.err
	}
	return nil, f.err
}

func TestDurableRunsSessionHandlerListsRecentRunsForOrgAndUser(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeDurableRunsSessionReader{runs: []durableRunListRow{{ID: "run-1", Goal: "Close month", Status: "running"}}}
	handler := newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/durable-runs", nil)
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || reader.listCalls != 1 || reader.orgID != *identity.OrgID || reader.userID != identity.UserID || reader.admin {
		t.Fatalf("status=%d reader=%+v body=%s", response.Code, reader, response.Body.String())
	}
	var body struct {
		Runs []durableRunListRow `json:"runs"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.Runs) != 1 || body.Runs[0].Goal != "Close month" {
		t.Fatalf("list body=%s err=%v", response.Body.String(), err)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("cache headers=%v", response.Header())
	}
}

func TestDurableRunsSessionHandlerListsAllRunsForAdmin(t *testing.T) {
	identity := directTestIdentity()
	identity.Permissions["iam.admin"] = true
	reader := &fakeDurableRunsSessionReader{runs: []durableRunListRow{}}
	response := httptest.NewRecorder()
	newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(
		response, httptest.NewRequest(http.MethodGet, "/api/durable-runs", nil))
	if response.Code != http.StatusOK || !reader.admin || reader.userID != identity.UserID || response.Body.String() != `{"runs":[]}`+"\n" {
		t.Fatalf("status=%d admin=%t user=%s body=%s", response.Code, reader.admin, reader.userID, response.Body.String())
	}
}

func TestDurableRunsSessionHandlerDetailUsesOwnerVisibilityAndLegacyShape(t *testing.T) {
	identity := directTestIdentity()
	started := "2026-09-10T11:12:13.000Z"
	reader := &fakeDurableRunsSessionReader{detail: &durableRunDetail{
		Run: durableRunDetailRecord{
			durableRunListRow: durableRunListRow{ID: "55555555-5555-4555-8555-555555555555", Goal: "Close month", CreatedAt: started, UpdatedAt: started},
			OrgID:             *identity.OrgID, ContractRevision: 2, RegistryVersion: "7", InitiatedByActorType: "human", InitiatedByActorID: &identity.UserID,
		},
		Steps: []durableRunStepRecord{{ID: "step-1", RunID: "55555555-5555-4555-8555-555555555555", StepIndex: 0, Input: json.RawMessage(`{"account":"1000"}`), Output: json.RawMessage(`{"ok":true}`), CreatedAt: started}},
	}}
	response := httptest.NewRecorder()
	newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(
		response, httptest.NewRequest(http.MethodGet, "/api/durable-runs/55555555-5555-4555-8555-555555555555", nil))
	if response.Code != http.StatusOK || reader.detailCalls != 1 || reader.orgID != *identity.OrgID || reader.userID != identity.UserID || reader.admin || reader.requestedRun != reader.detail.Run.ID {
		t.Fatalf("status=%d reader=%+v body=%s", response.Code, reader, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	run := body["run"].(map[string]any)
	steps := body["steps"].([]any)
	step := steps[0].(map[string]any)
	if run["contractRevision"] != float64(2) || run["registryVersion"] != "7" || run["createdAt"] != started ||
		step["input"].(map[string]any)["account"] != "1000" || step["output"].(map[string]any)["ok"] != true {
		t.Fatalf("detail response=%s", response.Body.String())
	}
}

func TestDurableRunsSessionHandlerReturnsNotFoundForInvisibleOrMissingRuns(t *testing.T) {
	identity := directTestIdentity()
	for _, test := range []struct {
		name   string
		detail *durableRunDetail
	}{
		{name: "missing"},
		{name: "invisible", detail: &durableRunDetail{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := &fakeDurableRunsSessionReader{detail: test.detail}
			response := httptest.NewRecorder()
			newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(
				response, httptest.NewRequest(http.MethodGet, "/api/durable-runs/55555555-5555-4555-8555-555555555555", nil))
			if response.Code != http.StatusNotFound || response.Body.String() != `{"error":"not found"}`+"\n" {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestDurableRunsSessionHandlerAllowsOwningAgentSession(t *testing.T) {
	identity := directTestIdentity()
	sessionID := "33333333-3333-4333-8333-333333333333"
	reader := &fakeDurableRunsSessionReader{
		detail: &durableRunDetail{Run: durableRunDetailRecord{
			durableRunListRow: durableRunListRow{ID: "55555555-5555-4555-8555-555555555555", SessionID: &sessionID},
		}},
		sessionOwner: &identity.UserID,
	}
	response := httptest.NewRecorder()
	newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(
		response, httptest.NewRequest(http.MethodGet, "/api/durable-runs/55555555-5555-4555-8555-555555555555", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDurableRunsSessionHandlerRejectsDetailAboveStepLimit(t *testing.T) {
	identity := directTestIdentity()
	detail := &durableRunDetail{Run: durableRunDetailRecord{
		durableRunListRow:  durableRunListRow{ID: "55555555-5555-4555-8555-555555555555"},
		InitiatedByActorID: &identity.UserID,
	}}
	detail.Steps = make([]durableRunStepRecord, durableRunDetailMaxSteps+1)
	reader := &fakeDurableRunsSessionReader{detail: detail}
	response := httptest.NewRecorder()
	newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(
		response, httptest.NewRequest(http.MethodGet, "/api/durable-runs/55555555-5555-4555-8555-555555555555", nil))
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), "durable run detail exceeds response limits") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDurableRunsSessionHandlerRejectsDetailAboveSerializedByteLimit(t *testing.T) {
	identity := directTestIdentity()
	detail := &durableRunDetail{Run: durableRunDetailRecord{
		durableRunListRow:  durableRunListRow{ID: "55555555-5555-4555-8555-555555555555", Goal: strings.Repeat("x", durableRunDetailMaxBytes)},
		InitiatedByActorID: &identity.UserID,
	}, Steps: []durableRunStepRecord{}}
	reader := &fakeDurableRunsSessionReader{detail: detail}
	response := httptest.NewRecorder()
	newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(
		response, httptest.NewRequest(http.MethodGet, "/api/durable-runs/55555555-5555-4555-8555-555555555555", nil))
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), "durable run detail exceeds response limits") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDurableRunsSessionHandlerPropagatesProductionDetailLimit(t *testing.T) {
	identity := directTestIdentity()
	reader := &fakeDurableRunsSessionReader{err: errDurableRunDetailTooLarge}
	response := httptest.NewRecorder()
	newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: identity}, reader, nil).ServeHTTP(
		response, httptest.NewRequest(http.MethodGet, "/api/durable-runs/55555555-5555-4555-8555-555555555555", nil))
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), "durable run detail exceeds response limits") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPgDurableRunsSessionReaderUsesLegacyTimestampPrecisionAndBoundsSteps(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed durable-run integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed durable-run integration fixtures")
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

	orgID, foreignOrgID := integrationUUID(t), integrationUUID(t)
	userID, sameOrgUserID, foreignUserID := integrationUUID(t), integrationUUID(t), integrationUUID(t)
	precisionRunID, largeRunID, oversizedRunID := integrationUUID(t), integrationUUID(t), integrationUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go durable-run integration fixture', $2),
		($3::uuid, 'Go durable-run foreign fixture', $4)`, orgID, "go-durable-run-"+orgID[:8], foreignOrgID, "go-durable-run-foreign-"+foreignOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	for _, fixtureUser := range []struct{ id, label string }{
		{userID, "initiator"}, {sameOrgUserID, "same-org"}, {foreignUserID, "foreign-org"},
	} {
		if _, err := owner.Exec(ctx, `
			INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, $3)`,
			fixtureUser.id, "go-durable-run-"+fixtureUser.label+"-"+fixtureUser.id[:8]+"@fixture.test", fixtureUser.label); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO memberships (org_id, user_id) VALUES
		($1::uuid, $2::uuid), ($1::uuid, $3::uuid), ($4::uuid, $5::uuid)`, orgID, userID, sameOrgUserID, foreignOrgID, foreignUserID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, foreignOrgID); err != nil {
			t.Errorf("delete durable-run fixture organization: %v", err)
		}
		for _, fixtureUserID := range []string{userID, sameOrgUserID, foreignUserID} {
			if _, err := owner.Exec(cleanupCtx, `DELETE FROM users WHERE id = $1::uuid`, fixtureUserID); err != nil {
				t.Errorf("delete durable-run fixture user: %v", err)
			}
		}
	})

	createdAt := time.Date(2026, 9, 10, 11, 12, 13, 123_456_789, time.UTC)
	updatedAt := time.Date(2026, 9, 10, 11, 12, 14, 987_654_321, time.UTC)
	startedAt := time.Date(2026, 9, 10, 11, 12, 12, 456_789_123, time.UTC)
	finishedAt := time.Date(2026, 9, 10, 11, 12, 15, 999_999_999, time.UTC)
	insertRun := `
		INSERT INTO agent_runs (
			id, org_id, goal, status, registry_version, initiated_by_actor_type, initiated_by_actor_id,
			created_at, updated_at, started_at, finished_at
		) VALUES ($1::uuid, $2::uuid, $3, 'completed', 'fixture-registry', 'human', $4::uuid, $5, $6, $7, $8)`
	if _, err := owner.Exec(ctx, insertRun, precisionRunID, orgID, "Timestamp precision fixture", userID, createdAt, updatedAt, startedAt, finishedAt); err != nil {
		t.Fatal(err)
	}
	stepCreatedAt := time.Date(2026, 9, 10, 11, 12, 16, 123_999_999, time.UTC)
	stepStartedAt := time.Date(2026, 9, 10, 11, 12, 16, 999_999_999, time.UTC)
	stepFinishedAt := time.Date(2026, 9, 10, 11, 12, 17, 456_789_123, time.UTC)
	if _, err := owner.Exec(ctx, `
		INSERT INTO agent_run_steps (org_id, run_id, step_index, kind, status, input, output, created_at, started_at, finished_at)
		VALUES ($1::uuid, $2::uuid, 0, 'capability', 'committed', '{"in":1}'::jsonb, '{"out":2}'::jsonb, $3, $4, $5)`,
		orgID, precisionRunID, stepCreatedAt, stepStartedAt, stepFinishedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, insertRun, largeRunID, orgID, "Too many steps fixture", userID, createdAt, updatedAt, startedAt, finishedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, insertRun, oversizedRunID, orgID, "Oversized payload fixture", userID, createdAt, updatedAt, startedAt, finishedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO agent_run_steps (org_id, run_id, step_index, kind, status, input, output)
		SELECT $1::uuid, $2::uuid, step_index, 'capability', 'pending', '{}'::jsonb, '{}'::jsonb
		FROM generate_series(0, $3) AS step_index`, orgID, largeRunID, durableRunDetailMaxSteps); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO agent_run_steps (org_id, run_id, step_index, kind, status, input, output)
		SELECT $1::uuid, $2::uuid, 0, 'capability', 'pending',
		       jsonb_build_object('payload', repeat('x', $3)), '{}'::jsonb`, orgID, oversizedRunID, durableRunDetailMaxBytes+1); err != nil {
		t.Fatal(err)
	}
	var storedPayloadBytes, logicalPayloadBytes int64
	if err := owner.QueryRow(ctx, `
		SELECT pg_column_size(input)::bigint, octet_length(input::text)::bigint
		FROM agent_run_steps
		WHERE org_id = $1::uuid AND run_id = $2::uuid`, orgID, oversizedRunID).Scan(&storedPayloadBytes, &logicalPayloadBytes); err != nil {
		t.Fatal(err)
	}
	if storedPayloadBytes >= durableRunDetailMaxBytes || logicalPayloadBytes <= durableRunDetailMaxBytes {
		t.Fatalf("compressible fixture stored=%d logical=%d, want stored <= %d and logical > %d", storedPayloadBytes, logicalPayloadBytes, durableRunDetailMaxBytes, durableRunDetailMaxBytes)
	}

	reader := pgDurableRunsSessionReader{pool: runtime}
	detail, err := reader.DetailForUser(ctx, orgID, precisionRunID, userID, false)
	if err != nil {
		t.Fatal(err)
	}
	if detail == nil {
		t.Fatal("durable run detail was not visible to its initiating user")
	}
	if otherDetail, err := reader.DetailForUser(ctx, orgID, precisionRunID, sameOrgUserID, false); err != nil || otherDetail != nil {
		t.Fatalf("same-org non-initiator detail=%v err=%v, want not found", otherDetail, err)
	}
	if foreignDetail, err := reader.DetailForUser(ctx, foreignOrgID, precisionRunID, foreignUserID, false); err != nil || foreignDetail != nil {
		t.Fatalf("foreign-org detail=%v err=%v, want not found", foreignDetail, err)
	}
	if detail.Run.CreatedAt != "2026-09-10T11:12:13.123Z" || detail.Run.UpdatedAt != "2026-09-10T11:12:14.987Z" ||
		detail.Run.StartedAt == nil || *detail.Run.StartedAt != "2026-09-10T11:12:12.456Z" ||
		detail.Run.FinishedAt == nil || *detail.Run.FinishedAt != "2026-09-10T11:12:15.999Z" {
		t.Fatalf("run timestamps = created %q updated %q started %v finished %v", detail.Run.CreatedAt, detail.Run.UpdatedAt, detail.Run.StartedAt, detail.Run.FinishedAt)
	}
	if len(detail.Steps) != 1 || detail.Steps[0].CreatedAt != "2026-09-10T11:12:16.123Z" ||
		detail.Steps[0].StartedAt == nil || *detail.Steps[0].StartedAt != "2026-09-10T11:12:16.999Z" ||
		detail.Steps[0].FinishedAt == nil || *detail.Steps[0].FinishedAt != "2026-09-10T11:12:17.456Z" {
		t.Fatalf("step timestamps = %+v", detail.Steps)
	}
	runs, err := reader.ListForUser(ctx, orgID, userID, false)
	if err != nil {
		t.Fatal(err)
	}
	var listed *durableRunListRow
	for index := range runs {
		if runs[index].ID == precisionRunID {
			listed = &runs[index]
			break
		}
	}
	if listed == nil || listed.CreatedAt != "2026-09-10T11:12:13.123Z" || listed.UpdatedAt != "2026-09-10T11:12:14.987Z" ||
		listed.StartedAt == nil || *listed.StartedAt != "2026-09-10T11:12:12.456Z" ||
		listed.FinishedAt == nil || *listed.FinishedAt != "2026-09-10T11:12:15.999Z" {
		t.Fatalf("listed run = %+v", listed)
	}
	if _, err := reader.DetailForUser(ctx, orgID, largeRunID, userID, false); !errors.Is(err, errDurableRunDetailTooLarge) {
		t.Fatalf("large run error = %v, want detail limit sentinel", err)
	}
	if _, err := reader.DetailForUser(ctx, orgID, oversizedRunID, userID, false); !errors.Is(err, errDurableRunDetailTooLarge) {
		t.Fatalf("oversized payload run error = %v, want detail limit sentinel", err)
	}
}

func TestDurableRunsSessionHandlerAuthOrganizationAndRouteErrors(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		reader := &fakeDurableRunsSessionReader{}
		response := httptest.NewRecorder()
		newDurableRunsSessionHandler(&fakeDirectSessionResolver{err: errors.New("no session")}, reader, nil).ServeHTTP(
			response, httptest.NewRequest(http.MethodGet, "/api/durable-runs", nil))
		if response.Code != http.StatusUnauthorized || reader.listCalls != 0 || response.Header().Get("WWW-Authenticate") == "" {
			t.Fatalf("status=%d reader calls=%d headers=%v", response.Code, reader.listCalls, response.Header())
		}
	})
	t.Run("invalid organization selector", func(t *testing.T) {
		reader := &fakeDurableRunsSessionReader{}
		request := httptest.NewRequest(http.MethodGet, "/api/durable-runs", nil)
		request.Header.Add("X-Organization-ID", "invalid")
		response := httptest.NewRecorder()
		newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || reader.listCalls != 0 {
			t.Fatalf("status=%d reader calls=%d body=%s", response.Code, reader.listCalls, response.Body.String())
		}
	})
	t.Run("organization mismatch", func(t *testing.T) {
		reader := &fakeDurableRunsSessionReader{}
		request := httptest.NewRequest(http.MethodGet, "/api/durable-runs", nil)
		request.Header.Set("X-Organization-ID", "44444444-4444-4444-8444-444444444444")
		response := httptest.NewRecorder()
		newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || reader.listCalls != 0 {
			t.Fatalf("status=%d reader calls=%d body=%s", response.Code, reader.listCalls, response.Body.String())
		}
	})
	t.Run("unsupported method", func(t *testing.T) {
		reader := &fakeDurableRunsSessionReader{}
		response := httptest.NewRecorder()
		newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil).ServeHTTP(
			response, httptest.NewRequest(http.MethodPost, "/api/durable-runs", strings.NewReader(`{}`)))
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet || reader.listCalls != 0 {
			t.Fatalf("status=%d allow=%q reader calls=%d", response.Code, response.Header().Get("Allow"), reader.listCalls)
		}
	})
	t.Run("database failure", func(t *testing.T) {
		reader := &fakeDurableRunsSessionReader{err: errors.New("private database detail")}
		response := httptest.NewRecorder()
		newDurableRunsSessionHandler(&fakeDirectSessionResolver{resolved: directTestIdentity()}, reader, nil).ServeHTTP(
			response, httptest.NewRequest(http.MethodGet, "/api/durable-runs", nil))
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private database detail") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
}
