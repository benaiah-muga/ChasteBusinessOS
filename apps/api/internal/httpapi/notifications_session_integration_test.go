package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPgNotificationsSessionReaderScopesVisibilityReceiptsAndUnreadCount(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("GO_DATABASE_URL or DATABASE_URL is required for notifications integration coverage")
		}
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed notifications integration fixtures")
		}
		t.Skip("DATABASE_URL is required to seed notifications integration fixtures")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtimeConfig, err := pgxpool.ParseConfig(runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	runtimeConfig.MaxConns = 1
	runtime, err := pgxpool.NewWithConfig(ctx, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	orgID := notificationsFixtureUUID(t)
	otherOrgID := notificationsFixtureUUID(t)
	userID := notificationsFixtureUUID(t)
	otherUserID := notificationsFixtureUUID(t)
	broadcastUnreadID := notificationsFixtureUUID(t)
	broadcastReceiptID := notificationsFixtureUUID(t)
	userNotificationID := notificationsFixtureUUID(t)
	otherUserNotificationID := notificationsFixtureUUID(t)
	otherOrgNotificationID := notificationsFixtureUUID(t)

	_, err = owner.Exec(ctx, `
		INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go notifications fixture', $2),
		($3::uuid, 'Go notifications other fixture', $4)`,
		orgID, "go-notifications-"+orgID[:8], otherOrgID, "go-notifications-other-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete notifications fixture organizations: %v", err)
		}
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM users WHERE id IN ($1::uuid, $2::uuid)`, userID, otherUserID); err != nil {
			t.Errorf("delete notifications fixture users: %v", err)
		}
	})

	for i, id := range []string{userID, otherUserID} {
		if _, err := owner.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, $3)`, id,
			fmt.Sprintf("go-notifications-%s@fixture.test", id[:8]), fmt.Sprintf("Notifications user %d", i+1)); err != nil {
			t.Fatal(err)
		}
	}

	base := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	for _, fixture := range []struct {
		id, orgID string
		userID    *string
		kind      string
		title     string
		createdAt time.Time
		readAt    *time.Time
	}{
		{id: broadcastUnreadID, orgID: orgID, kind: "system", title: "Latest broadcast", createdAt: base.Add(30 * time.Minute), readAt: timePointer(base.Add(31 * time.Minute))},
		{id: broadcastReceiptID, orgID: orgID, kind: "system", title: "Broadcast with user receipt", createdAt: base.Add(20 * time.Minute)},
		{id: userNotificationID, orgID: orgID, userID: &userID, kind: "system", title: "Current user notification", createdAt: base.Add(10 * time.Minute)},
		{id: otherUserNotificationID, orgID: orgID, userID: &otherUserID, kind: "system", title: "Other user secret", createdAt: base.Add(40 * time.Minute)},
		{id: otherOrgNotificationID, orgID: otherOrgID, kind: "system", title: "Other organization secret", createdAt: base.Add(50 * time.Minute)},
	} {
		if _, err := owner.Exec(ctx, `
			INSERT INTO notifications (id, org_id, user_id, kind, title, read_at, created_at)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
			fixture.id, fixture.orgID, fixture.userID, fixture.kind, fixture.title, fixture.readAt, fixture.createdAt); err != nil {
			t.Fatal(err)
		}
	}
	receiptAt := base.Add(21 * time.Minute)
	if _, err := owner.Exec(ctx, `
		INSERT INTO notification_reads (org_id, notification_id, user_id, read_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`, orgID, broadcastReceiptID, userID, receiptAt); err != nil {
		t.Fatal(err)
	}

	reader := pgNotificationsSessionReader{pool: runtime}
	rows, unread, err := reader.ForUser(ctx, orgID, userID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if unread != 2 {
		t.Fatalf("user unread count=%d, want 2 unread among all visible notifications", unread)
	}
	if len(rows) != 2 || rows[0].ID != broadcastUnreadID || rows[1].ID != broadcastReceiptID {
		t.Fatalf("limited notifications were not newest first or leaked a hidden row: %+v", rows)
	}
	if rows[0].ReadAt != nil {
		t.Fatalf("broadcast row inherited its shared read_at instead of user receipt state: %v", rows[0].ReadAt)
	}
	if rows[1].ReadAt == nil || !rows[1].ReadAt.Equal(receiptAt) {
		t.Fatalf("user receipt read_at=%v, want %v", rows[1].ReadAt, receiptAt)
	}

	otherRows, otherUnread, err := reader.ForUser(ctx, orgID, otherUserID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if otherUnread != 3 {
		t.Fatalf("other user unread count=%d, want 3; the first user's receipt must not apply", otherUnread)
	}
	if len(otherRows) != 3 || otherRows[0].ID != otherUserNotificationID || otherRows[1].ID != broadcastUnreadID || otherRows[2].ID != broadcastReceiptID {
		t.Fatalf("other user's visible notifications or ordering are wrong: %+v", otherRows)
	}
	if otherRows[2].ReadAt != nil {
		t.Fatalf("another user's broadcast receipt leaked: %v", otherRows[2].ReadAt)
	}

	var orgSetting string
	if err := runtime.QueryRow(ctx, `SELECT current_setting('app.org_id', true)`).Scan(&orgSetting); err != nil {
		t.Fatal(err)
	}
	if orgSetting != "" {
		t.Fatalf("reader leaked app.org_id outside its transaction: %q", orgSetting)
	}
	visibleRows, err := dbx.WithOrgTx(ctx, runtime, orgID, func(tx pgx.Tx) (int, error) {
		var count int
		err := tx.QueryRow(ctx, `SELECT count(*)::integer FROM notifications`).Scan(&count)
		return count, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if visibleRows != 4 {
		t.Fatalf("runtime role saw %d notifications with org scope set, want only the 4 rows from that organization", visibleRows)
	}
}

func notificationsFixtureUUID(t *testing.T) string {
	t.Helper()
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		t.Fatal(err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
}

func timePointer(value time.Time) *time.Time { return &value }
