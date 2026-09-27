package outbox

import (
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
	"sync/atomic"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoWebhookOutboxWorkerMatchesLegacy(t *testing.T) {
	assertRetryAfterDurations(t)
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the webhook worker database proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	appPassword := os.Getenv("CHASTE_APP_DB_PASSWORD")
	if appPassword == "" {
		appPassword = "chaste_app_dev_only"
	}
	workerPassword := os.Getenv("CHASTE_OUTBOX_WORKER_DB_PASSWORD")
	if workerPassword == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("CHASTE_OUTBOX_WORKER_DB_PASSWORD is required for the webhook worker database proof")
		}
		workerPassword = "chaste_outbox_worker_dev_only"
	}
	appURL := roleURL(t, ownerURL, "chaste_app", appPassword)
	workerURL := roleURL(t, ownerURL, dbx.OutboxWorkerRoleName, workerPassword)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner database: %v", err)
	}
	defer owner.Close()
	appPool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect app runtime database: %v", err)
	}
	defer appPool.Close()
	workerPool, err := pgxpool.New(ctx, workerURL)
	if err != nil {
		t.Fatalf("connect webhook worker database: %v", err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyOutboxWorkerRole(ctx, workerPool); err != nil {
		t.Fatalf("verify dedicated worker role: %v", err)
	}
	assertOutboxWorkerRoleBoundary(t, ctx, owner)
	assertClaimArgumentsFailClosed(t, ctx, workerPool)

	tag := fmt.Sprintf("outbox-worker-%d", time.Now().UnixNano())
	orgA := insertWorkerTestOrg(t, ctx, owner, tag+"-a")
	orgB := insertWorkerTestOrg(t, ctx, owner, tag+"-b")
	defer func() {
		_, _ = owner.Exec(context.Background(), `DELETE FROM organizations WHERE id = ANY($1::uuid[])`, []string{orgA, orgB})
	}()

	server, idempotencyKeys := newWebhookProvider()
	defer server.Close()

	expiredID := insertWorkerTestMessage(t, ctx, owner, orgA, "webhook", tag+"-expired", server.URL+"/ok")
	_, err = owner.Exec(ctx, `
		UPDATE outbox_messages
		SET status = 'processing', attempts = 1, lease_owner = 'old-worker',
		    lease_expires_at = clock_timestamp() - interval '1 second',
		    completed_at = '2000-01-02T03:04:05Z'::timestamptz
		WHERE id = $1::uuid`, expiredID)
	if err != nil {
		t.Fatalf("seed expired webhook lease: %v", err)
	}
	if claim, err := mustWorker(t, workerPool, "expiry-probe", nil).ClaimOne(ctx); err != nil || claim != nil {
		t.Fatalf("expired webhook unexpectedly re-entered the queue: claim=%#v err=%v", claim, err)
	}
	var expiredStatus, expiredError string
	var completedAt time.Time
	if err := owner.QueryRow(ctx, `SELECT status, last_error, completed_at FROM outbox_messages WHERE id = $1::uuid`, expiredID).Scan(&expiredStatus, &expiredError, &completedAt); err != nil {
		t.Fatalf("read expired webhook state: %v", err)
	}
	if expiredStatus != "unknown" || expiredError != "outbox lease expired during external delivery; provider outcome is unknown" || !completedAt.Equal(time.Date(2000, 1, 2, 3, 4, 5, 0, time.UTC)) {
		t.Fatalf("expired lease did not preserve legacy unknown semantics: status=%q error=%q completed=%s", expiredStatus, expiredError, completedAt)
	}

	webhookA := insertWorkerTestMessage(t, ctx, owner, orgA, "webhook", tag+"-concurrent-a", server.URL+"/ok")
	webhookB := insertWorkerTestMessage(t, ctx, owner, orgA, "webhook", tag+"-concurrent-b", server.URL+"/ok")
	emailID := insertWorkerTestMessage(t, ctx, owner, orgA, "email", tag+"-email", "")
	foreign := insertWorkerTestMessage(t, ctx, owner, orgB, "webhook", tag+"-foreign", server.URL+"/ok")

	workerA := mustWorker(t, workerPool, "concurrent-a", nil)
	workerB := mustWorker(t, workerPool, "concurrent-b", nil)
	var claims [2]*ClaimedMessage
	var claimErrors [2]error
	var concurrent sync.WaitGroup
	concurrent.Add(2)
	go func() {
		defer concurrent.Done()
		claims[0], claimErrors[0] = workerA.ClaimOne(ctx)
	}()
	go func() {
		defer concurrent.Done()
		claims[1], claimErrors[1] = workerB.ClaimOne(ctx)
	}()
	concurrent.Wait()
	for index, claimErr := range claimErrors {
		if claimErr != nil {
			t.Fatalf("concurrent claim %d: %v", index, claimErr)
		}
	}
	if claims[0] == nil || claims[1] == nil || claims[0].ID == claims[1].ID {
		t.Fatalf("concurrent claims were not unique: %#v", claims)
	}
	claimedIDs := map[string]bool{claims[0].ID: true, claims[1].ID: true}
	if !claimedIDs[webhookA] || !claimedIDs[webhookB] {
		t.Fatalf("worker did not claim the two ready webhook rows: %#v", claims)
	}
	for index, claim := range claims {
		worker := workerA
		if index == 1 {
			worker = workerB
		}
		if finalized, err := worker.finalize(ctx, *claim, unknownResult("test claim released")); err != nil || !finalized {
			t.Fatalf("release concurrency claim: finalized=%v err=%v", finalized, err)
		}
	}

	var unscopedPayload []byte
	err = workerPool.QueryRow(ctx, `SELECT payload FROM public.outbox_messages WHERE id = $1::uuid`, webhookA).Scan(&unscopedPayload)
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("worker saw outbox payload without app.org_id, err=%v", err)
	}
	var visibleEmailCount int
	_, err = dbx.WithOrgTx(ctx, workerPool, orgA, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `
			SELECT count(*)::int
			FROM public.outbox_messages
			WHERE org_id = $1::uuid AND kind = 'email'`, orgA).Scan(&visibleEmailCount)
	})
	if err != nil || visibleEmailCount != 0 {
		t.Fatalf("webhook worker could read email outbox rows: count=%d err=%v", visibleEmailCount, err)
	}
	var crossTenant []byte
	_, err = dbx.WithOrgTx(ctx, workerPool, orgA, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `
			SELECT payload
			FROM public.outbox_messages
			WHERE id = $1::uuid AND org_id = $2::uuid`, foreign, orgB).Scan(&crossTenant)
	})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("worker crossed organization boundary, err=%v", err)
	}
	var fixtureEmail string
	_, err = dbx.WithOrgTx(ctx, workerPool, orgA, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `SELECT id::text FROM public.outbox_messages WHERE id = $1::uuid`, emailID).Scan(&fixtureEmail)
	})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("worker fetched the seeded email row, err=%v", err)
	}
	if _, err := owner.Exec(ctx, `UPDATE outbox_messages SET status = 'failed' WHERE id = $1::uuid`, foreign); err != nil {
		t.Fatalf("settle cross-tenant fixture after isolation proof: %v", err)
	}

	// A 429 retry keeps the provider operation id stable and increments the
	// fencing token. An acknowledgement from the earlier lease must fail.
	fenceID := insertWorkerTestMessage(t, ctx, owner, orgA, "webhook", tag+"-fence", server.URL+"/ok")
	fenceWorker := mustWorker(t, workerPool, "fence-worker", nil)
	firstLease, err := fenceWorker.ClaimOne(ctx)
	if err != nil || firstLease == nil || firstLease.ID != fenceID {
		t.Fatalf("first fenced claim: claim=%#v err=%v", firstLease, err)
	}
	retryAt := time.Now().Add(time.Second)
	if finalized, err := fenceWorker.finalize(ctx, *firstLease, DeliveryResult{Status: "pending", AvailableAt: &retryAt}); err != nil || !finalized {
		t.Fatalf("first 429-style acknowledgement: finalized=%v err=%v", finalized, err)
	}
	_, err = owner.Exec(ctx, `UPDATE outbox_messages SET available_at = clock_timestamp() WHERE id = $1::uuid`, fenceID)
	if err != nil {
		t.Fatalf("make retry eligible: %v", err)
	}
	secondLease, err := fenceWorker.ClaimOne(ctx)
	if err != nil || secondLease == nil {
		t.Fatalf("second fenced claim: claim=%#v err=%v", secondLease, err)
	}
	if secondLease.FencingToken != firstLease.FencingToken+1 || secondLease.ProviderOperationID != firstLease.ProviderOperationID || secondLease.Attempts != firstLease.Attempts+1 {
		t.Fatalf("retry lost fencing or stable provider identity: first=%#v second=%#v", firstLease, secondLease)
	}
	if finalized, err := fenceWorker.finalize(ctx, *firstLease, DeliveryResult{Status: "sent"}); err != nil || finalized {
		t.Fatalf("stale lease was allowed to acknowledge: finalized=%v err=%v", finalized, err)
	}
	if finalized, err := fenceWorker.finalize(ctx, *secondLease, DeliveryResult{Status: "sent"}); err != nil || !finalized {
		t.Fatalf("current lease could not acknowledge: finalized=%v err=%v", finalized, err)
	}

	// A delivery longer than its original lease succeeds because the worker
	// renews the lease under the same org, owner, and fencing token.
	slowID := insertWorkerTestMessage(t, ctx, owner, orgA, "webhook", tag+"-slow", server.URL+"/slow")
	slowWorker, err := NewWorker(workerPool, workerPool, Options{
		WorkerID:       "slow-worker",
		LeaseDuration:  time.Second,
		RequestTimeout: 3 * time.Second,
		HTTPClient:     server.Client(),
	})
	if err != nil {
		t.Fatalf("construct short-lease worker: %v", err)
	}
	processed, err := slowWorker.ProcessOne(ctx)
	if err != nil || !processed {
		t.Fatalf("slow delivery did not finish after lease renewal: processed=%v err=%v", processed, err)
	}
	assertStatus(t, ctx, workerPool, orgA, slowID, "sent")

	// Invalid persisted payloads are recorded as unknown and do not stop the
	// next worker iteration from delivering a valid webhook.
	invalidID := insertWorkerTestMessage(t, ctx, owner, orgA, "webhook", tag+"-invalid", "file:///tmp/not-webhook")
	validAfterInvalidID := insertWorkerTestMessage(t, ctx, owner, orgA, "webhook", tag+"-valid-after-invalid", server.URL+"/ok")
	validationWorker := mustWorker(t, workerPool, "validation-worker", server.Client())
	processed, err = validationWorker.ProcessOne(ctx)
	if err != nil || !processed {
		t.Fatalf("invalid payload stopped the worker iteration: processed=%v err=%v", processed, err)
	}
	assertStatus(t, ctx, workerPool, orgA, invalidID, "unknown")
	processed, err = validationWorker.ProcessOne(ctx)
	if err != nil || !processed {
		t.Fatalf("worker did not continue after invalid payload: processed=%v err=%v", processed, err)
	}
	assertStatus(t, ctx, workerPool, orgA, validAfterInvalidID, "sent")

	// Exercise provider response semantics and the stable idempotency key on a
	// real local HTTP server. Retry-After is clamped to five minutes.
	rateID := insertWorkerTestMessage(t, ctx, owner, orgA, "webhook", tag+"-rate", server.URL+"/rate")
	rateWorker := mustWorker(t, workerPool, "rate-worker", nil)
	rateClaim, result := dispatchClaim(t, ctx, rateWorker, rateID)
	if result.Status != "pending" || result.AvailableAt == nil || time.Until(*result.AvailableAt) > 5*time.Minute+time.Second {
		t.Fatalf("429 did not return a clamped pending result: %#v", result)
	}
	if finalized, err := rateWorker.finalize(ctx, *rateClaim, result); err != nil || !finalized {
		t.Fatalf("persist 429 retry result: finalized=%v err=%v", finalized, err)
	}
	_, err = owner.Exec(ctx, `UPDATE outbox_messages SET available_at = clock_timestamp() WHERE id = $1::uuid`, rateID)
	if err != nil {
		t.Fatalf("make provider retry eligible: %v", err)
	}
	secondRateClaim, err := rateWorker.ClaimOne(ctx)
	if err != nil || secondRateClaim == nil || secondRateClaim.ProviderOperationID != rateClaim.ProviderOperationID {
		t.Fatalf("retry did not retain the provider operation id: claim=%#v err=%v", secondRateClaim, err)
	}
	payload, err := rateWorker.payload(ctx, *secondRateClaim)
	if err != nil {
		t.Fatalf("read retry payload under tenant context: %v", err)
	}
	secondResult := rateWorker.send(ctx, *secondRateClaim, payload)
	if secondResult.Status != "sent" {
		t.Fatalf("provider did not confirm the retry: %#v", secondResult)
	}
	if finalized, err := rateWorker.finalize(ctx, *secondRateClaim, secondResult); err != nil || !finalized {
		t.Fatalf("persist successful retry: finalized=%v err=%v", finalized, err)
	}
	keys := idempotencyKeys()
	if len(keys) < 2 || keys[len(keys)-1] != keys[len(keys)-2] || keys[len(keys)-1] != rateClaim.ProviderOperationID {
		t.Fatalf("retry idempotency key changed: %v, expected %s", keys, rateClaim.ProviderOperationID)
	}

	for _, scenario := range []struct {
		path   string
		status string
	}{
		{path: "/reject", status: "failed"},
		{path: "/server-error", status: "unknown"},
	} {
		id := insertWorkerTestMessage(t, ctx, owner, orgA, "webhook", tag+scenario.path, server.URL+scenario.path)
		worker := mustWorker(t, workerPool, "provider-"+strings.TrimPrefix(scenario.path, "/"), nil)
		claim, delivered := dispatchClaim(t, ctx, worker, id)
		if delivered.Status != scenario.status {
			t.Fatalf("%s mapped to %q, want %q", scenario.path, delivered.Status, scenario.status)
		}
		if finalized, err := worker.finalize(ctx, *claim, delivered); err != nil || !finalized {
			t.Fatalf("persist %s result: finalized=%v err=%v", scenario.path, finalized, err)
		}
	}

	transportID := insertWorkerTestMessage(t, ctx, owner, orgA, "webhook", tag+"-transport", server.URL+"/ok")
	transportWorker := mustWorker(t, workerPool, "transport-worker", &http.Client{Transport: errorRoundTripper{}})
	transportClaim, transportResult := dispatchClaim(t, ctx, transportWorker, transportID)
	if transportResult.Status != "unknown" {
		t.Fatalf("transport failure was not treated as unknown: %#v", transportResult)
	}
	if finalized, err := transportWorker.finalize(ctx, *transportClaim, transportResult); err != nil || !finalized {
		t.Fatalf("persist uncertain transport result: finalized=%v err=%v", finalized, err)
	}
	if next, err := transportWorker.ClaimOne(ctx); err != nil || next != nil {
		t.Fatalf("unknown webhook was automatically redelivered: claim=%#v err=%v", next, err)
	}
	if reconciled, err := transportWorker.Reconcile(ctx, ReconcileInput{OrgID: orgB, OutboxID: transportID, Status: "sent"}); err != nil || reconciled {
		t.Fatalf("reconciliation crossed tenant boundary: reconciled=%v err=%v", reconciled, err)
	}
	if reconciled, err := transportWorker.Reconcile(ctx, ReconcileInput{OrgID: orgA, OutboxID: transportID, Status: "sent", ProviderReceipt: json.RawMessage(`{"checked":true}`)}); err != nil || !reconciled {
		t.Fatalf("tenant-scoped reconciliation failed: reconciled=%v err=%v", reconciled, err)
	}
	if reconciled, err := transportWorker.Reconcile(ctx, ReconcileInput{OrgID: orgA, OutboxID: transportID, Status: "failed"}); err != nil || reconciled {
		t.Fatalf("settled webhook was reconciled a second time: reconciled=%v err=%v", reconciled, err)
	}

	assertStatus(t, ctx, workerPool, orgA, fenceID, "sent")
	assertStatus(t, ctx, workerPool, orgA, rateID, "sent")
	assertStatus(t, ctx, workerPool, orgA, transportID, "sent")
}

func assertRetryAfterDurations(t *testing.T) {
	t.Helper()
	for _, test := range []struct {
		name  string
		value string
		want  time.Duration
	}{
		{name: "missing header", value: "", want: time.Second},
		{name: "blank header", value: " \t ", want: time.Second},
		{name: "fractional seconds", value: "1.5", want: 1500 * time.Millisecond},
		{name: "clamps maximum", value: "999", want: 5 * time.Minute},
		{name: "invalid value fallback", value: "soon", want: 30 * time.Second},
		{name: "clamps minimum", value: "0", want: time.Second},
		{name: "positive infinity falls back", value: "Infinity", want: 30 * time.Second},
		{name: "negative infinity falls back", value: "-Infinity", want: 30 * time.Second},
	} {
		if got := retryAfterDuration(test.value); got != test.want {
			t.Fatalf("retry delay for %q is %s, want %s", test.value, got, test.want)
		}
	}
}

func assertOutboxWorkerRoleBoundary(t *testing.T, ctx context.Context, owner *pgxpool.Pool) {
	t.Helper()
	var workerLogin, workerSafe, workerNoMembership bool
	var claimOwnerNoLogin, claimOwnerSafe, claimOwnerNoMembership bool
	var functionOwner, securityDefiner, publicExecute, workerExecute, appExecute bool
	var fixedSearchPath, rowSecurity bool
	var workerPayloadSelect, workerStatusUpdate bool
	var claimPayloadSelect, claimStatusSelect, claimStatusUpdate bool
	var workerOtherTableAccess, claimOtherTableAccess bool
	var functionReturnsPayload bool
	err := owner.QueryRow(ctx, `
		SELECT worker.rolcanlogin,
		       NOT worker.rolsuper AND NOT worker.rolcreatedb AND NOT worker.rolcreaterole
		         AND NOT worker.rolreplication AND NOT worker.rolbypassrls AND NOT worker.rolinherit,
		       NOT EXISTS (SELECT 1 FROM pg_auth_members member WHERE member.member = worker.oid)
		       AND NOT EXISTS (SELECT 1 FROM pg_auth_members granted WHERE granted.roleid = worker.oid),
		       NOT claim_owner.rolcanlogin,
		       NOT claim_owner.rolsuper AND NOT claim_owner.rolcreatedb AND NOT claim_owner.rolcreaterole
		         AND NOT claim_owner.rolreplication AND NOT claim_owner.rolbypassrls AND NOT claim_owner.rolinherit,
		       NOT EXISTS (SELECT 1 FROM pg_auth_members member WHERE member.member = claim_owner.oid)
		         AND NOT EXISTS (SELECT 1 FROM pg_auth_members granted WHERE granted.roleid = claim_owner.oid),
		       function_owner.rolname = 'chaste_outbox_claim_owner',
		       procedure.prosecdef,
		       EXISTS (SELECT 1 FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
		               WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'),
		       has_function_privilege('chaste_outbox_worker', procedure.oid, 'EXECUTE'),
		       has_function_privilege('chaste_app', procedure.oid, 'EXECUTE'),
		       'search_path=pg_catalog, public' = ANY(procedure.proconfig),
		       'row_security=on' = ANY(procedure.proconfig),
		       has_column_privilege('chaste_outbox_worker', 'public.outbox_messages', 'payload', 'SELECT'),
		       has_column_privilege('chaste_outbox_worker', 'public.outbox_messages', 'status', 'UPDATE'),
		       has_column_privilege('chaste_outbox_claim_owner', 'public.outbox_messages', 'payload', 'SELECT'),
		       has_column_privilege('chaste_outbox_claim_owner', 'public.outbox_messages', 'status', 'SELECT'),
		       has_column_privilege('chaste_outbox_claim_owner', 'public.outbox_messages', 'status', 'UPDATE'),
	       EXISTS (
	         SELECT 1 FROM pg_class relation
	         JOIN pg_namespace rel_namespace ON rel_namespace.oid = relation.relnamespace
	         WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
	           AND rel_namespace.nspname = 'public'
	           AND relation.oid <> 'public.outbox_messages'::regclass
		           AND (has_any_column_privilege('chaste_outbox_worker', relation.oid, 'SELECT')
		             OR has_any_column_privilege('chaste_outbox_worker', relation.oid, 'INSERT')
		             OR has_any_column_privilege('chaste_outbox_worker', relation.oid, 'UPDATE')
		             OR has_table_privilege('chaste_outbox_worker', relation.oid, 'DELETE')
		             OR has_table_privilege('chaste_outbox_worker', relation.oid, 'TRUNCATE'))
		       ),
	       EXISTS (
	         SELECT 1 FROM pg_class relation
	         JOIN pg_namespace rel_namespace ON rel_namespace.oid = relation.relnamespace
	         WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
	           AND rel_namespace.nspname = 'public'
	           AND relation.oid <> 'public.outbox_messages'::regclass
		           AND (has_any_column_privilege('chaste_outbox_claim_owner', relation.oid, 'SELECT')
		             OR has_any_column_privilege('chaste_outbox_claim_owner', relation.oid, 'INSERT')
		             OR has_any_column_privilege('chaste_outbox_claim_owner', relation.oid, 'UPDATE')
		             OR has_table_privilege('chaste_outbox_claim_owner', relation.oid, 'DELETE')
		             OR has_table_privilege('chaste_outbox_claim_owner', relation.oid, 'TRUNCATE'))
		       ),
		       'payload' = ANY(COALESCE(procedure.proargnames, ARRAY[]::text[]))
		FROM pg_roles worker, pg_roles claim_owner, pg_proc procedure
		JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
		JOIN pg_roles function_owner ON function_owner.oid = procedure.proowner
		WHERE worker.rolname = 'chaste_outbox_worker'
		  AND claim_owner.rolname = 'chaste_outbox_claim_owner'
		  AND namespace.nspname = 'outbox_worker'
		  AND procedure.proname = 'claim_webhook'`).Scan(
		&workerLogin,
		&workerSafe,
		&workerNoMembership,
		&claimOwnerNoLogin,
		&claimOwnerSafe,
		&claimOwnerNoMembership,
		&functionOwner,
		&securityDefiner,
		&publicExecute,
		&workerExecute,
		&appExecute,
		&fixedSearchPath,
		&rowSecurity,
		&workerPayloadSelect,
		&workerStatusUpdate,
		&claimPayloadSelect,
		&claimStatusSelect,
		&claimStatusUpdate,
		&workerOtherTableAccess,
		&claimOtherTableAccess,
		&functionReturnsPayload,
	)
	if err != nil {
		t.Fatalf("inspect worker roles and ACLs: %v", err)
	}
	if !workerLogin || !workerSafe || !workerNoMembership || !claimOwnerNoLogin || !claimOwnerSafe || !claimOwnerNoMembership {
		t.Fatalf("unsafe worker role attributes or memberships: login=%v safe=%v memberships=%v ownerNoLogin=%v ownerSafe=%v ownerMemberships=%v", workerLogin, workerSafe, workerNoMembership, claimOwnerNoLogin, claimOwnerSafe, claimOwnerNoMembership)
	}
	if !functionOwner || !securityDefiner || publicExecute || !workerExecute || appExecute || !fixedSearchPath || !rowSecurity {
		t.Fatalf("unsafe claim function ACL/owner/config: owner=%v definer=%v public=%v worker=%v app=%v search_path=%v row_security=%v", functionOwner, securityDefiner, publicExecute, workerExecute, appExecute, fixedSearchPath, rowSecurity)
	}
	if !workerPayloadSelect || !workerStatusUpdate || claimPayloadSelect || !claimStatusSelect || !claimStatusUpdate || workerOtherTableAccess || claimOtherTableAccess || functionReturnsPayload {
		t.Fatalf("worker privilege boundary drift: worker payload=%v update=%v claim payload=%v claim select=%v update=%v other tables=%v/%v returns payload=%v", workerPayloadSelect, workerStatusUpdate, claimPayloadSelect, claimStatusSelect, claimStatusUpdate, workerOtherTableAccess, claimOtherTableAccess, functionReturnsPayload)
	}
}

func newWebhookProvider() (*httptest.Server, func() []string) {
	var rateCalls atomic.Int32
	var mu sync.Mutex
	keys := make([]string, 0, 8)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		keys = append(keys, request.Header.Get("idempotency-key"))
		mu.Unlock()
		switch request.URL.Path {
		case "/rate":
			if rateCalls.Add(1) == 1 {
				writer.Header().Set("Retry-After", "999")
				writer.WriteHeader(http.StatusTooManyRequests)
				return
			}
			writer.WriteHeader(http.StatusNoContent)
		case "/reject":
			writer.WriteHeader(http.StatusBadRequest)
		case "/server-error":
			writer.WriteHeader(http.StatusBadGateway)
		case "/slow":
			time.Sleep(1500 * time.Millisecond)
			writer.WriteHeader(http.StatusNoContent)
		default:
			writer.WriteHeader(http.StatusNoContent)
		}
	}))
	return server, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), keys...)
	}
}

func assertClaimArgumentsFailClosed(t *testing.T, ctx context.Context, worker *pgxpool.Pool) {
	t.Helper()
	for _, args := range []struct {
		workerID any
		leaseMS  any
	}{
		{workerID: "", leaseMS: 60_000},
		{workerID: " \t ", leaseMS: 60_000},
		{workerID: "valid-worker", leaseMS: nil},
		{workerID: "valid-worker", leaseMS: 999},
	} {
		var ignored string
		err := worker.QueryRow(ctx, `
			SELECT id::text FROM outbox_worker.claim_webhook($1::text, $2::integer)`, args.workerID, args.leaseMS).Scan(&ignored)
		var postgresErr *pgconn.PgError
		if !errors.As(err, &postgresErr) || postgresErr.Code != "22023" {
			t.Fatalf("invalid claim arguments were accepted: worker_id=%v lease_ms=%v err=%v", args.workerID, args.leaseMS, err)
		}
	}
}

func roleURL(t *testing.T, rawURL, role, password string) string {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse database URL: %v", err)
	}
	parsed.User = url.UserPassword(role, password)
	return parsed.String()
}

func insertWorkerTestOrg(t *testing.T, ctx context.Context, pool *pgxpool.Pool, slug string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id::text`, "Outbox worker proof", slug).Scan(&id)
	if err != nil {
		t.Fatalf("insert organization fixture: %v", err)
	}
	return id
}

func insertWorkerTestMessage(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, kind, dedupeKey, targetURL string) string {
	t.Helper()
	var payload []byte
	if kind == "webhook" {
		payload, _ = json.Marshal(map[string]any{"url": targetURL, "body": map[string]any{"proof": dedupeKey}})
	} else {
		payload = []byte(`{"to":"worker-proof@example.test","subject":"fixture","text":"fixture"}`)
	}
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO outbox_messages (org_id, kind, dedupe_key, provider_operation_id, payload)
		VALUES ($1::uuid, $2, $3, gen_random_uuid(), $4::jsonb)
		RETURNING id::text`, orgID, kind, dedupeKey, payload).Scan(&id)
	if err != nil {
		t.Fatalf("insert outbox fixture: %v", err)
	}
	return id
}

func mustWorker(t *testing.T, pool *pgxpool.Pool, workerID string, client *http.Client) *Worker {
	t.Helper()
	worker, err := NewWorker(pool, pool, Options{WorkerID: workerID, HTTPClient: client})
	if err != nil {
		t.Fatalf("construct webhook worker: %v", err)
	}
	return worker
}

func dispatchClaim(t *testing.T, ctx context.Context, worker *Worker, expectedID string) (*ClaimedMessage, DeliveryResult) {
	t.Helper()
	claim, err := worker.ClaimOne(ctx)
	if err != nil || claim == nil || claim.ID != expectedID {
		t.Fatalf("claim fixture %s: claim=%#v err=%v", expectedID, claim, err)
	}
	payload, err := worker.payload(ctx, *claim)
	if err != nil {
		t.Fatalf("read webhook fixture payload: %v", err)
	}
	return claim, worker.send(ctx, *claim, payload)
}

func assertStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, id, want string) {
	t.Helper()
	var got string
	_, err := dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx, `SELECT status FROM public.outbox_messages WHERE id = $1::uuid AND org_id = $2::uuid`, id, orgID).Scan(&got)
	})
	if err != nil || got != want {
		t.Fatalf("outbox %s status=%q, want %q, err=%v", id, got, want, err)
	}
}

type errorRoundTripper struct{}

func (errorRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("simulated network failure")
}
