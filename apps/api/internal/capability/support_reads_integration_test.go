package capability

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestGoSupportLibraryReadMatchesLegacyListsAndScopesOrganization(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "support.read")

	var refundID, billingID, foreignCannedID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO support_canned_responses (org_id, shortcut, title, body)
		VALUES ($1::uuid, '/refund', 'Refund help', 'Refund policy text')
		RETURNING id::text`, fx.orgID).Scan(&refundID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO support_canned_responses (org_id, shortcut, title, body)
		VALUES ($1::uuid, '/billing', 'Billing help', 'Billing policy text')
		RETURNING id::text`, fx.orgID).Scan(&billingID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO support_canned_responses (org_id, shortcut, title, body)
		VALUES ($1::uuid, '/foreign', 'Foreign help', 'Must stay hidden')
		RETURNING id::text`, fx.otherOrgID).Scan(&foreignCannedID); err != nil {
		t.Fatal(err)
	}

	var faqID, returnsID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO support_kb_articles (org_id, title, body, category)
		VALUES ($1::uuid, 'Returns', 'Returns article', 'billing')
		RETURNING id::text`, fx.orgID).Scan(&returnsID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO support_kb_articles (org_id, title, body, category)
		VALUES ($1::uuid, 'Delivery FAQ', 'Delivery article', NULL)
		RETURNING id::text`, fx.orgID).Scan(&faqID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO support_kb_articles (org_id, title, body, category)
		VALUES ($1::uuid, 'Foreign article', 'Must stay hidden', 'other')`, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO support_kb_articles (org_id, title, body, category, is_public)
		VALUES ($1::uuid, 'Published returns policy', 'Public returns instructions', 'billing', true)`, fx.orgID); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{}`)
	result, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, supportListLibraryCapabilityID, "support.read", input, "human", "", "support-library-parity"),
		supportListLibraryCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("support.listLibrary result=%+v err=%v", result, err)
	}
	var output SupportLibraryOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatalf("decode support.listLibrary output: %v", err)
	}
	if len(output.Canned) != 2 || output.Canned[0].ID != billingID || output.Canned[0].Shortcut != "/billing" ||
		output.Canned[1].ID != refundID || output.Canned[1].Shortcut != "/refund" || output.Canned[0].ID == foreignCannedID {
		t.Fatalf("canned responses=%+v, want this organization's two rows ordered by shortcut", output.Canned)
	}
	if len(output.Articles) != 3 || output.Articles[0].ID != faqID || output.Articles[0].Category != nil ||
		output.Articles[1].IsPublic != true || output.Articles[1].Title != "Published returns policy" ||
		output.Articles[2].ID != returnsID || output.Articles[2].Category == nil || *output.Articles[2].Category != "billing" {
		t.Fatalf("articles=%+v, want this organization's rows ordered by title with nullable category", output.Articles)
	}

	publicResult, err := RunPublicSupportReadTool(fx.ctx, fx.owner, fx.orgID,
		"22222222-2222-4222-8222-222222222222", PublicSupportSearchKnowledgeTool, json.RawMessage(`{"query":"returns"}`))
	if err != nil {
		t.Fatalf("public support knowledge lookup: %v", err)
	}
	var publicOutput SupportSearchKnowledgeOutput
	if err := json.Unmarshal(publicResult, &publicOutput); err != nil {
		t.Fatalf("decode public support knowledge output: %v", err)
	}
	if len(publicOutput.Results) != 1 || publicOutput.Results[0].Source == nil || *publicOutput.Results[0].Source != "Published returns policy" {
		t.Fatalf("public support search exposed unpublished or foreign articles: %+v", publicOutput.Results)
	}
}

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

	var emptyConversationID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO support_conversations (org_id, customer_id, subject, status, priority, created_by_actor_type)
		VALUES ($1::uuid, $2::uuid, 'No messages yet', 'open', 'normal', 'human')
		RETURNING id::text`, fx.orgID, customerID).Scan(&emptyConversationID); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name  string
		input string
	}{
		{name: "default projection", input: `{"conversationId":"` + emptyConversationID + `"}`},
		{name: "full detail", input: `{"conversationId":"` + emptyConversationID + `","fullDetail":true}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := json.RawMessage(test.input)
			result, err := fx.executor.Execute(fx.ctx,
				waveModuleClaims(fx, supportReadConversationCapabilityID, "support.read", input, "human", "", "support-empty-detail"),
				supportReadConversationCapabilityID, input)
			if err != nil || !result.OK {
				t.Fatalf("support.readConversation result=%+v err=%v", result, err)
			}
			var output map[string]json.RawMessage
			if err := json.Unmarshal(result.Data, &output); err != nil {
				t.Fatalf("decode support.readConversation output: %v", err)
			}
			if got := string(output["messages"]); got != "[]" {
				t.Fatalf("messages JSON=%s, want an empty array", got)
			}
		})
	}
}
