package httpapi

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAllowSupportAutoReplyDraftIsAtomicAndScoped(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to seed the support auto-reply budget fixture")
		}
		t.Skip("DATABASE_URL is required to seed the support auto-reply budget fixture")
	}

	ctx := context.Background()
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

	orgID := integrationUUID(t)
	otherOrgID := integrationUUID(t)
	conversationID := integrationUUID(t)
	otherConversationID := integrationUUID(t)
	otherOrgConversationID := integrationUUID(t)
	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1, 'Go support budget fixture', $2),
		($3, 'Go support budget other fixture', $4)`,
		orgID, "go-support-budget-"+orgID[:8], otherOrgID, "go-support-budget-other-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct{ orgID, conversationID string }{
		{orgID, conversationID},
		{orgID, otherConversationID},
		{otherOrgID, otherOrgConversationID},
	} {
		seedSupportBudgetConversation(t, ctx, owner, fixture.orgID, fixture.conversationID)
	}
	t.Cleanup(func() {
		if _, cleanupErr := owner.Exec(context.Background(), `DELETE FROM organizations WHERE id IN ($1, $2)`, orgID, otherOrgID); cleanupErr != nil {
			t.Errorf("delete support auto-reply budget fixtures: %v", cleanupErr)
		}
	})

	base := time.Now().UTC().Truncate(time.Second)
	const attempts = 12
	var admitted atomic.Int32
	var failures atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			ok, callErr := allowSupportAutoReplyDraft(ctx, runtime, orgID, conversationID, base)
			if callErr != nil {
				t.Errorf("concurrent budget decision: %v", callErr)
				failures.Add(1)
				return
			}
			if ok {
				admitted.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if got := admitted.Load(); got != supportAutoReplyDraftLimit {
		t.Fatalf("concurrent admissions = %d, want exactly %d", got, supportAutoReplyDraftLimit)
	}
	if failures.Load() != 0 {
		t.Fatalf("concurrent calls failed: %d", failures.Load())
	}

	for _, fixture := range []struct{ orgID, conversationID string }{
		{orgID, otherConversationID},
		{otherOrgID, otherOrgConversationID},
	} {
		for i := 0; i < supportAutoReplyDraftLimit; i++ {
			ok, callErr := allowSupportAutoReplyDraft(ctx, runtime, fixture.orgID, fixture.conversationID, base)
			if callErr != nil {
				t.Fatal(callErr)
			}
			if !ok {
				t.Fatalf("independent budget %s/%s denied attempt %d", fixture.orgID, fixture.conversationID, i+1)
			}
		}
		ok, callErr := allowSupportAutoReplyDraft(ctx, runtime, fixture.orgID, fixture.conversationID, base)
		if callErr != nil {
			t.Fatal(callErr)
		}
		if ok {
			t.Fatalf("independent budget %s/%s admitted attempt beyond limit", fixture.orgID, fixture.conversationID)
		}
	}

	for _, test := range []struct {
		name string
		now  time.Time
		want bool
	}{
		{name: "window boundary is still limited", now: base.Add(59 * time.Second), want: false},
		{name: "window resets at 60 seconds", now: base.Add(60 * time.Second), want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ok, callErr := allowSupportAutoReplyDraft(ctx, runtime, orgID, conversationID, test.now)
			if callErr != nil {
				t.Fatal(callErr)
			}
			if ok != test.want {
				t.Fatalf("allowed = %v, want %v", ok, test.want)
			}
		})
	}

	if _, err := allowSupportAutoReplyDraft(ctx, runtime, "", conversationID, base); err == nil {
		t.Fatal("empty organization id should fail")
	}
	if _, err := allowSupportAutoReplyDraft(ctx, runtime, orgID, "", base); err == nil {
		t.Fatal("empty conversation id should fail")
	}
}

func TestSupportAutoReplyOrganizationBudgetAndReservation(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to seed the support auto-reply organization budget fixture")
		}
		t.Skip("DATABASE_URL is required to seed the support auto-reply organization budget fixture")
	}
	ctx := context.Background()
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

	orgID := integrationUUID(t)
	otherOrgID := integrationUUID(t)
	_, err = owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Go support org budget fixture', $2), ($3, 'Go support org budget other fixture', $4)`, orgID, "go-support-org-budget-"+orgID[:8], otherOrgID, "go-support-org-budget-other-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, cleanupErr := owner.Exec(context.Background(), `DELETE FROM organizations WHERE id IN ($1, $2)`, orgID, otherOrgID); cleanupErr != nil {
			t.Errorf("delete support org budget fixtures: %v", cleanupErr)
		}
	})

	conversationIDs := make([]string, supportAutoReplyOrganizationDraftLimit+1)
	for i := range conversationIDs {
		conversationIDs[i] = integrationUUID(t)
		seedSupportBudgetConversation(t, ctx, owner, orgID, conversationIDs[i])
	}
	otherConversationID := integrationUUID(t)
	seedSupportBudgetConversation(t, ctx, owner, otherOrgID, otherConversationID)
	base := time.Now().UTC().Truncate(time.Second)

	// Each new thread gets its own thread counter, but the organization-wide
	// bucket admits only thirty drafts during the same minute.
	for i := 0; i < supportAutoReplyOrganizationDraftLimit; i++ {
		ok, callErr := allowSupportAutoReplyDraft(ctx, runtime, orgID, conversationIDs[i], base)
		if callErr != nil || !ok {
			t.Fatalf("organization draft %d: allowed=%v err=%v", i+1, ok, callErr)
		}
	}
	if ok, callErr := allowSupportAutoReplyDraft(ctx, runtime, orgID, conversationIDs[supportAutoReplyOrganizationDraftLimit], base); callErr != nil || ok {
		t.Fatalf("organization limit bypassed with a new conversation: allowed=%v err=%v", ok, callErr)
	}
	if ok, callErr := allowSupportAutoReplyDraft(ctx, runtime, otherOrgID, otherConversationID, base); callErr != nil || !ok {
		t.Fatalf("organization budget leaked across tenants: allowed=%v err=%v", ok, callErr)
	}
	if ok, callErr := allowSupportAutoReplyDraft(ctx, runtime, orgID, conversationIDs[supportAutoReplyOrganizationDraftLimit], base.Add(time.Minute)); callErr != nil || !ok {
		t.Fatalf("organization budget did not reset after one minute: allowed=%v err=%v", ok, callErr)
	}

	// Keep successful leases open to prove the concurrency ceiling is shared by
	// separate conversations. Releasing one slot admits the next request.
	leaseIDs := make([]string, 0, supportAutoReplyOrganizationConcurrencyLimit)
	for i := 0; i < supportAutoReplyOrganizationConcurrencyLimit; i++ {
		leaseID, ok, callErr := reserveSupportAutoReplyDraft(ctx, runtime, orgID, conversationIDs[i], base.Add(2*time.Minute))
		if callErr != nil || !ok {
			t.Fatalf("reserve concurrent slot %d: allowed=%v err=%v", i+1, ok, callErr)
		}
		leaseIDs = append(leaseIDs, leaseID)
	}
	if _, ok, callErr := reserveSupportAutoReplyDraft(ctx, runtime, orgID, conversationIDs[4], base.Add(2*time.Minute)); callErr != nil || ok {
		t.Fatalf("organization concurrency limit exceeded: allowed=%v err=%v", ok, callErr)
	}
	if err := releaseSupportAutoReplyDraft(ctx, runtime, orgID, leaseIDs[0]); err != nil {
		t.Fatal(err)
	}
	_, ok, callErr := reserveSupportAutoReplyDraft(ctx, runtime, orgID, conversationIDs[4], base.Add(2*time.Minute))
	if callErr != nil || !ok {
		t.Fatalf("released concurrency slot not reusable: allowed=%v err=%v", ok, callErr)
	}

	// Expired leases are reclaimed, and old thread rows are deleted as bounded
	// maintenance inside the same organization-scoped transaction.
	if _, err := owner.Exec(ctx, `UPDATE support_auto_reply_draft_limits SET window_started_at = $3 WHERE org_id = $1::uuid AND conversation_id = $2::uuid`, orgID, conversationIDs[5], base.Add(-3*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, ok, callErr := reserveSupportAutoReplyDraft(ctx, runtime, orgID, conversationIDs[5], base.Add(8*time.Minute)); callErr != nil || !ok {
		t.Fatalf("expired reservation or retained row blocked admission: allowed=%v err=%v", ok, callErr)
	}
	var staleRows int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM support_auto_reply_draft_limits WHERE org_id = $1::uuid AND conversation_id = $2::uuid`, orgID, conversationIDs[5]).Scan(&staleRows); err != nil {
		t.Fatal(err)
	}
	if staleRows != 1 {
		t.Fatalf("stale per-thread row count = %d, want one fresh row", staleRows)
	}
	var expiredReservations int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM support_auto_reply_reservations WHERE org_id = $1::uuid AND expires_at <= $2`, orgID, base.Add(8*time.Minute)).Scan(&expiredReservations); err != nil {
		t.Fatal(err)
	}
	if expiredReservations != 0 {
		t.Fatalf("expired reservation count = %d, want 0", expiredReservations)
	}
}

func seedSupportBudgetConversation(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, conversationID string) {
	t.Helper()
	if _, err := owner.Exec(ctx, `INSERT INTO support_conversations (id, org_id, subject, created_by_actor_type) VALUES ($1::uuid, $2::uuid, 'Budget test conversation', 'system')`, conversationID, orgID); err != nil {
		t.Fatalf("seed support budget conversation: %v", err)
	}
}
