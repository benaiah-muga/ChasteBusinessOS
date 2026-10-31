package capability

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestNotificationReceiptCapabilitySpecsDeclareCompensation(t *testing.T) {
	specs := NotificationReceiptCapabilitySpecs()
	mark, ok := specs[notificationMarkReadCapabilityID]
	if !ok || mark.Module != "notifications" || mark.Permission != "notifications.read" || mark.Risk != "write" ||
		mark.InverseCapabilityID != notificationRestoreReadCapabilityID || mark.InverseInputSource != "output" ||
		!reflect.DeepEqual(mark.InverseFields, []string{"id", "receiptCreated"}) {
		t.Fatalf("mark-read spec = %+v", mark)
	}
	if _, ok := specs[mark.InverseCapabilityID]; !ok {
		t.Fatalf("inverse capability %q is not registered", mark.InverseCapabilityID)
	}
	restore := specs[notificationRestoreReadCapabilityID]
	if restore.Risk != "write" || restore.InverseCapabilityID != notificationMarkReadCapabilityID ||
		restore.InverseInputSource != "output" || !reflect.DeepEqual(restore.InverseFields, []string{"id", "restored"}) {
		t.Fatalf("restore-read spec = %+v", restore)
	}
	if !supportedCapability(notificationMarkReadCapabilityID) || !supportedCapability(notificationRestoreReadCapabilityID) {
		t.Fatal("notification receipt capability missing from executor support registry")
	}
}

func TestParseNotificationReceiptInputIsStrict(t *testing.T) {
	const id = "44444444-4444-4444-8444-444444444444"
	parsed, err := parseNotificationReceiptInput(notificationMarkReadCapabilityID, json.RawMessage(`{"id":"`+id+`"}`))
	if err != nil || parsed != (notificationReceiptInput{ID: id}) {
		t.Fatalf("parsed input=%#v err=%v", parsed, err)
	}
	for _, raw := range []string{
		`{"id":"not-a-uuid"}`,
		`{"id":"` + id + `","userId":"11111111-1111-4111-8111-111111111111"}`,
		`{"id":"` + id + `","restored":"false"}`,
		`[]`,
	} {
		if _, err := parseNotificationReceiptInput(notificationMarkReadCapabilityID, json.RawMessage(raw)); err == nil {
			t.Errorf("accepted unsupported input %s", raw)
		}
	}
	parsed, err = parseNotificationReceiptInput(notificationMarkReadCapabilityID, json.RawMessage(`{"id":"`+id+`","restored":false}`))
	if err != nil || parsed.(notificationReceiptInput).Restored == nil || *parsed.(notificationReceiptInput).Restored {
		t.Fatalf("parsed inverse input=%#v err=%v", parsed, err)
	}
}
