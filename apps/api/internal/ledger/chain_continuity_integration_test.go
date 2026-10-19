package ledger

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ledgerChainOrderingCap bounds the key-order search used below. Legacy rows
// were hashed over JSON.stringify output whose object key order jsonb does not
// preserve. Rows whose orderings exceed this budget stay link-verified only.
const ledgerChainOrderingCap = 20_000

type ledgerChainRow struct {
	Seq           int64
	PrevHash      *string
	Hash          string
	OrgID         string
	ActorType     string
	ActorID       string
	Kind          string
	CapabilityID  string
	AuthSessionID string
	Payload       []byte
	OccurredAtMS  int64
}

// TestGoAppendVerifiesWholeMigratedLedgerChain proves the Go writer continues
// the migrated audit chain: it appends through the runtime role, then verifies
// the appended row and every existing row as one chain. Linkage is checked for
// every consecutive pair. Hashes are recomputed byte-for-byte where the stored
// payload text is JSON.stringify-compatible, and recovered through a bounded
// object key-order search where jsonb normalized the order.
func TestGoAppendVerifiesWholeMigratedLedgerChain(t *testing.T) {
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
			t.Fatal("DATABASE_URL is required to verify the migrated ledger chain")
		}
		t.Skip("DATABASE_URL is required to read the whole ledger chain")
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
	if _, err := ownerPool.Exec(ctx,
		`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Go ledger chain fixture', $2)`,
		orgID, "go-ledger-chain-"+orgID[:8],
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := purgeLedgerFixture(context.Background(), ownerPool, orgID, orgID); err != nil {
			t.Errorf("purge ledger chain fixture: %v", err)
		}
	})

	preSeq := int64(0)
	preHead := strings.Repeat("0", 64)
	err = ownerPool.QueryRow(ctx, `SELECT seq, hash FROM ledger_events ORDER BY seq DESC LIMIT 1`).Scan(&preSeq, &preHead)
	if errors.Is(err, pgx.ErrNoRows) {
		preSeq = 0
	} else if err != nil {
		t.Fatal(err)
	}

	if preSeq == 0 {
		// A fresh database has no migrated chain to continue, so seed one row
		// whose hash covers a JSON.stringify key order jsonb does not keep.
		legacyAt := time.Now().UTC().Truncate(time.Millisecond)
		legacyPayload := json.RawMessage(`{"bbb":1,"a":true}`)
		legacyEvent := AppendEvent{OrgID: orgID, ActorType: "system", Kind: "ledger.migrationFixture", OccurredAt: legacyAt}
		legacyHash := hashEvent(legacyEvent, legacyPayload, preHead, legacyAt)
		if _, err := ownerPool.Exec(ctx, `
			INSERT INTO ledger_events (org_id, actor_type, kind, payload, prev_hash, hash, occurred_at)
			VALUES ($1::uuid, 'system', 'ledger.migrationFixture', $2::jsonb, $3, $4, $5)`,
			orgID, string(legacyPayload), preHead, legacyHash, legacyAt); err != nil {
			t.Fatal(err)
		}
		if err := ownerPool.QueryRow(ctx, `SELECT seq, hash FROM ledger_events ORDER BY seq DESC LIMIT 1`).Scan(&preSeq, &preHead); err != nil {
			t.Fatal(err)
		}
	}

	probePayload := json.RawMessage(fmt.Sprintf(`{"continuityProbe":%q}`, randomUUID(t)))
	type appendResult struct {
		Seq  int64
		Hash string
	}
	appended, err := dbx.WithOrgTx(ctx, runtimePool, orgID, func(tx pgx.Tx) (appendResult, error) {
		seq, hash, err := AppendTx(ctx, tx, AppendEvent{
			OrgID: orgID, ActorType: "system", Kind: "ledger.continuityProof",
			Payload: probePayload, OccurredAt: time.Now().UTC(),
		})
		return appendResult{Seq: seq, Hash: hash}, err
	})
	if err != nil {
		t.Fatalf("append through the runtime role: %v", err)
	}

	var appendedRow ledgerChainRow
	appendedRow, err = dbx.WithOrgTx(ctx, runtimePool, orgID, func(tx pgx.Tx) (ledgerChainRow, error) {
		var row ledgerChainRow
		err := tx.QueryRow(ctx, `
			SELECT seq, prev_hash, hash, org_id::text, actor_type, coalesce(actor_id::text, ''),
			       kind, coalesce(capability_id, ''), coalesce(auth_session_id, ''), payload::text,
			       (extract(epoch from occurred_at) * 1000)::bigint
			FROM ledger_events WHERE org_id = $1::uuid AND seq = $2`, orgID, appended.Seq).
			Scan(&row.Seq, &row.PrevHash, &row.Hash, &row.OrgID, &row.ActorType, &row.ActorID,
				&row.Kind, &row.CapabilityID, &row.AuthSessionID, &row.Payload, &row.OccurredAtMS)
		return row, err
	})
	if err != nil {
		t.Fatalf("read the appended row through the runtime role: %v", err)
	}
	if appendedRow.Hash != appended.Hash || appendedRow.Kind != "ledger.continuityProof" {
		t.Fatalf("appended row = %+v, want returned hash %q", appendedRow, appended.Hash)
	}
	normalizedAppend, err := stringifyPayload(appendedRow.Payload)
	if err != nil {
		t.Fatalf("appended payload is invalid JSON: %v", err)
	}
	if !bytes.Equal(normalizedAppend, probePayload) {
		t.Fatalf("appended payload round-trip = %q, want %q", normalizedAppend, probePayload)
	}
	if got, want := ledgerRecomputedHash(appendedRow), appended.Hash; got != want {
		t.Fatalf("appended row recomputed hash = %s, want %s", got, want)
	}
	var predecessorHash string
	err = ownerPool.QueryRow(ctx, `SELECT hash FROM ledger_events WHERE seq < $1 ORDER BY seq DESC LIMIT 1`, appended.Seq).Scan(&predecessorHash)
	if errors.Is(err, pgx.ErrNoRows) {
		predecessorHash = strings.Repeat("0", 64)
	} else if err != nil {
		t.Fatal(err)
	}
	if appendedRow.PrevHash == nil || *appendedRow.PrevHash != predecessorHash {
		t.Fatalf("appended prev_hash = %v, want predecessor hash %q", appendedRow.PrevHash, predecessorHash)
	}
	if appended.Seq == preSeq+1 && *appendedRow.PrevHash != preHead {
		t.Fatalf("appended prev_hash = %q, want pre-append head %q", *appendedRow.PrevHash, preHead)
	}

	var totalRows, exactVerified, recoveredByOrder, overCap, residueRows, chainViolations, residueBreaks, deletionJunctions int
	var unexplained []string
	appendedExact := false
	rows, err := ownerPool.Query(ctx, `
		SELECT seq, prev_hash, hash, org_id::text, actor_type, coalesce(actor_id::text, ''),
		       kind, coalesce(capability_id, ''), coalesce(auth_session_id, ''), payload::text,
		       (extract(epoch from occurred_at) * 1000)::bigint
		FROM ledger_events ORDER BY seq`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var previous *ledgerChainRow
	for rows.Next() {
		var row ledgerChainRow
		if err := rows.Scan(&row.Seq, &row.PrevHash, &row.Hash, &row.OrgID, &row.ActorType, &row.ActorID,
			&row.Kind, &row.CapabilityID, &row.AuthSessionID, &row.Payload, &row.OccurredAtMS); err != nil {
			t.Fatal(err)
		}
		totalRows++
		productionHash := isProductionLedgerHash(row.Hash)
		if previous != nil {
			switch {
			case row.Seq > previous.Seq+1:
				deletionJunctions++
			case row.PrevHash == nil || *row.PrevHash != previous.Hash:
				if productionHash {
					chainViolations++
					unexplained = appendLimit(unexplained, fmt.Sprintf("seq %d linkage (prev %v != %s)", row.Seq, row.PrevHash, previous.Hash))
				} else {
					residueBreaks++
				}
			}
		}
		if !productionHash {
			residueRows++
			previous = &row
			continue
		}
		exact := ledgerRecomputedHash(row)
		if exact == row.Hash {
			exactVerified++
			if row.Seq == appended.Seq {
				appendedExact = true
			}
		} else if recovered, withinBudget := recoverLedgerRowHash(row); recovered {
			recoveredByOrder++
			if row.Seq == appended.Seq {
				appendedExact = true
			}
		} else if withinBudget {
			unexplained = appendLimit(unexplained, fmt.Sprintf("seq %d kind %s payload %.120s", row.Seq, row.Kind, strings.TrimSpace(string(row.Payload))))
		} else {
			overCap++
		}
		previous = &row
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	t.Logf("ledger chain: rows=%d exact=%d keyOrderRecovered=%d overCap=%d residue=%d deletionJunctions=%d residueBreaks=%d",
		totalRows, exactVerified, recoveredByOrder, overCap, residueRows, deletionJunctions, residueBreaks)
	if chainViolations != 0 || len(unexplained) != 0 {
		t.Fatalf("ledger chain violations=%d unexplained=%d: %s", chainViolations, len(unexplained), strings.Join(unexplained, "; "))
	}
	if exactVerified+recoveredByOrder+overCap+residueRows != totalRows {
		t.Fatalf("ledger chain accounting = %d + %d + %d + %d, want %d",
			exactVerified, recoveredByOrder, overCap, residueRows, totalRows)
	}
	if !appendedExact {
		t.Fatal("appended row was not hash-verified inside the whole-chain scan")
	}
	if totalRows < 2 {
		t.Fatalf("whole-chain scan saw %d rows, want the migrated chain plus the appended row", totalRows)
	}
}

func appendLimit(values []string, value string) []string {
	if len(values) < 10 {
		return append(values, value)
	}
	return values
}

func isProductionLedgerHash(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func ledgerRecomputedHash(row ledgerChainRow) string {
	if row.PrevHash == nil || !isProductionLedgerHash(row.Hash) {
		return ""
	}
	normalized, err := stringifyPayload(row.Payload)
	if err != nil {
		return ""
	}
	event := AppendEvent{
		OrgID: row.OrgID, ActorType: row.ActorType, Kind: row.Kind,
		OccurredAt: time.UnixMilli(row.OccurredAtMS).UTC(),
	}
	if row.ActorID != "" {
		actorID := row.ActorID
		event.ActorID = &actorID
	}
	if row.CapabilityID != "" {
		capabilityID := row.CapabilityID
		event.CapabilityID = &capabilityID
	}
	if row.AuthSessionID != "" {
		authSessionID := row.AuthSessionID
		event.AuthSessionID = &authSessionID
	}
	return hashEvent(event, normalized, *row.PrevHash, event.OccurredAt)
}

// recoverLedgerRowHash searches object key orderings for the stored hash. The
// second result is false when the payload exceeded the ordering budget.
func recoverLedgerRowHash(row ledgerChainRow) (bool, bool) {
	if row.PrevHash == nil {
		return false, true
	}
	decoder := json.NewDecoder(bytes.NewReader(row.Payload))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return false, true
	}
	if productOfOrderings(parsed) > ledgerChainOrderingCap {
		return false, false
	}
	event := AppendEvent{
		OrgID: row.OrgID, ActorType: row.ActorType, Kind: row.Kind,
		OccurredAt: time.UnixMilli(row.OccurredAtMS).UTC(),
	}
	if row.ActorID != "" {
		actorID := row.ActorID
		event.ActorID = &actorID
	}
	if row.CapabilityID != "" {
		capabilityID := row.CapabilityID
		event.CapabilityID = &capabilityID
	}
	if row.AuthSessionID != "" {
		authSessionID := row.AuthSessionID
		event.AuthSessionID = &authSessionID
	}
	budget := ledgerChainOrderingCap
	var builder bytes.Buffer
	found := false
	writeOrderings(parsed, &builder, func() bool {
		budget--
		if budget < 0 {
			return true
		}
		normalized, err := stringifyPayload(builder.Bytes())
		if err != nil {
			return false
		}
		if hashEvent(event, normalized, *row.PrevHash, event.OccurredAt) == row.Hash {
			found = true
			return true
		}
		return false
	})
	return found, true
}

func productOfOrderings(value any) int {
	switch v := value.(type) {
	case map[string]any:
		product := factorial(len(v))
		if product > ledgerChainOrderingCap {
			return ledgerChainOrderingCap + 1
		}
		for _, child := range v {
			childProduct := productOfOrderings(child)
			if childProduct > ledgerChainOrderingCap/product {
				return ledgerChainOrderingCap + 1
			}
			product *= childProduct
			if product > ledgerChainOrderingCap {
				return ledgerChainOrderingCap + 1
			}
		}
		return product
	case []any:
		product := 1
		for _, child := range v {
			childProduct := productOfOrderings(child)
			if childProduct > ledgerChainOrderingCap/product {
				return ledgerChainOrderingCap + 1
			}
			product *= childProduct
			if product > ledgerChainOrderingCap {
				return ledgerChainOrderingCap + 1
			}
		}
		return product
	default:
		return 1
	}
}

func factorial(value int) int {
	product := 1
	for i := 2; i <= value; i++ {
		product *= i
		if product > ledgerChainOrderingCap {
			return ledgerChainOrderingCap + 1
		}
	}
	return product
}

// writeOrderings appends every JSON.stringify-compatible serialization of
// value to builder, invoking emit after each complete serialization. Every
// frame restores the buffer to its entry length on return, in LIFO order, so
// builder is unchanged when this returns. It returns true when emit asked to
// stop.
func writeOrderings(value any, builder *bytes.Buffer, emit func() bool) bool {
	base := builder.Len()
	defer builder.Truncate(base)
	switch v := value.(type) {
	case nil:
		builder.WriteString("null")
		return emit()
	case bool:
		if v {
			builder.WriteString("true")
		} else {
			builder.WriteString("false")
		}
		return emit()
	case json.Number:
		builder.WriteString(v.String())
		return emit()
	case string:
		encoded, err := json.Marshal(v)
		if err != nil {
			return false
		}
		builder.Write(encoded)
		return emit()
	case []any:
		builder.WriteByte('[')
		var walk func(int) bool
		walk = func(index int) bool {
			frame := builder.Len()
			defer builder.Truncate(frame)
			if index == len(v) {
				builder.WriteByte(']')
				return emit()
			}
			if index > 0 {
				builder.WriteByte(',')
			}
			return writeOrderings(v[index], builder, func() bool { return walk(index + 1) })
		}
		return walk(0)
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		return permuteKeys(keys, func(order []string) bool {
			frame := builder.Len()
			defer builder.Truncate(frame)
			builder.WriteByte('{')
			var walk func(int) bool
			walk = func(index int) bool {
				step := builder.Len()
				defer builder.Truncate(step)
				if index == len(order) {
					builder.WriteByte('}')
					return emit()
				}
				if index > 0 {
					builder.WriteByte(',')
				}
				encodedKey, err := json.Marshal(order[index])
				if err != nil {
					return false
				}
				builder.Write(encodedKey)
				builder.WriteByte(':')
				return writeOrderings(v[order[index]], builder, func() bool { return walk(index + 1) })
			}
			return walk(0)
		})
	default:
		return false
	}
}

func permuteKeys(keys []string, visit func([]string) bool) bool {
	order := make([]string, len(keys))
	used := make([]bool, len(keys))
	var walk func(int) bool
	walk = func(index int) bool {
		if index == len(keys) {
			return visit(order)
		}
		for candidate := range keys {
			if used[candidate] {
				continue
			}
			used[candidate] = true
			order[index] = keys[candidate]
			if walk(index + 1) {
				return true
			}
			used[candidate] = false
		}
		return false
	}
	return walk(0)
}
