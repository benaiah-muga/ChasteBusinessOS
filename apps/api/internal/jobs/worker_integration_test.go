package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type systemCapabilityExecutorFunc func(context.Context, capability.SystemClaims, json.RawMessage) (capability.Result, error)

func (f systemCapabilityExecutorFunc) ExecuteSystem(ctx context.Context, claims capability.SystemClaims, input json.RawMessage) (capability.Result, error) {
	return f(ctx, claims, input)
}

func TestStaleWorkerCannotAdvanceDurableRunAfterReclaim(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the stale worker fencing proof")
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
		t.Fatalf("verify app runtime role: %v", err)
	}
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatalf("verify jobs worker role: %v", err)
	}

	tag := fmt.Sprintf("stale-worker-fence-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	defer cleanupJobsTestOrgs(t, owner, orgID)
	payload := json.RawMessage(`{"name":"Stale worker candidate"}`)
	var approvalID, runID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO approvals (org_id, capability_id, risk_class, payload, rationale, status, expires_at)
		VALUES ($1::uuid, 'crm.createCustomer', 'write', $2::jsonb, 'stale worker fencing proof', 'executing', clock_timestamp() + interval '1 hour')
		RETURNING id::text`, orgID, payload).Scan(&approvalID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `
		INSERT INTO agent_runs (org_id, goal, status, registry_version, initiated_by_actor_type)
		VALUES ($1::uuid, 'Stale worker fencing proof', 'waiting_approval', '1', 'agent')
		RETURNING id::text`, orgID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	const stepIndex = 1
	if _, err := owner.Exec(ctx, `
		INSERT INTO agent_run_steps (org_id, run_id, step_index, status, capability_id, capability_version, input_hash, input, approval_id)
		VALUES ($1::uuid, $2::uuid, $3, 'waiting_approval', 'crm.createCustomer', '1', 'fixture-input-hash', $4::jsonb, $5::uuid)`, orgID, runID, stepIndex, payload, approvalID); err != nil {
		t.Fatal(err)
	}
	jobID := insertJobsTestJobWithLinks(t, ctx, owner, orgID, "crm.createCustomer", payload, 3, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC), runID, stepIndex, approvalID)

	const staleWorkerID = "stale-durable-worker"
	var staleClaim *ClaimedJob
	var reclaimed *ClaimedJob
	var executor SystemCapabilityExecutor
	executor = systemCapabilityExecutorFunc(func(callCtx context.Context, _ capability.SystemClaims, _ json.RawMessage) (capability.Result, error) {
		var ownerID string
		var fencingToken int
		if err := owner.QueryRow(callCtx, `SELECT lease_owner, fencing_token FROM jobs WHERE id=$1::uuid`, jobID).Scan(&ownerID, &fencingToken); err != nil {
			return capability.Result{}, err
		}
		claimedStepIndex := stepIndex
		staleClaim = &ClaimedJob{
			ID: jobID, OrgID: orgID, Type: "crm.createCustomer", WorkerID: ownerID,
			FencingToken: fencingToken, RunID: &runID, RunStepIndex: &claimedStepIndex, ApprovedApprovalID: &approvalID,
		}
		if _, err := owner.Exec(callCtx, `UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid`, jobID); err != nil {
			return capability.Result{}, err
		}
		reclaimer, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "fresh-durable-worker", LeaseDuration: 30 * time.Second})
		if err != nil {
			return capability.Result{}, err
		}
		reclaimed, err = reclaimer.ClaimOne(callCtx)
		if err != nil {
			return capability.Result{}, err
		}
		if reclaimed == nil || reclaimed.FencingToken <= fencingToken || reclaimed.WorkerID == ownerID {
			return capability.Result{}, errors.New("job was not reclaimed with a newer lease fence")
		}
		return capability.Result{OK: true, Data: json.RawMessage(`{"customerId":"00000000-0000-4000-8000-000000000001"}`)}, nil
	})
	worker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: staleWorkerID, LeaseDuration: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	worked, err := worker.ProcessOne(ctx)
	if !worked || !errors.Is(err, ErrJobLeaseLost) {
		t.Fatalf("stale worker process worked=%v err=%v, want a fenced lease-loss error", worked, err)
	}
	if staleClaim == nil || reclaimed == nil {
		t.Fatal("stale and replacement claims were not captured")
	}

	for _, update := range []struct {
		name string
		run  func() error
	}{
		{name: "run", run: func() error { return worker.transitionRun(ctx, staleClaim, "failed", stepIndex, "stale worker") }},
		{name: "step", run: func() error {
			return worker.transitionStep(ctx, staleClaim, stepIndex, "failed", nil, "stale worker", nil, nil)
		}},
		{name: "approval", run: func() error { return worker.finishApproval(ctx, staleClaim) }},
	} {
		if err := update.run(); !errors.Is(err, ErrJobLeaseLost) {
			t.Errorf("stale %s update error=%v, want ErrJobLeaseLost", update.name, err)
		}
	}
	var jobStatus, leaseOwner, runStatus, stepStatus, approvalStatus string
	var fencingToken int
	if err := owner.QueryRow(ctx, `SELECT status, lease_owner, fencing_token FROM jobs WHERE id=$1::uuid`, jobID).Scan(&jobStatus, &leaseOwner, &fencingToken); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM agent_runs WHERE id=$1::uuid AND org_id=$2::uuid`, runID, orgID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM agent_run_steps WHERE run_id=$1::uuid AND org_id=$2::uuid AND step_index=$3`, runID, orgID, stepIndex).Scan(&stepStatus); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM approvals WHERE id=$1::uuid AND org_id=$2::uuid`, approvalID, orgID).Scan(&approvalStatus); err != nil {
		t.Fatal(err)
	}
	if jobStatus != "processing" || leaseOwner != reclaimed.WorkerID || fencingToken != reclaimed.FencingToken || runStatus != "running" || stepStatus != "running" || approvalStatus != "executing" {
		t.Fatalf("stale state mutation: job=%s/%s/%d run=%s step=%s approval=%s", jobStatus, leaseOwner, fencingToken, runStatus, stepStatus, approvalStatus)
	}

	var routineID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO routines (org_id, name, prompt, schedule, enabled, trigger_type)
		VALUES ($1::uuid, 'Stale routine', 'No action', '{"kind":"daily"}', true, 'schedule')
		RETURNING id::text`, orgID).Scan(&routineID); err != nil {
		t.Fatal(err)
	}
	routineJSON, err := json.Marshal(routinePayload{RoutineID: routineID, Trigger: "manual"})
	if err != nil {
		t.Fatal(err)
	}
	routineJobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, routineJSON, 3, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC))
	routineClaimer, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "stale-routine-worker", LeaseDuration: 30 * time.Second, RoutineAgentRunner: true})
	if err != nil {
		t.Fatal(err)
	}
	routineClaim, err := routineClaimer.ClaimOne(ctx)
	if err != nil || routineClaim == nil || routineClaim.ID != routineJobID {
		t.Fatalf("claim routine job=%+v err=%v", routineClaim, err)
	}
	routineReclaimer, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "fresh-routine-worker", LeaseDuration: 30 * time.Second, RoutineAgentRunner: true})
	if err != nil {
		t.Fatal(err)
	}
	// The fake model reclaims the lease in the response that asks for a tool call.
	// The routine then reaches ExecuteSystem with its stale claim.
	actualExecutor := capability.NewExecutor(appPool, "", "", "")
	var routineReclaimed *ClaimedJob
	var handlerErr error
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			handlerErr = fmt.Errorf("unexpected model request %s %s", r.Method, r.URL.Path)
			http.Error(w, handlerErr.Error(), http.StatusBadRequest)
			return
		}
		if requests == 1 {
			if _, err := owner.Exec(r.Context(), `UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid`, routineJobID); err != nil {
				handlerErr = err
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			routineReclaimed, handlerErr = routineReclaimer.ClaimOne(r.Context())
			if handlerErr != nil || routineReclaimed == nil || routineReclaimed.ID != routineJobID {
				if handlerErr == nil {
					handlerErr = errors.New("fake routine model could not reclaim the job")
				}
				http.Error(w, handlerErr.Error(), http.StatusInternalServerError)
				return
			}
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":null,"tool_calls":[{"id":"stale-routine-tool-call","type":"function","function":{"name":"crm_listCustomers","arguments":"{}"}}]}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
			return
		}
		var body struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			handlerErr = err
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		foundFencedTool := false
		for _, message := range body.Messages {
			if message.Role == "tool" && bytes.Contains(message.Content, []byte(capability.ErrSystemJobLeaseLost.Error())) {
				foundFencedTool = true
			}
		}
		if !foundFencedTool {
			handlerErr = errors.New("routine model did not receive the fenced tool result")
			http.Error(w, handlerErr.Error(), http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"routine finished"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
	}))
	defer server.Close()
	routineRunner := newRoutineAgent(appPool, actualExecutor)
	routineRunner.client = server.Client()
	apiKey := "fake-routine-model-key"
	config := routineConfig{BaseURL: server.URL + "/v1", APIKey: &apiKey}
	config.Models.Primary = "fake-routine-model"
	if _, _, err := routineRunner.agentLoop(ctx, routineClaim, "", routineRow{ID: routineID, Name: "Stale routine", Prompt: "List customers", OrgName: tag}, config); err != nil {
		t.Fatalf("fake routine tool turn error=%v", err)
	}
	if handlerErr != nil || requests != 2 || routineReclaimed == nil {
		t.Fatalf("fake model requests=%d reclaimer=%+v handler error=%v", requests, routineReclaimed, handlerErr)
	}
	toolIntent := routineIntent(routineJobID, 0, 0, "stale-routine-tool-call")
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, orgID, orgID+":"+toolIntent); got != 0 {
		t.Fatalf("stale routine tool created %d receipts, want none", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='crm.listCustomers' AND kind='capability.executed' AND actor_type='system'`, orgID); got != 0 {
		t.Fatalf("stale routine tool created %d capability audit events, want none", got)
	}
	freshToolClaims := capability.SystemClaims{
		OrganizationID: orgID, CapabilityID: "crm.listCustomers", Permission: GoCapabilityPermissions["crm.listCustomers"],
		IntentID: toolIntent, LeaseExtensionMillis: 180_000,
	}
	freshToolClaims.JobID = routineReclaimed.ID
	freshToolClaims.LeaseOwner = routineReclaimed.WorkerID
	freshToolClaims.FencingToken = routineReclaimed.FencingToken
	freshResult, err := actualExecutor.ExecuteSystem(ctx, freshToolClaims, json.RawMessage(`{}`))
	if err != nil || !freshResult.OK {
		t.Fatalf("fresh routine tool execution result=%+v err=%v, want success", freshResult, err)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, orgID, orgID+":"+toolIntent); got != 1 {
		t.Fatalf("fresh routine tool created %d receipts, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='crm.listCustomers' AND kind='capability.executed' AND actor_type='system'`, orgID); got != 1 {
		t.Fatalf("fresh routine tool created %d capability audit events, want one", got)
	}

	staleRoutineCtx := withJobLeaseContext(ctx, routineClaim)
	routineAgent := newRoutineAgent(appPool, executor)
	var staleRoutinePayload routinePayload
	if err := json.Unmarshal(routineJSON, &staleRoutinePayload); err != nil {
		t.Fatal(err)
	}
	if err := routineAgent.finish(staleRoutineCtx, orgID, staleRoutinePayload, routineID, "failed", "stale owner"); !errors.Is(err, ErrJobLeaseLost) {
		t.Fatalf("stale routine state update error=%v, want ErrJobLeaseLost", err)
	}
	var routineLastStatus string
	if err := owner.QueryRow(ctx, `SELECT COALESCE(last_status, '<null>') FROM routines WHERE id=$1::uuid AND org_id=$2::uuid`, routineID, orgID).Scan(&routineLastStatus); err != nil {
		t.Fatal(err)
	}
	if routineLastStatus != "<null>" {
		t.Fatalf("stale routine owner changed last_status to %q", routineLastStatus)
	}
}

func TestSystemCapabilityLongEffectCoordinatesLeaseHeartbeatAndRollback(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the long capability lease proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	appName := fmt.Sprintf("go-effect-lease-%d", time.Now().UnixNano())
	appURL, err := url.Parse(workerRoleURL(t, ownerURL, "chaste_app", envOr("CHASTE_APP_DB_PASSWORD", "chaste_app_dev_only")))
	if err != nil {
		t.Fatal(err)
	}
	appQuery := appURL.Query()
	appQuery.Set("application_name", appName)
	appURL.RawQuery = appQuery.Encode()
	appPool, err := pgxpool.New(ctx, appURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", envOr("CHASTE_JOBS_WORKER_DB_PASSWORD", "chaste_jobs_worker_dev_only")))
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
	orgID := insertJobsTestOrg(t, ctx, owner, fmt.Sprintf("effect-lease-%d", time.Now().UnixNano()))
	defer cleanupJobsTestOrgs(t, owner, orgID)
	executor := capability.NewExecutor(appPool, "", "", "")
	worker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "long-effect-worker", LeaseDuration: time.Second})
	if err != nil {
		t.Fatal(err)
	}

	// An unrelated table lock holds the governed capability transaction after
	// it has acquired and extended its own job lease row.
	longPayload := json.RawMessage(`{"name":"Lease protected long effect"}`)
	longJobID := insertJobsTestJob(t, ctx, owner, orgID, "crm.createCustomer", longPayload, 3, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC))
	blocker, err := owner.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx, `LOCK TABLE public.customers IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	processDone := make(chan struct {
		worked bool
		err    error
	}, 1)
	go func() {
		worked, err := worker.ProcessOne(ctx)
		processDone <- struct {
			worked bool
			err    error
		}{worked: worked, err: err}
	}()
	if err := waitForCapabilityTableLock(ctx, owner, appName); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-processDone:
		t.Fatalf("long capability returned before lock release: worked=%v err=%v", result.worked, result.err)
	case <-time.After(1200 * time.Millisecond):
	}
	competitor, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "long-effect-competitor", LeaseDuration: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if claimed, err := competitor.ClaimOne(ctx); err != nil || claimed != nil {
		t.Fatalf("competitor reclaimed row locked by live effect: claim=%+v err=%v", claimed, err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-processDone:
		if !result.worked || result.err != nil {
			t.Fatalf("long capability worker result worked=%v err=%v", result.worked, result.err)
		}
	case <-ctx.Done():
		t.Fatal("long capability worker did not finish after table lock release")
	}
	assertJobsTestState(t, ctx, owner, longJobID, "done", 1)
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM customers WHERE org_id=$1::uuid AND name=$2`, orgID, "Lease protected long effect"); got != 1 {
		t.Fatalf("long capability created %d customers, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, orgID, orgID+":"+longJobID); got != 1 {
		t.Fatalf("long capability created %d receipts, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='crm.createCustomer' AND kind='capability.executed' AND actor_type='system'`, orgID); got != 1 {
		t.Fatalf("long capability created %d audit events, want one", got)
	}

	// routineTx takes the same job row lock as capability effects. A delayed
	// routine read must extend the lease atomically, pause heartbeats while it
	// owns the row, and leave enough time for the original owner to acknowledge.
	var routineID string
	if err := owner.QueryRow(ctx, `INSERT INTO routines (org_id,name,prompt,schedule,enabled,trigger_type) VALUES ($1::uuid,'Lease proof routine','Read only','{"kind":"daily"}',true,'schedule') RETURNING id::text`, orgID).Scan(&routineID); err != nil {
		t.Fatal(err)
	}
	routinePayloadBytes, err := json.Marshal(routinePayload{RoutineID: routineID, Trigger: "manual"})
	if err != nil {
		t.Fatal(err)
	}
	routineJobID := insertJobsTestJob(t, ctx, owner, orgID, routineJobType, routinePayloadBytes, 3, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC))
	routineWorker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "routine-tx-owner", LeaseDuration: time.Second, RoutineAgentRunner: true})
	if err != nil {
		t.Fatal(err)
	}
	routineClaim, err := routineWorker.ClaimOne(ctx)
	if err != nil || routineClaim == nil || routineClaim.ID != routineJobID {
		t.Fatalf("routine tx proof claim=%+v err=%v", routineClaim, err)
	}
	routineBlocker, err := owner.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = routineBlocker.Rollback(context.Background()) }()
	if _, err := routineBlocker.Exec(ctx, `LOCK TABLE public.routines IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	routineCtx := withEffectHeartbeatGate(withJobLeaseContext(ctx, routineClaim), &effectHeartbeatGate{})
	routineAgent := newRoutineAgent(appPool, executor)
	routineLoaded := make(chan error, 1)
	go func() {
		_, _, loadErr := routineAgent.loadRoutine(routineCtx, orgID, routineID)
		routineLoaded <- loadErr
	}()
	if err := waitForApplicationTableLock(ctx, owner, appName, "routines"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-routineLoaded:
		t.Fatalf("routine transaction returned before lock release: %v", err)
	case <-time.After(1200 * time.Millisecond):
	}
	routineGate := routineCtx.Value(effectHeartbeatGateContextKey{}).(*effectHeartbeatGate)
	if renewed, err := routineGate.renew(ctx, func(ctx context.Context) (bool, error) { return routineWorker.renewLease(ctx, routineClaim) }); err != nil || !renewed {
		t.Fatalf("heartbeat coordination while routineTx is in flight renewed=%v err=%v", renewed, err)
	}
	competitor, err = NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "routine-tx-competitor", LeaseDuration: time.Second, RoutineAgentRunner: true})
	if err != nil {
		t.Fatal(err)
	}
	if claimed, err := competitor.ClaimOne(ctx); err != nil || claimed != nil {
		t.Fatalf("competitor reclaimed row locked by routineTx: claim=%+v err=%v", claimed, err)
	}
	if err := routineBlocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-routineLoaded:
		if err != nil {
			t.Fatalf("routineTx load failed after unblock: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("routineTx did not finish after table lock release")
	}
	var routineLeaseExpiry time.Time
	if err := owner.QueryRow(ctx, `SELECT lease_expires_at FROM jobs WHERE id=$1::uuid`, routineJobID).Scan(&routineLeaseExpiry); err != nil {
		t.Fatal(err)
	}
	if !routineLeaseExpiry.After(time.Now().UTC().Add(2 * time.Minute)) {
		t.Fatalf("routineTx did not commit the safety extension: expiry=%s", routineLeaseExpiry)
	}
	if renewed, err := routineGate.renew(ctx, func(ctx context.Context) (bool, error) { return routineWorker.renewLease(ctx, routineClaim) }); err != nil || !renewed {
		t.Fatalf("heartbeat did not resume after routineTx committed: renewed=%v err=%v", renewed, err)
	}
	if claimed, err := competitor.ClaimOne(ctx); err != nil || claimed != nil {
		t.Fatalf("competitor reclaimed after extension commit before acknowledgement: claim=%+v err=%v", claimed, err)
	}
	if finalized, err := routineWorker.finalize(ctx, routineClaim, "done", "", nil); err != nil || !finalized {
		t.Fatalf("original routine owner could not acknowledge after routineTx: finalized=%v err=%v", finalized, err)
	}
	assertJobsTestState(t, ctx, owner, routineJobID, "done", 1)

	// Cancel a second effect after its lease extension is staged but before its
	// capability write can pass the table lock. The transaction rollback must
	// discard both the extension and every governed effect, leaving it reclaimable.
	rollbackPayload := json.RawMessage(`{"name":"Rolled back lease effect"}`)
	rollbackJobID := insertJobsTestJob(t, ctx, owner, orgID, "crm.createCustomer", rollbackPayload, 3, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC))
	rollbackClaimer, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "rollback-owner", LeaseDuration: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	rollbackClaim, err := rollbackClaimer.ClaimOne(ctx)
	if err != nil || rollbackClaim == nil || rollbackClaim.ID != rollbackJobID {
		t.Fatalf("rollback proof claim=%+v err=%v", rollbackClaim, err)
	}
	rollbackBlocker, err := owner.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rollbackBlocker.Exec(ctx, `LOCK TABLE public.customers IN ACCESS EXCLUSIVE MODE`); err != nil {
		_ = rollbackBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	callCtx, cancelCall := context.WithCancel(ctx)
	callDone := make(chan error, 1)
	go func() {
		_, err := executor.ExecuteSystem(callCtx, capability.SystemClaims{
			OrganizationID: orgID, CapabilityID: rollbackClaim.Type, Permission: GoCapabilityPermissions[rollbackClaim.Type],
			IntentID: rollbackClaim.ID, JobID: rollbackClaim.ID, LeaseOwner: rollbackClaim.WorkerID,
			FencingToken: rollbackClaim.FencingToken, LeaseExtensionMillis: rollbackClaim.LeaseExtensionMillis,
		}, rollbackPayload)
		callDone <- err
	}()
	if err := waitForCapabilityTableLock(ctx, owner, appName); err != nil {
		cancelCall()
		_ = rollbackBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	time.Sleep(1200 * time.Millisecond)
	cancelCall()
	_ = rollbackBlocker.Rollback(ctx)
	select {
	case err := <-callDone:
		if err == nil {
			t.Fatal("cancelled capability transaction unexpectedly committed")
		}
	case <-ctx.Done():
		t.Fatal("cancelled capability transaction did not roll back")
	}
	var expiry time.Time
	if err := owner.QueryRow(ctx, `SELECT lease_expires_at FROM jobs WHERE id=$1::uuid`, rollbackJobID).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	if !expiry.Equal(rollbackClaim.LeaseExpiresAt) || expiry.After(time.Now().UTC()) {
		t.Fatalf("rolled back effect changed lease expiry from %s to %s", rollbackClaim.LeaseExpiresAt, expiry)
	}
	if _, err := owner.Exec(ctx, `UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1::uuid AND status='processing' AND lease_owner=$2 AND fencing_token=$3`, rollbackJobID, rollbackClaim.WorkerID, rollbackClaim.FencingToken); err != nil {
		t.Fatal(err)
	}
	var expired bool
	if err := owner.QueryRow(ctx, `SELECT lease_expires_at < clock_timestamp() FROM jobs WHERE id=$1::uuid`, rollbackJobID).Scan(&expired); err != nil {
		t.Fatal(err)
	}
	if !expired {
		t.Fatal("rollback fixture lease did not expire before reclaim")
	}
	if renewed, err := rollbackClaimer.renewLease(ctx, rollbackClaim); err != nil || renewed {
		t.Fatalf("expired same-owner heartbeat renewed=%v err=%v, want false without error", renewed, err)
	}
	if finalized, err := rollbackClaimer.finalize(ctx, rollbackClaim, "done", "expired owner", nil); err != nil || finalized {
		t.Fatalf("expired same-owner finalization finalized=%v err=%v, want false without error", finalized, err)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM customers WHERE org_id=$1::uuid AND name=$2`, orgID, "Rolled back lease effect"); got != 0 {
		t.Fatalf("rolled back capability created %d customers, want none", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, orgID, orgID+":"+rollbackJobID); got != 0 {
		t.Fatalf("rolled back capability created %d receipts, want none", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND capability_id='crm.createCustomer' AND kind='capability.executed' AND actor_type='system'`, orgID); got != 1 {
		t.Fatalf("rolled back capability changed audit count to %d, want only the successful long effect", got)
	}
	recoveryWorker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "rollback-recovery-owner", LeaseDuration: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := recoveryWorker.ClaimOne(ctx)
	if err != nil || recovered == nil || recovered.ID != rollbackJobID || recovered.FencingToken <= rollbackClaim.FencingToken {
		t.Fatalf("rolled back job was not safely reclaimable: claim=%+v err=%v", recovered, err)
	}
	result, err := executor.ExecuteSystem(ctx, capability.SystemClaims{
		OrganizationID: orgID, CapabilityID: recovered.Type, Permission: GoCapabilityPermissions[recovered.Type],
		IntentID: recovered.ID, JobID: recovered.ID, LeaseOwner: recovered.WorkerID,
		FencingToken: recovered.FencingToken, LeaseExtensionMillis: recovered.LeaseExtensionMillis,
	}, rollbackPayload)
	if err != nil || !result.OK {
		t.Fatalf("recovered capability result=%+v err=%v", result, err)
	}
}

func waitForCapabilityTableLock(ctx context.Context, owner *pgxpool.Pool, appName string) error {
	return waitForApplicationTableLock(ctx, owner, appName, "customers")
}

func waitForApplicationTableLock(ctx context.Context, owner *pgxpool.Pool, appName, table string) error {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		if err := owner.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity
				WHERE application_name=$1 AND wait_event_type='Lock' AND query ILIKE '%' || $2 || '%'
			)`, appName, table).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("capability executor did not reach the controlled customers table lock")
}

func TestGoCapabilityJobWorkerMatchesLegacy(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the Go capability jobs database proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := os.Getenv("CHASTE_APP_DB_PASSWORD")
	if appPassword == "" {
		appPassword = "chaste_app_dev_only"
	}
	workerPassword := os.Getenv("CHASTE_JOBS_WORKER_DB_PASSWORD")
	if workerPassword == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("CHASTE_JOBS_WORKER_DB_PASSWORD is required for the jobs worker database proof")
		}
		workerPassword = "chaste_jobs_worker_dev_only"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect database owner: %v", err)
	}
	defer owner.Close()
	appPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_app", appPassword))
	if err != nil {
		t.Fatalf("connect app runtime: %v", err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", workerPassword))
	if err != nil {
		t.Fatalf("connect jobs worker: %v", err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, appPool); err != nil {
		t.Fatalf("verify app runtime role: %v", err)
	}
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatalf("verify jobs worker role: %v", err)
	}

	tag := fmt.Sprintf("go-jobs-%d", time.Now().UnixNano())
	orgA := insertJobsTestOrg(t, ctx, owner, tag+"-a")
	orgB := insertJobsTestOrg(t, ctx, owner, tag+"-b")
	defer cleanupJobsTestOrgs(t, owner, orgA, orgB)

	executor := capability.NewExecutor(appPool, "", "", "")
	worker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{
		WorkerID:      "go-jobs-integration-worker",
		LeaseDuration: time.Second,
		PollInterval:  10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	unsupportedID := insertJobsTestJob(t, ctx, owner, orgA, "documents.parseDocument", json.RawMessage(`{"documentId":"00000000-0000-4000-8000-000000000000"}`), 3, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC))
	routineID := insertJobsTestJob(t, ctx, owner, orgA, "routines.executeRoutine", json.RawMessage(`{"routineId":"00000000-0000-4000-8000-000000000000","trigger":"schedule"}`), 3, time.Date(2090, 1, 1, 0, 0, 0, 0, time.UTC))
	foreignID := insertJobsTestJob(t, ctx, owner, orgB, "crm.createCustomer", json.RawMessage(`{"name":"Foreign tenant customer"}`), 3, time.Date(2090, 1, 1, 0, 0, 0, 0, time.UTC))

	var unscopedPayload []byte
	err = workerPool.QueryRow(ctx, `SELECT payload FROM public.jobs WHERE id = $1::uuid`, foreignID).Scan(&unscopedPayload)
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("jobs worker read payload without org context: err=%v", err)
	}
	var crossTenantID string
	_, err = dbx.WithOrgTx(ctx, workerPool, orgA, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `SELECT id::text FROM public.jobs WHERE id = $1::uuid AND org_id = $2::uuid`, foreignID, orgB).Scan(&crossTenantID)
	})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("jobs worker crossed organization boundary: err=%v", err)
	}
	_, err = dbx.WithOrgTx(ctx, workerPool, orgA, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `SELECT payload FROM public.jobs WHERE id = $1::uuid`, unsupportedID).Scan(&unscopedPayload)
	})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("jobs worker read a TypeScript-owned capability payload: err=%v", err)
	}

	// Two concurrent claimers must receive different rows. The claim function
	// returns metadata only, and its SQL allowlist skips both unported jobs.
	claimAID := insertJobsTestJob(t, ctx, owner, orgA, "crm.listTasks", json.RawMessage(`{}`), 3, time.Date(1901, 1, 1, 0, 0, 0, 0, time.UTC))
	claimBID := insertJobsTestJob(t, ctx, owner, orgA, "crm.listTasks", json.RawMessage(`{}`), 3, time.Date(1901, 1, 1, 0, 0, 0, 0, time.UTC))
	workerB, err := NewWorker(workerPool, workerPool, appPool, executor, Options{WorkerID: "go-jobs-integration-worker-b", LeaseDuration: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	var claims [2]*ClaimedJob
	var claimErrors [2]error
	var concurrent sync.WaitGroup
	concurrent.Add(2)
	go func() {
		defer concurrent.Done()
		claims[0], claimErrors[0] = worker.ClaimOne(ctx)
	}()
	go func() {
		defer concurrent.Done()
		claims[1], claimErrors[1] = workerB.ClaimOne(ctx)
	}()
	concurrent.Wait()
	for index, claimErr := range claimErrors {
		if claimErr != nil {
			t.Fatalf("claim %d: %v", index, claimErr)
		}
	}
	if claims[0] == nil || claims[1] == nil || claims[0].ID == claims[1].ID {
		t.Fatalf("concurrent claims were not unique: %#v", claims)
	}
	claimedIDs := map[string]bool{claims[0].ID: true, claims[1].ID: true}
	if !claimedIDs[claimAID] || !claimedIDs[claimBID] {
		t.Fatalf("claim function took unsupported work instead of the allowlisted jobs: %#v", claims)
	}
	if len(claims[0].Payload) != 0 || len(claims[1].Payload) != 0 {
		t.Fatal("global claim returned a job payload")
	}
	for index, claim := range claims {
		currentWorker := worker
		if index == 1 {
			currentWorker = workerB
		}
		if finalized, err := currentWorker.finalize(ctx, claim, "failed", "claim concurrency fixture released", nil); err != nil || !finalized {
			t.Fatalf("release claim %d: finalized=%v err=%v", index, finalized, err)
		}
	}

	// A worker crash after the governed receipt commits but before queue ack is
	// recovered by the same job ID receipt without duplicating the customer.
	replayInput := json.RawMessage(`{"name":"Go jobs receipt replay customer"}`)
	replayID := insertJobsTestJob(t, ctx, owner, orgA, "crm.createCustomer", replayInput, 3, time.Date(1902, 1, 1, 0, 0, 0, 0, time.UTC))
	firstClaim, err := worker.ClaimOne(ctx)
	if err != nil || firstClaim == nil || firstClaim.ID != replayID {
		t.Fatalf("first receipt claim=%#v err=%v", firstClaim, err)
	}
	if err := worker.loadPayload(ctx, firstClaim); err != nil {
		t.Fatalf("load first payload: %v", err)
	}
	firstResult, err := executor.ExecuteSystem(ctx, capability.SystemClaims{
		OrganizationID: orgA, CapabilityID: firstClaim.Type,
		Permission: GoCapabilityPermissions[firstClaim.Type], IntentID: firstClaim.ID,
		JobID: firstClaim.ID, LeaseOwner: firstClaim.WorkerID, FencingToken: firstClaim.FencingToken,
		LeaseExtensionMillis: firstClaim.LeaseExtensionMillis,
	}, firstClaim.Payload)
	if err != nil || !firstResult.OK || firstResult.Replayed {
		t.Fatalf("first effect result=%+v err=%v", firstResult, err)
	}
	if _, err := owner.Exec(ctx, `UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid`, replayID); err != nil {
		t.Fatal(err)
	}
	worked, err := worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("replacement worker process worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, replayID, "done", 2)
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM customers WHERE org_id = $1::uuid AND name = $2`, orgA, "Go jobs receipt replay customer"); got != 1 {
		t.Fatalf("receipt replay produced %d customers, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM action_receipts WHERE org_id = $1::uuid AND intent_key = $2`, orgA, orgA+":"+replayID); got != 1 {
		t.Fatalf("receipt replay produced %d action receipts, want one", got)
	}

	// Approval, effect receipt, and durable-step completion stay linked through
	// the same organization-scoped queue row.
	approvedInput := json.RawMessage(`{"name":"Go jobs approved durable customer","preferredContactMethod":"email","doNotContact":false}`)
	if _, err := owner.Exec(ctx, `
		INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, requires_approval_for)
		VALUES ($1::uuid, 'crm.createCustomer', 'read', '[]'::jsonb)`, orgA); err != nil {
		t.Fatal(err)
	}
	var approvalID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO approvals (org_id, capability_id, risk_class, payload, rationale, status, expires_at)
		VALUES ($1::uuid, 'crm.createCustomer', 'write', $2::jsonb, 'go jobs integration approval', 'executing', clock_timestamp() + interval '1 hour')
		RETURNING id::text`, orgA, approvedInput).Scan(&approvalID); err != nil {
		t.Fatal(err)
	}
	var runID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO agent_runs (org_id, goal, status, registry_version, initiated_by_actor_type)
		VALUES ($1::uuid, 'Go jobs durable worker proof', 'waiting_approval', '1', 'agent')
		RETURNING id::text`, orgA).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	var stepIndex = 1
	if _, err := owner.Exec(ctx, `
		INSERT INTO agent_run_steps (org_id, run_id, step_index, status, capability_id, capability_version, input_hash, input, approval_id)
		VALUES ($1::uuid, $2::uuid, $3, 'waiting_approval', 'crm.createCustomer', '1', 'fixture-input-hash', $4::jsonb, $5::uuid)`, orgA, runID, stepIndex, approvedInput, approvalID); err != nil {
		t.Fatal(err)
	}
	durableJobID := insertJobsTestJobWithLinks(t, ctx, owner, orgA, "crm.createCustomer", approvedInput, 3, time.Date(1903, 1, 1, 0, 0, 0, 0, time.UTC), runID, stepIndex, approvalID)
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("approved durable job process worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, durableJobID, "done", 1)
	var stepStatus, runStatus, approvalStatus string
	var receiptID *string
	if err := owner.QueryRow(ctx, `SELECT status, receipt_id::text FROM agent_run_steps WHERE org_id = $1::uuid AND run_id = $2::uuid AND step_index = $3`, orgA, runID, stepIndex).Scan(&stepStatus, &receiptID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM agent_runs WHERE org_id = $1::uuid AND id = $2::uuid`, orgA, runID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM approvals WHERE id = $1::uuid AND org_id = $2::uuid`, approvalID, orgA).Scan(&approvalStatus); err != nil {
		t.Fatal(err)
	}
	if stepStatus != "committed" || receiptID == nil || runStatus != "running" || approvalStatus != "executed" {
		t.Fatalf("linked durable state step=%q receipt=%v run=%q approval=%q", stepStatus, receiptID, runStatus, approvalStatus)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id = 'crm.createCustomer' AND actor_type = 'system' AND actor_id IS NULL AND session_id IS NULL`, orgA); got != 2 {
		t.Fatalf("system-attributed execution events=%d, want two", got)
	}

	// Running and failed durable-step transitions clear approval_id when the
	// queue row has no approval, while preserving a prior receipt_id. This
	// matches the legacy Drizzle update's NULL-versus-omitted field semantics.
	var priorReceiptID string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM action_receipts WHERE org_id = $1::uuid AND intent_key = $2`, orgA, orgA+":"+replayID).Scan(&priorReceiptID); err != nil {
		t.Fatal(err)
	}
	var failedRunID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO agent_runs (org_id, goal, status, registry_version, initiated_by_actor_type)
		VALUES ($1::uuid, 'Go jobs durable failure transition', 'waiting_approval', '1', 'agent')
		RETURNING id::text`, orgA).Scan(&failedRunID); err != nil {
		t.Fatal(err)
	}
	failedStepIndex := 1
	if _, err := owner.Exec(ctx, `
		INSERT INTO agent_run_steps (org_id, run_id, step_index, status, capability_id, capability_version, input_hash, input, approval_id, receipt_id)
		VALUES ($1::uuid, $2::uuid, $3, 'waiting_approval', 'crm.createCustomer', '1', 'fixture-input-hash', '{"name":""}'::jsonb, $4::uuid, $5::uuid)`, orgA, failedRunID, failedStepIndex, approvalID, priorReceiptID); err != nil {
		t.Fatal(err)
	}
	linkedFailureID := insertJobsTestJobWithLinks(t, ctx, owner, orgA, "crm.createCustomer", json.RawMessage(`{"name":""}`), 2, time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC), failedRunID, failedStepIndex, "")
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("linked retry process worked=%v err=%v", worked, err)
	}
	assertDurableStepRefs(t, ctx, owner, orgA, failedRunID, failedStepIndex, "running", priorReceiptID, false)
	if _, err := owner.Exec(ctx, `UPDATE jobs SET attempts = max_attempts - 1, available_at = '1906-01-01'::timestamptz WHERE id = $1::uuid`, linkedFailureID); err != nil {
		t.Fatal(err)
	}
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("linked exhausted process worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, linkedFailureID, "failed", 2)
	assertDurableStepRefs(t, ctx, owner, orgA, failedRunID, failedStepIndex, "failed", priorReceiptID, false)

	// A failed capability retries with the legacy exponential delay and is
	// permanently failed at max_attempts.
	invalidID := insertJobsTestJob(t, ctx, owner, orgA, "crm.createCustomer", json.RawMessage(`{"name":""}`), 3, time.Date(1905, 1, 1, 0, 0, 0, 0, time.UTC))
	started := time.Now()
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("invalid job retry process worked=%v err=%v", worked, err)
	}
	var retryStatus, retryError string
	var attempts int
	var availableAt time.Time
	if err := owner.QueryRow(ctx, `SELECT status, attempts, last_error, available_at FROM jobs WHERE id = $1::uuid`, invalidID).Scan(&retryStatus, &attempts, &retryError, &availableAt); err != nil {
		t.Fatal(err)
	}
	if retryStatus != "pending" || attempts != 1 || !strings.Contains(retryError, "invalid input") || availableAt.Before(started.Add(900*time.Millisecond)) {
		t.Fatalf("retry state status=%q attempts=%d error=%q available=%s", retryStatus, attempts, retryError, availableAt)
	}
	if _, err := owner.Exec(ctx, `UPDATE jobs SET attempts = max_attempts - 1, available_at = '1905-01-01'::timestamptz WHERE id = $1::uuid`, invalidID); err != nil {
		t.Fatal(err)
	}
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("exhausted invalid job process worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, invalidID, "failed", 3)
	assertJobsTestState(t, ctx, owner, unsupportedID, "pending", 0)
	assertJobsTestState(t, ctx, owner, routineID, "pending", 0)

}

func TestCRMDealJobsClaimAndExecuteThroughSystemPath(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the CRM deal jobs database proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := os.Getenv("CHASTE_APP_DB_PASSWORD")
	if appPassword == "" {
		appPassword = "chaste_app_dev_only"
	}
	workerPassword := os.Getenv("CHASTE_JOBS_WORKER_DB_PASSWORD")
	if workerPassword == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("CHASTE_JOBS_WORKER_DB_PASSWORD is required for the CRM deal jobs database proof")
		}
		workerPassword = "chaste_jobs_worker_dev_only"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect database owner: %v", err)
	}
	defer owner.Close()
	appPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_app", appPassword))
	if err != nil {
		t.Fatalf("connect app runtime: %v", err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", workerPassword))
	if err != nil {
		t.Fatalf("connect jobs worker: %v", err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, appPool); err != nil {
		t.Fatalf("verify app runtime role: %v", err)
	}
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatalf("verify jobs worker role: %v", err)
	}

	tag := fmt.Sprintf("crm-deal-jobs-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	defer cleanupJobsTestOrgs(t, owner, orgID)
	executor := capability.NewExecutor(appPool, "", "", "")
	worker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{
		WorkerID:      "crm-deal-jobs-integration-worker",
		LeaseDuration: time.Second,
		PollInterval:  10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	for capabilityID, permission := range map[string]string{
		"crm.createDeal":    "crm.write",
		"crm.moveDealStage": "crm.write",
		"crm.convertLead":   "crm.write",
	} {
		if GoCapabilityPermissions[capabilityID] != permission {
			t.Fatalf("Go job permission for %s = %q, want %q", capabilityID, GoCapabilityPermissions[capabilityID], permission)
		}
	}

	availableAt := time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC)
	createID := insertJobsTestJob(t, ctx, owner, orgID, "crm.createDeal", json.RawMessage(`{"title":"Worker-created prospect","valueMinor":7300,"source":"worker"}`), 3, availableAt)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("createDeal job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, createID, "done", 1)
	var dealID string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM deals WHERE org_id=$1::uuid AND title='Worker-created prospect'`, orgID).Scan(&dealID); err != nil {
		t.Fatal(err)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, orgID, orgID+":"+createID); got != 1 {
		t.Fatalf("createDeal system receipts=%d, want one", got)
	}

	moveToProposalID := insertJobsTestJob(t, ctx, owner, orgID, "crm.moveDealStage", json.RawMessage(fmt.Sprintf(`{"dealId":%q,"stage":"proposal"}`, dealID)), 3, availableAt)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("moveDealStage proposal job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, moveToProposalID, "done", 1)
	assertCRMDealJobStage(t, ctx, owner, orgID, dealID, "proposal")

	moveToLeadID := insertJobsTestJob(t, ctx, owner, orgID, "crm.moveDealStage", json.RawMessage(fmt.Sprintf(`{"dealId":%q,"stage":"lead"}`, dealID)), 3, availableAt)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("moveDealStage lead job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, moveToLeadID, "done", 1)
	assertCRMDealJobStage(t, ctx, owner, orgID, dealID, "lead")

	convertID := insertJobsTestJob(t, ctx, owner, orgID, "crm.convertLead", json.RawMessage(fmt.Sprintf(`{"dealId":%q,"createCustomer":true}`, dealID)), 3, availableAt)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("convertLead job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, convertID, "done", 1)
	var stage, customerName string
	if err := owner.QueryRow(ctx, `
		SELECT d.stage,c.name FROM deals d JOIN customers c ON c.id=d.customer_id
		WHERE d.id=$1::uuid AND d.org_id=$2::uuid`, dealID, orgID).Scan(&stage, &customerName); err != nil {
		t.Fatal(err)
	}
	if stage != "qualified" || customerName != "Worker-created prospect" {
		t.Fatalf("system conversion stage/customer=%q/%q, want qualified/title-derived customer", stage, customerName)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM ledger_events
		WHERE org_id=$1::uuid AND kind='capability.executed' AND actor_type='system' AND actor_id IS NULL AND session_id IS NULL
		AND capability_id IN ('crm.createDeal','crm.moveDealStage','crm.convertLead')`, orgID); got != 4 {
		t.Fatalf("system CRM deal audit events=%d, want four executions", got)
	}
}

func assertCRMDealJobStage(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, dealID, wantStage string) {
	t.Helper()
	var got string
	if err := owner.QueryRow(ctx, `SELECT stage FROM deals WHERE id=$1::uuid AND org_id=$2::uuid`, dealID, orgID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != wantStage {
		t.Fatalf("CRM deal stage=%q, want %q", got, wantStage)
	}
}

func TestCRMTaskJobsClaimAndExecuteThroughSystemPath(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the CRM task jobs database proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := os.Getenv("CHASTE_APP_DB_PASSWORD")
	if appPassword == "" {
		appPassword = "chaste_app_dev_only"
	}
	workerPassword := os.Getenv("CHASTE_JOBS_WORKER_DB_PASSWORD")
	if workerPassword == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("CHASTE_JOBS_WORKER_DB_PASSWORD is required for the CRM task jobs database proof")
		}
		workerPassword = "chaste_jobs_worker_dev_only"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect database owner: %v", err)
	}
	defer owner.Close()
	appPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_app", appPassword))
	if err != nil {
		t.Fatalf("connect app runtime: %v", err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", workerPassword))
	if err != nil {
		t.Fatalf("connect jobs worker: %v", err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, appPool); err != nil {
		t.Fatalf("verify app runtime role: %v", err)
	}
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatalf("verify jobs worker role: %v", err)
	}

	tag := fmt.Sprintf("crm-task-jobs-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	defer cleanupJobsTestOrgs(t, owner, orgID)
	executor := capability.NewExecutor(appPool, "", "", "")
	worker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{
		WorkerID:      "crm-task-jobs-integration-worker",
		LeaseDuration: time.Second,
		PollInterval:  10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	for capabilityID, permission := range map[string]string{
		"crm.createTask":         "crm.write",
		"crm.completeTask":       "crm.write",
		"crm.updateTaskDetails":  "crm.write",
		"crm.restoreTaskDetails": "crm.write",
	} {
		if GoCapabilityPermissions[capabilityID] != permission {
			t.Fatalf("Go job permission for %s = %q, want %q", capabilityID, GoCapabilityPermissions[capabilityID], permission)
		}
	}

	availableAt := time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC)
	createID := insertJobsTestJob(t, ctx, owner, orgID, "crm.createTask", json.RawMessage(`{"title":"Worker follow-up","dueAt":"2026-10-01T09:30:00.123Z","refType":"customer"}`), 3, availableAt)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("createTask job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, createID, "done", 1)
	var taskID string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM tasks WHERE org_id=$1::uuid AND title='Worker follow-up'`, orgID).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	var refType *string
	if err := owner.QueryRow(ctx, `SELECT ref_type FROM tasks WHERE id=$1::uuid`, taskID).Scan(&refType); err != nil {
		t.Fatal(err)
	}
	if refType != nil {
		t.Fatalf("system createTask ref_type=%q, want null without refId", *refType)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, orgID, orgID+":"+createID); got != 1 {
		t.Fatalf("createTask system receipts=%d, want one", got)
	}

	dueUpdateID := insertJobsTestJob(t, ctx, owner, orgID, "crm.updateTaskDetails", json.RawMessage(fmt.Sprintf(`{"taskId":%q,"dueAt":"2026-11-15T08:00:00.000Z"}`, taskID)), 3, availableAt)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("updateTaskDetails job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, dueUpdateID, "done", 1)
	var updatedDueAt *string
	if err := owner.QueryRow(ctx, `SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM tasks WHERE id=$1::uuid`, taskID).Scan(&updatedDueAt); err != nil {
		t.Fatal(err)
	}
	if updatedDueAt == nil || *updatedDueAt != "2026-11-15T08:00:00.000Z" {
		t.Fatalf("system updateTaskDetails due_at=%v, want 2026-11-15T08:00:00.000Z", updatedDueAt)
	}

	restoreID := insertJobsTestJob(t, ctx, owner, orgID, "crm.restoreTaskDetails", json.RawMessage(fmt.Sprintf(`{"taskId":%q,"dueAt":"2026-10-01T09:30:00.123Z"}`, taskID)), 3, availableAt)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("restoreTaskDetails job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, restoreID, "done", 1)
	if err := owner.QueryRow(ctx, `SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM tasks WHERE id=$1::uuid`, taskID).Scan(&updatedDueAt); err != nil {
		t.Fatal(err)
	}
	if updatedDueAt == nil || *updatedDueAt != "2026-10-01T09:30:00.123Z" {
		t.Fatalf("system restoreTaskDetails due_at=%v, want 2026-10-01T09:30:00.123Z", updatedDueAt)
	}

	completeID := insertJobsTestJob(t, ctx, owner, orgID, "crm.completeTask", json.RawMessage(fmt.Sprintf(`{"taskId":%q}`, taskID)), 3, availableAt)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("completeTask job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, completeID, "done", 1)
	var doneAt *time.Time
	if err := owner.QueryRow(ctx, `SELECT done_at FROM tasks WHERE id=$1::uuid`, taskID).Scan(&doneAt); err != nil {
		t.Fatal(err)
	}
	if doneAt == nil {
		t.Fatal("system completeTask left done_at null")
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM ledger_events
		WHERE org_id=$1::uuid AND kind='capability.executed' AND actor_type='system' AND actor_id IS NULL AND session_id IS NULL
		AND capability_id IN ('crm.createTask','crm.updateTaskDetails','crm.restoreTaskDetails','crm.completeTask')`, orgID); got != 4 {
		t.Fatalf("system CRM task audit events=%d, want four executions", got)
	}
}

func TestInventoryCycleCountWorkerClaimAndExecute(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the cycle-count jobs database proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := os.Getenv("CHASTE_APP_DB_PASSWORD")
	if appPassword == "" {
		appPassword = "chaste_app_dev_only"
	}
	workerPassword := os.Getenv("CHASTE_JOBS_WORKER_DB_PASSWORD")
	if workerPassword == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("CHASTE_JOBS_WORKER_DB_PASSWORD is required for the cycle-count jobs database proof")
		}
		workerPassword = "chaste_jobs_worker_dev_only"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect database owner: %v", err)
	}
	defer owner.Close()
	appPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_app", appPassword))
	if err != nil {
		t.Fatalf("connect app runtime: %v", err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", workerPassword))
	if err != nil {
		t.Fatalf("connect jobs worker: %v", err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, appPool); err != nil {
		t.Fatalf("verify app runtime role: %v", err)
	}
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatalf("verify jobs worker role: %v", err)
	}
	if GoCapabilityPermissions["inventory.createCycleCount"] != "inventory.write" ||
		GoCapabilityPermissions["inventory.recordCycleCounts"] != "inventory.write" ||
		GoCapabilityPermissions["inventory.postCycleCount"] != "inventory.write" ||
		GoCapabilityPermissions["inventory.cancelCycleCount"] != "inventory.write" {
		t.Fatal("cycle-count worker permissions are incomplete")
	}
	tag := fmt.Sprintf("inventory-cycle-count-jobs-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	defer cleanupJobsTestOrgs(t, owner, orgID)
	if _, err := owner.Exec(ctx, `INSERT INTO items (org_id, sku, name, kind) VALUES ($1::uuid, 'CYCLE-WORKER', 'Cycle count worker item', 'goods')`, orgID); err != nil {
		t.Fatalf("insert cycle-count item: %v", err)
	}
	executor := capability.NewExecutor(appPool, "", "", "")
	worker, err := NewWorker(workerPool, workerPool, appPool, executor, Options{
		WorkerID: "inventory-cycle-count-integration-worker", LeaseDuration: time.Second,
		PollInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	availableAt := time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC)
	jobID := insertJobsTestJob(t, ctx, owner, orgID, "inventory.createCycleCount", json.RawMessage(`{"skus":["CYCLE-WORKER"]}`), 3, availableAt)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("cycle-count job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, jobID, "done", 1)
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM cycle_counts cc JOIN cycle_count_lines ccl ON ccl.count_id=cc.id WHERE cc.org_id=$1::uuid AND cc.status='open' AND ccl.item_id=(SELECT id FROM items WHERE org_id=$1::uuid AND sku='CYCLE-WORKER')`, orgID); got != 1 {
		t.Fatalf("worker created %d open cycle-count snapshots, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2 AND capability_id='inventory.createCycleCount'`, orgID, orgID+":"+jobID); got != 1 {
		t.Fatalf("worker cycle-count action receipts=%d, want one", got)
	}
}

func TestPurchasingReturnGoodsWorkerClaimAndExecution(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the commerce jobs database proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := os.Getenv("CHASTE_APP_DB_PASSWORD")
	if appPassword == "" {
		appPassword = "chaste_app_dev_only"
	}
	workerPassword := os.Getenv("CHASTE_JOBS_WORKER_DB_PASSWORD")
	if workerPassword == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("CHASTE_JOBS_WORKER_DB_PASSWORD is required for the commerce jobs database proof")
		}
		workerPassword = "chaste_jobs_worker_dev_only"
	}
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
		t.Fatalf("verify app runtime role: %v", err)
	}
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatalf("verify jobs worker role: %v", err)
	}

	tag := fmt.Sprintf("commerce-jobs-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	defer cleanupJobsTestOrgs(t, owner, orgID)
	worker, err := NewWorker(workerPool, workerPool, appPool, capability.NewExecutor(appPool, "", "", ""), Options{
		WorkerID:      "commerce-jobs-integration-worker",
		LeaseDuration: time.Second,
		PollInterval:  10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	jobID := insertJobsTestJob(t, ctx, owner, orgID, "accounting.listExpenseClaims", json.RawMessage(`{}`), 3, time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC))
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("listExpenseClaims job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, jobID, "done", 1)
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed'
		AND actor_type='system' AND actor_id IS NULL AND capability_id='accounting.listExpenseClaims'`, orgID); got != 1 {
		t.Fatalf("system commerce audit events=%d, want one", got)
	}
	var vendorID string
	if err := owner.QueryRow(ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Commerce jobs vendor') RETURNING id::text`, orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO items (org_id,sku,name,sale_price_minor) VALUES ($1::uuid,'PILOT-CEM','Pilot cement',1500)`, orgID); err != nil {
		t.Fatal(err)
	}
	poPayload := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"lines":[{"description":"Stock item","quantity":2000,"unitPriceMinor":1500,"sku":"PILOT-CEM"}]}`, vendorID))
	poJobID := insertJobsTestJob(t, ctx, owner, orgID, "purchasing.createPurchaseOrder", poPayload, 3, time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC))
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("createPurchaseOrder job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, poJobID, "done", 1)
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid AND vendor_id=$2::uuid AND status='ordered'`, orgID, vendorID); got != 1 {
		t.Fatalf("system purchase orders=%d, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed'
		AND actor_type='system' AND actor_id IS NULL AND capability_id='purchasing.createPurchaseOrder'`, orgID); got != 1 {
		t.Fatalf("system purchase order audit events=%d, want one", got)
	}
	receiptPayload := json.RawMessage(`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":2000}]}`)
	receiptJobID := insertJobsTestJob(t, ctx, owner, orgID, "purchasing.receiveGoods", receiptPayload, 3, time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC))
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("receiveGoods job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, receiptJobID, "done", 1)
	if worked, err := worker.ProcessOne(ctx); err != nil || worked {
		t.Fatalf("completed receiveGoods job was claimed again: worked=%v err=%v", worked, err)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM goods_receipts r JOIN purchase_orders p ON p.id=r.po_id
		WHERE r.org_id=$1::uuid AND p.number=1 AND r.number=1`, orgID); got != 1 {
		t.Fatalf("system goods receipts=%d, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed'
		AND actor_type='system' AND actor_id IS NULL AND capability_id='purchasing.receiveGoods'`, orgID); got != 1 {
		t.Fatalf("system receipt audit events=%d, want one", got)
	}
	returnPayload := json.RawMessage(`{"poNumber":1,"lines":[{"lineNumber":1,"quantity":500,"reason":"worker return"}]}`)
	returnJobID := insertJobsTestJob(t, ctx, owner, orgID, "purchasing.returnGoods", returnPayload, 3, time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC))
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("returnGoods job worked=%v err=%v", worked, err)
	}
	assertJobsTestState(t, ctx, owner, returnJobID, "done", 1)
	if worked, err := worker.ProcessOne(ctx); err != nil || worked {
		t.Fatalf("completed returnGoods job was claimed again: worked=%v err=%v", worked, err)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM stock_movements sm JOIN items i ON i.id=sm.item_id
		WHERE sm.org_id=$1::uuid AND sm.quantity_delta=-500 AND sm.ref_type='goods_receipt_line' AND sm.reason='purchase'
		AND i.sku='PILOT-CEM'`, orgID); got != 1 {
		t.Fatalf("system return stock movements=%d, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed'
		AND actor_type='system' AND actor_id IS NULL AND capability_id='purchasing.returnGoods'`, orgID); got != 1 {
		t.Fatalf("system return audit events=%d, want one", got)
	}
}

func workerRoleURL(t *testing.T, baseURL, role, password string) string {
	t.Helper()
	parsed, err := url.Parse(baseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	parsed.User = url.UserPassword(role, password)
	return parsed.String()
}

func insertJobsTestOrg(t *testing.T, ctx context.Context, owner *pgxpool.Pool, slug string) string {
	t.Helper()
	var orgID string
	if err := owner.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id::text`, slug, slug).Scan(&orgID); err != nil {
		t.Fatalf("insert jobs test organization: %v", err)
	}
	return orgID
}

func insertJobsTestJob(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, capabilityID string, payload json.RawMessage, maxAttempts int, availableAt time.Time) string {
	return insertJobsTestJobWithLinks(t, ctx, owner, orgID, capabilityID, payload, maxAttempts, availableAt, "", 0, "")
}

func insertJobsTestJobWithLinks(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, capabilityID string, payload json.RawMessage, maxAttempts int, availableAt time.Time, runID string, runStepIndex int, approvalID string) string {
	t.Helper()
	var jobID string
	err := owner.QueryRow(ctx, `
		INSERT INTO jobs (org_id, type, payload, max_attempts, available_at, run_id, run_step_index, approved_approval_id)
		VALUES ($1::uuid, $2, $3::jsonb, $4, $5, NULLIF($6::text, '')::uuid, NULLIF($7::integer, 0), NULLIF($8::text, '')::uuid)
		RETURNING id::text`, orgID, capabilityID, payload, maxAttempts, availableAt, runID, runStepIndex, approvalID).Scan(&jobID)
	if err != nil {
		t.Fatalf("insert jobs test row: %v", err)
	}
	return jobID
}

func assertJobsTestState(t *testing.T, ctx context.Context, owner *pgxpool.Pool, jobID, wantStatus string, wantAttempts int) {
	t.Helper()
	var status string
	var attempts int
	if err := owner.QueryRow(ctx, `SELECT status, attempts FROM jobs WHERE id = $1::uuid`, jobID).Scan(&status, &attempts); err != nil {
		t.Fatalf("read job state: %v", err)
	}
	if status != wantStatus || attempts != wantAttempts {
		t.Fatalf("job %s state=%q attempts=%d, want %q/%d", jobID, status, attempts, wantStatus, wantAttempts)
	}
}

func countJobsTestRows(t *testing.T, ctx context.Context, owner *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var count int
	if err := owner.QueryRow(ctx, query, args...).Scan(&count); err != nil {
		t.Fatalf("count integration rows: %v", err)
	}
	return count
}

func assertDurableStepRefs(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, runID string, stepIndex int, wantStatus, wantReceiptID string, wantApproval bool) {
	t.Helper()
	var status string
	var receiptID, approvalID *string
	if err := owner.QueryRow(ctx, `
		SELECT status, receipt_id::text, approval_id::text FROM agent_run_steps
		WHERE org_id = $1::uuid AND run_id = $2::uuid AND step_index = $3`, orgID, runID, stepIndex).
		Scan(&status, &receiptID, &approvalID); err != nil {
		t.Fatal(err)
	}
	if status != wantStatus || receiptID == nil || *receiptID != wantReceiptID || (approvalID != nil) != wantApproval {
		t.Fatalf("durable step refs status=%q receipt=%v approval=%v, want status=%q receipt=%q approval_present=%v", status, receiptID, approvalID, wantStatus, wantReceiptID, wantApproval)
	}
}

func cleanupJobsTestOrgs(t *testing.T, owner *pgxpool.Pool, orgIDs ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := owner.Begin(ctx)
	if err != nil {
		t.Errorf("begin jobs test cleanup: %v", err)
		return
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
		_ = tx.Rollback(ctx)
		t.Errorf("enable ledger fixture cleanup: %v", err)
		return
	}
	if _, err := tx.Exec(ctx, `DELETE FROM ledger_events WHERE org_id = ANY($1::uuid[])`, orgIDs); err != nil {
		_ = tx.Rollback(ctx)
		t.Errorf("delete jobs test ledger rows: %v", err)
		return
	}
	if _, err := tx.Exec(ctx, `DELETE FROM organizations WHERE id = ANY($1::uuid[])`, orgIDs); err != nil {
		_ = tx.Rollback(ctx)
		t.Errorf("delete jobs test organizations: %v", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		t.Errorf("commit jobs test cleanup: %v", err)
	}
}
