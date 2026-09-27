package capability

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

const integrationAssertionSecret = "0123456789abcdef0123456789abcdef"

type executorFixture struct {
	t             *testing.T
	ctx           context.Context
	owner         *pgxpool.Pool
	runtime       *pgxpool.Pool
	executor      *Executor
	orgID         string
	otherOrgID    string
	userID        string
	authUserID    string
	authSessionID string
	roleID        string
	agentSession  string
	userEmail     string
}

func newExecutorFixture(t *testing.T) *executorFixture {
	t.Helper()
	ctx := context.Background()
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
			t.Fatal("DATABASE_URL is required to seed capability execution fixtures")
		}
		t.Skip("DATABASE_URL is required to seed capability execution fixtures")
	}
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

	fx := &executorFixture{
		t:             t,
		ctx:           ctx,
		owner:         owner,
		runtime:       runtime,
		orgID:         executorUUID(t),
		otherOrgID:    executorUUID(t),
		userID:        executorUUID(t),
		roleID:        executorUUID(t),
		authUserID:    "go-capability-user-" + executorUUID(t),
		authSessionID: "go-capability-session-" + executorUUID(t),
		userEmail:     "go-capability-" + executorUUID(t)[:8] + "@fixture.test",
	}
	fx.agentSession = executorUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go capability fixture', $2), ($3::uuid, 'Go capability other fixture', $4)`,
		fx.orgID, "go-capability-"+fx.orgID[:8], fx.otherOrgID, "go-capability-other-"+fx.otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Go capability user')`, fx.userID, fx.userEmail)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO auth_user (id, name, email, email_verified) VALUES ($1, 'Go capability user', $2, true)`, fx.authUserID, fx.userEmail)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO auth_session (id, expires_at, token, user_id) VALUES ($1, $2, $3, $4)`, fx.authSessionID, time.Now().Add(time.Hour), "token-"+executorUUID(t), fx.authUserID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, fx.orgID, fx.userID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO roles (id, org_id, key, name, is_system) VALUES ($1::uuid, $2::uuid, 'fixture_owner', 'Fixture owner', true)`, fx.roleID, fx.orgID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'crm.write', $2::uuid)`, fx.roleID, fx.orgID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, fx.userID, fx.roleID, fx.orgID)
	if err != nil {
		t.Fatal(err)
	}
	fx.executor = NewExecutor(runtime, "", "", "")
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		tx, err := owner.Begin(cleanupCtx)
		if err != nil {
			t.Errorf("begin fixture cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("enable fixture ledger cleanup: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM ledger_events WHERE org_id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("delete capability fixture ledger events: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, fx.orgID, fx.otherOrgID); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("delete capability fixture organizations: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM users WHERE id = $1::uuid`, fx.userID); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("delete capability fixture user: %v", err)
			return
		}
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id = $1`, fx.authUserID); err != nil {
			_ = tx.Rollback(cleanupCtx)
			t.Errorf("delete capability fixture auth user: %v", err)
			return
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit capability fixture cleanup: %v", err)
		}
	})
	return fx
}

func executorUUID(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

func (fx *executorFixture) humanClaims(rawInput json.RawMessage, intent string) authbridge.CapabilityClaims {
	return fx.claims(rawInput, "human", "", intent)
}

func (fx *executorFixture) claims(rawInput json.RawMessage, actorType, agentSession, intent string) authbridge.CapabilityClaims {
	digest, err := InputHash(rawInput)
	if err != nil {
		fx.t.Fatal(err)
	}
	actorID := fx.userID
	return authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		Subject:        fx.userID,
		OrganizationID: fx.orgID,
		CapabilityID:   createCustomerCapabilityID,
		InputSHA256:    digest,
		ActorID:        &actorID,
		ActorType:      actorType,
		Permissions:    []string{"crm.write"},
		AuthSessionID:  fx.authSessionID,
		AgentSessionID: agentSession,
		IntentID:       intent,
	}
}

func (fx *executorFixture) addAgentSession() {
	fx.t.Helper()
	_, err := fx.owner.Exec(fx.ctx, `INSERT INTO agent_sessions (id, org_id, user_id, mode, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'assist', 'open')`, fx.agentSession, fx.orgID, fx.userID)
	if err != nil {
		fx.t.Fatal(err)
	}
}

func (fx *executorFixture) seedForeignLedgerHead() string {
	fx.t.Helper()
	head := "foreign-head-" + executorUUID(fx.t)
	_, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO ledger_events (org_id, actor_type, kind, payload, prev_hash, hash, occurred_at)
		VALUES ($1::uuid, 'system', 'fixture.cross_org_head', '{}'::jsonb, repeat('0', 64), $2, now())`, fx.otherOrgID, head)
	if err != nil {
		fx.t.Fatal(err)
	}
	var stored string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT public.chaste_ledger_chain_head()`).Scan(&stored); err != nil {
		fx.t.Fatal(err)
	}
	if stored != head {
		fx.t.Fatalf("seeded chain head = %q, want %q", stored, head)
	}
	return head
}

func (fx *executorFixture) setModuleList(raw string) {
	fx.t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET enabled_modules = $2::jsonb WHERE id = $1::uuid`, fx.orgID, raw); err != nil {
		fx.t.Fatal(err)
	}
}

func (fx *executorFixture) addPolicy(pattern, risk string, requires []string) {
	fx.t.Helper()
	requiresJSON, err := json.Marshal(requires)
	if err != nil {
		fx.t.Fatal(err)
	}
	_, err = fx.owner.Exec(fx.ctx, `INSERT INTO policies (org_id, capability_pattern, max_risk_autonomous, requires_approval_for) VALUES ($1::uuid, $2, $3, $4::jsonb)`, fx.orgID, pattern, risk, requiresJSON)
	if err != nil {
		fx.t.Fatal(err)
	}
}

func (fx *executorFixture) count(query string, args ...any) int {
	fx.t.Helper()
	var count int
	if err := fx.owner.QueryRow(fx.ctx, query, args...).Scan(&count); err != nil {
		fx.t.Fatal(err)
	}
	return count
}

func TestGoCustomerExecutionRechecksVerifiedIdentityAndMembership(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Verified customer","preferredContactMethod":"email","doNotContact":false}`)

	claims := fx.humanClaims(input, "")
	claims.AuthSessionID = "unknown-session"
	if _, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("unknown auth session error = %v, want ErrSessionInvalid", err)
	}

	if _, err := fx.owner.Exec(fx.ctx, `UPDATE auth_user SET email_verified = false WHERE id = $1`, fx.authUserID); err != nil {
		t.Fatal(err)
	}
	claims = fx.humanClaims(input, "")
	if _, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("unverified auth session error = %v, want ErrSessionInvalid", err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE auth_user SET email_verified = true WHERE id = $1`, fx.authUserID); err != nil {
		t.Fatal(err)
	}

	claims = fx.humanClaims(input, "")
	claims.OrganizationID = fx.otherOrgID
	if _, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input); !errors.Is(err, ErrNotMember) {
		t.Fatalf("cross-organization execution error = %v, want ErrNotMember", err)
	}

	claims = fx.humanClaims(input, "")
	claims.Permissions = []string{"sales.write"}
	result, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input)
	if err != nil || result.OK || result.Error != "forbidden: missing permission: crm.write" {
		t.Fatalf("narrow signed permissions result=%+v err=%v, want missing crm.write", result, err)
	}

	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("unauthorized calls created %d customers, want 0", got)
	}
}

func TestGoCustomerExecutionCreatesApprovalWithoutEffectWhenPolicyGates(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	fx.addPolicy("crm.*", "read", nil)
	fx.setModuleList(`["accounting"]`)
	invalidInput := json.RawMessage(`{"name":""}`)
	moduleResult, err := fx.executor.Execute(fx.ctx, fx.humanClaims(invalidInput, ""), createCustomerCapabilityID, invalidInput)
	if err != nil || moduleResult.OK || moduleResult.Error != `module "crm" is disabled for this organization` {
		t.Fatalf("disabled module result=%+v err=%v, want module denial before input validation", moduleResult, err)
	}
	fx.setModuleList(`null`)
	input := json.RawMessage(`{"name":"Waiting customer","preferredContactMethod":"email","doNotContact":false}`)
	claims := fx.claims(input, "agent", fx.agentSession, "intent-pending")
	result, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input)
	if err != nil || result.OK || !result.PendingApproval || result.Error != "pending human approval" {
		t.Fatalf("approval result=%+v err=%v, want pending", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id = $1::uuid AND capability_id = 'crm.createCustomer' AND status = 'pending'`, fx.orgID); got != 1 {
		t.Fatalf("pending approvals = %d, want 1", got)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("gated action created %d customers, want 0", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("gated action wrote %d effect receipts, want 0", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'approval.requested'`, fx.orgID); got != 1 {
		t.Fatalf("approval audit rows = %d, want 1", got)
	}
	if got := fx.count(`SELECT count(*) FROM notifications WHERE org_id = $1::uuid AND kind = 'approval.requested'`, fx.orgID); got != 1 {
		t.Fatalf("approval inbox notifications = %d, want 1", got)
	}
}

func TestGoCustomerExecutionAppendsGlobalLedgerAndReceipt(t *testing.T) {
	fx := newExecutorFixture(t)
	foreignHead := fx.seedForeignLedgerHead()
	input := json.RawMessage(`{"name":"Cross organization chain customer","email":"person@fixture.test","preferredContactMethod":"email","doNotContact":false}`)
	claims := fx.humanClaims(input, "global-chain-intent")
	result, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input)
	if err != nil || !result.OK || len(result.Data) == 0 {
		t.Fatalf("create result=%+v err=%v, want success", result, err)
	}
	var output CreateCustomerOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if output.CustomerID == "" || output.DuplicateWarning != nil {
		t.Fatalf("create output = %+v, want new customer without duplicate warning", output)
	}
	customerCount := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid AND id = $2::uuid`, fx.orgID, output.CustomerID)
	var updatedBy string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT updated_by_user_id::text FROM customers WHERE org_id = $1::uuid AND id = $2::uuid`, fx.orgID, output.CustomerID).Scan(&updatedBy); err != nil {
		t.Fatal(err)
	}
	if customerCount != 1 || updatedBy != fx.userID {
		t.Fatalf("created customer count=%d updated_by=%v, want one human-attributed row", customerCount, updatedBy)
	}
	var prevHash, eventHash string
	var occurredAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT current.prev_hash, current.hash, current.occurred_at
		FROM ledger_events current WHERE current.org_id = $1::uuid AND current.kind = 'capability.executed'
		ORDER BY current.seq DESC LIMIT 1`, fx.orgID).Scan(&prevHash, &eventHash, &occurredAt); err != nil {
		t.Fatal(err)
	}
	if prevHash != foreignHead {
		t.Fatalf("Go event prev_hash = %q, want cross-tenant global head %q", prevHash, foreignHead)
	}
	receiptCount := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id = $1::uuid AND intent_key = $2`, fx.orgID, fx.orgID+":global-chain-intent")
	var receiptData []byte
	if err := fx.owner.QueryRow(fx.ctx, `SELECT data::text FROM action_receipts WHERE org_id = $1::uuid AND intent_key = $2`, fx.orgID, fx.orgID+":global-chain-intent").Scan(&receiptData); err != nil {
		t.Fatal(err)
	}
	if receiptCount != 1 {
		t.Fatalf("action receipts = %d, want 1", receiptCount)
	}
	if !occurredAt.Equal(occurredAt.Truncate(time.Millisecond)) || eventHash == "" || len(receiptData) == 0 {
		t.Fatalf("ledger timestamp/hash or receipt missing: at=%s hash=%q receipt=%s", occurredAt, eventHash, receiptData)
	}
}

func TestGoCustomerExecutionPreservesDuplicateWarningAndOrganizationScope(t *testing.T) {
	fx := newExecutorFixture(t)
	sharedEmail := "same-person@fixture.test"
	_, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO customers (org_id, name, email) VALUES
		($1::uuid, 'Different tenant customer', $2),
		($3::uuid, 'Northwind LLC', $2)`, fx.otherOrgID, sharedEmail, fx.orgID)
	if err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"name":"A different display name","email":"same-person@fixture.test","preferredContactMethod":"email","doNotContact":false}`)
	result, err := fx.executor.Execute(fx.ctx, fx.humanClaims(input, ""), createCustomerCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("create result=%+v err=%v, want success", result, err)
	}
	var output CreateCustomerOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	want := `Looks like existing customer "Northwind LLC" (matched by email). Merge or deactivate one of them.`
	if output.DuplicateWarning == nil || *output.DuplicateWarning != want {
		t.Fatalf("duplicate warning = %v, want %q", output.DuplicateWarning, want)
	}
}

func TestGoCustomerExecutionRollsBackEffectWhenAuditAppendFails(t *testing.T) {
	fx := newExecutorFixture(t)
	functionName := "go_capability_fail_ledger_" + strings.ReplaceAll(fx.orgID, "-", "")
	triggerName := functionName + "_trigger"
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE FUNCTION public.%s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'fixture audit failure'; END
		$$`, functionName)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON ledger_events`, triggerName)); err != nil {
			t.Errorf("drop capability fixture trigger: %v", err)
		}
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS public.%s()`, functionName)); err != nil {
			t.Errorf("drop capability fixture function: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE TRIGGER %s BEFORE INSERT ON ledger_events FOR EACH ROW
		WHEN (NEW.org_id = '%s'::uuid AND NEW.kind = 'capability.executed')
		EXECUTE FUNCTION public.%s()`, triggerName, fx.orgID, functionName)); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"name":"Must roll back","preferredContactMethod":"email","doNotContact":false}`)
	_, err := fx.executor.Execute(fx.ctx, fx.humanClaims(input, "rollback-intent"), createCustomerCapabilityID, input)
	if err == nil {
		t.Fatal("execution succeeded despite audit append failure")
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("failed audited write left %d customer rows, want 0", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id = $1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("failed audited write left %d receipts, want 0", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed'`, fx.orgID); got != 0 {
		t.Fatalf("failed audited write left %d execution events, want 0", got)
	}
}

func TestGoCustomerExecutionSerializesSameIntent(t *testing.T) {
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{"name":"Idempotent customer","preferredContactMethod":"email","doNotContact":false}`)
	claims := fx.humanClaims(input, "same-intent")
	first, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input)
	if err != nil || !first.OK {
		t.Fatalf("first result=%+v err=%v, want success", first, err)
	}
	second, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input)
	var firstOutput, secondOutput CreateCustomerOutput
	if err := json.Unmarshal(first.Data, &firstOutput); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(second.Data, &secondOutput); err != nil {
		t.Fatal(err)
	}
	if err != nil || !second.OK || !second.Replayed || firstOutput.CustomerID != secondOutput.CustomerID {
		t.Fatalf("replay result=%+v err=%v, want same successful result", second, err)
	}

	changedInput := json.RawMessage(`{"name":"Different customer","preferredContactMethod":"email","doNotContact":false}`)
	changedClaims := fx.humanClaims(changedInput, "same-intent")
	conflict, err := fx.executor.Execute(fx.ctx, changedClaims, createCustomerCapabilityID, changedInput)
	if err != nil || conflict.OK || conflict.Error != "action intent conflict: same action key used with a different payload" {
		t.Fatalf("conflict result=%+v err=%v, want refused payload conflict", conflict, err)
	}

	var concurrent sync.WaitGroup
	results := make(chan Result, 2)
	errorsSeen := make(chan error, 2)
	concurrent.Add(2)
	for range 2 {
		go func() {
			defer concurrent.Done()
			result, err := fx.executor.Execute(fx.ctx, claims, createCustomerCapabilityID, input)
			results <- result
			errorsSeen <- err
		}()
	}
	concurrent.Wait()
	close(results)
	close(errorsSeen)
	for err := range errorsSeen {
		if err != nil {
			t.Fatalf("concurrent retry error: %v", err)
		}
	}
	for result := range results {
		if !result.OK || !result.Replayed {
			t.Fatalf("concurrent retry result=%+v, want receipt replay", result)
		}
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id = $1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("same intent created %d customers, want 1", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed'`, fx.orgID); got != 1 {
		t.Fatalf("same intent appended %d execution events, want 1", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id = $1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("same intent stored %d receipts, want 1", got)
	}
}
