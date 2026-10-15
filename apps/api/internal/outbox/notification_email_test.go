package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestNotificationEmailDispatcherUsesGoApprovalProducerContract(t *testing.T) {
	raw := json.RawMessage(`{"to":"approver@example.test","subject":"[Chaste] Approval needed: crm.createCustomer","text":"An action is waiting for human approval."}`)
	claim := NotificationEmailClaim{
		ID: "11111111-1111-4111-8111-111111111111", OrgID: "22222222-2222-4222-8222-222222222222", Kind: "email",
		DedupeKey:           "notification:approval.email:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ProviderOperationID: "33333333-3333-4333-8333-333333333333",
	}
	var sendCount int
	dispatcher := NewNotificationEmailDispatcher(MarketingEmailConfig{Host: "smtp.example.test"}, func(_ context.Context, config MarketingEmailConfig, message ClaimedMessage, payload marketingEmailPayload) (json.RawMessage, error) {
		sendCount++
		if config.Host != "smtp.example.test" || message.ID != claim.ID || message.OrgID != claim.OrgID || message.ProviderOperationID != claim.ProviderOperationID {
			t.Fatalf("sender received wrong SMTP config or claim: config=%+v claim=%+v", config, message)
		}
		if message.Kind != "email" || payload.To != "approver@example.test" || payload.Subject != "[Chaste] Approval needed: crm.createCustomer" || payload.Text != "An action is waiting for human approval." {
			t.Fatalf("sender received wrong producer payload: claim=%+v payload=%+v", message, payload)
		}
		return json.RawMessage(`{"messageId":"<provider-op-id@chaste.local>"}`), nil
	})

	result := dispatcher.Deliver(context.Background(), claim, raw)
	if result.Status != "sent" || sendCount != 1 || string(result.ProviderReceipt) != `{"messageId":"<provider-op-id@chaste.local>"}` {
		t.Fatalf("delivery result=%+v send count=%d", result, sendCount)
	}
}

func TestNotificationEmailDispatcherRejectsUntrustedClaimAndPayload(t *testing.T) {
	validClaim := NotificationEmailClaim{
		ID: "11111111-1111-4111-8111-111111111111", OrgID: "22222222-2222-4222-8222-222222222222", Kind: "email",
		DedupeKey:           "notification:approval.email:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ProviderOperationID: "33333333-3333-4333-8333-333333333333",
	}
	validPayload := json.RawMessage(`{"to":"approver@example.test","subject":"Approval needed","text":"Review the request."}`)
	var sendCount int
	dispatcher := NewNotificationEmailDispatcher(MarketingEmailConfig{Host: "smtp.example.test"}, func(context.Context, MarketingEmailConfig, ClaimedMessage, marketingEmailPayload) (json.RawMessage, error) {
		sendCount++
		return json.RawMessage(`{}`), nil
	})

	claim := validClaim
	claim.DedupeKey = "marketing:campaign:123"
	if result := dispatcher.Deliver(context.Background(), claim, validPayload); result.Status != "failed" {
		t.Fatalf("foreign claim status=%q, want failed", result.Status)
	}

	invalidPayloads := map[string]json.RawMessage{
		"invalid recipient": json.RawMessage(`{"to":"not-an-email","subject":"Approval","text":"Body"}`),
		"header injection":  json.RawMessage(`{"to":"approver@example.test","subject":"Approval\r\nBcc: victim@example.test","text":"Body"}`),
		"unknown property":  json.RawMessage(`{"to":"approver@example.test","subject":"Approval","text":"Body","url":"https://example.test"}`),
		"trailing document": json.RawMessage(`{"to":"approver@example.test","subject":"Approval","text":"Body"} {}`),
		"oversized body":    json.RawMessage(`{"to":"approver@example.test","subject":"Approval","text":"` + strings.Repeat("x", 60*1024+1) + `"}`),
	}
	for name, raw := range invalidPayloads {
		t.Run(name, func(t *testing.T) {
			result := dispatcher.Deliver(context.Background(), validClaim, raw)
			if result.Status != "failed" || result.LastError == nil || !strings.Contains(*result.LastError, "invalid approval notification email payload") {
				t.Fatalf("invalid payload result=%+v", result)
			}
		})
	}
	if sendCount != 0 {
		t.Fatalf("invalid claim or payload reached sender %d times", sendCount)
	}
}

func TestNotificationEmailDispatcherTreatsSMTPFailureAsUnknown(t *testing.T) {
	claim := NotificationEmailClaim{
		ID: "11111111-1111-4111-8111-111111111111", OrgID: "22222222-2222-4222-8222-222222222222", Kind: "email",
		DedupeKey:           "notification:approval.email:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ProviderOperationID: "33333333-3333-4333-8333-333333333333",
	}
	dispatcher := NewNotificationEmailDispatcher(MarketingEmailConfig{Host: "smtp.example.test"}, func(context.Context, MarketingEmailConfig, ClaimedMessage, marketingEmailPayload) (json.RawMessage, error) {
		return nil, errors.New("connection closed after DATA")
	})
	result := dispatcher.Deliver(context.Background(), claim, json.RawMessage(`{"to":"approver@example.test","subject":"Approval","text":"Review it."}`))
	if result.Status != "unknown" || result.LastError == nil || !strings.HasPrefix(*result.LastError, unknownOutcome) {
		t.Fatalf("SMTP failure result=%+v, want unknown outcome", result)
	}
}
