package capability

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	marketingCreateSegmentCapabilityID     = "marketing.createSegment"
	marketingCreateCampaignCapabilityID    = "marketing.createCampaign"
	marketingSendCampaignCapabilityID      = "marketing.sendCampaign"
	marketingCampaignAnalyticsCapabilityID = "marketing.campaignAnalytics"
)

type MarketingCreateSegmentInput struct {
	Name          string `json:"name"`
	MinSpendMinor int64  `json:"minSpendMinor"`
}

type MarketingCreateSegmentOutput struct {
	SegmentID string `json:"segmentId"`
}

type MarketingCreateCampaignInput struct {
	SegmentID string `json:"segmentId"`
	Name      string `json:"name"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
}

type MarketingCreateCampaignOutput struct {
	CampaignID string `json:"campaignId"`
}

type MarketingSendCampaignInput struct {
	CampaignID string `json:"campaignId"`
}

type MarketingSendCampaignOutput struct {
	Recipients       int64 `json:"recipients"`
	SkippedOptOut    int64 `json:"skippedOptOut"`
	SkippedNoAddress int64 `json:"skippedNoAddress"`
	AlreadySent      int64 `json:"alreadySent"`
}

type MarketingCampaignAnalyticsInput struct {
	CampaignID string `json:"campaignId"`
}

type MarketingCampaignAnalyticsOutput struct {
	CampaignName string  `json:"campaignName"`
	SentCount    int64   `json:"sentCount"`
	QueuedAt     *string `json:"queuedAt"`
}

func ParseMarketingCreateSegmentInput(raw json.RawMessage) (MarketingCreateSegmentInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MarketingCreateSegmentInput{}, err
	}
	var input MarketingCreateSegmentInput
	if input.Name, err = requiredCRMDealString(fields, "name", 1, 120); err != nil {
		return MarketingCreateSegmentInput{}, err
	}
	if _, ok := fields["minSpendMinor"]; ok {
		if input.MinSpendMinor, err = requiredSafeInteger(fields, "minSpendMinor"); err != nil {
			return MarketingCreateSegmentInput{}, err
		}
		if input.MinSpendMinor < 0 {
			return MarketingCreateSegmentInput{}, errors.New("minSpendMinor must be at least 0")
		}
	}
	return input, nil
}

func ParseMarketingCreateCampaignInput(raw json.RawMessage) (MarketingCreateCampaignInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MarketingCreateCampaignInput{}, err
	}
	var input MarketingCreateCampaignInput
	if input.SegmentID, err = projectRequiredUUID(fields, "segmentId"); err != nil {
		return MarketingCreateCampaignInput{}, err
	}
	if input.Name, err = requiredCRMDealString(fields, "name", 1, 120); err != nil {
		return MarketingCreateCampaignInput{}, err
	}
	if input.Subject, err = requiredCRMDealString(fields, "subject", 1, 200); err != nil {
		return MarketingCreateCampaignInput{}, err
	}
	if input.Body, err = requiredCRMDealString(fields, "body", 1, 10000); err != nil {
		return MarketingCreateCampaignInput{}, err
	}
	return input, nil
}

func ParseMarketingSendCampaignInput(raw json.RawMessage) (MarketingSendCampaignInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MarketingSendCampaignInput{}, err
	}
	var input MarketingSendCampaignInput
	if input.CampaignID, err = projectRequiredUUID(fields, "campaignId"); err != nil {
		return MarketingSendCampaignInput{}, err
	}
	return input, nil
}

func ParseMarketingCampaignAnalyticsInput(raw json.RawMessage) (MarketingCampaignAnalyticsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MarketingCampaignAnalyticsInput{}, err
	}
	var input MarketingCampaignAnalyticsInput
	if input.CampaignID, err = projectRequiredUUID(fields, "campaignId"); err != nil {
		return MarketingCampaignAnalyticsInput{}, err
	}
	return input, nil
}

func parseMarketingCampaignInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case marketingCreateSegmentCapabilityID:
		return ParseMarketingCreateSegmentInput(raw)
	case marketingCreateCampaignCapabilityID:
		return ParseMarketingCreateCampaignInput(raw)
	case marketingSendCampaignCapabilityID:
		return ParseMarketingSendCampaignInput(raw)
	case marketingCampaignAnalyticsCapabilityID:
		return ParseMarketingCampaignAnalyticsInput(raw)
	default:
		return nil, errors.New("unsupported marketing capability")
	}
}

func marketingCreateSegment(ctx context.Context, tx pgx.Tx, orgID string, input MarketingCreateSegmentInput) (MarketingCreateSegmentOutput, error) {
	var segmentID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO marketing_segments (org_id, name, min_spend_minor)
		VALUES ($1::uuid, $2, $3)
		RETURNING id::text`, orgID, input.Name, input.MinSpendMinor).Scan(&segmentID); err != nil {
		return MarketingCreateSegmentOutput{}, err
	}
	return MarketingCreateSegmentOutput{SegmentID: segmentID}, nil
}

func marketingCreateCampaign(ctx context.Context, tx pgx.Tx, orgID string, input MarketingCreateCampaignInput) (MarketingCreateCampaignOutput, error) {
	var segmentID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM marketing_segments WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`, input.SegmentID, orgID).Scan(&segmentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return MarketingCreateCampaignOutput{}, errors.New("segment not found")
	}
	if err != nil {
		return MarketingCreateCampaignOutput{}, err
	}
	var campaignID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO marketing_campaigns (org_id, segment_id, name, subject, body)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		RETURNING id::text`, orgID, input.SegmentID, input.Name, input.Subject, input.Body).Scan(&campaignID); err != nil {
		return MarketingCreateCampaignOutput{}, err
	}
	return MarketingCreateCampaignOutput{CampaignID: campaignID}, nil
}

func marketingSendCampaign(ctx context.Context, tx pgx.Tx, orgID string, input MarketingSendCampaignInput, now time.Time) (MarketingSendCampaignOutput, error) {
	var campaignID, segmentID, subject, body string
	var sentAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT id::text, segment_id::text, subject, body, sent_at FROM marketing_campaigns WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`,
		input.CampaignID, orgID).Scan(&campaignID, &segmentID, &subject, &body, &sentAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return MarketingSendCampaignOutput{}, errors.New("campaign not found")
	}
	if err != nil {
		return MarketingSendCampaignOutput{}, err
	}
	if sentAt != nil {
		return MarketingSendCampaignOutput{}, errors.New("campaign already sent")
	}
	var minSpend int64
	err = tx.QueryRow(ctx, `
		SELECT min_spend_minor FROM marketing_segments WHERE id=$1::uuid LIMIT 1`, segmentID).Scan(&minSpend)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return MarketingSendCampaignOutput{}, err
	}

	type marketingMember struct {
		id       string
		email    *string
		optedOut bool
	}
	memberRows, err := tx.Query(ctx, `
		SELECT id::text, email, marketing_opt_out FROM customers WHERE org_id=$1::uuid AND deactivated_at IS NULL`, orgID)
	if err != nil {
		return MarketingSendCampaignOutput{}, err
	}
	var members []marketingMember
	for memberRows.Next() {
		var m marketingMember
		if err := memberRows.Scan(&m.id, &m.email, &m.optedOut); err != nil {
			memberRows.Close()
			return MarketingSendCampaignOutput{}, err
		}
		members = append(members, m)
	}
	memberRows.Close()

	spendRows, err := tx.Query(ctx, `
		SELECT customer_id::text, coalesce(sum(total_minor), 0) FROM invoices
		WHERE org_id=$1::uuid AND voided_at IS NULL GROUP BY customer_id`, orgID)
	if err != nil {
		return MarketingSendCampaignOutput{}, err
	}
	spendByCustomer := map[string]int64{}
	for spendRows.Next() {
		var customerID string
		var spend int64
		if err := spendRows.Scan(&customerID, &spend); err != nil {
			spendRows.Close()
			return MarketingSendCampaignOutput{}, err
		}
		spendByCustomer[customerID] = spend
	}
	spendRows.Close()

	digestJSON, err := json.Marshal(struct {
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}{Subject: subject, Body: body})
	if err != nil {
		return MarketingSendCampaignOutput{}, err
	}
	contentDigest := fmt.Sprintf("%x", sha256.Sum256(digestJSON))

	var out MarketingSendCampaignOutput
	for _, m := range members {
		if spendByCustomer[m.id] < minSpend {
			continue
		}
		if m.optedOut {
			out.SkippedOptOut++
			continue
		}
		var existingDelivery string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM marketing_deliveries WHERE campaign_id=$1::uuid AND customer_id=$2::uuid LIMIT 1`,
			campaignID, m.id).Scan(&existingDelivery)
		if err == nil {
			out.AlreadySent++
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return MarketingSendCampaignOutput{}, err
		}
		if m.email == nil || *m.email == "" {
			out.SkippedNoAddress++
			continue
		}
		payload, err := json.Marshal(struct {
			To         string `json:"to"`
			Subject    string `json:"subject"`
			Text       string `json:"text"`
			CustomerID string `json:"customerId"`
		}{To: *m.email, Subject: subject, Text: body, CustomerID: m.id})
		if err != nil {
			return MarketingSendCampaignOutput{}, err
		}
		providerOperationID, err := manufacturingNewRunRef()
		if err != nil {
			return MarketingSendCampaignOutput{}, err
		}
		dedupeKey := fmt.Sprintf("marketing:%s:%s", campaignID, m.id)
		var outboxID string
		err = tx.QueryRow(ctx, `
			INSERT INTO outbox_messages (org_id, kind, dedupe_key, provider_operation_id, payload)
			VALUES ($1::uuid, 'email', $2, $3, $4::jsonb)
			ON CONFLICT (org_id, dedupe_key) DO NOTHING
			RETURNING id::text`, orgID, dedupeKey, providerOperationID, string(payload)).Scan(&outboxID)
		if errors.Is(err, pgx.ErrNoRows) {
			var existingOutbox string
			err := tx.QueryRow(ctx, `
				SELECT id::text FROM outbox_messages WHERE org_id=$1::uuid AND dedupe_key=$2 LIMIT 1`,
				orgID, dedupeKey).Scan(&existingOutbox)
			if err != nil {
				return MarketingSendCampaignOutput{}, errors.New("campaign outbox dedupe conflict without an existing row")
			}
			out.AlreadySent++
			continue
		}
		if err != nil {
			return MarketingSendCampaignOutput{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO marketing_deliveries (org_id, campaign_id, customer_id, outbox_id, email_snapshot, content_digest, queued_at)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)`,
			orgID, campaignID, m.id, outboxID, *m.email, contentDigest, now); err != nil {
			return MarketingSendCampaignOutput{}, err
		}
		out.Recipients++
	}
	if _, err := tx.Exec(ctx, `
		UPDATE marketing_campaigns SET sent_at=$2 WHERE id=$1::uuid`, campaignID, now); err != nil {
		return MarketingSendCampaignOutput{}, err
	}
	return out, nil
}

func marketingCampaignAnalytics(ctx context.Context, tx pgx.Tx, orgID string, input MarketingCampaignAnalyticsInput) (MarketingCampaignAnalyticsOutput, error) {
	var campaignName string
	var sentAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT name, sent_at FROM marketing_campaigns WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`,
		input.CampaignID, orgID).Scan(&campaignName, &sentAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return MarketingCampaignAnalyticsOutput{}, errors.New("campaign not found")
	}
	if err != nil {
		return MarketingCampaignAnalyticsOutput{}, err
	}
	var sentCount int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM marketing_deliveries
		INNER JOIN outbox_messages ON outbox_messages.id = marketing_deliveries.outbox_id
		WHERE marketing_deliveries.campaign_id=$1::uuid AND outbox_messages.status='sent'`,
		input.CampaignID).Scan(&sentCount); err != nil {
		return MarketingCampaignAnalyticsOutput{}, err
	}
	out := MarketingCampaignAnalyticsOutput{CampaignName: campaignName, SentCount: sentCount}
	if sentAt != nil {
		queued := sentAt.UTC().Format("2006-01-02T15:04:05.000Z07:00")
		out.QueuedAt = &queued
	}
	return out, nil
}
