package jobs

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRoutineJobRunsGovernedAgentAndFinalizesOccurrence(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the Go routine agent database proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := envOr("CHASTE_APP_DB_PASSWORD", "chaste_app_dev_only")
	workerPassword := envOr("CHASTE_JOBS_WORKER_DB_PASSWORD", "chaste_jobs_worker_dev_only")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	appPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_app", appPassword))
	if err != nil {
		t.Fatal(err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", workerPassword))
	if err != nil {
		t.Fatal(err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, appPool); err != nil {
		t.Fatal(err)
	}
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatal(err)
	}
	tag := fmt.Sprintf("go-routine-agent-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	defer cleanupJobsTestOrgs(t, owner, orgID)
	secret := "routine-test-encryption-secret"
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", secret)
	serverCalls := atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			t.Errorf("provider request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer integration-provider-key" {
			t.Errorf("provider authorization was not applied")
		}
		call := serverCalls.Add(1)
		if call%2 == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call-routine-1","type":"function","function":{"name":"crm_listCustomers","arguments":"{}"}}]}}],"usage":{"prompt_tokens":12,"completion_tokens":3}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Routine found the customer list."}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`))
	}))
	defer server.Close()
	settings, err := json.Marshal(map[string]any{"ai": map[string]any{"provider": "custom", "baseUrl": server.URL + "/v1", "models": map[string]string{"primary": "routine-test-model", "fast": "routine-test-model", "reasoning": "routine-test-model", "embeddings": "routine-test-model"}, "encryptedApiKey": encryptRoutineKey(t, secret, "integration-provider-key"), "keyHint": "••••key", "updatedAt": time.Now().UTC().Format(time.RFC3339)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `UPDATE organizations SET settings=$2::jsonb WHERE id=$1::uuid`, orgID, string(settings)); err != nil {
		t.Fatal(err)
	}
	var routineID, occurrenceID string
	if err := owner.QueryRow(ctx, `INSERT INTO routines(org_id,name,prompt,schedule,enabled,trigger_type) VALUES($1::uuid,'Test digest','Count customers', '{"kind":"daily","atTime":"08:00"}', true, 'schedule') RETURNING id::text`, orgID).Scan(&routineID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO routine_occurrences(org_id,routine_id,scheduled_at,status) VALUES($1::uuid,$2::uuid,clock_timestamp(),'queued') RETURNING id::text`, orgID, routineID).Scan(&occurrenceID); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(routinePayload{RoutineID: routineID, Trigger: "schedule", OccurrenceID: &occurrenceID})
	jobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, payload, 3, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC))
	executor := capability.NewExecutor(appPool, "", "", "")
	runner := newRoutineAgent(appPool, executor)
	runner.client = server.Client()
	worker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "go-routine-agent-integration", LeaseDuration: time.Second, RoutineRunner: runner, RoutineAgentRunner: true})
	if err != nil {
		t.Fatal(err)
	}
	worked, err := worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("routine worker worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, jobID, "done", 1)
	if got := serverCalls.Load(); got != 2 {
		t.Fatalf("provider calls=%d, want one tool turn and one final turn", got)
	}
	var status, lastError string
	if err := owner.QueryRow(ctx, `SELECT last_status,COALESCE(last_error,'') FROM routines WHERE id=$1::uuid AND org_id=$2::uuid`, routineID, orgID).Scan(&status, &lastError); err != nil {
		t.Fatal(err)
	}
	if status != "ok" || lastError != "" {
		t.Fatalf("routine outcome status=%q error=%q", status, lastError)
	}
	var occurrenceStatus string
	if err := owner.QueryRow(ctx, `SELECT status FROM routine_occurrences WHERE id=$1::uuid AND org_id=$2::uuid`, occurrenceID, orgID).Scan(&occurrenceStatus); err != nil {
		t.Fatal(err)
	}
	if occurrenceStatus != "done" {
		t.Fatalf("scheduled occurrence status=%q", occurrenceStatus)
	}
	var sessionID string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM agent_sessions WHERE org_id=$1::uuid AND title='Routine: Test digest' ORDER BY created_at DESC LIMIT 1`, orgID).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM session_events WHERE session_id=$1::uuid AND role IN ('user','assistant')`, sessionID); got != 2 {
		t.Fatalf("routine session events=%d, want user and assistant", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='crm.listCustomers' AND session_id=$2::uuid AND actor_type='system'`, orgID, sessionID); got != 1 {
		t.Fatalf("session-linked system capability audit events=%d", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND kind='routine.run' AND href='/sessions'`, orgID); got != 1 {
		t.Fatalf("routine finding notifications=%d", got)
	}
	var inputUsage, outputUsage int
	if err := owner.QueryRow(ctx, `SELECT (token_usage->>'input')::int,(token_usage->>'output')::int FROM agent_sessions WHERE id=$1::uuid`, sessionID).Scan(&inputUsage, &outputUsage); err != nil {
		t.Fatal(err)
	}
	if inputUsage != 22 || outputUsage != 8 {
		t.Fatalf("routine token usage in=%d out=%d", inputUsage, outputUsage)
	}
	manualPayload, _ := json.Marshal(routinePayload{RoutineID: routineID, Trigger: "manual"})
	manualJobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, manualPayload, 3, time.Date(1901, 1, 1, 0, 0, 0, 0, time.UTC))
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("manual routine worker worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, manualJobID, "done", 1)
	if got := serverCalls.Load(); got != 4 {
		t.Fatalf("provider calls after manual run=%d, want two tool turns and two final turns", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND kind='routine.run' AND href='/sessions'`, orgID); got != 2 {
		t.Fatalf("scheduled plus manual notifications=%d, want two", got)
	}
	var disabledRoutineID, disabledOccurrenceID string
	if err := owner.QueryRow(ctx, `INSERT INTO routines(org_id,name,prompt,schedule,enabled,trigger_type) VALUES($1::uuid,'Disabled digest','Do not run','{"kind":"daily","atTime":"08:00"}',false,'schedule') RETURNING id::text`, orgID).Scan(&disabledRoutineID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `INSERT INTO routine_occurrences(org_id,routine_id,scheduled_at,status) VALUES($1::uuid,$2::uuid,clock_timestamp(),'queued') RETURNING id::text`, orgID, disabledRoutineID).Scan(&disabledOccurrenceID); err != nil {
		t.Fatal(err)
	}
	disabledPayload, _ := json.Marshal(routinePayload{RoutineID: disabledRoutineID, Trigger: "schedule", OccurrenceID: &disabledOccurrenceID})
	disabledJobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, disabledPayload, 3, time.Date(1902, 1, 1, 0, 0, 0, 0, time.UTC))
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("disabled schedule worker worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, disabledJobID, "done", 1)
	var disabledRoutineStatus, disabledOccurrenceStatus string
	if err := owner.QueryRow(ctx, `SELECT last_status FROM routines WHERE id=$1::uuid`, disabledRoutineID).Scan(&disabledRoutineStatus); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM routine_occurrences WHERE id=$1::uuid`, disabledOccurrenceID).Scan(&disabledOccurrenceStatus); err != nil {
		t.Fatal(err)
	}
	if disabledRoutineStatus != "cancelled" || disabledOccurrenceStatus != "cancelled" {
		t.Fatalf("disabled scheduled routine outcome status=%q occurrence=%q", disabledRoutineStatus, disabledOccurrenceStatus)
	}
	if got := serverCalls.Load(); got != 4 {
		t.Fatalf("disabled routine called provider, count=%d", got)
	}
}

func encryptRoutineKey(t *testing.T, secret, plain string) string {
	t.Helper()
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	tag := sealed[len(sealed)-gcm.Overhead():]
	ciphertext := sealed[:len(sealed)-gcm.Overhead()]
	return "v1:" + base64.RawURLEncoding.EncodeToString(iv) + ":" + base64.RawURLEncoding.EncodeToString(tag) + ":" + base64.RawURLEncoding.EncodeToString(ciphertext)
}
