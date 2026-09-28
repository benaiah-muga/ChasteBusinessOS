package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	routineID := insertJobsTestJob(t, ctx, owner, orgA, "routines.executeRoutine", json.RawMessage(`{"routineId":"00000000-0000-4000-8000-000000000000","trigger":"schedule"}`), 3, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC))
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
