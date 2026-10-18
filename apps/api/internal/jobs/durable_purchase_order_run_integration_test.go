package jobs

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

type durableIdentityFixture struct {
	userID         string
	authUserID     string
	authSessionID  string
	agentSessionID string
}

func durableTestUUID(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

func seedDurableIdentityFixture(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, tag string) durableIdentityFixture {
	t.Helper()
	fixture := durableIdentityFixture{
		userID:         durableTestUUID(t),
		authUserID:     "durable-po-auth-" + tag,
		authSessionID:  "durable-po-session-" + tag,
		agentSessionID: durableTestUUID(t),
	}
	roleID := durableTestUUID(t)
	email := tag + "@fixture.test"
	for _, statement := range []struct {
		name  string
		query string
		args  []any
	}{
		{"users", "INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Durable PO operator')", []any{fixture.userID, email}},
		{"auth user", "INSERT INTO auth_user (id, name, email, email_verified) VALUES ($1, 'Durable PO operator', $2, true)", []any{fixture.authUserID, email}},
		{"auth session", "INSERT INTO auth_session (id, expires_at, token, user_id) VALUES ($1, $2, $3, $4)", []any{fixture.authSessionID, time.Now().Add(time.Hour), "durable-po-token-" + tag, fixture.authUserID}},
		{"membership", "INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)", []any{orgID, fixture.userID}},
		{"role", "INSERT INTO roles (id, org_id, key, name, is_system) VALUES ($1::uuid, $2::uuid, 'durable_po_operator', 'Durable PO operator', true)", []any{roleID, orgID}},
		{"role permissions", "INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'harness.approve', $2::uuid), ($1::uuid, 'purchasing.write', $2::uuid)", []any{roleID, orgID}},
		{"user role", "INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)", []any{fixture.userID, roleID, orgID}},
		{"agent session", "INSERT INTO agent_sessions (id, org_id, user_id, mode, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'assist', 'open')", []any{fixture.agentSessionID, orgID, fixture.userID}},
	} {
		if _, err := owner.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("seed durable identity %s: %v", statement.name, err)
		}
	}
	return fixture
}

func TestDurablePurchaseOrderRunWorkerGateReceiptAndAuditProof(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the durable purchase order worker proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if err != nil {
		t.Skipf("runtime database role is unavailable: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
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

	tag := fmt.Sprintf("durable-po-worker-%d", time.Now().UnixNano())
	orgID := insertJobsTestOrg(t, ctx, owner, tag)
	fixture := seedDurableIdentityFixture(t, ctx, owner, orgID, tag)
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = owner.Exec(cleanupCtx, `DELETE FROM auth_session WHERE id=$1`, fixture.authSessionID)
		_, _ = owner.Exec(cleanupCtx, `DELETE FROM users WHERE id=$1::uuid`, fixture.userID)
		_, _ = owner.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id=$1`, fixture.authUserID)
	}()
	defer cleanupJobsTestOrgs(t, owner, orgID)

	executor := capability.NewExecutor(runtimePool, "", "", "")
	var compositionID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO harness_compositions (org_id, profile_id, profile_version, environment, profile_digest, composition_digest, profile, bundles, patches)
		VALUES ($1::uuid, 'erp-prod', '1.0.0', 'erp-prod', $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
		RETURNING id::text`, orgID, durableTestProfileDigest, durableTestCompositionDigest, durableTestProfile, durableTestBundles, durableTestPatches).Scan(&compositionID); err != nil {
		t.Fatalf("seed harness composition: %v", err)
	}
	compositionRequestInput := json.RawMessage(fmt.Sprintf(`{"compositionId":%q,"compositionDigest":%q}`, compositionID, durableTestCompositionDigest))
	compositionDecision, err := executeAgentCapability(t, ctx, executor, fixture, orgID, "harness.approveComposition", []string{"harness.approve"}, compositionRequestInput)
	if err != nil {
		t.Fatalf("request harness composition approval: %v", err)
	}
	if !compositionDecision.PendingApproval || compositionDecision.ApprovalID == "" {
		t.Fatalf("harness composition request = %+v, want a pending approval", compositionDecision)
	}
	decider := capability.NewApprovalDecider(runtimePool, executor)
	decided, err := decider.DecideForSession(ctx, fixture.userID, orgID, fixture.authSessionID, []string{"harness.approve"}, capability.ApprovalDecisionInput{
		ApprovalID: compositionDecision.ApprovalID,
		Decision:   "approve",
	})
	if err != nil {
		t.Fatalf("decide harness composition approval: %v", err)
	}
	if !decided.OK || decided.Status != "executed" {
		t.Fatalf("harness composition decision = %+v, want an executed approval", decided)
	}

	var vendorID string
	if err := owner.QueryRow(ctx, `INSERT INTO vendors (org_id, name) VALUES ($1::uuid, 'Durable PO vendor') RETURNING id::text`, orgID).Scan(&vendorID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO items (org_id, sku, name, sale_price_minor) VALUES ($1::uuid, 'CEM-DURABLE', 'Durable cement', 25000)`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous) VALUES ($1::uuid, 'purchasing.*', 'read')`, orgID); err != nil {
		t.Fatal(err)
	}

	poPayload := json.RawMessage(fmt.Sprintf(`{"vendorId":%q,"memo":"Durable reorder","lines":[{"description":"Cement replenishment","quantity":10000,"unitPriceMinor":25000,"sku":"CEM-DURABLE"}]}`, vendorID))
	gated, err := executeAgentCapability(t, ctx, executor, fixture, orgID, "purchasing.createPurchaseOrder", []string{"purchasing.write"}, poPayload)
	if err != nil {
		t.Fatalf("agent purchase order request: %v", err)
	}
	if !gated.PendingApproval || gated.ApprovalID == "" {
		t.Fatalf("agent purchase order = %+v, want a pending approval", gated)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid`, orgID); got != 0 {
		t.Fatalf("purchase orders before the gate opened=%d, want none", got)
	}
	var approvalStatus string
	if err := owner.QueryRow(ctx, `SELECT status FROM approvals WHERE id=$1::uuid AND org_id=$2::uuid`, gated.ApprovalID, orgID).Scan(&approvalStatus); err != nil {
		t.Fatal(err)
	}
	if approvalStatus != "pending" {
		t.Fatalf("purchase order approval status=%q, want pending", approvalStatus)
	}

	// Supervised handoff: the gate is claimed for the queued worker. The Go
	// decision service executes approved effects inline, so this claim-only
	// transition is the boundary the durable gate scripts model before the
	// worker owns the effect.
	if _, err := owner.Exec(ctx, `UPDATE approvals SET status='executing', decided_at=clock_timestamp() WHERE id=$1::uuid AND status='pending'`, gated.ApprovalID); err != nil {
		t.Fatal(err)
	}
	var approvedPayload string
	if err := owner.QueryRow(ctx, `SELECT payload::text FROM approvals WHERE id=$1::uuid AND org_id=$2::uuid`, gated.ApprovalID, orgID).Scan(&approvedPayload); err != nil {
		t.Fatal(err)
	}

	runID := durableTestUUID(t)
	input := StartDurableRunInput{
		RunID: runID, OrgID: orgID, ActorID: fixture.userID,
		Goal: "Replenish cement stock through a supervised purchase order", RegistryVersion: "1",
		HarnessCompositionID: compositionID, HarnessCompositionHash: durableTestCompositionDigest,
		CompositionApprovalID: compositionDecision.ApprovalID,
		Steps: []DurableRunStepInput{
			{CapabilityID: "purchasing.supplierPerformance", Input: json.RawMessage(`{}`)},
			{CapabilityID: "purchasing.createPurchaseOrder", Input: json.RawMessage(approvedPayload), ApprovedApprovalID: &gated.ApprovalID},
		},
	}
	dispatcher := NewDurableRunDispatcher(runtimePool)
	created, err := dispatcher.CreateAndDispatch(ctx, input)
	if err != nil {
		t.Fatalf("dispatch durable purchase order run: %v", err)
	}
	if created.RunID != runID || created.Replayed || created.Status != "pending" {
		t.Fatalf("dispatch result=%+v, want a fresh pending run", created)
	}
	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM jobs WHERE org_id=$1::uuid AND run_id=$2::uuid`, orgID, runID); got != 1 {
		t.Fatalf("linked jobs after dispatch=%d, want the first step job", got)
	}

	worker, err := NewWorker(workerPool, workerPool, runtimePool, executor, Options{WorkerID: "durable-po-worker-proof", LeaseDuration: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("process durable read step: worked=%v err=%v", worked, err)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM jobs WHERE org_id=$1::uuid AND run_id=$2::uuid AND run_step_index=1
		  AND type='purchasing.createPurchaseOrder' AND approved_approval_id=$3::uuid`, orgID, runID, gated.ApprovalID); got != 1 {
		t.Fatalf("approval-linked second step jobs=%d, want one", got)
	}
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("process durable purchase order step: worked=%v err=%v", worked, err)
	}
	if worked, err := worker.ProcessOne(ctx); err != nil || worked {
		t.Fatalf("completed durable run was claimed again: worked=%v err=%v", worked, err)
	}

	if got := countJobsTestRows(t, ctx, owner, `SELECT count(*) FROM jobs WHERE org_id=$1::uuid AND run_id=$2::uuid AND status='done'`, orgID, runID); got != 2 {
		t.Fatalf("done durable run jobs=%d, want both steps", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM purchase_orders WHERE org_id=$1::uuid AND vendor_id=$2::uuid AND status='ordered'`, orgID, vendorID); got != 1 {
		t.Fatalf("governed purchase orders=%d, want one", got)
	}
	var poJobID string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM jobs WHERE org_id=$1::uuid AND run_id=$2::uuid AND run_step_index=1`, orgID, runID).Scan(&poJobID); err != nil {
		t.Fatal(err)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2 AND capability_id='purchasing.createPurchaseOrder'`, orgID, orgID+":"+poJobID); got != 1 {
		t.Fatalf("purchase order action receipts=%d, want one", got)
	}
	if got := countJobsTestRows(t, ctx, owner, `
		SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed'
		  AND actor_type='system' AND actor_id IS NULL AND capability_id='purchasing.createPurchaseOrder'`, orgID); got != 1 {
		t.Fatalf("purchase order audit events=%d, want one", got)
	}
	var readReceiptID, poReceiptID string
	if err := owner.QueryRow(ctx, `
		SELECT receipt_id::text FROM agent_run_steps WHERE org_id=$1::uuid AND run_id=$2::uuid AND step_index=0`, orgID, runID).Scan(&readReceiptID); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `
		SELECT receipt_id::text FROM agent_run_steps WHERE org_id=$1::uuid AND run_id=$2::uuid AND step_index=1`, orgID, runID).Scan(&poReceiptID); err != nil {
		t.Fatal(err)
	}
	assertDurableStepRefs(t, ctx, owner, orgID, runID, 0, "committed", readReceiptID, false)
	assertDurableStepRefs(t, ctx, owner, orgID, runID, 1, "committed", poReceiptID, true)
	var runStatus string
	if err := owner.QueryRow(ctx, `SELECT status FROM agent_runs WHERE org_id=$1::uuid AND id=$2::uuid`, orgID, runID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "completed" {
		t.Fatalf("durable run status=%q, want completed", runStatus)
	}
	if err := owner.QueryRow(ctx, `SELECT status FROM approvals WHERE id=$1::uuid AND org_id=$2::uuid`, gated.ApprovalID, orgID).Scan(&approvalStatus); err != nil {
		t.Fatal(err)
	}
	if approvalStatus != "executed" {
		t.Fatalf("purchase order approval status=%q, want executed", approvalStatus)
	}
}

func executeAgentCapability(t *testing.T, ctx context.Context, executor *capability.Executor, fixture durableIdentityFixture, orgID, capabilityID string, permissions []string, input json.RawMessage) (capability.Result, error) {
	t.Helper()
	digest, err := capability.InputHash(input)
	if err != nil {
		t.Fatal(err)
	}
	actorID := fixture.userID
	result, err := executor.Execute(ctx, authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		Subject:        fixture.userID,
		OrganizationID: orgID,
		CapabilityID:   capabilityID,
		InputSHA256:    digest,
		ActorID:        &actorID,
		ActorType:      "agent",
		Permissions:    permissions,
		AuthSessionID:  fixture.authSessionID,
		AgentSessionID: fixture.agentSessionID,
	}, capabilityID, input)
	if err != nil {
		return capability.Result{}, err
	}
	if !result.OK && !result.PendingApproval {
		return result, fmt.Errorf("capability %s failed: %s", capabilityID, result.Error)
	}
	return result, nil
}
