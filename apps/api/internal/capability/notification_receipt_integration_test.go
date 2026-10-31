package capability

import (
	"encoding/json"
	"testing"
)

func TestGoNotificationReadReceiptIsPerUserOrgScopedAndReversible(t *testing.T) {
	fx := newExecutorFixture(t)
	const notificationID = "66666666-6666-4666-8666-666666666666"
	otherUserID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Notification colleague')`, otherUserID, "notification-colleague-"+otherUserID[:8]+"@fixture.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM notifications WHERE user_id=$1::uuid`, otherUserID); err != nil {
			t.Errorf("delete private notification fixture: %v", err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM notification_reads WHERE user_id=$1::uuid`, otherUserID); err != nil {
			t.Errorf("delete notification fixture receipts: %v", err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `DELETE FROM users WHERE id=$1::uuid`, otherUserID); err != nil {
			t.Errorf("delete notification fixture user: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO notifications (id, org_id, user_id, kind, title, href)
		VALUES ($1::uuid, $2::uuid, NULL, 'fixture', 'Receipt test', NULL)`, notificationID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO notification_reads (org_id, notification_id, user_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid)`, fx.orgID, notificationID, otherUserID); err != nil {
		t.Fatal(err)
	}
	markInput := json.RawMessage(`{"id":"` + notificationID + `"}`)
	claims := fx.humanClaims(markInput, "notification-mark-1")
	claims.CapabilityID = notificationMarkReadCapabilityID
	result, err := fx.executor.Execute(fx.ctx, claims, notificationMarkReadCapabilityID, markInput)
	if err != nil || !result.OK {
		t.Fatalf("mark-read result=%+v err=%v", result, err)
	}
	var first notificationMarkReadOutput
	if err := json.Unmarshal(result.Data, &first); err != nil || !first.Found || !first.ReceiptCreated {
		t.Fatalf("first mark-read output=%+v err=%v", first, err)
	}
	claims.IntentID = "notification-mark-2"
	result, err = fx.executor.Execute(fx.ctx, claims, notificationMarkReadCapabilityID, markInput)
	if err != nil || !result.OK {
		t.Fatalf("repeated mark-read result=%+v err=%v", result, err)
	}
	var repeated notificationMarkReadOutput
	if err := json.Unmarshal(result.Data, &repeated); err != nil || !repeated.Found || repeated.ReceiptCreated {
		t.Fatalf("repeated mark-read output=%+v err=%v", repeated, err)
	}
	var actorReceipts, colleagueReceipts int
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM notification_reads WHERE org_id=$1::uuid AND notification_id=$2::uuid AND user_id=$3::uuid`, fx.orgID, notificationID, fx.userID).Scan(&actorReceipts); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM notification_reads WHERE org_id=$1::uuid AND notification_id=$2::uuid AND user_id=$3::uuid`, fx.orgID, notificationID, otherUserID).Scan(&colleagueReceipts); err != nil {
		t.Fatal(err)
	}
	if actorReceipts != 1 || colleagueReceipts != 1 {
		t.Fatalf("receipt counts actor=%d colleague=%d, want one each", actorReceipts, colleagueReceipts)
	}
	var notificationReadAt *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT read_at::text FROM notifications WHERE id=$1::uuid`, notificationID).Scan(&notificationReadAt); err != nil {
		t.Fatal(err)
	}
	if notificationReadAt != nil {
		t.Fatalf("mark-read changed shared notification read_at to %q", *notificationReadAt)
	}

	restoreInput := json.RawMessage(`{"id":"` + notificationID + `","receiptCreated":true}`)
	restoreClaims := fx.humanClaims(restoreInput, "notification-restore-1")
	restoreClaims.CapabilityID = notificationRestoreReadCapabilityID
	result, err = fx.executor.Execute(fx.ctx, restoreClaims, notificationRestoreReadCapabilityID, restoreInput)
	if err != nil || !result.OK {
		t.Fatalf("restore result=%+v err=%v", result, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM notification_reads WHERE org_id=$1::uuid AND notification_id=$2::uuid AND user_id=$3::uuid`, fx.orgID, notificationID, fx.userID).Scan(&actorReceipts); err != nil {
		t.Fatal(err)
	}
	if actorReceipts != 0 {
		t.Fatalf("inverse left %d actor receipts", actorReceipts)
	}
	noOpRestoreClaims := fx.humanClaims(restoreInput, "notification-restore-noop")
	noOpRestoreClaims.CapabilityID = notificationRestoreReadCapabilityID
	result, err = fx.executor.Execute(fx.ctx, noOpRestoreClaims, notificationRestoreReadCapabilityID, restoreInput)
	if err != nil || !result.OK {
		t.Fatalf("no-op restore result=%+v err=%v", result, err)
	}
	var noOpRestore notificationRestoreReadOutput
	if err := json.Unmarshal(result.Data, &noOpRestore); err != nil || noOpRestore.ID != notificationID || noOpRestore.Restored {
		t.Fatalf("no-op restore output=%+v err=%v", noOpRestore, err)
	}
	markNoOpInput := json.RawMessage(`{"id":"` + notificationID + `","restored":false}`)
	markNoOpClaims := fx.humanClaims(markNoOpInput, "notification-mark-noop-inverse")
	markNoOpClaims.CapabilityID = notificationMarkReadCapabilityID
	result, err = fx.executor.Execute(fx.ctx, markNoOpClaims, notificationMarkReadCapabilityID, markNoOpInput)
	if err != nil || !result.OK {
		t.Fatalf("no-op mark inverse result=%+v err=%v", result, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM notification_reads WHERE org_id=$1::uuid AND notification_id=$2::uuid AND user_id=$3::uuid`, fx.orgID, notificationID, fx.userID).Scan(&actorReceipts); err != nil {
		t.Fatal(err)
	}
	if actorReceipts != 0 {
		t.Fatalf("no-op restore inverse created %d actor receipts", actorReceipts)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM notification_reads WHERE org_id=$1::uuid AND notification_id=$2::uuid AND user_id=$3::uuid`, fx.orgID, notificationID, otherUserID).Scan(&colleagueReceipts); err != nil {
		t.Fatal(err)
	}
	if colleagueReceipts != 1 {
		t.Fatalf("inverse changed colleague receipt count to %d", colleagueReceipts)
	}

	missingInput := json.RawMessage(`{"id":"77777777-7777-4777-8777-777777777777"}`)
	missingClaims := fx.humanClaims(missingInput, "notification-mark-missing")
	missingClaims.CapabilityID = notificationMarkReadCapabilityID
	result, err = fx.executor.Execute(fx.ctx, missingClaims, notificationMarkReadCapabilityID, missingInput)
	if err != nil || !result.OK {
		t.Fatalf("missing notification result=%+v err=%v", result, err)
	}
	var missing notificationMarkReadOutput
	if err := json.Unmarshal(result.Data, &missing); err != nil || missing.Found {
		t.Fatalf("missing notification output=%+v err=%v", missing, err)
	}

	const colleagueNotificationID = "88888888-8888-4888-8888-888888888888"
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO notifications (id, org_id, user_id, kind, title, href)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'fixture', 'Private notification', NULL)`, colleagueNotificationID, fx.orgID, otherUserID); err != nil {
		t.Fatal(err)
	}
	privateInput := json.RawMessage(`{"id":"` + colleagueNotificationID + `"}`)
	privateClaims := fx.humanClaims(privateInput, "notification-mark-private")
	privateClaims.CapabilityID = notificationMarkReadCapabilityID
	result, err = fx.executor.Execute(fx.ctx, privateClaims, notificationMarkReadCapabilityID, privateInput)
	if err != nil || !result.OK {
		t.Fatalf("private notification result=%+v err=%v", result, err)
	}
	var private notificationMarkReadOutput
	if err := json.Unmarshal(result.Data, &private); err != nil || private.Found {
		t.Fatalf("private notification output=%+v err=%v", private, err)
	}

	const foreignNotificationID = "99999999-9999-4999-8999-999999999999"
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO notifications (id, org_id, user_id, kind, title, href)
		VALUES ($1::uuid, $2::uuid, NULL, 'fixture', 'Foreign notification', NULL)`, foreignNotificationID, fx.otherOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO notification_reads (org_id, notification_id, user_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid)`, fx.otherOrgID, foreignNotificationID, fx.userID); err != nil {
		t.Fatal(err)
	}
	foreignInput := json.RawMessage(`{"id":"` + foreignNotificationID + `"}`)
	foreignClaims := fx.humanClaims(foreignInput, "notification-mark-foreign")
	foreignClaims.CapabilityID = notificationMarkReadCapabilityID
	result, err = fx.executor.Execute(fx.ctx, foreignClaims, notificationMarkReadCapabilityID, foreignInput)
	if err != nil || !result.OK {
		t.Fatalf("foreign notification result=%+v err=%v", result, err)
	}
	var foreign notificationMarkReadOutput
	if err := json.Unmarshal(result.Data, &foreign); err != nil || foreign.Found {
		t.Fatalf("foreign notification output=%+v err=%v", foreign, err)
	}
	var foreignReceipts int
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM notification_reads WHERE org_id=$1::uuid AND notification_id=$2::uuid AND user_id=$3::uuid`, fx.otherOrgID, foreignNotificationID, fx.userID).Scan(&foreignReceipts); err != nil {
		t.Fatal(err)
	}
	if foreignReceipts != 1 {
		t.Fatalf("cross-organization request changed foreign receipt count to %d", foreignReceipts)
	}
}
