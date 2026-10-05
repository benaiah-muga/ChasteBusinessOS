package dashboard

import "testing"

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
