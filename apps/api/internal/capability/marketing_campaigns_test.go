package capability

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

type marketingRowsFixture struct {
	remaining int
	err       error
}

func (r *marketingRowsFixture) Next() bool {
	if r.remaining == 0 {
		return false
	}
	r.remaining--
	return true
}

func (r *marketingRowsFixture) Err() error { return r.err }

func TestMarketingSpendConvertsPersistedInvoiceCurrencies(t *testing.T) {
	baseSpend := int64(6_000)
	euroSpend := int64(3_200)
	rateNum, rateDen := int64(5), int64(4)
	got, err := marketingSpendByCustomer([]marketingInvoiceSpend{
		{customerID: "customer", totalMinor: baseSpend, currency: "USD"},
		{customerID: "customer", totalMinor: euroSpend, currency: "EUR", rateNum: &rateNum, rateDen: &rateDen},
	}, "USD")
	if err != nil {
		t.Fatal(err)
	}
	if got["customer"] != 10_000 {
		t.Fatalf("base-currency spend = %d, want 10000 minor units", got["customer"])
	}

	if _, err := marketingSpendByCustomer([]marketingInvoiceSpend{{customerID: "customer", totalMinor: 1, currency: "EUR"}}, "USD"); err == nil {
		t.Fatal("foreign-currency spend without its persisted FX basis was accepted")
	}
}

func TestCollectMarketingRowsReturnsIterationError(t *testing.T) {
	iterationErr := errors.New("iteration failed")
	rows := &marketingRowsFixture{remaining: 1, err: iterationErr}
	collected, err := collectMarketingRows(rows, func() (string, error) { return "row", nil })
	if !errors.Is(err, iterationErr) {
		t.Fatalf("iteration error = %v, want %v", err, iterationErr)
	}
	if collected != nil {
		t.Fatalf("partially collected rows = %v, want nil on iteration failure", collected)
	}
}

func TestMarketingCampaignsParsersMirrorZodContracts(t *testing.T) {
	segment, err := ParseMarketingCreateSegmentInput(json.RawMessage(`{"name":"Loyal","minSpendMinor":500000}`))
	if err != nil || segment.Name != "Loyal" || segment.MinSpendMinor != 500000 {
		t.Fatalf("segment parse=%+v err=%v", segment, err)
	}
	// Zod z.number() rejects a quoted amount, so the Go parser must refuse it too.
	if _, err := ParseMarketingCreateSegmentInput(json.RawMessage(`{"name":"Loyal","minSpendMinor":"500000"}`)); err == nil {
		t.Fatal("quoted minSpendMinor accepted, but z.number() rejects it")
	}
	defaultSegment, err := ParseMarketingCreateSegmentInput(json.RawMessage(`{"name":"Everyone"}`))
	if err != nil || defaultSegment.MinSpendMinor != 0 {
		t.Fatalf("segment default parse=%+v err=%v, want zero default", defaultSegment, err)
	}
	if _, err := ParseMarketingCreateSegmentInput(json.RawMessage(`{"name":"Debtors","minSpendMinor":-1}`)); err == nil {
		t.Fatal("negative minSpendMinor refused")
	}
	largeSegment, err := ParseMarketingCreateSegmentInput(json.RawMessage(`{"name":"High value","minSpendMinor":999999999999}`))
	if err != nil || largeSegment.MinSpendMinor != 999999999999 {
		t.Fatalf("large segment threshold parse=%+v err=%v", largeSegment, err)
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

func TestMarketingCampaignSpendUsesPersistedInvoiceFX(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		for _, stmt := range []string{
			`DELETE FROM marketing_deliveries WHERE org_id=$1::uuid`,
			`DELETE FROM outbox_messages WHERE org_id=$1::uuid AND dedupe_key LIKE 'marketing:%'`,
			`DELETE FROM marketing_campaigns WHERE org_id=$1::uuid`,
			`DELETE FROM marketing_segments WHERE org_id=$1::uuid`,
			`DELETE FROM invoices WHERE org_id=$1::uuid`,
			`DELETE FROM customers WHERE org_id=$1::uuid`,
		} {
			if _, err := fx.owner.Exec(fx.ctx, stmt, fx.orgID); err != nil {
				t.Errorf("marketing FX cleanup %q: %v", stmt, err)
			}
		}
	})

	var convertedCustomer, belowThresholdCustomer string
	for _, customer := range []struct {
		name  string
		email string
		id    *string
	}{
		{name: "Converted", email: "converted@fixture.test", id: &convertedCustomer},
		{name: "Below threshold", email: "below@fixture.test", id: &belowThresholdCustomer},
	} {
		if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO customers (org_id, name, email) VALUES ($1::uuid, $2, $3) RETURNING id::text`, fx.orgID, customer.name, customer.email).Scan(customer.id); err != nil {
			t.Fatal(err)
		}
	}
	for _, invoice := range []struct {
		customer string
		number   int64
		currency string
		total    int64
		rateNum  *int64
		rateDen  *int64
	}{
		{customer: convertedCustomer, number: 1, currency: "USD", total: 6_000},
		{customer: convertedCustomer, number: 2, currency: "EUR", total: 3_200, rateNum: marketingTestInt64(5), rateDen: marketingTestInt64(4)},
		{customer: belowThresholdCustomer, number: 3, currency: "USD", total: 9_999},
	} {
		if _, err := fx.owner.Exec(fx.ctx, `
			INSERT INTO invoices (org_id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, fx_rate_num, fx_rate_den)
			VALUES ($1::uuid, $2::uuid, $3, 'sent', $4, $5, 0, $5, 0, 0, $6, $7)`, fx.orgID, invoice.customer, invoice.number, invoice.currency, invoice.total, invoice.rateNum, invoice.rateDen); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.owner, fx.orgID, func(tx pgx.Tx) (struct{}, error) {
		segment, err := marketingCreateSegment(fx.ctx, tx, fx.orgID, MarketingCreateSegmentInput{Name: "Converted spend", MinSpendMinor: 10_000})
		if err != nil {
			return struct{}{}, err
		}
		campaign, err := marketingCreateCampaign(fx.ctx, tx, fx.orgID, MarketingCreateCampaignInput{SegmentID: segment.SegmentID, Name: "FX test", Subject: "Hello", Body: "Body"})
		if err != nil {
			return struct{}{}, err
		}
		result, err := marketingSendCampaign(fx.ctx, tx, fx.orgID, MarketingSendCampaignInput{CampaignID: campaign.CampaignID}, time.Now().UTC())
		if err != nil {
			return struct{}{}, err
		}
		if result.Recipients != 1 {
			return struct{}{}, errors.New("campaign did not include only the customer whose converted spend meets the threshold")
		}
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
}

func marketingTestInt64(value int64) *int64 { return &value }
