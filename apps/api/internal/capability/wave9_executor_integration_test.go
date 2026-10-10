package capability

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGoWave9SignalsSkillsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	RegisterSignalsProducer(func(ctx context.Context, orgID string, now time.Time) ([]BusinessSignal, error) {
		return []BusinessSignal{{ID: "wave9-signal", Severity: "orange", Module: "inventory", Subject: "Low stock on WIDGET"}}, nil
	})
	t.Cleanup(func() {
		signalsProducersMu.Lock()
		signalsProducers = nil
		signalsProducersMu.Unlock()
	})
	grantWavePermission(t, fx, "signals.read")
	grantWavePermission(t, fx, "documents.read")

	listInput := json.RawMessage(`{}`)
	listClaims := waveModuleClaims(fx, signalsListCapabilityID, "signals.read", listInput, "human", "", "wave9-signals")
	listed, err := fx.executor.Execute(fx.ctx, listClaims, signalsListCapabilityID, listInput)
	if err != nil || !listed.OK {
		t.Fatalf("signals.list result=%+v err=%v", listed, err)
	}
	var signals SignalsListOutput
	if err := json.Unmarshal(listed.Data, &signals); err != nil {
		t.Fatal(err)
	}
	if len(signals.Signals) != 1 || signals.Signals[0].Subject != "Low stock on WIDGET" {
		t.Fatalf("signals output=%+v, want the registered producer signal", signals)
	}
	replay, err := fx.executor.Execute(fx.ctx, listClaims, signalsListCapabilityID, listInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("signals.list replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, signalsListCapabilityID, "crm.write", listInput, "human", "", "wave9-signals-denied"), signalsListCapabilityID, listInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: signals.read") {
		t.Fatalf("signals.list denied result=%+v err=%v, want permission failure", denied, err)
	}

	findInput := json.RawMessage(`{"task":"receive goods for a purchase order"}`)
	found, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, skillsFindCapabilityID, "documents.read", findInput, "human", "", "wave9-skills-find"), skillsFindCapabilityID, findInput)
	if err != nil || !found.OK {
		t.Fatalf("skills.find result=%+v err=%v", found, err)
	}
	var findOut SkillsFindOutput
	if err := json.Unmarshal(found.Data, &findOut); err != nil {
		t.Fatal(err)
	}
	if len(findOut.Skills) == 0 || findOut.Skills[0].ID != "procure-to-pay" {
		t.Fatalf("skills.find output=%+v, want procure-to-pay", findOut)
	}
	loaded, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, skillsLoadCapabilityID, "documents.read", json.RawMessage(`{"id":"procure-to-pay"}`), "human", "", "wave9-skills-load"), skillsLoadCapabilityID, json.RawMessage(`{"id":"procure-to-pay"}`))
	if err != nil || !loaded.OK {
		t.Fatalf("skills.load result=%+v err=%v", loaded, err)
	}
}

func TestGoWave9RoutinesGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "routines.write")
	grantWavePermission(t, fx, "routines.read")

	createInput := json.RawMessage(`{"name":"Weekly reorder","prompt":"Raise reorder POs","scheduleText":"weekly on monday at 08:00","withWebhook":true}`)
	createClaims := waveModuleClaims(fx, routinesCreateCapabilityID, "routines.write", createInput, "human", "", "wave9-routine-create")
	created, err := fx.executor.Execute(fx.ctx, createClaims, routinesCreateCapabilityID, createInput)
	if err != nil || !created.OK {
		t.Fatalf("routines.create result=%+v err=%v", created, err)
	}
	var createdOut RoutinesCreateOutput
	if err := json.Unmarshal(created.Data, &createdOut); err != nil {
		t.Fatal(err)
	}
	if createdOut.WebhookToken == nil || createdOut.ScheduleLabel != "Weekly on Monday at 08:00" {
		t.Fatalf("routines.create output=%+v, want webhook and weekly label", createdOut)
	}
	replay, err := fx.executor.Execute(fx.ctx, createClaims, routinesCreateCapabilityID, createInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("routines.create replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, routinesCreateCapabilityID, "crm.write", createInput, "human", "", "wave9-routine-denied"), routinesCreateCapabilityID, createInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: routines.write") {
		t.Fatalf("routines.create denied result=%+v err=%v, want permission failure", denied, err)
	}

	runInput := json.RawMessage(`{"routineId":"` + createdOut.RoutineID + `"}`)
	run, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, routinesRunNowCapabilityID, "routines.write", runInput, "human", "", "wave9-routine-run"), routinesRunNowCapabilityID, runInput)
	if err != nil || !run.OK {
		t.Fatalf("routines.runNow result=%+v err=%v", run, err)
	}
	deleteInput := json.RawMessage(`{"routineId":"` + createdOut.RoutineID + `"}`)
	deleted, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, routinesDeleteCapabilityID, "routines.write", deleteInput, "human", "", "wave9-routine-delete"), routinesDeleteCapabilityID, deleteInput)
	if err != nil || !deleted.OK {
		t.Fatalf("routines.delete result=%+v err=%v", deleted, err)
	}
	if got := fx.count(`SELECT count(*) FROM routines WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("routines=%d, want zero after delete", got)
	}
}

func TestGoWave9AnalyticsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "analytics.report")
	grantWavePermission(t, fx, "accounting.read")
	grantWavePermission(t, fx, "crm.read")
	grantWavePermission(t, fx, "inventory.read")
	customerID := seedReportsCustomer(t, fx, fx.orgID, "Wave9 Customer")
	issuedAt := time.Date(2026, 2, 15, 12, 0, 0, 0, time.UTC)
	invoiceID := seedReportsInvoice(t, fx, fx.orgID, customerID, 1, "sent", "USD", 120000, 0, 120000, 0, 0, &issuedAt, nil, nil)
	seedReportsInvoiceLine(t, fx, invoiceID, 1000, 120000, 0, nil, nil, false)

	pipelineInput := json.RawMessage(`{}`)
	pipeline, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, analyticsPipelineByStageCapabilityID, "crm.read", pipelineInput, "human", "", "wave9-pipeline"), analyticsPipelineByStageCapabilityID, pipelineInput)
	if err != nil || !pipeline.OK {
		t.Fatalf("pipelineByStage result=%+v err=%v", pipeline, err)
	}
	revenueInput := json.RawMessage(`{"monthsBack":3}`)
	revenueClaims := waveModuleClaims(fx, analyticsRevenueByMonthCapabilityID, "accounting.read", revenueInput, "human", "", "wave9-revenue")
	revenue, err := fx.executor.Execute(fx.ctx, revenueClaims, analyticsRevenueByMonthCapabilityID, revenueInput)
	if err != nil || !revenue.OK {
		t.Fatalf("revenueByMonth result=%+v err=%v", revenue, err)
	}
	replay, err := fx.executor.Execute(fx.ctx, revenueClaims, analyticsRevenueByMonthCapabilityID, revenueInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("revenueByMonth replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, analyticsRevenueByMonthCapabilityID, "crm.write", revenueInput, "human", "", "wave9-revenue-denied"), analyticsRevenueByMonthCapabilityID, revenueInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("revenueByMonth denied result=%+v err=%v, want permission failure", denied, err)
	}

	explainInput := json.RawMessage(`{"dimension":"customer","periodAFrom":"2026-01-01T00:00:00Z","periodATo":"2026-02-01T00:00:00Z","periodBFrom":"2026-02-01T00:00:00Z","periodBTo":"2026-03-01T00:00:00Z"}`)
	explained, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, analyticsExplainChangeCapabilityID, "analytics.report", explainInput, "human", "", "wave9-explain"), analyticsExplainChangeCapabilityID, explainInput)
	if err != nil || !explained.OK {
		t.Fatalf("explainChange result=%+v err=%v", explained, err)
	}
	var explainedOut AnalyticsExplainChangeOutput
	if err := json.Unmarshal(explained.Data, &explainedOut); err != nil {
		t.Fatal(err)
	}
	if explainedOut.CurrentTotalMinor != 120000 {
		t.Fatalf("explainChange output=%+v, want current total 120000", explainedOut)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, analyticsExplainChangeCapabilityID); got != 1 {
		t.Fatalf("explain audit events=%d, want one", got)
	}
}

func TestGoWave9SupportGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "support.write")
	grantWavePermission(t, fx, "support.read")
	customerID := seedReportsCustomer(t, fx, fx.orgID, "Wave9 Support Customer")

	startInput := json.RawMessage(`{"customerId":"` + customerID + `","subject":"Wave9 delivery question"}`)
	startClaims := waveModuleClaims(fx, supportStartConversationCapabilityID, "support.write", startInput, "human", "", "wave9-support-start")
	started, err := fx.executor.Execute(fx.ctx, startClaims, supportStartConversationCapabilityID, startInput)
	if err != nil || !started.OK {
		t.Fatalf("startConversation result=%+v err=%v", started, err)
	}
	var startedOut SupportStartConversationOutput
	if err := json.Unmarshal(started.Data, &startedOut); err != nil {
		t.Fatal(err)
	}
	if !isUUID(startedOut.ConversationID) {
		t.Fatalf("startConversation output=%+v, want UUID conversationId", startedOut)
	}
	replay, err := fx.executor.Execute(fx.ctx, startClaims, supportStartConversationCapabilityID, startInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("startConversation replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, supportStartConversationCapabilityID, "crm.write", startInput, "human", "", "wave9-support-denied"), supportStartConversationCapabilityID, startInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: support.write") {
		t.Fatalf("startConversation denied result=%+v err=%v, want permission failure", denied, err)
	}

	messageInput := json.RawMessage(`{"conversationId":"` + startedOut.ConversationID + `","body":"Where is my order?","from":"customer"}`)
	posted, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, supportPostMessageCapabilityID, "support.write", messageInput, "human", "", "wave9-support-post"), supportPostMessageCapabilityID, messageInput)
	if err != nil || !posted.OK {
		t.Fatalf("postMessage result=%+v err=%v", posted, err)
	}
	var senderType string
	var senderUserID *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT sender_type, sender_user_id::text FROM support_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND body='Where is my order?'`, fx.orgID, startedOut.ConversationID).Scan(&senderType, &senderUserID); err != nil {
		t.Fatal(err)
	}
	if senderType != "customer" || senderUserID == nil || *senderUserID != fx.userID {
		t.Fatalf("customer-words message provenance=(%q,%v), want sender type customer attributed to signed-in user %s", senderType, senderUserID, fx.userID)
	}
	deniedPostInput := json.RawMessage(`{"conversationId":"` + startedOut.ConversationID + `","body":"This attempt must be denied","from":"customer"}`)
	deniedPost, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, supportPostMessageCapabilityID, "crm.write", deniedPostInput, "human", "", "wave9-support-post-denied"), supportPostMessageCapabilityID, deniedPostInput)
	if err != nil || deniedPost.OK || !strings.Contains(deniedPost.Error, "forbidden: missing permission: support.write") {
		t.Fatalf("customer-words post without support.write=%+v err=%v, want permission failure", deniedPost, err)
	}
	escalateInput := json.RawMessage(`{"conversationId":"` + startedOut.ConversationID + `","reason":"Needs a refund decision"}`)
	escalated, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, supportEscalateConversationCapabilityID, "support.write", escalateInput, "human", "", "wave9-support-escalate"), supportEscalateConversationCapabilityID, escalateInput)
	if err != nil || !escalated.OK {
		t.Fatalf("escalateConversation result=%+v err=%v", escalated, err)
	}
	if got := fx.count(`SELECT count(*) FROM support_conversations WHERE org_id=$1::uuid AND id=$2::uuid AND status='escalated'`, fx.orgID, startedOut.ConversationID); got != 1 {
		t.Fatalf("escalated conversations=%d, want one", got)
	}
	categoryInput := json.RawMessage(`{"text":"The item arrived damaged, I want a refund"}`)
	category, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, supportSuggestCategoryCapabilityID, "support.read", categoryInput, "human", "", "wave9-category"), supportSuggestCategoryCapabilityID, categoryInput)
	if err != nil || !category.OK {
		t.Fatalf("suggestCategory result=%+v err=%v", category, err)
	}
	var categoryOut SupportSuggestCategoryOutput
	if err := json.Unmarshal(category.Data, &categoryOut); err != nil {
		t.Fatal(err)
	}
	if categoryOut.Category != "billing" || !categoryOut.Draft {
		t.Fatalf("suggestCategory output=%+v, want billing draft", categoryOut)
	}
	if got := fx.count(`SELECT count(*) FROM support_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND sender_type='system'`, fx.orgID, startedOut.ConversationID); got != 2 {
		t.Fatalf("system messages=%d, want open plus escalation notes", got)
	}
}

func TestGoWave9SupportListHandlesConversationWithoutMessages(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "support.read")
	var conversationID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO support_conversations (org_id, subject, status, created_by_actor_type)
		VALUES ($1::uuid, 'Empty transcript', 'open', 'human')
		RETURNING id::text`, fx.orgID).Scan(&conversationID); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(`{"limit":50}`)
	result, err := fx.executor.Execute(fx.ctx,
		waveModuleClaims(fx, supportListConversationsCapabilityID, "support.read", input, "human", "", "wave9-empty-support-list"),
		supportListConversationsCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("support.listConversations result=%+v err=%v", result, err)
	}
	var output SupportListConversationsOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if len(output.Conversations) != 1 || output.Conversations[0].ID != conversationID || output.Conversations[0].LastMessagePreview != "" {
		t.Fatalf("conversations=%+v, want the empty transcript row with an empty preview", output.Conversations)
	}
	if _, err := time.Parse(time.RFC3339Nano, output.Conversations[0].LastMessageAt); err != nil {
		t.Fatalf("lastMessageAt=%q, want the conversation creation timestamp", output.Conversations[0].LastMessageAt)
	}
}

func TestGoWave9SupportBoundListFiltersBeforeLimit(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "support.read")
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name)
		VALUES ($1::uuid, 'Bound support customer')
		RETURNING id::text`, fx.orgID).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	var customerConversationID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO support_conversations (org_id, customer_id, subject, status, created_by_actor_type, created_at)
		VALUES ($1::uuid, $2::uuid, 'Customer inbox item', 'open', 'human', now() - interval '1 minute')
		RETURNING id::text`, fx.orgID, customerID).Scan(&customerConversationID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO support_conversations (org_id, subject, status, created_by_actor_type, created_at)
		SELECT $1::uuid, 'Visitor inbox item', 'open', 'human', now() + interval '1 minute'
		FROM generate_series(1, 105)`, fx.orgID); err != nil {
		t.Fatal(err)
	}

	executeList := func(input json.RawMessage, intent string) SupportListConversationsOutput {
		t.Helper()
		result, err := fx.executor.Execute(fx.ctx,
			waveModuleClaims(fx, supportListConversationsCapabilityID, "support.read", input, "human", "", intent),
			supportListConversationsCapabilityID, input)
		if err != nil || !result.OK {
			t.Fatalf("support.listConversations result=%+v err=%v", result, err)
		}
		var output SupportListConversationsOutput
		if err := json.Unmarshal(result.Data, &output); err != nil {
			t.Fatal(err)
		}
		return output
	}

	legacyShape := executeList(json.RawMessage(`{"limit":100}`), "wave9-support-all-list")
	if len(legacyShape.Conversations) != 100 {
		t.Fatalf("unfiltered conversations=%d, want 100", len(legacyShape.Conversations))
	}
	for _, conversation := range legacyShape.Conversations {
		if conversation.CustomerID != "" {
			t.Fatalf("unfiltered first 100 unexpectedly included customer %q", conversation.CustomerID)
		}
	}

	bound := executeList(json.RawMessage(`{"limit":100,"customerBoundOnly":true}`), "wave9-support-bound-list")
	if len(bound.Conversations) != 1 || bound.Conversations[0].ID != customerConversationID || bound.Conversations[0].CustomerID != customerID {
		t.Fatalf("customer-bound conversations=%+v, want the customer row despite 105 newer visitor rows", bound.Conversations)
	}
}
