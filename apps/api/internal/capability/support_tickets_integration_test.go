package capability

import (
	"encoding/json"
	"testing"
	"time"
)

func TestGoSupportListTicketsIsReadScopedTenantSafeAndLimited(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "support.read")
	createdAt := time.Date(2026, 10, 14, 8, 30, 0, 0, time.UTC)
	var olderID, newerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tickets (org_id, title, description, origin, status, created_at)
		VALUES ($1::uuid, 'Older request', 'Follow up on the export screen.', 'request', 'open', $2)
		RETURNING id::text`, fx.orgID, createdAt).Scan(&olderID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tickets (org_id, title, description, origin, status, created_at)
		VALUES ($1::uuid, 'Newer bug', 'The report does not load.', 'bug', 'open', $2::timestamptz + interval '1 hour')
		RETURNING id::text`, fx.orgID, createdAt).Scan(&newerID); err != nil {
		t.Fatal(err)
	}
	var foreignID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tickets (org_id, title, description, origin, status, created_at)
		VALUES ($1::uuid, 'Foreign ticket', 'Must remain hidden.', 'capability_gap', 'open', $2::timestamptz + interval '2 hours')
		RETURNING id::text`, fx.otherOrgID, createdAt).Scan(&foreignID); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{"limit":10}`)
	result, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, supportListTicketsCapabilityID, "support.read", input, "human", "", "support-ticket-list-read"),
		supportListTicketsCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("support.listTickets result=%+v err=%v", result, err)
	}
	var output SupportListTicketsOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode support.listTickets output: %v", err)
	}
	if len(output.Tickets) != 2 {
		t.Fatalf("tickets=%+v, want only the two organization tickets", output.Tickets)
	}
	newer, older := output.Tickets[0], output.Tickets[1]
	if newer.ID != newerID || newer.Title != "Newer bug" || newer.Description != "The report does not load." ||
		newer.Origin != "bug" || newer.Status != "open" || newer.CreatedAt != "2026-10-14T09:30:00.000Z" {
		t.Fatalf("newest ticket=%+v, want complete newest ticket projection", newer)
	}
	if older.ID != olderID || older.Title != "Older request" || older.Origin != "request" || older.ID == foreignID {
		t.Fatalf("older ticket=%+v, want organization-scoped request ticket", older)
	}

	limitedInput := json.RawMessage(`{"limit":1}`)
	limitedResult, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, supportListTicketsCapabilityID, "support.read", limitedInput, "human", "", "support-ticket-list-limit"),
		supportListTicketsCapabilityID, limitedInput)
	if err != nil || !limitedResult.OK {
		t.Fatalf("limited support.listTickets result=%+v err=%v", limitedResult, err)
	}
	if err := json.Unmarshal(limitedResult.Data, &output); err != nil {
		t.Fatalf("decode limited support.listTickets output: %v", err)
	}
	if len(output.Tickets) != 1 || output.Tickets[0].ID != newerID {
		t.Fatalf("limited tickets=%+v, want newest ticket only", output.Tickets)
	}

	denied, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, supportListTicketsCapabilityID, "support.write", input, "human", "", "support-ticket-list-wrong-permission"),
		supportListTicketsCapabilityID, input)
	if err != nil || denied.OK {
		t.Fatalf("support.listTickets with support.write=%+v err=%v, want read permission denial", denied, err)
	}
}
