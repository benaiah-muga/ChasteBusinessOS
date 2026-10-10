package capability

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestMarketingOverviewSnapshotInputIsStrictlyEmpty(t *testing.T) {
	for _, raw := range []string{`{}`, "{}\n"} {
		if _, err := ParseMarketingOverviewSnapshotInput(json.RawMessage(raw)); err != nil {
			t.Fatalf("accepted empty input %q: %v", raw, err)
		}
	}
	for _, raw := range []string{`{"orgId":"` + executorUUID(t) + `"}`, `[]`, `{} {}`} {
		if _, err := ParseMarketingOverviewSnapshotInput(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted invalid input %q", raw)
		}
	}
	if !supportedCapability(marketingOverviewSnapshotCapabilityID) || capabilitySpecs[marketingOverviewSnapshotCapabilityID].permission != "marketing.read" {
		t.Fatal("overview snapshot capability is not registered as a marketing.read capability")
	}
}

func TestGoMarketingOverviewSnapshotPreservesContractAndOrganizationScope(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		for _, orgID := range []string{fx.orgID, fx.otherOrgID} {
			for _, stmt := range []string{
				`DELETE FROM marketing_deliveries WHERE org_id=$1::uuid`,
				`DELETE FROM outbox_messages WHERE org_id=$1::uuid AND dedupe_key LIKE 'marketing:%'`,
				`DELETE FROM marketing_campaigns WHERE org_id=$1::uuid`,
				`DELETE FROM marketing_segments WHERE org_id=$1::uuid`,
				`DELETE FROM customers WHERE org_id=$1::uuid`,
			} {
				if _, err := fx.owner.Exec(fx.ctx, stmt, orgID); err != nil {
					t.Errorf("marketing snapshot cleanup %q for %s: %v", stmt, orgID, err)
				}
			}
		}
	})
	grantWavePermission(t, fx, "marketing.read")
	input := json.RawMessage(`{}`)
	if _, ok := capabilitySpecs[marketingOverviewSnapshotCapabilityID]; !ok {
		t.Fatal("overview snapshot capability lacks authorization specification")
	}
	if parsed, err := ParseMarketingOverviewSnapshotInput(input); err != nil || parsed != (MarketingOverviewSnapshotInput{}) {
		t.Fatalf("parse overview input=%+v err=%v", parsed, err)
	}

	type fixtureRows struct{ segmentID, campaignID, customerID string }
	seed := func(orgID, label string) fixtureRows {
		t.Helper()
		var rows fixtureRows
		if _, err := dbx.WithOrgTx(fx.ctx, fx.owner, orgID, func(tx pgx.Tx) (struct{}, error) {
			segment, err := marketingCreateSegment(fx.ctx, tx, orgID, MarketingCreateSegmentInput{Name: label + " segment", MinSpendMinor: 0})
			if err != nil {
				return struct{}{}, err
			}
			campaign, err := marketingCreateCampaign(fx.ctx, tx, orgID, MarketingCreateCampaignInput{SegmentID: segment.SegmentID, Name: label + " campaign", Subject: "Subject", Body: "Body"})
			if err != nil {
				return struct{}{}, err
			}
			rows.segmentID, rows.campaignID = segment.SegmentID, campaign.CampaignID
			if err := tx.QueryRow(fx.ctx, `INSERT INTO customers (org_id, name, email) VALUES ($1::uuid,$2,$3) RETURNING id::text`, orgID, label+" Customer", label+"@fixture.test").Scan(&rows.customerID); err != nil {
				return struct{}{}, err
			}
			if _, err := marketingSendCampaign(fx.ctx, tx, orgID, MarketingSendCampaignInput{CampaignID: campaign.CampaignID}, time.Now().UTC().Truncate(time.Millisecond)); err != nil {
				return struct{}{}, err
			}
			return struct{}{}, nil
		}); err != nil {
			t.Fatalf("seed marketing snapshot for %s: %v", label, err)
		}
		return rows
	}
	own := seed(fx.orgID, "Primary")
	_ = seed(fx.otherOrgID, "Foreign")
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE outbox_messages SET status='sent', completed_at=now() WHERE org_id=$1::uuid AND dedupe_key LIKE 'marketing:%'`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE outbox_messages SET status='sent', completed_at=now() WHERE org_id=$1::uuid AND dedupe_key LIKE 'marketing:%'`, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}

	claims := waveModuleClaims(fx, marketingOverviewSnapshotCapabilityID, "marketing.read", input, "human", "", "marketing-overview-snapshot")
	result, err := fx.executor.Execute(fx.ctx, claims, marketingOverviewSnapshotCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("overview snapshot result=%+v err=%v", result, err)
	}
	var got MarketingOverviewSnapshotOutput
	if err := json.Unmarshal(result.Data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Segments) != 1 || got.Segments[0].ID != own.segmentID || got.Segments[0].Name != "Primary segment" || got.Segments[0].MinSpendMinor != 0 || got.Segments[0].CreatedAt == "" {
		t.Fatalf("segments=%+v, want only the complete same-org row", got.Segments)
	}
	if len(got.Campaigns) != 1 || got.Campaigns[0].ID != own.campaignID || got.Campaigns[0].SegmentID != own.segmentID || got.Campaigns[0].QueuedAt == nil || got.Campaigns[0].CreatedAt == "" {
		t.Fatalf("campaigns=%+v, want exact campaign report fields", got.Campaigns)
	}
	if len(got.SendCounts) != 1 || got.SendCounts[0].CampaignID != own.campaignID || got.SendCounts[0].Count != 1 {
		t.Fatalf("sendCounts=%+v, want one provider-confirmed delivery", got.SendCounts)
	}
	if len(got.RecentSends) != 1 || got.RecentSends[0].CampaignID != own.campaignID || got.RecentSends[0].CustomerName != "Primary Customer" || got.RecentSends[0].CustomerEmail == nil || *got.RecentSends[0].CustomerEmail != "Primary@fixture.test" || got.RecentSends[0].Status != "sent" || got.RecentSends[0].SentAt == nil {
		t.Fatalf("recentSends=%+v, want same-org customer and outbox state", got.RecentSends)
	}
	if !strings.Contains(*got.Campaigns[0].QueuedAt, "T") || !strings.Contains(got.RecentSends[0].QueuedAt, "T") {
		t.Fatalf("report timestamps are not ISO instants: %+v", got)
	}
	denied := waveModuleClaims(fx, marketingOverviewSnapshotCapabilityID, "crm.write", input, "human", "", "marketing-overview-denied")
	deniedResult, err := fx.executor.Execute(fx.ctx, denied, marketingOverviewSnapshotCapabilityID, input)
	if err != nil || deniedResult.OK || !strings.Contains(deniedResult.Error, "forbidden: missing permission: marketing.read") {
		t.Fatalf("wrong permission result=%+v err=%v, want marketing.read denial", deniedResult, err)
	}
}
