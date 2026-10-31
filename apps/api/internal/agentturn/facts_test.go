package agentturn

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func testNow() time.Time {
	return time.Date(2026, 10, 28, 19, 0, 0, 0, time.UTC)
}

func approvalsJSON(t *testing.T, count int, rows string) string {
	t.Helper()
	if rows == "" {
		rows = "[]"
	}
	return `{"count":` + itoa(count) + `,"approvals":` + rows + `}`
}

func itoa(value int) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "0"
	}
	return string(encoded)
}

func TestCompileFacts(t *testing.T) {
	rows := `[
		{"id":"11111111-1111-4111-8111-111111111111","capabilityId":"accounting.createInvoice","riskClass":"money","rationale":"Issue invoice INV-12 for 120000 minor units","createdAt":"2026-10-28T16:00:00Z","raisedBy":{"kind":"agent","name":"Workmate"}},
		{"id":"22222222-2222-4222-8222-222222222222","capabilityId":"purchasing.createPurchaseOrder","riskClass":"write","rationale":null,"createdAt":"2026-10-27T10:00:00Z","raisedBy":{"kind":"human","name":"Jane"}}
	]`

	t.Run("reads both inboxes", func(t *testing.T) {
		facts := CompileFacts(FactInput{
			Now:                  testNow(),
			ApprovalsPayload:     approvalsJSON(t, 2, rows),
			NotificationsPayload: `{"unreadCount":3,"notifications":[{"title":"Invoice #12 paid","createdAt":"2026-10-28T18:30:00Z"}]}`,
		})
		if !facts.ApprovalsKnown || !facts.NotificationsKnown {
			t.Fatalf("facts should be known: %+v", facts)
		}
		if facts.PendingApprovalCount != 2 || len(facts.Approvals) != 2 {
			t.Fatalf("approvals=%+v", facts.Approvals)
		}
		if facts.Approvals[0].Rationale != "Issue invoice INV-12 for 120000 minor units" || facts.Approvals[0].RaisedBy != "Workmate" {
			t.Fatalf("approval row=%+v", facts.Approvals[0])
		}
		if facts.UnreadNotifications != 3 || len(facts.Notifications) != 1 {
			t.Fatalf("notifications=%+v", facts.Notifications)
		}
		if facts.Now.Location() != time.UTC {
			t.Fatalf("facts time must be UTC, got %v", facts.Now.Location())
		}
	})

	t.Run("a failed read is unknown, never zero", func(t *testing.T) {
		facts := CompileFacts(FactInput{Now: testNow(), ApprovalsErr: "could not read approvals", NotificationsErr: "notifications are unavailable"})
		if facts.ApprovalsKnown || facts.NotificationsKnown {
			t.Fatalf("failed reads must stay unknown: %+v", facts)
		}
		rendered := RenderFacts(facts)
		if !strings.Contains(rendered, "pendingApprovals: unknown (could not read approvals)") {
			t.Fatalf("rendered=%q", rendered)
		}
		if strings.Contains(rendered, "pendingApprovals: 0") {
			t.Fatalf("an unknown read must never render as zero: %q", rendered)
		}
	})

	t.Run("malformed payload is unknown", func(t *testing.T) {
		facts := CompileFacts(FactInput{Now: testNow(), ApprovalsPayload: "{not json", NotificationsPayload: `{"unreadCount":1}`})
		if facts.ApprovalsKnown {
			t.Fatal("malformed approvals payload must not be treated as known")
		}
		if !facts.NotificationsKnown || facts.UnreadNotifications != 1 {
			t.Fatalf("notifications=%+v", facts)
		}
	})

	t.Run("an empty inbox is an explicit zero", func(t *testing.T) {
		facts := CompileFacts(FactInput{Now: testNow(), ApprovalsPayload: approvalsJSON(t, 0, ""), NotificationsPayload: `{"unreadCount":0,"notifications":[]}`})
		rendered := RenderFacts(facts)
		if !strings.Contains(rendered, "pendingApprovals: 0") || !strings.Contains(rendered, "nothing is waiting for a decision") {
			t.Fatalf("rendered=%q", rendered)
		}
		if !strings.Contains(rendered, "unreadNotifications: 0") {
			t.Fatalf("rendered=%q", rendered)
		}
	})

	t.Run("caps the rows but not the count", func(t *testing.T) {
		var many strings.Builder
		many.WriteString("[")
		for index := 0; index < MaxApprovalFacts+2; index++ {
			if index > 0 {
				many.WriteString(",")
			}
			many.WriteString(`{"id":"row-`)
			many.WriteString(itoa(index))
			many.WriteString(`","capabilityId":"crm.createTask","createdAt":"2026-10-28T18:00:00Z"}`)
		}
		many.WriteString("]")
		facts := CompileFacts(FactInput{Now: testNow(), ApprovalsPayload: approvalsJSON(t, MaxApprovalFacts+2, many.String())})
		if facts.PendingApprovalCount != MaxApprovalFacts+2 || len(facts.Approvals) != MaxApprovalFacts {
			t.Fatalf("count=%d rows=%d", facts.PendingApprovalCount, len(facts.Approvals))
		}
		rendered := RenderFacts(facts)
		if !strings.Contains(rendered, "2 more in Approvals") {
			t.Fatalf("rendered=%q", rendered)
		}
	})

	t.Run("summary is the durable digest", func(t *testing.T) {
		facts := CompileFacts(FactInput{Now: testNow(), ApprovalsPayload: approvalsJSON(t, 2, rows), NotificationsPayload: `{"unreadCount":3}`})
		summary := facts.Summary()
		if summary["pendingApprovals"] != 2 || summary["unreadNotifications"] != 3 {
			t.Fatalf("summary=%v", summary)
		}
		ids, ok := summary["pendingApprovalIds"].([]string)
		if !ok || len(ids) != 2 || ids[0] != "11111111-1111-4111-8111-111111111111" {
			t.Fatalf("summary=%v", summary)
		}
		unknown := CompileFacts(FactInput{Now: testNow(), ApprovalsErr: "boom"}).Summary()
		if _, exists := unknown["pendingApprovals"]; exists {
			t.Fatalf("unknown approvals must not look like a count: %v", unknown)
		}
	})
}

func TestRenderFacts(t *testing.T) {
	facts := CompileFacts(FactInput{
		Now:                  testNow(),
		ApprovalsPayload:     approvalsJSON(t, 2, `[{"id":"a","capabilityId":"accounting.createInvoice","riskClass":"money","rationale":"Issue invoice","createdAt":"2026-10-28T16:00:00Z","raisedBy":{"name":"Workmate"}}]`),
		NotificationsPayload: `{"unreadCount":3,"notifications":[{"title":"Invoice #12 paid","createdAt":"2026-10-28T18:30:00Z"}]}`,
	})
	rendered := RenderFacts(facts)
	if !strings.HasPrefix(rendered, "<turn_facts>\n") || !strings.HasSuffix(rendered, "\n</turn_facts>") {
		t.Fatalf("rendered=%q", rendered)
	}
	for _, want := range []string{
		"readAt: 2026-10-28T19:00:00Z",
		"pendingApprovals: 2",
		"accounting.createInvoice (money)",
		`"Issue invoice"`,
		"raised by Workmate",
		"3 hours ago",
		"approval a",
		"1 more in Approvals",
		`unreadNotifications: 3 (latest: "Invoice #12 paid", 30 minutes ago)`,
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered missing %q: %q", want, rendered)
		}
	}
	if renderAgain := RenderFacts(facts); renderAgain != rendered {
		t.Fatalf("render is not deterministic:\n%s\n%s", rendered, renderAgain)
	}
	if strings.ContainsAny(rendered, "\u2014\u2013") {
		t.Fatalf("facts must not contain dash characters: %q", rendered)
	}
}
