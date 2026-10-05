package capability

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	publicSupportOrgID          = "11111111-1111-4111-8111-111111111111"
	publicSupportConversationID = "22222222-2222-4222-8222-222222222222"
	modelConversationID         = "33333333-3333-4333-8333-333333333333"
)

func TestRunPublicSupportReadToolBindsOrderLookupToServerConversation(t *testing.T) {
	tx := &publicSupportFakeTx{}
	pool := &publicSupportFakePool{tx: tx}
	input := json.RawMessage(fmt.Sprintf(`{"conversationId":%q}`, modelConversationID))

	result, err := RunPublicSupportReadTool(context.Background(), pool, publicSupportOrgID, publicSupportConversationID, PublicSupportLookupOrderStatusTool, input)
	if err != nil {
		t.Fatalf("RunPublicSupportReadTool() error = %v", err)
	}
	if !tx.orgContextSet {
		t.Fatal("WithOrgTx did not set the organization context")
	}
	if tx.conversationID != publicSupportConversationID {
		t.Fatalf("conversation lookup used %q, want server supplied %q", tx.conversationID, publicSupportConversationID)
	}
	var output SupportLookupOrderStatusOutput
	if err := json.Unmarshal(result, &output); err != nil {
		t.Fatalf("result is not JSON support output: %v", err)
	}
	if output.CustomerName != "Website visitor" || output.Invoices == nil {
		t.Fatalf("unexpected order lookup output: %+v", output)
	}
}

func TestRunPublicSupportReadToolSearchesKnowledgeAndLimitsToolSurface(t *testing.T) {
	tx := &publicSupportFakeTx{}
	pool := &publicSupportFakePool{tx: tx}
	result, err := RunPublicSupportReadTool(context.Background(), pool, publicSupportOrgID, publicSupportConversationID, PublicSupportSearchKnowledgeTool, json.RawMessage(`{"query":"returns"}`))
	if err != nil {
		t.Fatalf("RunPublicSupportReadTool() error = %v", err)
	}
	var output SupportSearchKnowledgeOutput
	if err := json.Unmarshal(result, &output); err != nil {
		t.Fatalf("result is not JSON support output: %v", err)
	}
	if output.Mode != "text" || len(output.Results) != 1 || output.Results[0].Kind != "article" || output.Results[0].Source == nil || *output.Results[0].Source != "Returns policy" || output.Results[0].Content != "Returns are accepted within 30 days." {
		t.Fatalf("unexpected knowledge output: %+v", output)
	}
	if tx.queryCount != 1 || !strings.Contains(tx.lastQuery, "FROM support_kb_articles") || strings.Contains(tx.lastQuery, "memories") || !strings.Contains(tx.lastQuery, "org_id=$1::uuid") || !strings.Contains(tx.lastQuery, "is_public=true") {
		t.Fatalf("unexpected database query count/query: %d %q", tx.queryCount, tx.lastQuery)
	}
	if len(tx.lastQueryArgs) != 2 || tx.lastQueryArgs[0] != publicSupportOrgID {
		t.Fatalf("knowledge query was not bound to the organization: %#v", tx.lastQueryArgs)
	}

	before := pool.beginCount
	if _, err := RunPublicSupportReadTool(context.Background(), pool, publicSupportOrgID, publicSupportConversationID, "support.postMessage", json.RawMessage(`{}`)); err == nil {
		t.Fatal("unsupported tool unexpectedly succeeded")
	}
	if pool.beginCount != before {
		t.Fatal("unsupported tool opened a database transaction")
	}
}

func TestRunPublicSupportReadToolRejectsInvalidToolInput(t *testing.T) {
	pool := &publicSupportFakePool{tx: &publicSupportFakeTx{}}
	for _, tc := range []struct {
		name string
		tool string
		args json.RawMessage
	}{
		{name: "lookup requires object", tool: PublicSupportLookupOrderStatusTool, args: json.RawMessage(`[]`)},
		{name: "search requires query", tool: PublicSupportSearchKnowledgeTool, args: json.RawMessage(`{"query":"x"}`)},
		{name: "search validates root", tool: PublicSupportSearchKnowledgeTool, args: json.RawMessage(`null`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := pool.beginCount
			if _, err := RunPublicSupportReadTool(context.Background(), pool, publicSupportOrgID, publicSupportConversationID, tc.tool, tc.args); err == nil {
				t.Fatal("invalid input unexpectedly succeeded")
			}
			if pool.beginCount != before {
				t.Fatal("invalid input opened a database transaction")
			}
		})
	}
}

type publicSupportFakePool struct {
	tx         *publicSupportFakeTx
	beginCount int
}

func (p *publicSupportFakePool) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	p.beginCount++
	return p.tx, nil
}

type publicSupportFakeTx struct {
	pgx.Tx
	orgContextSet  bool
	conversationID string
	queryCount     int
	lastQuery      string
	lastQueryArgs  []any
}

func (tx *publicSupportFakeTx) Exec(_ context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	if strings.Contains(query, "set_config('app.org_id'") && len(args) == 1 && args[0] == publicSupportOrgID {
		tx.orgContextSet = true
	}
	return pgconn.NewCommandTag("SELECT 1"), nil
}

func (tx *publicSupportFakeTx) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	if strings.Contains(query, "FROM support_conversations c") {
		if len(args) > 1 {
			tx.conversationID, _ = args[1].(string)
		}
		return publicSupportFakeRow{values: []any{
			publicSupportConversationID, "open", nil, "Returns", nil, nil, "visitor@example.test", "normal", nil, nil, nil,
		}}
	}
	return publicSupportFakeRow{err: fmt.Errorf("unexpected QueryRow: %s", query)}
}

func (tx *publicSupportFakeTx) Query(_ context.Context, query string, args ...any) (pgx.Rows, error) {
	tx.queryCount++
	tx.lastQuery = query
	tx.lastQueryArgs = args
	switch {
	case strings.Contains(query, "FROM invoices"):
		return &publicSupportFakeRows{}, nil
	case strings.Contains(query, "FROM support_kb_article_embeddings"):
		return &publicSupportFakeRows{rows: [][]any{{"Returns policy", "Returns are accepted within 30 days."}}}, nil
	case strings.Contains(query, "FROM support_kb_articles"):
		return &publicSupportFakeRows{rows: [][]any{{"Returns policy", "Returns are accepted within 30 days."}}}, nil
	default:
		return nil, fmt.Errorf("unexpected Query: %s", query)
	}
}

func (tx *publicSupportFakeTx) Commit(context.Context) error   { return nil }
func (tx *publicSupportFakeTx) Rollback(context.Context) error { return nil }

type publicSupportFakeRow struct {
	values []any
	err    error
}

func (row publicSupportFakeRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(dest) != len(row.values) {
		return fmt.Errorf("Scan received %d destinations, want %d", len(dest), len(row.values))
	}
	for i := range dest {
		target := reflect.ValueOf(dest[i])
		if target.Kind() != reflect.Pointer || target.IsNil() {
			return fmt.Errorf("Scan destination %d is not a non-nil pointer", i)
		}
		value := reflect.ValueOf(row.values[i])
		if !value.IsValid() {
			target.Elem().Set(reflect.Zero(target.Elem().Type()))
			continue
		}
		if value.Type().AssignableTo(target.Elem().Type()) {
			target.Elem().Set(value)
			continue
		}
		if target.Elem().Kind() == reflect.Pointer && value.Type().AssignableTo(target.Elem().Type().Elem()) {
			allocated := reflect.New(target.Elem().Type().Elem())
			allocated.Elem().Set(value)
			target.Elem().Set(allocated)
			continue
		}
		return fmt.Errorf("cannot scan %T into %T", row.values[i], dest[i])
	}
	return nil
}

type publicSupportFakeRows struct {
	pgx.Rows
	rows  [][]any
	index int
}

func (rows *publicSupportFakeRows) Next() bool { return rows.index < len(rows.rows) }
func (rows *publicSupportFakeRows) Close()     {}
func (rows *publicSupportFakeRows) Err() error { return nil }
func (rows *publicSupportFakeRows) Scan(dest ...any) error {
	if rows.index >= len(rows.rows) {
		return fmt.Errorf("Scan called without a current row")
	}
	if err := (publicSupportFakeRow{values: rows.rows[rows.index]}).Scan(dest...); err != nil {
		return err
	}
	rows.index++
	return nil
}
