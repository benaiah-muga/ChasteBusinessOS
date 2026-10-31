package capability

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestGoWave7ManufacturingGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin wave7 manufacturing cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		if _, err := tx.Exec(fx.ctx, `SELECT set_config('app.ledger_maintenance', 'on', true)`); err != nil {
			t.Errorf("enable wave7 manufacturing cleanup: %v", err)
			return
		}
		for _, stmt := range []string{
			`DELETE FROM stock_movements WHERE org_id=$1::uuid`,
			`DELETE FROM stock_balances WHERE org_id=$1::uuid`,
			`DELETE FROM lots WHERE org_id=$1::uuid`,
			`DELETE FROM work_orders WHERE org_id=$1::uuid`,
			`DELETE FROM bom_lines WHERE org_id=$1::uuid`,
			`DELETE FROM items WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("wave7 manufacturing cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit wave7 manufacturing cleanup: %v", err)
		}
	})
	grantWavePermission(t, fx, "manufacturing.write")
	grantWavePermission(t, fx, "manufacturing.read")
	assemblyID := seedInventoryValuationItem(t, fx, fx.orgID, "CHAIR", "goods", 120000, 0, nil)
	componentID := seedInventoryValuationItem(t, fx, fx.orgID, "SEAT", "goods", 40000, 0, nil)
	seedInventoryValuationMovement(t, fx, fx.orgID, componentID, 5000, "purchase", nil, nil, nil, "system", time.Now().UTC())

	defineInput := json.RawMessage(`{"assemblySku":"CHAIR","expectedComponents":[],"components":[{"sku":"SEAT","quantityThousandths":1000,"scrapPctThousandths":15000}]}`)
	defineClaims := waveModuleClaims(fx, manufacturingDefineBomCapabilityID, "manufacturing.write", defineInput, "human", "", "wave7-bom-define")
	defined, err := fx.executor.Execute(fx.ctx, defineClaims, manufacturingDefineBomCapabilityID, defineInput)
	if err != nil || !defined.OK {
		t.Fatalf("defineBom result=%+v err=%v", defined, err)
	}
	var definition ManufacturingDefineBomOutput
	if err := json.Unmarshal(defined.Data, &definition); err != nil {
		t.Fatal(err)
	}
	if definition.AssemblyItemID != assemblyID || definition.ComponentCount != 1 {
		t.Fatalf("defineBom output=%+v, want one component on CHAIR", definition)
	}
	if definition.AssemblySKU != "CHAIR" || len(definition.PreviousComponents) != 0 || len(definition.Components) != 1 || definition.Components[0].SKU != "SEAT" ||
		definition.Components[0].QuantityThousandths != 1000 || definition.Components[0].ScrapPctThousandths != 15000 {
		t.Fatalf("defineBom inverse snapshot=%+v, want exact created BOM state", definition)
	}
	replay, err := fx.executor.Execute(fx.ctx, defineClaims, manufacturingDefineBomCapabilityID, defineInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("defineBom replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, manufacturingDefineBomCapabilityID, "crm.write", defineInput, "human", "", "wave7-bom-denied"), manufacturingDefineBomCapabilityID, defineInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: manufacturing.write") {
		t.Fatalf("defineBom denied result=%+v err=%v, want permission failure", denied, err)
	}

	createInput := json.RawMessage(`{"assemblySku":"CHAIR","plannedQtyThousandths":2000,"yieldPctThousandths":1000000}`)
	created, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, manufacturingCreateWorkOrderCapabilityID, "manufacturing.write", createInput, "human", "", "wave7-wo-create"), manufacturingCreateWorkOrderCapabilityID, createInput)
	if err != nil || !created.OK {
		t.Fatalf("createWorkOrder result=%+v err=%v", created, err)
	}
	var workOrder ManufacturingCreateWorkOrderOutput
	if err := json.Unmarshal(created.Data, &workOrder); err != nil {
		t.Fatal(err)
	}
	if !isUUID(workOrder.WorkOrderID) {
		t.Fatalf("createWorkOrder output=%+v, want UUID workOrderId", workOrder)
	}

	fx.addAgentSession()
	fx.addPolicy(manufacturingReleaseWorkOrderCapabilityID, "read", nil)
	releaseInput := json.RawMessage(`{"workOrderId":"` + workOrder.WorkOrderID + `"}`)
	approved := approveModuleWrite(t, fx, manufacturingReleaseWorkOrderCapabilityID, "manufacturing.write", releaseInput)
	var released ManufacturingReleaseWorkOrderOutput
	if err := json.Unmarshal(approved.Data, &released); err != nil {
		t.Fatal(err)
	}
	if got := fx.count(`SELECT count(*) FROM work_orders WHERE org_id=$1::uuid AND id=$2::uuid AND status='released'`, fx.orgID, workOrder.WorkOrderID); got != 1 {
		t.Fatalf("released work orders=%d, want one", got)
	}

	feasibilityInput := json.RawMessage(`{"assemblySku":"CHAIR","desiredUnitsThousandths":1000}`)
	feasibility, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, manufacturingCheckProductionFeasibilityCapabilityID, "manufacturing.read", feasibilityInput, "human", "", "wave7-feasibility"), manufacturingCheckProductionFeasibilityCapabilityID, feasibilityInput)
	if err != nil || !feasibility.OK {
		t.Fatalf("checkProductionFeasibility result=%+v err=%v", feasibility, err)
	}
	costInput := json.RawMessage(`{"assemblySku":"CHAIR","quantityThousandths":1000}`)
	costPreview, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, manufacturingCostPreviewCapabilityID, "manufacturing.read", costInput, "human", "", "wave7-cost-preview"), manufacturingCostPreviewCapabilityID, costInput)
	if err != nil || !costPreview.OK {
		t.Fatalf("costPreview result=%+v err=%v", costPreview, err)
	}
	bomReportInput := json.RawMessage(`{"assemblySku":"CHAIR","quantityThousandths":1000}`)
	bomReport, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, manufacturingBomReportCapabilityID, "manufacturing.read", bomReportInput, "human", "", "wave7-bom-report"), manufacturingBomReportCapabilityID, bomReportInput)
	if err != nil || !bomReport.OK {
		t.Fatalf("bomReport result=%+v err=%v", bomReport, err)
	}
	for _, read := range []struct {
		id    string
		input json.RawMessage
	}{
		{manufacturingCheckProductionFeasibilityCapabilityID, feasibilityInput},
		{manufacturingCostPreviewCapabilityID, costInput},
		{manufacturingBomReportCapabilityID, bomReportInput},
	} {
		deniedRead, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, read.id, "crm.read", read.input, "human", "", "wave7-denied-"+read.id), read.id, read.input)
		if err != nil || deniedRead.OK || !strings.Contains(deniedRead.Error, "forbidden: missing permission: manufacturing.read") {
			t.Fatalf("%s denied result=%+v err=%v, want manufacturing.read permission failure", read.id, deniedRead, err)
		}
	}
	foreignAssemblyID := seedInventoryValuationItem(t, fx, fx.otherOrgID, "FOREIGN-CHAIR", "goods", 0, 0, nil)
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM items WHERE org_id=$1::uuid AND id=$2::uuid`, fx.otherOrgID, foreignAssemblyID); err != nil {
			t.Errorf("delete foreign manufacturing fixture item: %v", err)
		}
	})
	for _, read := range []struct {
		id    string
		input json.RawMessage
	}{
		{manufacturingCheckProductionFeasibilityCapabilityID, json.RawMessage(`{"assemblySku":"FOREIGN-CHAIR","desiredUnitsThousandths":1000}`)},
		{manufacturingCostPreviewCapabilityID, json.RawMessage(`{"assemblySku":"FOREIGN-CHAIR","quantityThousandths":1000}`)},
		{manufacturingBomReportCapabilityID, json.RawMessage(`{"assemblySku":"FOREIGN-CHAIR","quantityThousandths":1000}`)},
	} {
		foreignRead, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, read.id, "manufacturing.read", read.input, "human", "", "wave7-foreign-"+read.id), read.id, read.input)
		message := foreignRead.Error
		if err != nil {
			message = err.Error()
		}
		if foreignRead.OK || !strings.Contains(strings.ToLower(message), "no item with sku foreign-chair") {
			t.Fatalf("%s foreign organization result=%+v err=%v, want the foreign SKU to remain hidden", read.id, foreignRead, err)
		}
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, manufacturingReleaseWorkOrderCapabilityID); got != 1 {
		t.Fatalf("release audit events=%d, want one", got)
	}

	fx.addPolicy(manufacturingDeleteBomCapabilityID, "read", nil)
	deleteInput := json.RawMessage(`{"assemblySku":"CHAIR","expectedComponents":[{"sku":"SEAT","quantityThousandths":1000,"scrapPctThousandths":15000}]}`)
	deleteIntent := "wave7-manufacturing-delete-bom"
	deleteAgentClaims := waveModuleClaims(fx, manufacturingDeleteBomCapabilityID, "manufacturing.write", deleteInput, "agent", fx.agentSession, deleteIntent)
	pendingDelete, err := fx.executor.Execute(fx.ctx, deleteAgentClaims, manufacturingDeleteBomCapabilityID, deleteInput)
	if err != nil || pendingDelete.OK || !pendingDelete.PendingApproval || pendingDelete.ApprovalID == "" {
		t.Fatalf("deleteBom pending result=%+v err=%v, want approval", pendingDelete, err)
	}
	decision, err := NewApprovalDecider(fx.runtime, fx.executor).Decide(fx.ctx,
		waveModuleClaims(fx, manufacturingDeleteBomCapabilityID, "manufacturing.write", deleteInput, "human", "", deleteIntent),
		ApprovalDecisionInput{ApprovalID: pendingDelete.ApprovalID, Decision: "approve"})
	if err != nil || !decision.OK || decision.Status != "executed" || decision.Result == nil || !decision.Result.OK {
		t.Fatalf("deleteBom approval result=%+v err=%v, want completed deletion", decision, err)
	}
	deleted := *decision.Result
	var deletion ManufacturingDeleteBomOutput
	if err := json.Unmarshal(deleted.Data, &deletion); err != nil {
		t.Fatal(err)
	}
	if deletion.AssemblySKU != "CHAIR" || deletion.RemovedCount != 1 || len(deletion.PreviousComponents) != 1 || len(deletion.Components) != 0 ||
		deletion.PreviousComponents[0].SKU != "SEAT" || deletion.PreviousComponents[0].QuantityThousandths != 1000 || deletion.PreviousComponents[0].ScrapPctThousandths != 15000 {
		t.Fatalf("deleteBom output=%+v, want the single SEAT inverse snapshot", deletion)
	}
	if got := fx.count(`SELECT count(*) FROM bom_lines WHERE org_id=$1::uuid AND assembly_item_id=$2::uuid`, fx.orgID, assemblyID); got != 0 {
		t.Fatalf("deleteBom left %d assembly lines, want none", got)
	}
	deleteHumanClaims := waveModuleClaims(fx, manufacturingDeleteBomCapabilityID, "manufacturing.write", deleteInput, "human", "", deleteIntent)
	replayedDelete, err := fx.executor.Execute(fx.ctx, deleteHumanClaims, manufacturingDeleteBomCapabilityID, deleteInput)
	var replayedDeletion ManufacturingDeleteBomOutput
	if decodeErr := json.Unmarshal(replayedDelete.Data, &replayedDeletion); decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if err != nil || !replayedDelete.OK || !replayedDelete.Replayed || !reflect.DeepEqual(replayedDeletion, deletion) {
		t.Fatalf("deleteBom replay=%+v err=%v, want the original successful response", replayedDelete, err)
	}
	if got := fx.count(`SELECT count(*) FROM bom_lines WHERE org_id=$1::uuid AND assembly_item_id=$2::uuid`, fx.orgID, assemblyID); got != 0 {
		t.Fatalf("deleteBom replay changed line count to %d, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, manufacturingDeleteBomCapabilityID); got != 1 {
		t.Fatalf("deleteBom audit events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND capability_id=$2`, fx.orgID, manufacturingDeleteBomCapabilityID); got != 1 {
		t.Fatalf("deleteBom receipts=%d, want one", got)
	}
	restoreInput, err := json.Marshal(struct {
		AssemblySKU        string                           `json:"assemblySku"`
		ExpectedComponents []ManufacturingBomComponentInput `json:"expectedComponents"`
		Components         []ManufacturingBomComponentInput `json:"components"`
	}{AssemblySKU: deletion.AssemblySKU, ExpectedComponents: deletion.Components, Components: deletion.PreviousComponents})
	if err != nil {
		t.Fatal(err)
	}
	restoreIntent := deleteIntent + "-restore"
	restoreClaims := waveModuleClaims(fx, manufacturingRestoreBomCapabilityID, "manufacturing.write", restoreInput, "human", "", restoreIntent)
	restored, err := fx.executor.Execute(fx.ctx, restoreClaims, manufacturingRestoreBomCapabilityID, restoreInput)
	if err != nil || !restored.OK {
		t.Fatalf("restoreBom inverse result=%+v err=%v, want exact BOM restoration", restored, err)
	}
	var restoration ManufacturingRestoreBomOutput
	if err := json.Unmarshal(restored.Data, &restoration); err != nil {
		t.Fatal(err)
	}
	if restoration.AssemblySKU != deletion.AssemblySKU || restoration.RestoredCount != deletion.RemovedCount {
		t.Fatalf("restoreBom output=%+v, want restored delete snapshot %+v", restoration, deletion)
	}
	if !reflect.DeepEqual(restoration.PreviousComponents, deletion.Components) || !reflect.DeepEqual(restoration.Components, deletion.PreviousComponents) {
		t.Fatalf("restoreBom state transition=%+v, want from %+v to %+v", restoration, deletion.Components, deletion.PreviousComponents)
	}
	var restoredQuantity, restoredScrap int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT bl.quantity_thousandths, bl.scrap_pct_thousandths
		FROM bom_lines bl JOIN items component ON component.id=bl.component_item_id AND component.org_id=bl.org_id
		WHERE bl.org_id=$1::uuid AND bl.assembly_item_id=$2::uuid AND component.sku='SEAT'`, fx.orgID, assemblyID).
		Scan(&restoredQuantity, &restoredScrap); err != nil {
		t.Fatal(err)
	}
	if restoredQuantity != deletion.PreviousComponents[0].QuantityThousandths || restoredScrap != deletion.PreviousComponents[0].ScrapPctThousandths {
		t.Fatalf("restored BOM quantity=%d scrap=%d, want %d and %d", restoredQuantity, restoredScrap, deletion.PreviousComponents[0].QuantityThousandths, deletion.PreviousComponents[0].ScrapPctThousandths)
	}
	replacementDefinition := json.RawMessage(`{"assemblySku":"CHAIR","expectedComponents":[{"sku":"SEAT","quantityThousandths":1000,"scrapPctThousandths":15000}],"components":[{"sku":"SEAT","quantityThousandths":2000,"scrapPctThousandths":30000}]}`)
	replacementClaims := waveModuleClaims(fx, manufacturingDefineBomCapabilityID, "manufacturing.write", replacementDefinition, "human", "", deleteIntent+"-replacement")
	replacementResult, err := fx.executor.Execute(fx.ctx, replacementClaims, manufacturingDefineBomCapabilityID, replacementDefinition)
	if err != nil || !replacementResult.OK {
		t.Fatalf("replacement defineBom result=%+v err=%v", replacementResult, err)
	}
	var replacement ManufacturingDefineBomOutput
	if err := json.Unmarshal(replacementResult.Data, &replacement); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(replacement.PreviousComponents, deletion.PreviousComponents) || len(replacement.Components) != 1 || replacement.Components[0].QuantityThousandths != 2000 {
		t.Fatalf("replacement defineBom snapshot=%+v, want previous and resulting states", replacement)
	}
	defineInverseInput, err := json.Marshal(struct {
		AssemblySKU        string                           `json:"assemblySku"`
		ExpectedComponents []ManufacturingBomComponentInput `json:"expectedComponents"`
		Components         []ManufacturingBomComponentInput `json:"components"`
	}{AssemblySKU: replacement.AssemblySKU, ExpectedComponents: replacement.Components, Components: replacement.PreviousComponents})
	if err != nil {
		t.Fatal(err)
	}
	defineInverseClaims := waveModuleClaims(fx, manufacturingRestoreBomCapabilityID, "manufacturing.write", defineInverseInput, "human", "", deleteIntent+"-replacement-undo")
	defineInverse, err := fx.executor.Execute(fx.ctx, defineInverseClaims, manufacturingRestoreBomCapabilityID, defineInverseInput)
	if err != nil || !defineInverse.OK {
		t.Fatalf("replacement inverse result=%+v err=%v, want previous BOM restoration", defineInverse, err)
	}
	var inverseRestoration ManufacturingRestoreBomOutput
	if err := json.Unmarshal(defineInverse.Data, &inverseRestoration); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(inverseRestoration.PreviousComponents, replacement.Components) || !reflect.DeepEqual(inverseRestoration.Components, replacement.PreviousComponents) {
		t.Fatalf("replacement inverse state transition=%+v", inverseRestoration)
	}
	newerDefinition := json.RawMessage(`{"assemblySku":"CHAIR","expectedComponents":[{"sku":"SEAT","quantityThousandths":1000,"scrapPctThousandths":15000}],"components":[{"sku":"SEAT","quantityThousandths":3000,"scrapPctThousandths":40000}]}`)
	newerClaims := waveModuleClaims(fx, manufacturingDefineBomCapabilityID, "manufacturing.write", newerDefinition, "human", "", deleteIntent+"-newer-definition")
	newerResult, err := fx.executor.Execute(fx.ctx, newerClaims, manufacturingDefineBomCapabilityID, newerDefinition)
	if err != nil || !newerResult.OK {
		t.Fatalf("newer defineBom result=%+v err=%v", newerResult, err)
	}
	staleUndoInput, err := json.Marshal(struct {
		AssemblySKU        string                           `json:"assemblySku"`
		ExpectedComponents []ManufacturingBomComponentInput `json:"expectedComponents"`
		Components         []ManufacturingBomComponentInput `json:"components"`
	}{AssemblySKU: replacement.AssemblySKU, ExpectedComponents: replacement.Components, Components: replacement.PreviousComponents})
	if err != nil {
		t.Fatal(err)
	}
	staleUndoClaims := waveModuleClaims(fx, manufacturingRestoreBomCapabilityID, "manufacturing.write", staleUndoInput, "human", "", restoreIntent+"-stale-undo")
	staleUndo, err := fx.executor.Execute(fx.ctx, staleUndoClaims, manufacturingRestoreBomCapabilityID, staleUndoInput)
	if err == nil || staleUndo.OK || !strings.Contains(err.Error(), "changed since it was read") {
		t.Fatalf("stale define inverse result=%+v err=%v, want exact-snapshot restore refusal", staleUndo, err)
	}
	staleRestoreClaims := waveModuleClaims(fx, manufacturingRestoreBomCapabilityID, "manufacturing.write", restoreInput, "human", "", restoreIntent+"-stale")
	staleRestore, err := fx.executor.Execute(fx.ctx, staleRestoreClaims, manufacturingRestoreBomCapabilityID, restoreInput)
	if err == nil || staleRestore.OK || !strings.Contains(err.Error(), "restore was not applied") {
		t.Fatalf("stale restore result=%+v err=%v, want it to refuse the newer definition", staleRestore, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT bl.quantity_thousandths, bl.scrap_pct_thousandths
		FROM bom_lines bl JOIN items component ON component.id=bl.component_item_id AND component.org_id=bl.org_id
		WHERE bl.org_id=$1::uuid AND bl.assembly_item_id=$2::uuid AND component.sku='SEAT'`, fx.orgID, assemblyID).
		Scan(&restoredQuantity, &restoredScrap); err != nil {
		t.Fatal(err)
	}
	if restoredQuantity != 3000 || restoredScrap != 40000 {
		t.Fatalf("stale restore overwrote newer BOM quantity=%d scrap=%d", restoredQuantity, restoredScrap)
	}
	clearInput, err := json.Marshal(struct {
		AssemblySKU        string                           `json:"assemblySku"`
		ExpectedComponents []ManufacturingBomComponentInput `json:"expectedComponents"`
		Components         []ManufacturingBomComponentInput `json:"components"`
	}{
		AssemblySKU:        "CHAIR",
		ExpectedComponents: []ManufacturingBomComponentInput{{SKU: "SEAT", QuantityThousandths: 3000, ScrapPctThousandths: 40000}},
		Components:         []ManufacturingBomComponentInput{},
	})
	if err != nil {
		t.Fatal(err)
	}
	clearClaims := waveModuleClaims(fx, manufacturingRestoreBomCapabilityID, "manufacturing.write", clearInput, "human", "", restoreIntent+"-clear")
	cleared, err := fx.executor.Execute(fx.ctx, clearClaims, manufacturingRestoreBomCapabilityID, clearInput)
	if err != nil || !cleared.OK {
		t.Fatalf("restoreBom empty target result=%+v err=%v, want empty BOM", cleared, err)
	}
	if got := fx.count(`SELECT count(*) FROM bom_lines WHERE org_id=$1::uuid AND assembly_item_id=$2::uuid`, fx.orgID, assemblyID); got != 0 {
		t.Fatalf("restoreBom empty target left %d assembly lines", got)
	}
}

func TestGoWave7MarketingGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin wave7 marketing cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		for _, stmt := range []string{
			`DELETE FROM marketing_deliveries WHERE org_id=$1::uuid`,
			`DELETE FROM outbox_messages WHERE org_id=$1::uuid AND dedupe_key LIKE 'marketing:%'`,
			`DELETE FROM marketing_campaigns WHERE org_id=$1::uuid`,
			`DELETE FROM marketing_segments WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("wave7 marketing cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit wave7 marketing cleanup: %v", err)
		}
	})
	grantWavePermission(t, fx, "marketing.write")
	grantWavePermission(t, fx, "marketing.read")

	segmentInput := json.RawMessage(`{"name":"Wave7 segment","minSpendMinor":250000}`)
	segmentClaims := waveModuleClaims(fx, marketingCreateSegmentCapabilityID, "marketing.write", segmentInput, "human", "", "wave7-segment")
	segment, err := fx.executor.Execute(fx.ctx, segmentClaims, marketingCreateSegmentCapabilityID, segmentInput)
	if err != nil || !segment.OK {
		t.Fatalf("createSegment result=%+v err=%v", segment, err)
	}
	var segmentOut MarketingCreateSegmentOutput
	if err := json.Unmarshal(segment.Data, &segmentOut); err != nil {
		t.Fatal(err)
	}
	replay, err := fx.executor.Execute(fx.ctx, segmentClaims, marketingCreateSegmentCapabilityID, segmentInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createSegment replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, marketingCreateSegmentCapabilityID, "crm.write", segmentInput, "human", "", "wave7-segment-denied"), marketingCreateSegmentCapabilityID, segmentInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: marketing.write") {
		t.Fatalf("createSegment denied result=%+v err=%v, want permission failure", denied, err)
	}

	campaignInput := json.RawMessage(`{"segmentId":"` + segmentOut.SegmentID + `","name":"Wave7 campaign","subject":"Hello","body":"Body"}`)
	created, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, marketingCreateCampaignCapabilityID, "marketing.write", campaignInput, "human", "", "wave7-campaign"), marketingCreateCampaignCapabilityID, campaignInput)
	if err != nil || !created.OK {
		t.Fatalf("createCampaign result=%+v err=%v", created, err)
	}
	var campaign MarketingCreateCampaignOutput
	if err := json.Unmarshal(created.Data, &campaign); err != nil {
		t.Fatal(err)
	}

	fx.addAgentSession()
	fx.addPolicy(marketingSendCampaignCapabilityID, "read", nil)
	sendInput := json.RawMessage(`{"campaignId":"` + campaign.CampaignID + `"}`)
	approved := approveModuleWrite(t, fx, marketingSendCampaignCapabilityID, "marketing.write", sendInput)
	var sent MarketingSendCampaignOutput
	if err := json.Unmarshal(approved.Data, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.Recipients != 0 || sent.SkippedOptOut != 0 || sent.SkippedNoAddress != 0 {
		t.Fatalf("sendCampaign output=%+v, want an empty segment send", sent)
	}
	if got := fx.count(`SELECT count(*) FROM marketing_campaigns WHERE org_id=$1::uuid AND id=$2::uuid AND sent_at IS NOT NULL`, fx.orgID, campaign.CampaignID); got != 1 {
		t.Fatalf("sent campaigns=%d, want one stamped", got)
	}
}

func TestGoWave7HROpeningsGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "hr.write")

	createInput := json.RawMessage(`{"title":"Wave7 Bookkeeper","department":"Finance","note":"Backfill"}`)
	createClaims := waveModuleClaims(fx, hrCreateOpeningCapabilityID, "hr.write", createInput, "human", "", "wave7-opening-create")
	created, err := fx.executor.Execute(fx.ctx, createClaims, hrCreateOpeningCapabilityID, createInput)
	if err != nil || !created.OK {
		t.Fatalf("createOpening result=%+v err=%v", created, err)
	}
	var opening HRCreateOpeningOutput
	if err := json.Unmarshal(created.Data, &opening); err != nil {
		t.Fatal(err)
	}
	if !isUUID(opening.OpeningID) {
		t.Fatalf("createOpening output=%+v, want UUID openingId", opening)
	}
	replay, err := fx.executor.Execute(fx.ctx, createClaims, hrCreateOpeningCapabilityID, createInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("createOpening replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrCreateOpeningCapabilityID, "crm.write", createInput, "human", "", "wave7-opening-denied"), hrCreateOpeningCapabilityID, createInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: hr.write") {
		t.Fatalf("createOpening denied result=%+v err=%v, want permission failure", denied, err)
	}

	closeInput := json.RawMessage(`{"openingId":"` + opening.OpeningID + `"}`)
	closed, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, hrCloseOpeningCapabilityID, "hr.write", closeInput, "human", "", "wave7-opening-close"), hrCloseOpeningCapabilityID, closeInput)
	if err != nil || !closed.OK {
		t.Fatalf("closeOpening result=%+v err=%v", closed, err)
	}
	var closedOut HRCloseOpeningOutput
	if err := json.Unmarshal(closed.Data, &closedOut); err != nil {
		t.Fatal(err)
	}
	if !closedOut.Closed {
		t.Fatalf("closeOpening output=%+v, want closed", closedOut)
	}
	if got := fx.count(`SELECT count(*) FROM job_openings WHERE org_id=$1::uuid AND id=$2::uuid AND status='closed'`, fx.orgID, opening.OpeningID); got != 1 {
		t.Fatalf("closed openings=%d, want one", got)
	}
}

func TestGoWave7BuildRemindersGovernedExecutorPath(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "accounting.read")

	remindersInput := json.RawMessage(`{}`)
	remindersClaims := waveModuleClaims(fx, buildRemindersCapabilityID, "accounting.read", remindersInput, "human", "", "wave7-reminders")
	reminders, err := fx.executor.Execute(fx.ctx, remindersClaims, buildRemindersCapabilityID, remindersInput)
	if err != nil || !reminders.OK {
		t.Fatalf("buildReminders result=%+v err=%v", reminders, err)
	}
	var built BuildRemindersOutput
	if err := json.Unmarshal(reminders.Data, &built); err != nil {
		t.Fatal(err)
	}
	replay, err := fx.executor.Execute(fx.ctx, remindersClaims, buildRemindersCapabilityID, remindersInput)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("buildReminders replay=%+v err=%v, want governed receipt replay", replay, err)
	}

	denied, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, buildRemindersCapabilityID, "crm.write", remindersInput, "human", "", "wave7-reminders-denied"), buildRemindersCapabilityID, remindersInput)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: accounting.read") {
		t.Fatalf("buildReminders denied result=%+v err=%v, want permission failure", denied, err)
	}
}
