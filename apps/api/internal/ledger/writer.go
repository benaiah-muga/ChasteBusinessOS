package ledger

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

const ledgerChainLockKey int64 = 7_214_811

// AppendEvent is one hash-chained ledger fact. Payload should be JSON created
// from typed structs whose field order matches the TypeScript event payload.
type AppendEvent struct {
	OrgID        string
	ActorType    string
	ActorID      *string
	Kind         string
	CapabilityID *string
	SessionID    *string
	Payload      json.RawMessage
	OccurredAt   time.Time
}

// AppendTx appends an event through the caller's transaction. It neither
// begins nor commits a transaction, so callers can commit or roll back the
// business mutation, audit event, and receipt as one unit.
func AppendTx(ctx context.Context, tx pgx.Tx, event AppendEvent) (seq int64, hash string, err error) {
	if tx == nil {
		return 0, "", errors.New("ledger transaction is required")
	}

	payload, err := stringifyPayload(event.Payload)
	if err != nil {
		return 0, "", fmt.Errorf("encode ledger payload: %w", err)
	}
	occurredAt := event.OccurredAt.Truncate(time.Millisecond).UTC()

	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, ledgerChainLockKey); err != nil {
		return 0, "", fmt.Errorf("lock ledger chain: %w", err)
	}

	var prevHash string
	if err = tx.QueryRow(ctx, `SELECT public.chaste_ledger_chain_head()`).Scan(&prevHash); err != nil {
		return 0, "", fmt.Errorf("read ledger chain head: %w", err)
	}

	hash = hashEvent(event, payload, prevHash, occurredAt)
	err = tx.QueryRow(ctx, `
		INSERT INTO ledger_events (
			org_id, actor_type, actor_id, kind, capability_id, session_id,
			payload, prev_hash, hash, occurred_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
		RETURNING seq`,
		event.OrgID,
		event.ActorType,
		event.ActorID,
		event.Kind,
		event.CapabilityID,
		event.SessionID,
		string(payload),
		prevHash,
		hash,
		occurredAt,
	).Scan(&seq)
	if err != nil {
		return 0, "", fmt.Errorf("insert ledger event: %w", err)
	}
	return seq, hash, nil
}

func hashEvent(event AppendEvent, payload []byte, prevHash string, occurredAt time.Time) string {
	digest := sha256.New()
	writeHashPart(digest, prevHash)
	writeHashPart(digest, event.OrgID)
	writeHashPart(digest, event.ActorType)
	writeHashPart(digest, stringValue(event.ActorID))
	writeHashPart(digest, event.Kind)
	writeHashPart(digest, stringValue(event.CapabilityID))
	writeHashPart(digest, string(payload))
	writeHashPart(digest, strconv.FormatInt(occurredAt.UnixMilli(), 10))
	return hex.EncodeToString(digest.Sum(nil))
}

func writeHashPart(digest hash.Hash, value string) {
	_, _ = digest.Write([]byte(value))
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// stringifyPayload compacts JSON and removes the escapes that Go adds for
// HTML-sensitive characters and JavaScript line separators. TypeScript's
// JSON.stringify emits those characters literally. The scanner preserves
// escaped backslashes, so text such as the six characters "\\u2028" stays
// text instead of becoming a line separator.
func stringifyPayload(raw json.RawMessage) ([]byte, error) {
	if !json.Valid(raw) {
		return nil, errors.New("payload is not valid JSON")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, err
	}
	return unescapeJSONStringifyCharacters(compact.Bytes()), nil
}

func unescapeJSONStringifyCharacters(src []byte) []byte {
	dst := make([]byte, 0, len(src))
	inString := false
	for i := 0; i < len(src); {
		b := src[i]
		if !inString {
			dst = append(dst, b)
			if b == '"' {
				inString = true
			}
			i++
			continue
		}

		if b == '"' {
			dst = append(dst, b)
			inString = false
			i++
			continue
		}
		if b != '\\' || i+1 >= len(src) {
			dst = append(dst, b)
			i++
			continue
		}

		next := src[i+1]
		if next == 'u' && i+6 <= len(src) {
			if codepoint, ok := parseHex4(src[i+2 : i+6]); ok {
				switch codepoint {
				case '<', '>', '&', 0x2028, 0x2029:
					dst = append(dst, string(rune(codepoint))...)
					i += 6
					continue
				}
			}
		}
		if next == '/' {
			dst = append(dst, '/')
			i += 2
			continue
		}
		// Copy a JSON escape as a unit, so escaped quotes and backslashes do
		// not alter the scanner's string state.
		dst = append(dst, b, next)
		i += 2
	}
	return dst
}

func parseHex4(src []byte) (uint16, bool) {
	if len(src) != 4 {
		return 0, false
	}
	var value uint16
	for _, b := range src {
		value <<= 4
		switch {
		case b >= '0' && b <= '9':
			value |= uint16(b - '0')
		case b >= 'a' && b <= 'f':
			value |= uint16(b-'a') + 10
		case b >= 'A' && b <= 'F':
			value |= uint16(b-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}
