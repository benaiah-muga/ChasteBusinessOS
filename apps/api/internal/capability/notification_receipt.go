package capability

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

const (
	notificationMarkReadCapabilityID    = "notifications.markRead"
	notificationRestoreReadCapabilityID = "notifications.restoreRead"
)

type NotificationReceiptCapabilitySpec struct {
	Module              string
	Permission          string
	Risk                string
	InverseCapabilityID string
	InverseInputSource  string
	InverseFields       []string
}

func NotificationReceiptCapabilitySpecs() map[string]NotificationReceiptCapabilitySpec {
	return map[string]NotificationReceiptCapabilitySpec{
		notificationMarkReadCapabilityID: {
			Module: "notifications", Permission: "notifications.read", Risk: "write",
			InverseCapabilityID: notificationRestoreReadCapabilityID,
			InverseInputSource:  "output", InverseFields: []string{"id", "receiptCreated"},
		},
		notificationRestoreReadCapabilityID: {
			Module: "notifications", Permission: "notifications.read", Risk: "write",
			InverseCapabilityID: notificationMarkReadCapabilityID,
			InverseInputSource:  "output", InverseFields: []string{"id", "restored"},
		},
	}
}

type notificationReceiptInput struct {
	ID       string `json:"id"`
	Restored *bool  `json:"restored,omitempty"`
}

type notificationRestoreReceiptInput struct {
	ID             string `json:"id"`
	ReceiptCreated bool   `json:"receiptCreated"`
}

type notificationMarkReadOutput struct {
	ID             string `json:"id"`
	ReceiptCreated bool   `json:"receiptCreated"`
	Found          bool   `json:"found"`
}

type notificationRestoreReadOutput struct {
	ID       string `json:"id"`
	Restored bool   `json:"restored"`
}

func parseNotificationReceiptInput(capabilityID string, raw json.RawMessage) (any, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, errors.New("expected an object")
	}
	switch capabilityID {
	case notificationMarkReadCapabilityID:
		var input notificationReceiptInput
		if (len(fields) != 1 && len(fields) != 2) || fields["id"] == nil ||
			(len(fields) == 2 && fields["restored"] == nil) || json.Unmarshal(fields["id"], &input.ID) != nil {
			return nil, errors.New("id is required")
		}
		if fields["restored"] != nil {
			var restored bool
			if json.Unmarshal(fields["restored"], &restored) != nil {
				return nil, errors.New("restored must be a boolean")
			}
			input.Restored = &restored
		}
		if !isUUID(input.ID) {
			return nil, errors.New("id must be a UUID")
		}
		return input, nil
	case notificationRestoreReadCapabilityID:
		var input notificationRestoreReceiptInput
		if len(fields) != 2 || fields["id"] == nil || fields["receiptCreated"] == nil ||
			json.Unmarshal(fields["id"], &input.ID) != nil || json.Unmarshal(fields["receiptCreated"], &input.ReceiptCreated) != nil {
			return nil, errors.New("id and receiptCreated are required")
		}
		if !isUUID(input.ID) {
			return nil, errors.New("id must be a UUID")
		}
		return input, nil
	default:
		return nil, errors.New("unknown notification receipt capability")
	}
}

func markNotificationRead(ctx context.Context, tx pgx.Tx, orgID, userID string, input notificationReceiptInput) (notificationMarkReadOutput, error) {
	var exists bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM notifications
			WHERE id = $1::uuid AND org_id = $2::uuid
			  AND (user_id IS NULL OR user_id = $3::uuid)
		)`, input.ID, orgID, userID).Scan(&exists)
	if err != nil {
		return notificationMarkReadOutput{}, err
	}
	if !exists {
		return notificationMarkReadOutput{ID: input.ID}, nil
	}
	if input.Restored != nil && !*input.Restored {
		return notificationMarkReadOutput{ID: input.ID, Found: true}, nil
	}
	var created bool
	err = tx.QueryRow(ctx, `
		INSERT INTO notification_reads (org_id, notification_id, user_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid)
		ON CONFLICT (notification_id, user_id) DO NOTHING
		RETURNING true`, orgID, input.ID, userID).Scan(&created)
	if errors.Is(err, pgx.ErrNoRows) {
		created, err = false, nil
	}
	if err != nil {
		return notificationMarkReadOutput{}, err
	}
	return notificationMarkReadOutput{ID: input.ID, ReceiptCreated: created, Found: true}, nil
}

func restoreNotificationRead(ctx context.Context, tx pgx.Tx, orgID, userID string, input notificationRestoreReceiptInput) (notificationRestoreReadOutput, error) {
	if !input.ReceiptCreated {
		return notificationRestoreReadOutput{ID: input.ID}, nil
	}
	command, err := tx.Exec(ctx, `
		DELETE FROM notification_reads nr
		WHERE nr.org_id = $1::uuid AND nr.notification_id = $2::uuid AND nr.user_id = $3::uuid
		  AND EXISTS (
			SELECT 1 FROM notifications n
			WHERE n.id = nr.notification_id AND n.org_id = nr.org_id
			  AND (n.user_id IS NULL OR n.user_id = nr.user_id)
		  )`, orgID, input.ID, userID)
	if err != nil {
		return notificationRestoreReadOutput{}, err
	}
	return notificationRestoreReadOutput{ID: input.ID, Restored: command.RowsAffected() == 1}, nil
}
