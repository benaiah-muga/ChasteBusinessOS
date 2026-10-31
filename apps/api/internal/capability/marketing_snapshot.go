package capability

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func marketingOverviewSnapshot(ctx context.Context, tx pgx.Tx, orgID string) (MarketingOverviewSnapshotOutput, error) {
	out := MarketingOverviewSnapshotOutput{
		Segments:    make([]MarketingOverviewSegment, 0),
		Campaigns:   make([]MarketingOverviewCampaign, 0),
		SendCounts:  make([]MarketingOverviewSendCount, 0),
		RecentSends: make([]MarketingOverviewRecentSend, 0),
	}

	segmentRows, err := tx.Query(ctx, `
		SELECT id::text, name, min_spend_minor, created_at
		FROM marketing_segments
		WHERE org_id=$1::uuid
		ORDER BY created_at DESC
		LIMIT 100`, orgID)
	if err != nil {
		return MarketingOverviewSnapshotOutput{}, err
	}
	for segmentRows.Next() {
		var row MarketingOverviewSegment
		var createdAt time.Time
		if err := segmentRows.Scan(&row.ID, &row.Name, &row.MinSpendMinor, &createdAt); err != nil {
			segmentRows.Close()
			return MarketingOverviewSnapshotOutput{}, err
		}
		row.CreatedAt = marketingSnapshotInstant(createdAt)
		out.Segments = append(out.Segments, row)
	}
	if err := segmentRows.Err(); err != nil {
		segmentRows.Close()
		return MarketingOverviewSnapshotOutput{}, err
	}
	segmentRows.Close()

	campaignRows, err := tx.Query(ctx, `
		SELECT id::text, segment_id::text, name, subject, body, sent_at, created_at
		FROM marketing_campaigns
		WHERE org_id=$1::uuid
		ORDER BY created_at DESC
		LIMIT 100`, orgID)
	if err != nil {
		return MarketingOverviewSnapshotOutput{}, err
	}
	for campaignRows.Next() {
		var row MarketingOverviewCampaign
		var queuedAt *time.Time
		var createdAt time.Time
		if err := campaignRows.Scan(&row.ID, &row.SegmentID, &row.Name, &row.Subject, &row.Body, &queuedAt, &createdAt); err != nil {
			campaignRows.Close()
			return MarketingOverviewSnapshotOutput{}, err
		}
		row.QueuedAt = marketingSnapshotNullableInstant(queuedAt)
		row.CreatedAt = marketingSnapshotInstant(createdAt)
		out.Campaigns = append(out.Campaigns, row)
	}
	if err := campaignRows.Err(); err != nil {
		campaignRows.Close()
		return MarketingOverviewSnapshotOutput{}, err
	}
	campaignRows.Close()

	countRows, err := tx.Query(ctx, `
		SELECT d.campaign_id::text, count(*)
		FROM marketing_deliveries d
		INNER JOIN outbox_messages o ON o.id=d.outbox_id AND o.org_id=d.org_id
		WHERE d.org_id=$1::uuid AND o.status='sent'
		GROUP BY d.campaign_id`, orgID)
	if err != nil {
		return MarketingOverviewSnapshotOutput{}, err
	}
	for countRows.Next() {
		var row MarketingOverviewSendCount
		if err := countRows.Scan(&row.CampaignID, &row.Count); err != nil {
			countRows.Close()
			return MarketingOverviewSnapshotOutput{}, err
		}
		if row.Count < 0 || row.Count > 1<<53-1 {
			countRows.Close()
			return MarketingOverviewSnapshotOutput{}, errors.New("marketing send count exceeds the safe response range")
		}
		out.SendCounts = append(out.SendCounts, row)
	}
	if err := countRows.Err(); err != nil {
		countRows.Close()
		return MarketingOverviewSnapshotOutput{}, err
	}
	countRows.Close()

	recentRows, err := tx.Query(ctx, `
		SELECT d.id::text, d.campaign_id::text, c.name, c.email, d.queued_at, o.status, o.completed_at
		FROM marketing_deliveries d
		INNER JOIN customers c ON c.id=d.customer_id AND c.org_id=d.org_id
		INNER JOIN outbox_messages o ON o.id=d.outbox_id AND o.org_id=d.org_id
		WHERE d.org_id=$1::uuid
		ORDER BY d.queued_at DESC
		LIMIT 50`, orgID)
	if err != nil {
		return MarketingOverviewSnapshotOutput{}, err
	}
	for recentRows.Next() {
		var row MarketingOverviewRecentSend
		var queuedAt time.Time
		var sentAt *time.Time
		if err := recentRows.Scan(&row.ID, &row.CampaignID, &row.CustomerName, &row.CustomerEmail, &queuedAt, &row.Status, &sentAt); err != nil {
			recentRows.Close()
			return MarketingOverviewSnapshotOutput{}, err
		}
		row.QueuedAt = marketingSnapshotInstant(queuedAt)
		row.SentAt = marketingSnapshotNullableInstant(sentAt)
		out.RecentSends = append(out.RecentSends, row)
	}
	if err := recentRows.Err(); err != nil {
		recentRows.Close()
		return MarketingOverviewSnapshotOutput{}, err
	}
	recentRows.Close()

	return out, nil
}

func marketingSnapshotInstant(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func marketingSnapshotNullableInstant(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := marketingSnapshotInstant(*value)
	return &formatted
}
