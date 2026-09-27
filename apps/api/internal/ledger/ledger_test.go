package ledger

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresReaderPreservesLedgerRowsAndScopesOrganizations(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to seed the ledger integration test")
		}
		t.Skip("DATABASE_URL is required to seed ledger fixture rows")
	}

	ctx := context.Background()
	ownerPool, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ownerPool.Close)
	runtimePool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtimePool.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtimePool); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	orgID := randomUUID(t)
	otherOrgID := randomUUID(t)
	actorID := randomUUID(t)
	_, err = ownerPool.Exec(ctx,
		`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Go ledger fixture', $2), ($3, 'Go ledger other', $4)`,
		orgID, "go-ledger-"+orgID[:8], otherOrgID, "go-ledger-other-"+otherOrgID[:8],
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := purgeLedgerFixture(context.Background(), ownerPool, orgID, otherOrgID); err != nil {
			t.Errorf("purge ledger fixture: %v", err)
		}
	})

	firstSeq := insertEvent(t, ctx, ownerPool, orgID,
		"human", "fixture.first", nil, nil, `{"value":"old"}`, nil, "hash-first", time.Date(2024, 1, 2, 3, 4, 5, 123456000, time.UTC))
	secondSeq := insertEvent(t, ctx, ownerPool, orgID,
		"agent", "fixture.second", &actorID, stringRef("crm.createCustomer"), `{"nested":[1,"x"]}`, stringRef("hash-first"), "hash-second", time.Date(2024, 1, 2, 3, 4, 6, 987654000, time.UTC))
	insertEvent(t, ctx, ownerPool, otherOrgID,
		"system", "fixture.other", nil, nil, `{"secret":"other-org"}`, nil, "hash-other", time.Date(2024, 1, 2, 3, 4, 7, 0, time.UTC))

	reader := NewPostgresReader(runtimePool)
	events, err := reader.RecentForOrg(ctx, orgID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Seq != secondSeq || events[1].Seq != firstSeq {
		t.Fatalf("recent events = %+v, want seqs [%d %d] in descending order", events, secondSeq, firstSeq)
	}
	visibleOtherRows, err := dbx.WithOrgTx(ctx, runtimePool, orgID, func(tx pgx.Tx) (int, error) {
		var count int
		err := tx.QueryRow(ctx, `SELECT count(*) FROM ledger_events WHERE org_id = $1`, otherOrgID).Scan(&count)
		return count, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if visibleOtherRows != 0 {
		t.Fatalf("runtime role saw %d event(s) from another organization", visibleOtherRows)
	}
	var compactPayload bytes.Buffer
	if err := json.Compact(&compactPayload, events[0].Payload); err != nil {
		t.Fatalf("invalid payload JSON: %v", err)
	}
	if events[0].Kind != "fixture.second" || events[0].CapabilityID == nil || *events[0].CapabilityID != "crm.createCustomer" ||
		events[0].ActorID == nil || *events[0].ActorID != actorID || events[0].PrevHash == nil || *events[0].PrevHash != "hash-first" ||
		compactPayload.String() != `{"nested":[1,"x"]}` || events[0].Hash != "hash-second" ||
		events[0].OccurredAt != "2024-01-02T03:04:06.987Z" {
		t.Fatalf("second event lost stored wire fields: %+v", events[0])
	}
	if events[1].CapabilityID != nil || events[1].ActorID != nil || events[1].SessionID != nil || events[1].PrevHash != nil ||
		events[1].OccurredAt != "2024-01-02T03:04:05.123Z" {
		t.Fatalf("null or timestamp fields differ from legacy serialization: %+v", events[1])
	}
	limited, err := reader.RecentForOrg(ctx, orgID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited) != 1 || limited[0].Seq != secondSeq {
		t.Fatalf("limited events = %+v, want only latest seq %d", limited, secondSeq)
	}
}

func insertEvent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, actorType, kind string, actorID, capabilityID *string, payload string, prevHash *string, hash string, occurredAt time.Time) int64 {
	t.Helper()
	var seq int64
	err := pool.QueryRow(ctx, `
		INSERT INTO ledger_events (org_id, actor_type, actor_id, kind, capability_id, payload, prev_hash, hash, occurred_at)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
		RETURNING seq`, orgID, actorType, actorID, kind, capabilityID, payload, prevHash, hash, occurredAt).Scan(&seq)
	if err != nil {
		t.Fatal(err)
	}
	return seq
}

func purgeLedgerFixture(ctx context.Context, pool *pgxpool.Pool, orgID, otherOrgID string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.ledger_maintenance', 'on', true)"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM ledger_events WHERE org_id IN ($1::uuid, $2::uuid)", orgID, otherOrgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)", orgID, otherOrgID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func randomUUID(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

func stringRef(value string) *string {
	return &value
}
