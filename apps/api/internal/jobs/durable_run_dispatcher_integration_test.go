package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	durableTestProfile           = `{"id":"erp-prod","version":"1.0.0","environment":"erp-prod","authority":{"allowSourceWrites":false,"allowProcessLaunch":false,"allowCodeExecution":false,"allowRegistryMutation":false,"allowNetwork":true},"allowedModules":["accounting","crm"]}`
	durableTestBundles           = `[{"id":"core","version":"1.0.0","serviceIds":["ledger","mailer"]}]`
	durableTestPatches           = `[{"id":"defaults","version":"2.0.0","values":{"retention":{"days":90},"label":"erp"}}]`
	durableTestProfileDigest     = "a667f8842fe5203faa9f2174079f2b6f7e1de17cdb025fcd3f243d5bb706c81d"
	durableTestCompositionDigest = "75b91e4570ef5fe6ab768475ae605ac6d132221a94b356d7edc4ec8deebda1c5"
)

func TestDurableRunCreateIsOrgScopedAndIdempotentWithRuntimeRole(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for durable run producer runtime proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if err != nil {
		t.Skipf("runtime database role is unavailable: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	runtimePool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	defer runtimePool.Close()
	if err := dbx.VerifyAppRuntimeRole(ctx, runtimePool); err != nil {
		t.Fatalf("verify app runtime role: %v", err)
	}
	workerPool, err := pgxpool.New(ctx, workerRoleURL(t, ownerURL, "chaste_jobs_worker", envOr("CHASTE_JOBS_WORKER_DB_PASSWORD", "chaste_jobs_worker_dev_only")))
	if err != nil {
		t.Fatal(err)
	}
	defer workerPool.Close()
	if err := VerifyRole(ctx, workerPool); err != nil {
		t.Fatalf("verify jobs worker role: %v", err)
	}

	tag := fmt.Sprintf("durable-run-producer-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	otherOrgID := insertJobsTestOrg(t, ctx, owner, tag+"-other")
	defer cleanupJobsTestOrgs(t, owner, orgID, otherOrgID)
	var compositionID, approvalID, stepApprovalID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO harness_compositions (org_id, profile_id, profile_version, environment, profile_digest, composition_digest, profile, bundles, patches)
		VALUES ($1::uuid, 'erp-prod', '1.0.0', 'erp-prod', $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
		RETURNING id::text`, orgID, durableTestProfileDigest, durableTestCompositionDigest, durableTestProfile, durableTestBundles, durableTestPatches).Scan(&compositionID); err != nil {
		t.Fatalf("seed harness composition: %v", err)
	}
	compositionApprovalPayload, _ := json.Marshal(map[string]string{"compositionId": compositionID, "compositionDigest": durableTestCompositionDigest})
	if err := owner.QueryRow(ctx, `
		INSERT INTO approvals (org_id, capability_id, risk_class, payload, rationale, status, expires_at)
		VALUES ($1::uuid, 'harness.approveComposition', 'write', $2::jsonb, 'durable run integration proof', 'executed', clock_timestamp() + interval '1 hour')
		RETURNING id::text`, orgID, compositionApprovalPayload).Scan(&approvalID); err != nil {
		t.Fatalf("seed composition approval: %v", err)
	}
	writePayload := json.RawMessage(`{"name":"Durable run test customer"}`)
	if err := owner.QueryRow(ctx, `
		INSERT INTO approvals (org_id, capability_id, risk_class, payload, rationale, status, expires_at)
		VALUES ($1::uuid, 'crm.createCustomer', 'write', $2::jsonb, 'durable run step integration proof', 'executing', clock_timestamp() + interval '1 hour')
		RETURNING id::text`, orgID, writePayload).Scan(&stepApprovalID); err != nil {
		t.Fatalf("seed step approval: %v", err)
	}

	input := StartDurableRunInput{
		RunID: "88888888-8888-4888-8888-888888888888", OrgID: orgID,
		ActorID: "99999999-9999-4999-8999-999999999999", Goal: "Read the customer list", RegistryVersion: "1",
		HarnessCompositionID: compositionID, HarnessCompositionHash: durableTestCompositionDigest,
		CompositionApprovalID: approvalID,
		Steps: []DurableRunStepInput{
			{CapabilityID: "crm.listCustomers", Input: json.RawMessage(`{}`)},
			{CapabilityID: "crm.createCustomer", Input: writePayload, ApprovedApprovalID: &stepApprovalID},
		},
	}
	dispatcher := NewDurableRunDispatcher(runtimePool)
	var wait sync.WaitGroup
	results := make([]StartDurableRunResult, 2)
	errors := make([]error, 2)
	for index := range results {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index], errors[index] = dispatcher.CreateAndDispatch(ctx, input)
		}(index)
	}
	wait.Wait()
	for index, err := range errors {
		if err != nil {
			t.Fatalf("concurrent create %d: %v", index, err)
		}
	}
	if results[0].RunID != input.RunID || results[1].RunID != input.RunID || results[0].Replayed == results[1].Replayed {
		t.Fatalf("concurrent results=%+v, want one original and one replay", results)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM agent_runs WHERE org_id=$1::uuid AND id=$2::uuid`, orgID, input.RunID); got != 1 {
		t.Fatalf("durable run rows=%d, want 1", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM agent_run_steps WHERE org_id=$1::uuid AND run_id=$2::uuid`, orgID, input.RunID); got != 2 {
		t.Fatalf("durable steps=%d, want 2", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM jobs WHERE org_id=$1::uuid AND run_id=$2::uuid`, orgID, input.RunID); got != 1 {
		t.Fatalf("initial linked jobs=%d, want one sequentially-dispatched job", got)
	}
	executor := systemCapabilityExecutorFunc(func(context.Context, capability.SystemClaims, json.RawMessage) (capability.Result, error) {
		return capability.Result{OK: true, Data: json.RawMessage(`{"customers":[]}`)}, nil
	})
	worker, err := NewWorker(workerPool, workerPool, runtimePool, executor, Options{WorkerID: "durable-run-dispatch-integration"})
	if err != nil {
		t.Fatalf("create runtime worker: %v", err)
	}
	worked, err := worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("process first sequential run step: worked=%v err=%v", worked, err)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM jobs WHERE org_id=$1::uuid AND run_id=$2::uuid AND run_step_index=1 AND type='crm.createCustomer' AND approved_approval_id=$3::uuid`, orgID, input.RunID, stepApprovalID); got != 1 {
		t.Fatalf("second linked job with approval=%d, want one", got)
	}
	worked, err = worker.ProcessOne(ctx)
	if err != nil || !worked {
		t.Fatalf("process approved second sequential run step: worked=%v err=%v", worked, err)
	}
	var runStatus, stepApprovalStatus string
	if err := owner.QueryRow(ctx, `SELECT status FROM agent_runs WHERE org_id=$1::uuid AND id=$2::uuid`, orgID, input.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM approvals WHERE org_id=$1::uuid AND id=$2::uuid`, orgID, stepApprovalID).Scan(&stepApprovalStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "completed" || stepApprovalStatus != "executed" {
		t.Fatalf("final run status=%q approval status=%q, want completed/executed", runStatus, stepApprovalStatus)
	}

	foreignInput := input
	foreignInput.RunID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	foreignInput.OrgID = otherOrgID
	if _, err := dispatcher.CreateAndDispatch(ctx, foreignInput); err == nil {
		t.Fatal("runtime role accepted a composition owned by another organization")
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM agent_runs WHERE org_id=$1::uuid AND id=$2::uuid`, otherOrgID, foreignInput.RunID); got != 0 {
		t.Fatalf("foreign durable run rows=%d, want 0", got)
	}
}
