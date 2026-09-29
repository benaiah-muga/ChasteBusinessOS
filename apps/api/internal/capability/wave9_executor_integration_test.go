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
