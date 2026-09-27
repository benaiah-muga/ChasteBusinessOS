package ledger

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestStringifyPayloadMatchesJSONStringifyEscaping(t *testing.T) {
	type createInput struct {
		Name                   string `json:"name"`
		Phone                  string `json:"phone"`
		PreferredContactMethod string `json:"preferredContactMethod"`
		DoNotContact           bool   `json:"doNotContact"`
		LiteralEscape          string `json:"literalEscape"`
	}
	type auditPayload struct {
		Input createInput `json:"input"`
	}

	encoded, err := json.Marshal(auditPayload{Input: createInput{
		Name:                   "A<&\u2028B",
		Phone:                  "+256 700",
		PreferredContactMethod: "email",
		LiteralEscape:          `\u2028`,
	}})
	if err != nil {
		t.Fatal(err)
	}

	got, err := stringifyPayload(encoded)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"input":{"name":"A<& B","phone":"+256 700","preferredContactMethod":"email","doNotContact":false,"literalEscape":"\\u2028"}}`
	if !bytes.Equal(got, []byte(want)) {
		t.Fatalf("stringifyPayload() = %q, want %q", got, want)
	}
}

func TestHashEventMatchesTypeScriptVector(t *testing.T) {
	actorID := "22222222-2222-4222-8222-222222222222"
	capabilityID := "crm.createCustomer"
	event := AppendEvent{
		OrgID:        "11111111-1111-4111-8111-111111111111",
		ActorType:    "agent",
		ActorID:      &actorID,
		Kind:         "capability.executed",
		CapabilityID: &capabilityID,
		Payload:      json.RawMessage(`{"input":{"name":"A<& B","phone":"+256 700","preferredContactMethod":"email","doNotContact":false}}`),
		OccurredAt:   time.Date(2024, 1, 2, 3, 4, 5, 123987000, time.UTC),
	}
	payload, err := stringifyPayload(event.Payload)
	if err != nil {
		t.Fatal(err)
	}
	got := hashEvent(event, payload, strings.Repeat("0", 64), event.OccurredAt.Truncate(time.Millisecond))
	want := "abc28bbf790049bbc7442e81e6e238821ff3cf89b953e451bba23b7e3da8fddf"
	if got != want {
		t.Fatalf("hashEvent() = %s, want TypeScript vector %s", got, want)
	}
}

func TestAppendTxUsesCallerTransactionAndGlobalHead(t *testing.T) {
	actorID := "22222222-2222-4222-8222-222222222222"
	capabilityID := "crm.createCustomer"
	sessionID := "33333333-3333-4333-8333-333333333333"
	payload := json.RawMessage(`{"input": {"name": "Acme <Ltd>"}}`)
	occurredAt := time.Date(2024, 1, 2, 3, 4, 5, 123987000, time.FixedZone("UTC+3", 3*60*60))
	tx := &captureLedgerTx{head: "head-hash", nextSeq: 42}
	event := AppendEvent{
		OrgID:        "11111111-1111-4111-8111-111111111111",
		ActorType:    "agent",
		ActorID:      &actorID,
		Kind:         "capability.executed",
		CapabilityID: &capabilityID,
		SessionID:    &sessionID,
		Payload:      payload,
		OccurredAt:   occurredAt,
	}

	seq, hash, err := AppendTx(context.Background(), tx, event)
	if err != nil {
		t.Fatal(err)
	}
	if seq != tx.nextSeq || hash != tx.insertArgs[8] {
		t.Fatalf("AppendTx() = (%d, %s), want seq %d and inserted hash %v", seq, hash, tx.nextSeq, tx.insertArgs[8])
	}
	if got, want := strings.Join(tx.operations, ","), "lock,head,insert"; got != want {
		t.Fatalf("database operation order = %q, want %q", got, want)
	}
	if tx.lockKey != ledgerChainLockKey {
		t.Fatalf("advisory lock key = %d, want %d", tx.lockKey, ledgerChainLockKey)
	}
	if tx.insertArgs[7] != tx.head {
		t.Fatalf("insert prev_hash = %v, want global head %q", tx.insertArgs[7], tx.head)
	}
	if tx.insertArgs[6] != `{"input":{"name":"Acme <Ltd>"}}` {
		t.Fatalf("insert payload = %q, want compact JSON.stringify-compatible JSON", tx.insertArgs[6])
	}
	if got, want := tx.insertArgs[9].(time.Time), occurredAt.Truncate(time.Millisecond).UTC(); !got.Equal(want) {
		t.Fatalf("insert occurred_at = %s, want truncated UTC timestamp %s", got, want)
	}
	if tx.insertArgs[5] != &sessionID {
		t.Fatalf("insert session_id = %v, want %q", tx.insertArgs[5], sessionID)
	}
}

func TestAppendTxRejectsInvalidPayloadBeforeTakingLock(t *testing.T) {
	tx := &captureLedgerTx{}
	_, _, err := AppendTx(context.Background(), tx, AppendEvent{Payload: json.RawMessage(`{"broken"`)})
	if err == nil {
		t.Fatal("AppendTx() accepted invalid JSON payload")
	}
	if len(tx.operations) != 0 {
		t.Fatalf("invalid payload touched transaction: %v", tx.operations)
	}
}

type captureLedgerTx struct {
	pgx.Tx
	head       string
	nextSeq    int64
	lockKey    int64
	insertArgs []any
	operations []string
}

func (tx *captureLedgerTx) Exec(_ context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	tx.operations = append(tx.operations, "lock")
	if !strings.Contains(query, "pg_advisory_xact_lock") || len(args) != 1 {
		return pgconn.CommandTag{}, pgx.ErrNoRows
	}
	key, ok := args[0].(int64)
	if !ok {
		return pgconn.CommandTag{}, pgx.ErrNoRows
	}
	tx.lockKey = key
	return pgconn.CommandTag{}, nil
}

func (tx *captureLedgerTx) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	if strings.Contains(query, "chaste_ledger_chain_head") {
		tx.operations = append(tx.operations, "head")
		return capturedRow(func(dest ...any) error {
			if len(dest) != 1 {
				return pgx.ErrNoRows
			}
			*dest[0].(*string) = tx.head
			return nil
		})
	}
	if strings.Contains(query, "INSERT INTO ledger_events") {
		tx.operations = append(tx.operations, "insert")
		tx.insertArgs = append([]any(nil), args...)
		return capturedRow(func(dest ...any) error {
			if len(dest) != 1 {
				return pgx.ErrNoRows
			}
			*dest[0].(*int64) = tx.nextSeq
			return nil
		})
	}
	return capturedRow(func(...any) error { return pgx.ErrNoRows })
}

type capturedRow func(...any) error

func (row capturedRow) Scan(dest ...any) error { return row(dest...) }
