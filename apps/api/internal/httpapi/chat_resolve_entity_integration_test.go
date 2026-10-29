package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestResolveEntityFollowsCustomerMerges proves the identity resolver against a
// migrated database: a duplicate that was merged away never comes back as the
// id to act on, and the evidence that matched is reported.
func TestResolveEntityFollowsCustomerMerges(t *testing.T) {
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if secret == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("BETTER_AUTH_SECRET is required for the identity resolution proof")
		}
		t.Skip("BETTER_AUTH_SECRET is required for the identity resolution proof")
	}
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := orgParityEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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

	fixture := seedOrgParityFixture(t, owner, secret)
	var survivorID, mergedID string
	if err := owner.QueryRow(ctx,
		`INSERT INTO customers (org_id, name, email, phone) VALUES ($1::uuid, 'Acme Supplies Ltd', 'billing@acme.test', '0772 123 456') RETURNING id::text`,
		fixture.orgA).Scan(&survivorID); err != nil {
		t.Fatalf("seed surviving customer: %v", err)
	}
	if err := owner.QueryRow(ctx,
		`INSERT INTO customers (org_id, name, email, deactivated_at, merged_into_customer_id, merged_at)
		 VALUES ($1::uuid, 'Acme Supply', 'old@acme.test', now(), $2::uuid, now()) RETURNING id::text`,
		fixture.orgA, survivorID).Scan(&mergedID); err != nil {
		t.Fatalf("seed merged customer: %v", err)
	}

	handler := &chatSessionHandler{pool: runtime}
	user := &session.ResolvedUser{UserID: fixture.userID, OrgID: &fixture.orgA, Permissions: map[string]bool{"crm.read": true}}
	resolve := func(query string) (int, []chatEntityMatch) {
		t.Helper()
		arguments, err := json.Marshal(map[string]any{"type": "customer", "query": query})
		if err != nil {
			t.Fatal(err)
		}
		payload, ok, message := handler.resolveEntity(ctx, user, chatToolCall{Name: "resolve_entity", Arguments: arguments})
		if !ok {
			t.Fatalf("resolve_entity(%q) refused: %s", query, message)
		}
		var decoded struct {
			Count   int               `json:"count"`
			Matches []chatEntityMatch `json:"matches"`
		}
		if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
			t.Fatalf("resolve_entity(%q) returned invalid JSON: %v (%s)", query, err, payload)
		}
		return decoded.Count, decoded.Matches
	}

	count, matches := resolve("Acme Supply")
	if count != 1 || len(matches) != 1 {
		t.Fatalf("merged name count=%d matches=%+v", count, matches)
	}
	if matches[0].ID != survivorID || matches[0].Name != "Acme Supplies Ltd" {
		t.Fatalf("a merged duplicate must resolve to the survivor, got %+v", matches[0])
	}
	if matches[0].MergedFrom != "Acme Supply" || matches[0].MatchedOn != "exact name" {
		t.Fatalf("provenance=%+v", matches[0])
	}
	if matches[0].Deactivated {
		t.Fatalf("the survivor is active, got %+v", matches[0])
	}

	count, matches = resolve("Supplies Acme")
	if count != 1 || matches[0].ID != survivorID || matches[0].MatchedOn != "name tokens" {
		t.Fatalf("token order count=%d matches=%+v", count, matches)
	}

	count, matches = resolve("+256 772 123 456")
	if count != 1 || matches[0].ID != survivorID || matches[0].MatchedOn != "phone" {
		t.Fatalf("phone count=%d matches=%+v", count, matches)
	}

	count, matches = resolve("BILLING@ACME.TEST")
	if count != 1 || matches[0].ID != survivorID || matches[0].MatchedOn != "email" {
		t.Fatalf("email count=%d matches=%+v", count, matches)
	}

	// A survivor can itself be merged later, so the resolver must follow a
	// chain rather than a single link.
	var chainRootID, chainMiddleID, chainLeafID string
	if err := owner.QueryRow(ctx,
		`INSERT INTO customers (org_id, name, email) VALUES ($1::uuid, 'Zeta Holdings Ltd', 'root@zeta.test') RETURNING id::text`,
		fixture.orgA).Scan(&chainRootID); err != nil {
		t.Fatalf("seed chain root: %v", err)
	}
	if err := owner.QueryRow(ctx,
		`INSERT INTO customers (org_id, name, email, deactivated_at, merged_into_customer_id, merged_at)
		 VALUES ($1::uuid, 'Zeta Holdings', 'middle@zeta.test', now(), $2::uuid, now()) RETURNING id::text`,
		fixture.orgA, chainRootID).Scan(&chainMiddleID); err != nil {
		t.Fatalf("seed chain middle: %v", err)
	}
	if err := owner.QueryRow(ctx,
		`INSERT INTO customers (org_id, name, email, deactivated_at, merged_into_customer_id, merged_at)
		 VALUES ($1::uuid, 'Zeta Ltd', 'leaf@zeta.test', now(), $2::uuid, now()) RETURNING id::text`,
		fixture.orgA, chainMiddleID).Scan(&chainLeafID); err != nil {
		t.Fatalf("seed chain leaf: %v", err)
	}
	count, matches = resolve("Zeta Ltd")
	if count != 1 || matches[0].ID != chainRootID {
		t.Fatalf("a chain of merges must resolve to the root: count=%d matches=%+v root=%s middle=%s leaf=%s", count, matches, chainRootID, chainMiddleID, chainLeafID)
	}

	for _, query := range []string{"Acme", "acme supplies", "+256 772 123 456"} {
		_, matches := resolve(query)
		for _, match := range matches {
			if match.ID == mergedID {
				t.Fatalf("query %q returned the merged record as an actionable id: %+v", query, match)
			}
		}
	}
}
