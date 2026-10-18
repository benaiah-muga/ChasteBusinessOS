package signals

import (
	"context"
	"fmt"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type inventoryItemRow struct {
	id           string
	sku          string
	name         string
	reorderPoint int64
	createdAt    time.Time
}

type reorderDraftLine struct {
	Description string `json:"description"`
	Quantity    int64  `json:"quantity"`
}

type reorderDraft struct {
	Memo  string             `json:"memo"`
	Lines []reorderDraftLine `json:"lines"`
}

// NewInventoryProducer ports modules/inventory/src/signals.ts: reorder
// pressure, dead stock, and anomalous adjustments over the append-only stock
// ledger.
func NewInventoryProducer(pool *pgxpool.Pool) capability.SignalProducer {
	return func(ctx context.Context, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
		return dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) ([]capability.BusinessSignal, error) {
			return inventorySignals(ctx, tx, orgID, now)
		})
	}
}

func inventorySignals(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
	itemRows, err := tx.Query(ctx, `
		SELECT id::text, sku, name, reorder_point_thousandths, created_at
		FROM items
		WHERE org_id = $1::uuid AND archived_at IS NULL
		ORDER BY id ASC
		LIMIT 200`, orgID)
	if err != nil {
		return nil, err
	}
	var items []inventoryItemRow
	for itemRows.Next() {
		var item inventoryItemRow
		if err := itemRows.Scan(&item.id, &item.sku, &item.name, &item.reorderPoint, &item.createdAt); err != nil {
			itemRows.Close()
			return nil, err
		}
		items = append(items, item)
	}
	if err := itemRows.Err(); err != nil {
		itemRows.Close()
		return nil, err
	}
	itemRows.Close()
	if len(items) == 0 {
		return nil, nil
	}

	onHand := make(map[string]int64, len(items))
	onHandRows, err := tx.Query(ctx, `
		SELECT item_id::text, COALESCE(SUM(quantity_delta), 0)
		FROM stock_movements
		WHERE org_id = $1::uuid
		GROUP BY item_id`, orgID)
	if err != nil {
		return nil, err
	}
	for onHandRows.Next() {
		var itemID string
		var quantity int64
		if err := onHandRows.Scan(&itemID, &quantity); err != nil {
			onHandRows.Close()
			return nil, err
		}
		onHand[itemID] = quantity
	}
	if err := onHandRows.Err(); err != nil {
		onHandRows.Close()
		return nil, err
	}
	onHandRows.Close()

	lastOutbound := make(map[string]time.Time, len(items))
	lastOutboundRows, err := tx.Query(ctx, `
		SELECT item_id::text, MAX(created_at)
		FROM stock_movements
		WHERE org_id = $1::uuid AND quantity_delta < 0
		GROUP BY item_id`, orgID)
	if err != nil {
		return nil, err
	}
	for lastOutboundRows.Next() {
		var itemID string
		var movedAt time.Time
		if err := lastOutboundRows.Scan(&itemID, &movedAt); err != nil {
			lastOutboundRows.Close()
			return nil, err
		}
		lastOutbound[itemID] = movedAt
	}
	if err := lastOutboundRows.Err(); err != nil {
		lastOutboundRows.Close()
		return nil, err
	}
	lastOutboundRows.Close()

	signals := make([]capability.BusinessSignal, 0, len(items))
	names := make(map[string]string, len(items))
	for _, item := range items {
		names[item.id] = item.name
		hand := onHand[item.id]
		if needsReorder(hand, item.reorderPoint) {
			signals = append(signals, capability.BusinessSignal{
				ID:       "inventory.reorder:" + item.sku,
				Severity: "orange",
				Module:   "inventory",
				Subject:  item.name + " is at or below its reorder point",
				Detail:   formatThousandths(hand) + " on hand against a reorder point of " + formatThousandths(item.reorderPoint) + ".",
				Evidence: evidence("item", item.id),
				SuggestedAction: suggestedAction("purchasing.createPurchaseOrder", reorderDraft{
					Memo: "Replenish " + item.sku,
					Lines: []reorderDraftLine{{
						Description: item.sku + " replenishment",
						Quantity:    maxInt64(item.reorderPoint-hand, 0),
					}},
				}),
			})
		}

		movedAt := item.createdAt
		if last, ok := lastOutbound[item.id]; ok {
			movedAt = last
		}
		days := ageDays(now.Sub(movedAt))
		if hand > 0 && days >= deadStockDays {
			signals = append(signals, capability.BusinessSignal{
				ID:       "inventory.dead-stock:" + item.sku,
				Severity: "orange",
				Module:   "inventory",
				Subject:  fmt.Sprintf("%s has not moved in %d days", item.name, days),
				Detail:   fmt.Sprintf("%s on hand with no outbound movement since %d months - cash sitting on a shelf.", formatThousandths(hand), days/30),
				Evidence: evidence("item", item.id),
			})
		}
	}

	adjustmentRows, err := tx.Query(ctx, `
		SELECT id::text, item_id::text, quantity_delta
		FROM stock_movements
		WHERE org_id = $1::uuid AND reason = 'adjustment'
		ORDER BY created_at DESC
		LIMIT 50`, orgID)
	if err != nil {
		return nil, err
	}
	defer adjustmentRows.Close()
	for adjustmentRows.Next() {
		var movementID, itemID string
		var delta int64
		if err := adjustmentRows.Scan(&movementID, &itemID, &delta); err != nil {
			return nil, err
		}
		hand := onHand[itemID]
		if hand > 0 && 2*absInt64(delta) > hand {
			name, known := names[itemID]
			if !known {
				name = "an item"
			}
			signals = append(signals, capability.BusinessSignal{
				ID:       "inventory.anomalous-adjustment:" + movementID,
				Severity: "red",
				Module:   "inventory",
				Subject:  fmt.Sprintf("Unusual adjustment on %s", name),
				Detail:   fmt.Sprintf("A single adjustment of %s is more than half the current on-hand (%s) - worth a look.", formatThousandths(delta), formatThousandths(hand)),
				Evidence: evidence("stock_movement", movementID),
			})
		}
	}
	if err := adjustmentRows.Err(); err != nil {
		return nil, err
	}

	return signals, nil
}
