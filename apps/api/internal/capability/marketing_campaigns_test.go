package capability

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestMarketingCampaignsParsersMirrorZodContracts(t *testing.T) {
	segment, err := ParseMarketingCreateSegmentInput(json.RawMessage(`{"name":"Loyal","minSpendMinor":"500000"}`))
	if err != nil || segment.Name != "Loyal" || segment.MinSpendMinor != 500000 {
		t.Fatalf("segment parse=%+v err=%v", segment, err)
	}
	defaultSegment, err := ParseMarketingCreateSegmentInput(json.RawMessage(`{"name":"Everyone"}`))
	if err != nil || defaultSegment.MinSpendMinor != 0 {
		t.Fatalf("segment default parse=%+v err=%v, want zero default", defaultSegment, err)
	}
	if _, err := ParseMarketingCreateSegmentInput(json.RawMessage(`{"name":"Debtors","minSpendMinor":-1}`)); err == nil {
		t.Fatal("negative minSpendMinor refused")
	}
	campaign, err := ParseMarketingCreateCampaignInput(json.RawMessage(`{"segmentId":"8c1e6f4a-2b3d-4e5f-8a9b-0c1d2e3f4a5b","name":"Launch","subject":"Hello","body":"Body"}`))
	if err != nil || campaign.Subject != "Hello" {
		t.Fatalf("campaign parse=%+v err=%v", campaign, err)
	}
	if _, err := ParseMarketingSendCampaignInput(json.RawMessage(`{"campaignId":"nope"}`)); err == nil {
		t.Fatal("bad campaign uuid refused")
	}
	if _, err := parseMarketingCampaignInput(marketingCampaignAnalyticsCapabilityID, json.RawMessage(`{"campaignId":"8c1e6f4a-2b3d-4e5f-8a9b-0c1d2e3f4a5b"}`)); err != nil {
		t.Fatalf("dispatcher refused analytics id: %v", err)
	}
	if _, err := parseMarketingCampaignInput("marketing.unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("dispatcher refused unknown id")
	}
}

func TestMarketingCampaignsLifecycle(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin marketing cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		for _, stmt := range []string{
			`DELETE FROM marketing_deliveries WHERE org_id=$1::uuid`,
			`DELETE FROM outbox_messages WHERE org_id=$1::uuid AND dedupe_key LIKE 'marketing:%'`,
			`DELETE FROM marketing_campaigns WHERE org_id=$1::uuid`,
			`DELETE FROM marketing_segments WHERE org_id=$1::uuid`,
			`DELETE FROM invoices WHERE org_id=$1::uuid`,
			`DELETE FROM customers WHERE org_id=$1::uuid`,
		} {
			if _, err := tx.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("marketing cleanup %q: %v", stmt, err)
				return
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit marketing cleanup: %v", err)
		}
	})

	var spenderID, optedOutID, quietID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name, email) VALUES ($1::uuid, 'Spender', 'spender@fixture.test') RETURNING id::text`, fx.orgID).Scan(&spenderID)
	if err != nil {
		t.Fatal(err)
	}
	err = fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name, email, marketing_opt_out) VALUES ($1::uuid, 'OptedOut', 'optout@fixture.test', true) RETURNING id::text`, fx.orgID).Scan(&optedOutID)
	if err != nil {
		t.Fatal(err)
	}
	err = fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (org_id, name) VALUES ($1::uuid, 'Quiet') RETURNING id::text`, fx.orgID).Scan(&quietID)
	if err != nil {
		t.Fatal(err)
	}
	seedReportsInvoice(t, fx, fx.orgID, spenderID, 1, "sent", "USD", 900000, 0, 900000, 0, 0, nil, nil, nil)
	seedReportsInvoice(t, fx, fx.orgID, optedOutID, 2, "sent", "USD", 800000, 0, 800000, 0, 0, nil, nil, nil)
	seedReportsInvoice(t, fx, fx.orgID, quietID, 3, "sent", "USD", 700000, 0, 700000, 0, 0, nil, nil, nil)

	if _, err := dbx.WithOrgTx(fx.ctx, fx.owner, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		segment, err := marketingCreateSegment(context.Background(), tx, fx.orgID, MarketingCreateSegmentInput{Name: "Big spenders", MinSpendMinor: 500000})
		if err != nil {
			return struct{}{}, err
		}
		campaign, err := marketingCreateCampaign(context.Background(), tx, fx.orgID, MarketingCreateCampaignInput{SegmentID: segment.SegmentID, Name: "Wave7 launch", Subject: "Hello", Body: "Body"})
		if err != nil {
			return struct{}{}, err
		}
		if _, err := marketingCreateCampaign(context.Background(), tx, fx.orgID, MarketingCreateCampaignInput{SegmentID: "8c1e6f4a-2b3d-4e5f-8a9b-0c1d2e3f4a5b", Name: "Ghost", Subject: "Hello", Body: "Body"}); err == nil || err.Error() != "segment not found" {
			t.Errorf("unknown segment err=%v, want segment not found", err)
		}
		sent, err := marketingSendCampaign(context.Background(), tx, fx.orgID, MarketingSendCampaignInput{CampaignID: campaign.CampaignID}, time.Now().UTC())
		if err != nil {
			return struct{}{}, err
		}
		if sent.Recipients != 1 || sent.SkippedOptOut != 1 || sent.SkippedNoAddress != 1 || sent.AlreadySent != 0 {
			t.Fatalf("send output=%+v, want one recipient with opt-out and no-address skips", sent)
		}
		replay, err := marketingSendCampaign(context.Background(), tx, fx.orgID, MarketingSendCampaignInput{CampaignID: campaign.CampaignID}, time.Now().UTC())
		if err == nil || replay.Recipients != 0 || err.Error() != "campaign already sent" {
			t.Fatalf("second send=%+v err=%v, want campaign already sent", replay, err)
		}
		analytics, err := marketingCampaignAnalytics(context.Background(), tx, fx.orgID, MarketingCampaignAnalyticsInput{CampaignID: campaign.CampaignID})
		if err != nil {
			return struct{}{}, err
		}
		if analytics.CampaignName != "Wave7 launch" || analytics.SentCount != 0 || analytics.QueuedAt == nil {
			t.Fatalf("analytics output=%+v, want zero provider-confirmed sends before dispatch", analytics)
		}
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := fx.count(`SELECT count(*) FROM outbox_messages WHERE org_id=$1::uuid AND kind='email'`, fx.orgID); got != 1 {
		t.Fatalf("outbox rows=%d, want one queued email", got)
	}
	if got := fx.count(`SELECT count(*) FROM marketing_deliveries WHERE org_id=$1::uuid`, fx.orgID); got != 1 {
		t.Fatalf("deliveries=%d, want one", got)
	}
}
