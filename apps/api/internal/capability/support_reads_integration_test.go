package capability

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestGoSupportReadConversationMatchesLegacyDetail(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "support.read")
	customerID := seedReportsCustomer(t, fx, fx.orgID, "Support detail customer")
	slaDueAt := time.Date(2026, 10, 7, 11, 12, 13, 456000000, time.UTC)
	var conversationID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO support_conversations (org_id, customer_id, subject, status, priority, category, assigned_user_id, sla_due_at, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'Shipping follow-up', 'escalated', 'urgent', 'shipping', $3::uuid, $4, 'human')
		RETURNING id::text`, fx.orgID, customerID, fx.userID, slaDueAt).Scan(&conversationID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO support_messages (org_id, conversation_id, sender_type, sender_user_id, body, created_at)
		SELECT $1::uuid, $2::uuid, CASE WHEN n % 2 = 0 THEN 'staff' ELSE 'customer' END,
			CASE WHEN n % 2 = 0 THEN $3::uuid ELSE NULL END,
			'message ' || n, '2026-09-30 08:00:00+00'::timestamptz + (n || ' seconds')::interval
		FROM generate_series(1, 201) AS n`, fx.orgID, conversationID, fx.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO support_messages (org_id, conversation_id, sender_type, body, created_at)
		VALUES ($1::uuid, $2::uuid, 'system', 'foreign organization row', '2026-09-30 08:00:00+00'::timestamptz)`, fx.otherOrgID, conversationID); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{"conversationId":"` + conversationID + `","limit":200}`)
	claims := waveModuleClaims(fx, supportReadConversationCapabilityID, "support.read", input, "human", "", "support-detail-parity")
	result, err := fx.executor.Execute(fx.ctx, claims, supportReadConversationCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("support.readConversation result=%+v err=%v", result, err)
	}
	var output SupportReadConversationOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode support.readConversation output: %v", err)
	}
	conversation := output.Conversation
	if conversation.ID != conversationID || conversation.CustomerID == nil || *conversation.CustomerID != customerID ||
		conversation.CustomerName != "Support detail customer" || conversation.Subject != "Shipping follow-up" ||
		conversation.Status != "escalated" || conversation.Priority != "urgent" || conversation.Category == nil || *conversation.Category != "shipping" ||
		conversation.AssignedUserID == nil || *conversation.AssignedUserID != fx.userID || conversation.SLADueAt == nil ||
		*conversation.SLADueAt != "2026-10-07T11:12:13.456Z" {
		t.Fatalf("conversation header=%+v, want the full legacy ticket header", conversation)
	}
	if len(output.Messages) != 200 {
		t.Fatalf("messages=%d, want the legacy 200 row limit", len(output.Messages))
	}
	for index, message := range output.Messages {
		wantBody := fmt.Sprintf("message %d", index+1)
		if message.Body != wantBody || message.OrgID != fx.orgID || message.ConversationID != conversationID || message.ID == "" || message.CreatedAt == "" {
			t.Fatalf("message[%d]=%+v, want %q from the scoped conversation", index, message, wantBody)
		}
		if index%2 == 1 && (message.SenderUserID == nil || *message.SenderUserID != fx.userID) {
			t.Fatalf("message[%d].senderUserId=%v, want %s", index, message.SenderUserID, fx.userID)
		}
		if index%2 == 0 && message.SenderUserID != nil {
			t.Fatalf("message[%d].senderUserId=%v, want null", index, message.SenderUserID)
		}
	}
	if output.Messages[0].Body != "message 1" || output.Messages[len(output.Messages)-1].Body != "message 200" {
		t.Fatalf("message range %q through %q, want oldest 200 records in creation order", output.Messages[0].Body, output.Messages[len(output.Messages)-1].Body)
	}

	legacyInput := json.RawMessage(`{"conversationId":"` + conversationID + `"}`)
	legacyResult, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, supportReadConversationCapabilityID, "support.read", legacyInput, "human", "", "support-detail-default"),
		supportReadConversationCapabilityID, legacyInput)
	if err != nil || !legacyResult.OK {
		t.Fatalf("default support.readConversation result=%+v err=%v", legacyResult, err)
	}
	var legacy map[string]any
	if err := json.Unmarshal(legacyResult.Data, &legacy); err != nil {
		t.Fatal(err)
	}
	legacyConversation := legacy["conversation"].(map[string]any)
	legacyMessages := legacy["messages"].([]any)
	legacyMessage := legacyMessages[0].(map[string]any)
	if len(legacyMessages) != supportTranscriptMaxMessages || len(legacyConversation) != 5 || len(legacyMessage) != 3 {
		t.Fatalf("default detail shape conversation=%v firstMessage=%v messages=%d, want unchanged header/message fields and default limit %d", legacyConversation, legacyMessage, len(legacyMessages), supportTranscriptMaxMessages)
	}
}
