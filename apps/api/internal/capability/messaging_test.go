package capability

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestMessagingCapabilitySpecsMatchTheMigrationManifest(t *testing.T) {
	want := map[string]MessagingCapabilitySpec{
		messagingSendMessageCapabilityID:             {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingDeleteMessageCapabilityID, InverseInputSource: "output", InverseFields: []string{"messageId"}},
		messagingListConversationsCapabilityID:       {Module: "messaging", Permission: "messaging.read", Risk: "read"},
		messagingReadMessagesCapabilityID:            {Module: "messaging", Permission: "messaging.read", Risk: "read"},
		messagingListPeopleCapabilityID:              {Module: "messaging", Permission: "messaging.read", Risk: "read"},
		messagingCreateConversationCapabilityID:      {Module: "messaging", Permission: "messaging.write", Risk: "write"},
		messagingUpdateConversationCapabilityID:      {Module: "messaging", Permission: "messaging.write", Risk: "write"},
		messagingArchiveConversationCapabilityID:     {Module: "messaging", Permission: "messaging.write", Risk: "write"},
		messagingDeleteConversationCapabilityID:      {Module: "messaging", Permission: "messaging.write", Risk: "destructive"},
		messagingLeaveConversationCapabilityID:       {Module: "messaging", Permission: "messaging.write", Risk: "write"},
		messagingAddMemberCapabilityID:               {Module: "messaging", Permission: "messaging.write", Risk: "write"},
		messagingEditMessageCapabilityID:             {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingRestoreMessageEditCapabilityID, InverseInputSource: "output", InverseFields: []string{"messageId", "body", "expectedBody", "expectedEditedAt"}},
		messagingRestoreMessageEditCapabilityID:      {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingEditMessageCapabilityID, InverseInputSource: "output", InverseFields: []string{"messageId", "body", "expectedBody", "expectedEditedAt"}},
		messagingDeleteMessageCapabilityID:           {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingRestoreMessageDeleteCapabilityID, InverseInputSource: "output", InverseFields: []string{"messageId", "deletedAt", "expectedDeletedAt"}},
		messagingRestoreMessageDeleteCapabilityID:    {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingDeleteMessageCapabilityID, InverseInputSource: "output", InverseFields: []string{"messageId", "expectedDeletedAt"}},
		messagingAdvanceReadCursorCapabilityID:       {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingRestoreReadCursorCapabilityID, InverseInputSource: "output", InverseFields: []string{"conversationId", "previousReadAt"}},
		messagingRestoreReadCursorCapabilityID:       {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingAdvanceReadCursorCapabilityID, InverseInputSource: "output", InverseFields: []string{"conversationId", "previousReadAt"}},
		messagingSetMessageReactionCapabilityID:      {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingRestoreMessageReactionCapabilityID, InverseInputSource: "input", InverseFields: []string{"messageId", "emoji"}},
		messagingRestoreMessageReactionCapabilityID:  {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingSetMessageReactionCapabilityID, InverseInputSource: "output", InverseFields: []string{"previousActive"}},
		messagingSetMessagePinCapabilityID:           {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingRestoreMessagePinCapabilityID, InverseInputSource: "output", InverseFields: []string{"messageId"}},
		messagingRestoreMessagePinCapabilityID:       {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingSetMessagePinCapabilityID, InverseInputSource: "output", InverseFields: []string{"messageId"}},
		messagingUpdatePresenceCapabilityID:          {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingRestorePresenceCapabilityID, InverseInputSource: "input", InverseFields: []string{"conversationId"}},
		messagingRestorePresenceCapabilityID:         {Module: "messaging", Permission: "messaging.write", Risk: "write", InverseCapabilityID: messagingUpdatePresenceCapabilityID, InverseInputSource: "output", InverseFields: []string{"previousLastSeenAt", "previousTypingUntil"}},
		messagingUploadAttachmentCapabilityID:        {Module: "messaging", Permission: "messaging.write", Risk: "secret", InverseCapabilityID: messagingDeletePendingAttachmentCapabilityID, InverseInputSource: "output", InverseFields: []string{"attachmentId"}},
		messagingDeletePendingAttachmentCapabilityID: {Module: "messaging", Permission: "messaging.write", Risk: "secret"},
	}
	if len(messagingCapabilitySpecs) != len(want) {
		t.Fatalf("messaging spec count=%d, want %d", len(messagingCapabilitySpecs), len(want))
	}
	for id, expected := range want {
		spec, ok := messagingCapabilitySpecs[id]
		if !ok {
			t.Errorf("messaging capability %s is missing from the module spec table", id)
			continue
		}
		if spec.Module != expected.Module || spec.Permission != expected.Permission ||
			spec.Risk != expected.Risk || spec.MoneyThresholdMinor != 0 || spec.InverseCapabilityID != expected.InverseCapabilityID ||
			spec.InverseInputSource != expected.InverseInputSource || !reflect.DeepEqual(spec.InverseFields, expected.InverseFields) {
			t.Errorf("messaging spec %s = %+v, want module=%s permission=%s risk=%s inverse=%q",
				id, spec, expected.Module, expected.Permission, expected.Risk, expected.InverseCapabilityID)
		}
		if !strings.HasPrefix(id, "messaging.") {
			t.Errorf("capability id %q is not a module.action id", id)
		}
	}
	if got := MessagingCapabilitySpecs(); len(got) != len(want) {
		t.Fatalf("MessagingCapabilitySpecs() returned %d entries, want %d", len(got), len(want))
	}
	for id, spec := range messagingCapabilitySpecs {
		if spec.InverseCapabilityID == "" {
			continue
		}
		if _, ok := messagingCapabilitySpecs[spec.InverseCapabilityID]; !ok {
			t.Errorf("capability %s names inverse %s, which this module does not implement", id, spec.InverseCapabilityID)
		}
	}
}

func TestMessagingParsersAcceptEveryValidManifestPayload(t *testing.T) {
	const (
		conversationID = "3f0d2c14-9a1b-4c2d-8e3f-1a2b3c4d5e6f"
		messageID      = "11111111-1111-4111-8111-111111111111"
		attachmentID   = "22222222-2222-4222-8222-222222222222"
	)
	cases := []struct {
		id   string
		raw  string
		want string
	}{
		{messagingSendMessageCapabilityID,
			`{"conversationId":"conv-1","body":"hello"}`,
			`{"conversationId":"conv-1","body":"hello"}`},
		{messagingSendMessageCapabilityID,
			`{"conversationId":"conv-1","body":"","mentions":[{"type":"user","id":"u1"},{"type":"agent","id":"workmate"}],"parentMessageId":"` + messageID + `","attachmentIds":["` + attachmentID + `"]}`,
			`{"conversationId":"conv-1","body":"","mentions":[{"type":"user","id":"u1"},{"type":"agent","id":"workmate"}],"parentMessageId":"` + messageID + `","attachmentIds":["` + attachmentID + `"]}`},
		{messagingListConversationsCapabilityID, `{}`, `{"limit":100}`},
		{messagingListConversationsCapabilityID, `{"query":"  ops  ","limit":10}`, `{"query":"ops","limit":10}`},
		{messagingListConversationsCapabilityID, `{"query":""}`, `{"query":"","limit":100}`},
		{messagingReadMessagesCapabilityID, `{"conversationId":"conv-1"}`, `{"conversationId":"conv-1","limit":60}`},
		{messagingReadMessagesCapabilityID, `{"conversationId":"conv-1","limit":100}`, `{"conversationId":"conv-1","limit":100}`},
		{messagingReadMessagesCapabilityID, `{"conversationId":"conv-1","before":"` + messageID + `","limit":25}`, `{"conversationId":"conv-1","limit":25,"before":"` + messageID + `"}`},
		{messagingListPeopleCapabilityID, `{}`, `{}`},
		{messagingListPeopleCapabilityID, `{"query":" chaste ","limit":5}`, `{"query":"chaste","limit":5}`},
		{messagingCreateConversationCapabilityID, `{"title":"ops"}`, `{"title":"ops","kind":"channel","agentEnabled":false}`},
		{messagingCreateConversationCapabilityID, `{"title":"dm","kind":"dm","agentEnabled":true}`, `{"title":"dm","kind":"dm","agentEnabled":true}`},
		{messagingUpdateConversationCapabilityID, `{"conversationId":"conv-1","title":"renamed"}`, `{"conversationId":"conv-1","title":"renamed"}`},
		{messagingUpdateConversationCapabilityID, `{"conversationId":"conv-1","agentEnabled":false}`, `{"conversationId":"conv-1","agentEnabled":false}`},
		{messagingArchiveConversationCapabilityID, `{"conversationId":"conv-1"}`, `{"conversationId":"conv-1","archived":true}`},
		{messagingArchiveConversationCapabilityID, `{"conversationId":"conv-1","archived":false}`, `{"conversationId":"conv-1","archived":false}`},
		{messagingDeleteConversationCapabilityID, `{"conversationId":"conv-1"}`, `{"conversationId":"conv-1"}`},
		{messagingLeaveConversationCapabilityID, `{"conversationId":"conv-1"}`, `{"conversationId":"conv-1"}`},
		{messagingAddMemberCapabilityID, `{"conversationId":"conv-1","userId":"` + conversationID + `"}`,
			`{"conversationId":"conv-1","userId":"` + conversationID + `"}`},
		{messagingEditMessageCapabilityID, `{"messageId":"msg-1","body":"corrected"}`, `{"messageId":"msg-1","body":"corrected"}`},
		{messagingEditMessageCapabilityID, `{"messageId":"msg-1","body":"corrected","expectedBody":"current","expectedEditedAt":"2026-09-20T00:00:00.000Z"}`, `{"messageId":"msg-1","body":"corrected","expectedBody":"current","expectedEditedAt":"2026-09-20T00:00:00.000Z"}`},
		{messagingRestoreMessageEditCapabilityID, `{"messageId":"msg-1","body":"original","expectedBody":"corrected","expectedEditedAt":"2026-09-20T00:00:00.000Z"}`, `{"messageId":"msg-1","body":"original","expectedBody":"corrected","expectedEditedAt":"2026-09-20T00:00:00.000Z"}`},
		{messagingDeleteMessageCapabilityID, `{"messageId":"msg-1"}`, `{"messageId":"msg-1"}`},
		{messagingDeleteMessageCapabilityID, `{"messageId":"msg-1","expectedDeletedAt":null}`, `{"messageId":"msg-1"}`},
		{messagingDeleteMessageCapabilityID, `{"messageId":"msg-1","expectedDeletedAt":"2026-09-20T00:00:00Z"}`, `{"messageId":"msg-1","expectedDeletedAt":"2026-09-20T00:00:00.000Z"}`},
		{messagingRestoreMessageDeleteCapabilityID, `{"messageId":"msg-1","deletedAt":null,"expectedDeletedAt":"2026-09-20T00:00:00Z"}`, `{"messageId":"msg-1","deletedAt":null,"expectedDeletedAt":"2026-09-20T00:00:00.000Z"}`},
		{messagingAdvanceReadCursorCapabilityID, `{"conversationId":"` + conversationID + `"}`,
			`{"conversationId":"` + conversationID + `"}`},
		{messagingAdvanceReadCursorCapabilityID, `{"conversationId":"` + conversationID + `","readAt":null}`,
			`{"conversationId":"` + conversationID + `"}`},
		{messagingAdvanceReadCursorCapabilityID, `{"conversationId":"` + conversationID + `","readAt":"2026-09-20T00:00:00.000Z"}`,
			`{"conversationId":"` + conversationID + `","readAt":"2026-09-20T00:00:00.000Z"}`},
		{messagingRestoreReadCursorCapabilityID, `{"conversationId":"` + conversationID + `","readAt":null}`,
			`{"conversationId":"` + conversationID + `","readAt":null}`},
		{messagingSetMessageReactionCapabilityID, `{"messageId":"` + messageID + `","emoji":"\u2764\ufe0f","active":true}`,
			`{"messageId":"` + messageID + `","emoji":"` + "\u2764\ufe0f" + `","active":true}`},
		{messagingRestoreMessageReactionCapabilityID, `{"messageId":"` + messageID + `","emoji":"\ud83d\udc4d","active":false}`,
			`{"messageId":"` + messageID + `","emoji":"` + "\U0001F44D" + `","active":false}`},
		{messagingSetMessagePinCapabilityID, `{"messageId":"` + messageID + `","pinned":true}`,
			`{"messageId":"` + messageID + `","pinned":true}`},
		{messagingRestoreMessagePinCapabilityID, `{"messageId":"` + messageID + `","pinned":false}`,
			`{"messageId":"` + messageID + `","pinned":false}`},
		{messagingUpdatePresenceCapabilityID, `{"conversationId":"` + conversationID + `","typing":true}`,
			`{"conversationId":"` + conversationID + `","typing":true}`},
		{messagingRestorePresenceCapabilityID,
			`{"conversationId":"` + conversationID + `","lastSeenAt":null,"typingUntil":null}`,
			`{"conversationId":"` + conversationID + `","lastSeenAt":null,"typingUntil":null}`},
		{messagingRestorePresenceCapabilityID,
			`{"conversationId":"` + conversationID + `","lastSeenAt":"2026-09-20T00:00:00.000Z","typingUntil":"2026-09-20T00:00:08.000Z"}`,
			`{"conversationId":"` + conversationID + `","lastSeenAt":"2026-09-20T00:00:00.000Z","typingUntil":"2026-09-20T00:00:08.000Z"}`},
		{messagingUploadAttachmentCapabilityID,
			`{"conversationId":"` + conversationID + `","filename":"brief.txt","mimeType":"text/plain","contentBase64":"aGVsbG8="}`,
			`{"conversationId":"` + conversationID + `","filename":"brief.txt","mimeType":"text/plain","contentBase64":"aGVsbG8="}`},
		{messagingDeletePendingAttachmentCapabilityID, `{"attachmentId":"` + attachmentID + `"}`, `{"attachmentId":"` + attachmentID + `"}`},
	}
	for _, test := range cases {
		t.Run(test.id+" "+test.want, func(t *testing.T) {
			parsed, err := parseMessagingInput(test.id, json.RawMessage(test.raw))
			if err != nil {
				t.Fatalf("parseMessagingInput(%s, %s): %v", test.id, test.raw, err)
			}
			encoded, err := marshalJS(parsed)
			if err != nil {
				t.Fatalf("marshal parsed messaging input: %v", err)
			}
			if string(encoded) != test.want {
				t.Fatalf("parsed input=%s, want %s", encoded, test.want)
			}
		})
	}
}

func TestMessagingParsersRejectInvalidManifestPayloads(t *testing.T) {
	const (
		conversationID = "3f0d2c14-9a1b-4c2d-8e3f-1a2b3c4d5e6f"
		messageID      = "11111111-1111-4111-8111-111111111111"
		attachmentID   = "22222222-2222-4222-8222-222222222222"
	)
	oversizedBody, err := json.Marshal(map[string]string{
		"conversationId": "conv-1",
		"body":           strings.Repeat("a", 8001),
	})
	if err != nil {
		t.Fatal(err)
	}
	tooManyMentions := `{"conversationId":"conv-1","body":"hi","mentions":[` +
		strings.Repeat(`{"type":"user","id":"u1"},`, 20) + `{"type":"user","id":"u21"}]}`
	tooManyAttachments := `{"conversationId":"conv-1","body":"hi","attachmentIds":[` +
		strings.Repeat(`"`+messageID+`",`, 5) + `"` + messageID + `"]}`

	cases := []struct {
		name string
		id   string
		raw  string
	}{
		{"send without body", messagingSendMessageCapabilityID, `{"conversationId":"conv-1"}`},
		{"send without conversation", messagingSendMessageCapabilityID, `{"body":"hi"}`},
		{"send with numeric conversation", messagingSendMessageCapabilityID, `{"conversationId":7,"body":"hi"}`},
		{"send with oversized body", messagingSendMessageCapabilityID, string(oversizedBody)},
		{"send with null mentions", messagingSendMessageCapabilityID, `{"conversationId":"c","body":"b","mentions":null}`},
		{"send with too many mentions", messagingSendMessageCapabilityID, tooManyMentions},
		{"send with unknown mention type", messagingSendMessageCapabilityID, `{"conversationId":"c","body":"b","mentions":[{"type":"robot","id":"u1"}]}`},
		{"send with empty mention id", messagingSendMessageCapabilityID, `{"conversationId":"c","body":"b","mentions":[{"type":"user","id":""}]}`},
		{"send with mention missing id", messagingSendMessageCapabilityID, `{"conversationId":"c","body":"b","mentions":[{"type":"user"}]}`},
		{"send with non-uuid parent", messagingSendMessageCapabilityID, `{"conversationId":"c","body":"b","parentMessageId":"nope"}`},
		{"send with non-uuid attachment", messagingSendMessageCapabilityID, `{"conversationId":"c","body":"b","attachmentIds":["nope"]}`},
		{"send with too many attachments", messagingSendMessageCapabilityID, tooManyAttachments},
		{"list conversations with zero limit", messagingListConversationsCapabilityID, `{"limit":0}`},
		{"list conversations with oversized limit", messagingListConversationsCapabilityID, `{"limit":101}`},
		{"list conversations with fractional limit", messagingListConversationsCapabilityID, `{"limit":1.5}`},
		{"list conversations with oversized query", messagingListConversationsCapabilityID, `{"query":"` + strings.Repeat("q", 101) + `"}`},
		{"read messages without conversation", messagingReadMessagesCapabilityID, `{}`},
		{"read messages with zero limit", messagingReadMessagesCapabilityID, `{"conversationId":"c","limit":0}`},
		{"read messages with oversized limit", messagingReadMessagesCapabilityID, `{"conversationId":"c","limit":101}`},
		{"read messages with non-uuid cursor", messagingReadMessagesCapabilityID, `{"conversationId":"c","before":"invalid"}`},
		{"read messages with null cursor", messagingReadMessagesCapabilityID, `{"conversationId":"c","before":null}`},
		{"list people with blank query", messagingListPeopleCapabilityID, `{"query":"   "}`},
		{"list people with oversized query", messagingListPeopleCapabilityID, `{"query":"` + strings.Repeat("q", 81) + `"}`},
		{"list people with oversized limit", messagingListPeopleCapabilityID, `{"limit":101}`},
		{"create without title", messagingCreateConversationCapabilityID, `{"kind":"channel","agentEnabled":false}`},
		{"create with empty title", messagingCreateConversationCapabilityID, `{"title":""}`},
		{"create with oversized title", messagingCreateConversationCapabilityID, `{"title":"` + strings.Repeat("t", 81) + `"}`},
		{"create with unknown kind", messagingCreateConversationCapabilityID, `{"title":"ops","kind":"thread"}`},
		{"create with null kind", messagingCreateConversationCapabilityID, `{"title":"ops","kind":null}`},
		{"create with null agent flag", messagingCreateConversationCapabilityID, `{"title":"ops","agentEnabled":null}`},
		{"update with empty title", messagingUpdateConversationCapabilityID, `{"conversationId":"c","title":""}`},
		{"update with null agent flag", messagingUpdateConversationCapabilityID, `{"conversationId":"c","agentEnabled":null}`},
		{"update without conversation", messagingUpdateConversationCapabilityID, `{"title":"renamed"}`},
		{"archive with null flag", messagingArchiveConversationCapabilityID, `{"conversationId":"c","archived":null}`},
		{"archive without conversation", messagingArchiveConversationCapabilityID, `{}`},
		{"delete conversation without id", messagingDeleteConversationCapabilityID, `{}`},
		{"leave conversation without id", messagingLeaveConversationCapabilityID, `{}`},
		{"add member without user", messagingAddMemberCapabilityID, `{"conversationId":"c"}`},
		{"add member with non-uuid user", messagingAddMemberCapabilityID, `{"conversationId":"c","userId":"nope"}`},
		{"edit without body", messagingEditMessageCapabilityID, `{"messageId":"m"}`},
		{"edit with empty body", messagingEditMessageCapabilityID, `{"messageId":"m","body":""}`},
		{"edit with oversized body", messagingEditMessageCapabilityID, `{"messageId":"m","body":"` + strings.Repeat("b", 8001) + `"}`},
		{"edit with null expected body", messagingEditMessageCapabilityID, `{"messageId":"m","body":"corrected","expectedBody":null}`},
		{"edit with oversized expected body", messagingEditMessageCapabilityID, `{"messageId":"m","body":"corrected","expectedBody":"` + strings.Repeat("b", 8001) + `"}`},
		{"edit with bad expected editedAt", messagingEditMessageCapabilityID, `{"messageId":"m","body":"corrected","expectedEditedAt":"yesterday"}`},
		{"restore edit without body", messagingRestoreMessageEditCapabilityID, `{"messageId":"m","expectedBody":"corrected","expectedEditedAt":"2026-09-20T00:00:00.000Z"}`},
		{"restore edit without expected body", messagingRestoreMessageEditCapabilityID, `{"messageId":"m","body":"original","expectedEditedAt":"2026-09-20T00:00:00.000Z"}`},
		{"restore edit without expected editedAt", messagingRestoreMessageEditCapabilityID, `{"messageId":"m","body":"original","expectedBody":"corrected"}`},
		{"restore edit with invalid expected editedAt", messagingRestoreMessageEditCapabilityID, `{"messageId":"m","body":"original","expectedBody":"corrected","expectedEditedAt":"yesterday"}`},
		{"restore edit with oversized body", messagingRestoreMessageEditCapabilityID, `{"messageId":"m","body":"` + strings.Repeat("b", 8001) + `","expectedBody":"corrected","expectedEditedAt":"2026-09-20T00:00:00.000Z"}`},
		{"delete message without id", messagingDeleteMessageCapabilityID, `{}`},
		{"delete message with invalid expected deletedAt", messagingDeleteMessageCapabilityID, `{"messageId":"m","expectedDeletedAt":"yesterday"}`},
		{"delete message with numeric expected deletedAt", messagingDeleteMessageCapabilityID, `{"messageId":"m","expectedDeletedAt":4}`},
		{"restore delete without deletedAt", messagingRestoreMessageDeleteCapabilityID, `{"messageId":"m","expectedDeletedAt":"2026-09-20T00:00:00Z"}`},
		{"restore delete without expected timestamp", messagingRestoreMessageDeleteCapabilityID, `{"messageId":"m","deletedAt":null}`},
		{"restore delete with invalid prior timestamp", messagingRestoreMessageDeleteCapabilityID, `{"messageId":"m","deletedAt":"yesterday","expectedDeletedAt":"2026-09-20T00:00:00Z"}`},
		{"advance cursor with non-uuid conversation", messagingAdvanceReadCursorCapabilityID, `{"conversationId":"conv-1"}`},
		{"advance cursor with offset datetime", messagingAdvanceReadCursorCapabilityID, `{"conversationId":"` + conversationID + `","readAt":"2026-09-20T00:00:00+02:00"}`},
		{"advance cursor with date only", messagingAdvanceReadCursorCapabilityID, `{"conversationId":"` + conversationID + `","readAt":"2026-09-20"}`},
		{"advance cursor with impossible date", messagingAdvanceReadCursorCapabilityID, `{"conversationId":"` + conversationID + `","readAt":"2026-02-30T00:00:00Z"}`},
		{"advance cursor with non-leap february 29", messagingAdvanceReadCursorCapabilityID, `{"conversationId":"` + conversationID + `","readAt":"2026-02-29T00:00:00Z"}`},
		{"advance cursor with numeric readAt", messagingAdvanceReadCursorCapabilityID, `{"conversationId":"` + conversationID + `","readAt":7}`},
		{"restore cursor without readAt", messagingRestoreReadCursorCapabilityID, `{"conversationId":"` + conversationID + `"}`},
		{"restore cursor with bad datetime", messagingRestoreReadCursorCapabilityID, `{"conversationId":"` + conversationID + `","readAt":"yesterday"}`},
		{"set reaction with unknown emoji", messagingSetMessageReactionCapabilityID, `{"messageId":"` + messageID + `","emoji":"\U0001F4AA","active":true}`},
		{"set reaction without active", messagingSetMessageReactionCapabilityID, `{"messageId":"` + messageID + `","emoji":"\U0001F44D"}`},
		{"set reaction with non-uuid message", messagingSetMessageReactionCapabilityID, `{"messageId":"m","emoji":"\U0001F44D","active":true}`},
		{"restore reaction with empty emoji", messagingRestoreMessageReactionCapabilityID, `{"messageId":"` + messageID + `","emoji":"","active":true}`},
		{"set pin without pinned", messagingSetMessagePinCapabilityID, `{"messageId":"` + messageID + `"}`},
		{"set pin with non-uuid message", messagingSetMessagePinCapabilityID, `{"messageId":"m","pinned":true}`},
		{"restore pin with null pinned", messagingRestoreMessagePinCapabilityID, `{"messageId":"` + messageID + `","pinned":null}`},
		{"update presence without typing", messagingUpdatePresenceCapabilityID, `{"conversationId":"` + conversationID + `"}`},
		{"update presence with non-uuid conversation", messagingUpdatePresenceCapabilityID, `{"conversationId":"c","typing":true}`},
		{"restore presence without lastSeenAt", messagingRestorePresenceCapabilityID, `{"conversationId":"` + conversationID + `","typingUntil":null}`},
		{"restore presence without typingUntil", messagingRestorePresenceCapabilityID, `{"conversationId":"` + conversationID + `","lastSeenAt":null}`},
		{"restore presence with bad typingUntil", messagingRestorePresenceCapabilityID, `{"conversationId":"` + conversationID + `","lastSeenAt":null,"typingUntil":"soon"}`},
		{"upload without filename", messagingUploadAttachmentCapabilityID, `{"conversationId":"` + conversationID + `","mimeType":"text/plain","contentBase64":"aGVsbG8="}`},
		{"upload with empty filename", messagingUploadAttachmentCapabilityID, `{"conversationId":"` + conversationID + `","filename":"","mimeType":"text/plain","contentBase64":"aGVsbG8="}`},
		{"upload with oversized filename", messagingUploadAttachmentCapabilityID, `{"conversationId":"` + conversationID + `","filename":"` + strings.Repeat("f", 256) + `","mimeType":"text/plain","contentBase64":"aGVsbG8="}`},
		{"upload with empty mime", messagingUploadAttachmentCapabilityID, `{"conversationId":"` + conversationID + `","filename":"f.txt","mimeType":"","contentBase64":"aGVsbG8="}`},
		{"upload with short payload", messagingUploadAttachmentCapabilityID, `{"conversationId":"` + conversationID + `","filename":"f.txt","mimeType":"text/plain","contentBase64":"aGk"}`},
		{"upload with non-uuid conversation", messagingUploadAttachmentCapabilityID, `{"conversationId":"c","filename":"f.txt","mimeType":"text/plain","contentBase64":"aGVsbG8="}`},
		{"delete pending attachment without id", messagingDeletePendingAttachmentCapabilityID, `{}`},
		{"delete pending attachment with non-uuid", messagingDeletePendingAttachmentCapabilityID, `{"attachmentId":"a"}`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseMessagingInput(test.id, json.RawMessage(test.raw)); err == nil {
				t.Fatalf("parseMessagingInput(%s, %s) accepted an invalid payload", test.id, test.raw)
			}
		})
	}
	for _, id := range messagingCapabilityIDs() {
		if _, err := parseMessagingInput(id, json.RawMessage(`[]`)); err == nil {
			t.Errorf("messaging parser %s accepted a non-object payload", id)
		}
		if _, err := parseMessagingInput(id, json.RawMessage(`{"conversationId":"c"} trailing`)); err == nil {
			t.Errorf("messaging parser %s accepted trailing JSON data", id)
		}
	}
	if _, err := parseMessagingInput("messaging.notARealCapability", json.RawMessage(`{}`)); err == nil {
		t.Fatal("messaging parser accepted an unknown capability id")
	}
}

func messagingCapabilityIDs() []string {
	ids := make([]string, 0, len(messagingCapabilitySpecs))
	for id := range messagingCapabilitySpecs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func TestMessagingParsersStripUnknownKeysLikeZod(t *testing.T) {
	cases := []struct {
		id   string
		raw  string
		want string
	}{
		{messagingListConversationsCapabilityID, `{"unknown":true,"nested":{"a":1}}`, `{"limit":100}`},
		{messagingListPeopleCapabilityID, `{"unknown":[1,2],"query":"ann"}`, `{"query":"ann"}`},
		{messagingSendMessageCapabilityID, `{"conversationId":"c","body":"b","extra":true}`, `{"conversationId":"c","body":"b"}`},
		{messagingSendMessageCapabilityID,
			`{"conversationId":"c","body":"b","mentions":[{"type":"user","id":"u1","extra":true}]}`,
			`{"conversationId":"c","body":"b","mentions":[{"type":"user","id":"u1"}]}`},
		{messagingCreateConversationCapabilityID, `{"title":"ops","kind":"channel","agentEnabled":true,"extra":1}`, `{"title":"ops","kind":"channel","agentEnabled":true}`},
		{messagingUpdateConversationCapabilityID, `{"conversationId":"c","agentEnabled":true,"extra":1}`, `{"conversationId":"c","agentEnabled":true}`},
		{messagingAdvanceReadCursorCapabilityID,
			`{"conversationId":"3f0d2c14-9a1b-4c2d-8e3f-1a2b3c4d5e6f","readAt":"2026-09-20T00:00:00Z","extra":1}`,
			`{"conversationId":"3f0d2c14-9a1b-4c2d-8e3f-1a2b3c4d5e6f","readAt":"2026-09-20T00:00:00Z"}`},
	}
	for _, test := range cases {
		parsed, err := parseMessagingInput(test.id, json.RawMessage(test.raw))
		if err != nil {
			t.Fatalf("parseMessagingInput(%s, %s): %v", test.id, test.raw, err)
		}
		encoded, err := marshalJS(parsed)
		if err != nil {
			t.Fatalf("marshal parsed messaging input: %v", err)
		}
		if string(encoded) != test.want {
			t.Errorf("parsed %s from %s = %s, want %s", test.id, test.raw, encoded, test.want)
		}
	}
}

func TestMessagingAdvanceReadCursorDistinguishesAbsentFromNull(t *testing.T) {
	const conversationID = "3f0d2c14-9a1b-4c2d-8e3f-1a2b3c4d5e6f"
	absent, err := parseMessagingAdvanceReadCursorInput(json.RawMessage(`{"conversationId":"` + conversationID + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	if absent.ReadAtProvided || absent.ReadAt != nil {
		t.Fatalf("absent readAt parsed as %+v, want unset", absent)
	}
	explicitNull, err := parseMessagingAdvanceReadCursorInput(json.RawMessage(`{"conversationId":"` + conversationID + `","readAt":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if !explicitNull.ReadAtProvided || explicitNull.ReadAt != nil {
		t.Fatalf("null readAt parsed as %+v, want a provided null", explicitNull)
	}
}

func TestMessagingDeleteGuardDistinguishesAbsentFromExplicitNull(t *testing.T) {
	absent, err := parseMessagingInput(messagingDeleteMessageCapabilityID, json.RawMessage(`{"messageId":"m"}`))
	if err != nil {
		t.Fatal(err)
	}
	explicitNull, err := parseMessagingInput(messagingDeleteMessageCapabilityID, json.RawMessage(`{"messageId":"m","expectedDeletedAt":null}`))
	if err != nil {
		t.Fatal(err)
	}
	absentInput := absent.(MessagingDeleteMessageInput)
	nullInput := explicitNull.(MessagingDeleteMessageInput)
	if absentInput.ExpectedDeletedAtProvided || !nullInput.ExpectedDeletedAtProvided || nullInput.ExpectedDeletedAt != nil {
		t.Fatalf("delete guard absent=%+v explicit-null=%+v", absentInput, nullInput)
	}
	abSentHash, err := canonicalInputHash(absentInput)
	if err != nil {
		t.Fatal(err)
	}
	nullHash, err := canonicalInputHash(nullInput)
	if err != nil {
		t.Fatal(err)
	}
	if abSentHash == nullHash {
		t.Fatal("absent and explicit-null delete guards must have different canonical hashes")
	}
}

func TestMessagingOutputShapesMatchTheManifest(t *testing.T) {
	cases := []struct {
		id   string
		out  any
		want []string
	}{
		{messagingSendMessageCapabilityID, MessagingSendMessageOutput{MessageID: "m"}, []string{"messageId"}},
		{messagingCreateConversationCapabilityID, MessagingConversationIDOutput{ConversationID: "c"}, []string{"conversationId"}},
		{messagingUpdateConversationCapabilityID, MessagingConversationIDOutput{ConversationID: "c"}, []string{"conversationId"}},
		{messagingArchiveConversationCapabilityID, MessagingArchiveConversationOutput{ConversationID: "c", Archived: true}, []string{"conversationId", "archived"}},
		{messagingDeleteConversationCapabilityID, MessagingDeleteConversationOutput{Deleted: true}, []string{"deleted"}},
		{messagingLeaveConversationCapabilityID, MessagingLeaveConversationOutput{Left: true}, []string{"left"}},
		{messagingAddMemberCapabilityID, MessagingAddMemberOutput{Added: true}, []string{"added"}},
		{messagingEditMessageCapabilityID, MessagingEditMessageOutput{MessageID: "m", Body: "before", ExpectedBody: "after", ExpectedEditedAt: "2026-09-20T00:00:00.000Z", EditedAt: "2026-09-20T00:00:00.000Z"}, []string{"messageId", "body", "expectedBody", "expectedEditedAt", "editedAt"}},
		{messagingRestoreMessageEditCapabilityID, MessagingRestoreMessageEditOutput{MessageID: "m", Body: "after", ExpectedBody: "before", ExpectedEditedAt: "2026-09-20T00:00:00.000Z", EditedAt: "2026-09-20T00:00:00.000Z"}, []string{"messageId", "body", "expectedBody", "expectedEditedAt", "editedAt"}},
		{messagingDeleteMessageCapabilityID, MessagingDeleteMessageOutput{MessageID: "m", Deleted: true, ExpectedDeletedAt: "2026-09-20T00:00:00.000Z"}, []string{"messageId", "deleted", "deletedAt", "expectedDeletedAt"}},
		{messagingRestoreMessageDeleteCapabilityID, MessagingRestoreMessageDeleteOutput{MessageID: "m"}, []string{"messageId", "expectedDeletedAt"}},
		{messagingAdvanceReadCursorCapabilityID, MessagingReadCursorOutput{ConversationID: "c"}, []string{"conversationId", "previousReadAt"}},
		{messagingRestoreReadCursorCapabilityID, MessagingReadCursorOutput{ConversationID: "c"}, []string{"conversationId", "previousReadAt"}},
		{messagingSetMessageReactionCapabilityID, MessagingSetMessageReactionOutput{Active: true}, []string{"previousActive", "active"}},
		{messagingRestoreMessageReactionCapabilityID, MessagingRestoreMessageReactionOutput{}, []string{"previousActive"}},
		{messagingSetMessagePinCapabilityID, MessagingSetMessagePinOutput{Pinned: true}, []string{"previousPinned", "pinned"}},
		{messagingRestoreMessagePinCapabilityID, MessagingRestoreMessagePinOutput{}, []string{"previousPinned"}},
		{messagingUpdatePresenceCapabilityID, MessagingConversationPresenceOutput{}, []string{"previousLastSeenAt", "previousTypingUntil"}},
		{messagingRestorePresenceCapabilityID, MessagingConversationPresenceOutput{}, []string{"previousLastSeenAt", "previousTypingUntil"}},
		{messagingUploadAttachmentCapabilityID, MessagingUploadMessageAttachmentOutput{AttachmentID: "a"}, []string{"attachmentId"}},
		{messagingDeletePendingAttachmentCapabilityID, MessagingDeletePendingAttachmentOutput{Removed: true}, []string{"removed"}},
		{messagingListConversationsCapabilityID, MessagingListConversationsOutput{Conversations: []MessagingConversationListItem{{}}},
			[]string{"conversations", "me"}},
		{messagingReadMessagesCapabilityID, MessagingReadMessagesOutput{Messages: []MessagingMessageSnapshot{{}}},
			[]string{"conversation", "messages", "me", "readers", "pinnedMessages", "hasMore", "nextCursor"}},
		{messagingListPeopleCapabilityID, MessagingListPeopleOutput{People: []MessagingPerson{{}}},
			[]string{"people"}},
	}
	for _, test := range cases {
		encoded, err := marshalJS(test.out)
		if err != nil {
			t.Fatalf("marshal %s output: %v", test.id, err)
		}
		var wire map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &wire); err != nil {
			t.Fatalf("decode %s output %s: %v", test.id, encoded, err)
		}
		got := make([]string, 0, len(wire))
		for key := range wire {
			got = append(got, key)
		}
		sort.Strings(got)
		want := append([]string(nil), test.want...)
		sort.Strings(want)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s output keys=%v, want %v", test.id, got, want)
		}
	}

	encoded, err := marshalJS(MessagingListConversationsOutput{Conversations: []MessagingConversationListItem{{ID: "c"}}})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"conversations":[{"id":"c","kind":"","title":"","agentEnabled":false,"archivedAt":null,"createdByMe":false,"unreadCount":0,"lastMessage":null}],"me":""}` {
		t.Errorf("listConversations wire shape=%s", encoded)
	}
	encoded, err = marshalJS(MessagingReadMessagesOutput{
		Conversation: MessagingConversationSnapshot{ID: "c"},
		Messages:     []MessagingMessageSnapshot{{ID: "m", SenderType: "human", Attachments: []MessagingMessageAttachment{}, Reactions: []MessagingMessageReaction{}}},
		Me:           "u", Readers: []MessagingReaderSnapshot{}, PinnedMessages: []MessagingPinnedMessageSnapshot{}, NextCursor: nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"conversation":{"id":"c","orgId":"","kind":"","title":"","agentEnabled":false,"createdByUserId":null,"createdAt":"","archivedAt":null,"deletedAt":null},"messages":[{"id":"m","senderType":"human","senderUserId":null,"body":"","createdAt":"","editedAt":null,"parentMessageId":null,"pinnedAt":null,"mentions":null,"attachments":[],"reactions":[]}],"me":"u","readers":[],"pinnedMessages":[],"hasMore":false,"nextCursor":null}` {
		t.Errorf("readMessages wire shape=%s", encoded)
	}
	encoded, err = marshalJS(MessagingListPeopleOutput{People: []MessagingPerson{{Type: "agent", ID: "workmate", Name: messagingWorkmateName}}})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"people":[{"type":"agent","id":"workmate","name":"Chaste · AI workmate"}]}` {
		t.Errorf("listPeople wire shape=%s", encoded)
	}
}

func TestMessagingTimestampsUseJavaScriptDateFormat(t *testing.T) {
	parsed, err := messagingParseDateTime("2026-09-20T00:00:00.123456Z")
	if err != nil {
		t.Fatal(err)
	}
	if got := messagingFormatTime(parsed); got != "2026-09-20T00:00:00.123Z" {
		t.Fatalf("messagingFormatTime=%q, want millisecond precision with a Z suffix", got)
	}
	if messagingFormatOptionalTime(nil) != nil {
		t.Fatal("messagingFormatOptionalTime(nil) must stay null")
	}
	optional := time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC)
	if got := messagingFormatOptionalTime(&optional); got == nil || *got != "2026-09-20T00:00:00.000Z" {
		t.Fatalf("messagingFormatOptionalTime=%v, want 2026-09-20T00:00:00.000Z", got)
	}
	for _, value := range []string{
		"2026-09-20T00:00:00.000Z", "2026-09-20T00:00Z", "2026-09-20T00:00:00Z",
		"2024-02-29T23:59:59.999Z", "2026-01-01T00:00:00.1Z",
	} {
		if _, err := messagingParseDateTime(value); err != nil {
			t.Errorf("messagingParseDateTime(%q): %v", value, err)
		}
	}
	for _, value := range []string{
		"2026-09-20", "2026-09-20T00:00:00", "2026-09-20T00:00:00+02:00", "2026-09-20 00:00:00Z",
		"2026-02-30T00:00:00Z", "2025-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-09-20T24:00:00Z",
		"2026-09-20T00:60:00Z", "not-a-date", "",
	} {
		if _, err := messagingParseDateTime(value); err == nil {
			t.Errorf("messagingParseDateTime(%q) accepted an invalid datetime", value)
		}
	}
}

func TestMessagingNormalizeMentionsRejectsMalformedPersistedValues(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
		bad  bool
	}{
		{name: "null", raw: `null`, want: `null`},
		{name: "empty", raw: `[]`, want: `[]`},
		{name: "valid", raw: `[ {"type":"user","id":"u-1"} ]`, want: `[{"type":"user","id":"u-1"}]`},
		{name: "unknown type", raw: `[{"type":"robot","id":"u-1"}]`, bad: true},
		{name: "extra property", raw: `[{"type":"user","id":"u-1","role":"admin"}]`, bad: true},
		{name: "missing id", raw: `[{"type":"user"}]`, bad: true},
		{name: "non-array", raw: `{"type":"user","id":"u-1"}`, bad: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := messagingNormalizeMentions(json.RawMessage(test.raw))
			if test.bad {
				if err == nil {
					t.Fatalf("normalize(%s)=%s, want validation error", test.raw, got)
				}
				return
			}
			if err != nil || string(got) != test.want {
				t.Fatalf("normalize(%s)=%s err=%v, want %s", test.raw, got, err, test.want)
			}
		})
	}
}

func TestMessagingAttachmentPayloadMatchesTypeScriptValidation(t *testing.T) {
	decoded, err := messagingDecodeAttachment("aGVsbG8gZnJvbSBhIHByaXZhdGUgYXR0YWNobWVudA==")
	if err != nil {
		t.Fatalf("decode a valid attachment: %v", err)
	}
	if string(decoded) != "hello from a private attachment" {
		t.Fatalf("decoded attachment=%q", decoded)
	}
	if _, err := messagingDecodeAttachment("aGVsbG8"); err != nil {
		t.Fatalf("decode unpadded base64: %v", err)
	}
	if _, err := messagingDecodeAttachment("aGVsbG8="); err != nil {
		t.Fatalf("decode single-padded base64: %v", err)
	}
	// Node's lenient decoder plus the canonical re-encode check accepts surplus
	// trailing padding, so the Go path must too.
	if _, err := messagingDecodeAttachment("aGk="); err != nil {
		t.Fatalf("decode a two-byte padded payload: %v", err)
	}
	if _, err := messagingDecodeAttachment("aGVsbG8==="); err != nil {
		t.Fatalf("decode a surplus-padded payload: %v", err)
	}
	for _, value := range []string{
		"", "aGVs bG8=", "aGVsbG8=\n", "!!!!", "aGVs=G8",
	} {
		if _, err := messagingDecodeAttachment(value); err == nil {
			t.Errorf("messagingDecodeAttachment(%q) accepted a payload the TypeScript check refuses", value)
		}
	}
	if _, err := messagingDecodeAttachment(strings.Repeat("A", 12*1024*1024)); err == nil {
		t.Error("messagingDecodeAttachment accepted a payload over the 5 MB ceiling")
	}
}

func TestMessagingReactionAndWorkmateCodePointsMatchTheManifest(t *testing.T) {
	want := []string{"\U0001F44D", "\u2764\ufe0f", "\U0001F389", "\u2705", "\U0001F440"}
	if !reflect.DeepEqual(messagingReactionEmoji, want) {
		t.Fatalf("reaction emoji=%q, want %q", messagingReactionEmoji, want)
	}
	for _, emoji := range want {
		if !messagingSupportedReaction(emoji) {
			t.Errorf("messagingSupportedReaction(%q)=false", emoji)
		}
	}
	for _, emoji := range []string{"", "\U0001F4AA", "\u2764", "thumbsup"} {
		if messagingSupportedReaction(emoji) {
			t.Errorf("messagingSupportedReaction(%q)=true, want false", emoji)
		}
	}
	if messagingWorkmateID != "workmate" || messagingWorkmateName != "Chaste \u00b7 AI workmate" {
		t.Fatalf("workmate entry=%q %q, want the manifest listing label", messagingWorkmateID, messagingWorkmateName)
	}
	if !messagingWorkmateQueryPattern.MatchString("ask the Chaste workmate") || messagingWorkmateQueryPattern.MatchString("ann") {
		t.Fatal("workmate query pattern does not match the TypeScript /chaste|workmate|agent/i test")
	}
}

func TestMessagingFilenameSanitizationMatchesTypeScript(t *testing.T) {
	cases := map[string]string{
		"brief.txt":              "brief.txt",
		"../../etc/passwd":       ".._.._etc_passwd",
		`dir\sub/name.txt`:       "dir_sub_name.txt",
		"null\x00byte.txt":       "null_byte.txt",
		strings.Repeat("f", 300): strings.Repeat("f", 255),
	}
	for input, want := range cases {
		if got := messagingSanitizeFilename(input); got != want {
			t.Errorf("messagingSanitizeFilename(%q)=%q, want %q", input, got, want)
		}
	}
}
