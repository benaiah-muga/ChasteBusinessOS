package dashboard

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSetupPayloadMatchesChecklistCompletionRules(t *testing.T) {
	t.Run("empty organization", func(t *testing.T) {
		payload := setupPayload(setupCounts{}, false, false)
		if len(payload.Items) != 7 || payload.Remaining != 7 {
			t.Fatalf("items=%d remaining=%d, want 7 unfinished steps", len(payload.Items), payload.Remaining)
		}
	})

	t.Run("populated organization", func(t *testing.T) {
		payload := setupPayload(setupCounts{
			vendors: 1, items: 1, customers: 1, members: 2, invites: 0, widget: true,
		}, true, true)
		if payload.Remaining != 0 {
			t.Fatalf("remaining=%d, want 0", payload.Remaining)
		}
		for _, item := range payload.Items {
			if !item.Done {
				t.Errorf("setup item %q should be done", item.ID)
			}
		}
	})

	t.Run("pending invitation completes team step", func(t *testing.T) {
		payload := setupPayload(setupCounts{members: 1, invites: 1}, false, false)
		for _, item := range payload.Items {
			if item.ID == "team" && !item.Done {
				t.Fatal("team setup should be complete when an invitation exists")
			}
		}
	})
}

func TestSetupPayloadFromRuntimeReturnsCompleteSevenItemChecklist(t *testing.T) {
	binDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(binDir, "codex"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMTP_HOST", "smtp.example.test")
	t.Setenv("PATH", binDir)

	got := setupPayloadFromRuntime(setupCounts{
		vendors: 1, items: 1, customers: 1, members: 2, widget: true,
	})
	want := SetupPayload{
		Items: []SetupItem{
			{ID: "products", Title: "Add what you sell", Why: "Orders, invoices, and stock all reference products; without them nothing can be priced.", Href: "/products", Done: true},
			{ID: "customers", Title: "Add your first customer", Why: "Sales, invoicing, and customer care hang off customer records.", Href: "/crm", Done: true},
			{ID: "vendors", Title: "Add a vendor", Why: "Purchase requests, RFQs, and bills name the vendor you buy from.", Href: "/purchasing", Done: true},
			{ID: "team", Title: "Invite your team", Why: "Approvals need a second pair of eyes; money-gated actions wait for them.", Href: "/team", Done: true},
			{ID: "email", Title: "Connect outgoing email", Why: "Invoices, approvals, and notifications reach people by email once SMTP is set.", Href: "/settings", Done: true},
			{ID: "widget", Title: "Put chat on your website", Why: "Customer questions land in your care inbox instead of a shared mailbox.", Href: "/support", Done: true},
			{ID: "creator-agent", Title: "Connect a coding agent for Creator mode", Why: "With an agent installed, improvements are proposed as reviewed diffs instead of wishful thinking.", Href: "/proposals", Done: true},
		},
		Remaining: 0,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("runtime setup payload = %+v, want %+v", got, want)
	}
}
