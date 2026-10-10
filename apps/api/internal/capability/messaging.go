package capability

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	messagingSendMessageCapabilityID             = "messaging.sendMessage"
	messagingListConversationsCapabilityID       = "messaging.listConversations"
	messagingReadMessagesCapabilityID            = "messaging.readMessages"
	messagingListPeopleCapabilityID              = "messaging.listPeople"
	messagingCreateConversationCapabilityID      = "messaging.createConversation"
	messagingUpdateConversationCapabilityID      = "messaging.updateConversation"
	messagingArchiveConversationCapabilityID     = "messaging.archiveConversation"
	messagingDeleteConversationCapabilityID      = "messaging.deleteConversation"
	messagingLeaveConversationCapabilityID       = "messaging.leaveConversation"
	messagingAddMemberCapabilityID               = "messaging.addMember"
	messagingEditMessageCapabilityID             = "messaging.editMessage"
	messagingRestoreMessageEditCapabilityID      = "messaging.restoreMessageEdit"
	messagingDeleteMessageCapabilityID           = "messaging.deleteMessage"
	messagingRestoreMessageDeleteCapabilityID    = "messaging.restoreMessageDelete"
	messagingAdvanceReadCursorCapabilityID       = "messaging.advanceReadCursor"
	messagingRestoreReadCursorCapabilityID       = "messaging.restoreReadCursor"
	messagingSetMessageReactionCapabilityID      = "messaging.setMessageReaction"
	messagingRestoreMessageReactionCapabilityID  = "messaging.restoreMessageReaction"
	messagingSetMessagePinCapabilityID           = "messaging.setMessagePin"
	messagingRestoreMessagePinCapabilityID       = "messaging.restoreMessagePin"
	messagingUpdatePresenceCapabilityID          = "messaging.updateConversationPresence"
	messagingRestorePresenceCapabilityID         = "messaging.restoreConversationPresence"
	messagingUploadAttachmentCapabilityID        = "messaging.uploadMessageAttachment"
	messagingDeletePendingAttachmentCapabilityID = "messaging.deletePendingAttachment"

	messagingTitleMax               = 80
	messagingQueryMax               = 100
	messagingPeopleQueryMax         = 80
	messagingBodyMax                = 8000
	messagingFilenameMax            = 255
	messagingMimeTypeMax            = 120
	messagingContentBase64Max       = 7_000_000
	messagingMentionIDMax           = 80
	messagingMentionCountMax        = 20
	messagingAttachmentCountMax     = 5
	messagingAttachmentBytesMax     = 5 * 1024 * 1024
	messagingNotificationBodyMax    = 200
	messagingConversationListLimit  = 100
	messagingPeopleListLimit        = 50
	messagingReadMessagesDefLimit   = 60
	messagingListItemLimitMax       = 100
	messagingTypingWindow           = 8 * time.Second
	messagingWorkmateID             = "workmate"
	messagingWorkmateName           = "Chaste \u00b7 AI workmate"
	messagingConversationKindDM     = "dm"
	messagingConversationKindChannl = "channel"
)

// zod v4 string().datetime() with default options: no offset, "Z" only,
// optional seconds, optional fractional seconds.
var messagingDateTimePattern = regexp.MustCompile(`^(?:` +
	`(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29` +
	`|\d{4}-(?:` +
	`(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])` +
	`|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)` +
	`|(?:02)-(?:0[1-9]|1\d|2[0-8])` +
	`)` +
	`)T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$`)

var messagingWorkmateQueryPattern = regexp.MustCompile(`(?i)chaste|workmate|agent`)

var messagingLikeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

var messagingReactionEmoji = []string{"\U0001F44D", "\u2764\ufe0f", "\U0001F389", "\u2705", "\U0001F440"}

// MessagingCapabilitySpec mirrors the executor's capabilitySpec so the module
// owns its own registry metadata.
type MessagingCapabilitySpec struct {
	Module              string
	Permission          string
	Risk                string
	MoneyThresholdMinor int64
	InverseCapabilityID string
	InverseInputSource  string
	InverseFields       []string
}

var messagingCapabilitySpecs = map[string]MessagingCapabilitySpec{
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

// MessagingCapabilitySpecs is the metadata table the executor registry needs for
// the messaging module: module gate, permission, risk, and inverse declaration.
func MessagingCapabilitySpecs() map[string]MessagingCapabilitySpec {
	return messagingCapabilitySpecs
}

type MessagingMention struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type MessagingSendMessageInput struct {
	ConversationID  string             `json:"conversationId"`
	Body            string             `json:"body"`
	Mentions        []MessagingMention `json:"mentions,omitempty"`
	ParentMessageID *string            `json:"parentMessageId,omitempty"`
	AttachmentIDs   []string           `json:"attachmentIds,omitempty"`
}

type MessagingSendMessageOutput struct {
	MessageID string `json:"messageId"`
}

type MessagingListConversationsInput struct {
	Query *string `json:"query,omitempty"`
	Limit int64   `json:"limit"`
}

type MessagingConversationListItem struct {
	ID           string                            `json:"id"`
	Kind         string                            `json:"kind"`
	Title        string                            `json:"title"`
	AgentEnabled bool                              `json:"agentEnabled"`
	ArchivedAt   *string                           `json:"archivedAt"`
	CreatedByMe  bool                              `json:"createdByMe"`
	UnreadCount  int64                             `json:"unreadCount"`
	LastMessage  *MessagingConversationLastMessage `json:"lastMessage"`
}

type MessagingConversationLastMessage struct {
	At   string `json:"at"`
	Body string `json:"body"`
}

type MessagingListConversationsOutput struct {
	Conversations []MessagingConversationListItem `json:"conversations"`
	Me            string                          `json:"me"`
}

type MessagingReadMessagesInput struct {
	ConversationID string  `json:"conversationId"`
	Limit          int64   `json:"limit"`
	Before         *string `json:"before,omitempty"`
	Around         *string `json:"around,omitempty"`
}

type MessagingConversationSnapshot struct {
	ID              string  `json:"id"`
	OrgID           string  `json:"orgId"`
	Kind            string  `json:"kind"`
	Title           string  `json:"title"`
	AgentEnabled    bool    `json:"agentEnabled"`
	CreatedByUserID *string `json:"createdByUserId"`
	CreatedAt       string  `json:"createdAt"`
	ArchivedAt      *string `json:"archivedAt"`
	DeletedAt       *string `json:"deletedAt"`
}

type MessagingMessageAttachment struct {
	ID        string `json:"id"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
	Href      string `json:"href"`
}

type MessagingMessageReaction struct {
	Emoji       string   `json:"emoji"`
	Count       int64    `json:"count"`
	ReactedByMe bool     `json:"reactedByMe"`
	Names       []string `json:"names"`
}

type MessagingMessageSnapshot struct {
	ID              string                       `json:"id"`
	SenderType      string                       `json:"senderType"`
	SenderUserID    *string                      `json:"senderUserId"`
	Body            string                       `json:"body"`
	CreatedAt       string                       `json:"createdAt"`
	EditedAt        *string                      `json:"editedAt"`
	ParentMessageID *string                      `json:"parentMessageId"`
	PinnedAt        *string                      `json:"pinnedAt"`
	Mentions        json.RawMessage              `json:"mentions"`
	Attachments     []MessagingMessageAttachment `json:"attachments"`
	Reactions       []MessagingMessageReaction   `json:"reactions"`
}

type MessagingReaderSnapshot struct {
	UserID     string  `json:"userId"`
	Name       string  `json:"name"`
	LastReadAt *string `json:"lastReadAt"`
}

type MessagingPinnedMessageSnapshot struct {
	ID       string `json:"id"`
	Body     string `json:"body"`
	PinnedAt string `json:"pinnedAt"`
}

type MessagingReadMessagesOutput struct {
	Conversation   MessagingConversationSnapshot    `json:"conversation"`
	Messages       []MessagingMessageSnapshot       `json:"messages"`
	Me             string                           `json:"me"`
	Readers        []MessagingReaderSnapshot        `json:"readers"`
	PinnedMessages []MessagingPinnedMessageSnapshot `json:"pinnedMessages"`
	HasMore        bool                             `json:"hasMore"`
	NextCursor     *string                          `json:"nextCursor"`
}

type MessagingListPeopleInput struct {
	Query *string `json:"query,omitempty"`
	Limit *int64  `json:"limit,omitempty"`
}

type MessagingPerson struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

type MessagingListPeopleOutput struct {
	People []MessagingPerson `json:"people"`
}

type MessagingConversationIDInput struct {
	ConversationID string `json:"conversationId"`
}

type MessagingCreateConversationInput struct {
	Title        string `json:"title"`
	Kind         string `json:"kind"`
	AgentEnabled bool   `json:"agentEnabled"`
}

type MessagingConversationIDOutput struct {
	ConversationID string `json:"conversationId"`
}

type MessagingUpdateConversationInput struct {
	ConversationID string  `json:"conversationId"`
	Title          *string `json:"title,omitempty"`
	AgentEnabled   *bool   `json:"agentEnabled,omitempty"`
}

type MessagingArchiveConversationInput struct {
	ConversationID string `json:"conversationId"`
	Archived       bool   `json:"archived"`
}

type MessagingArchiveConversationOutput struct {
	ConversationID string `json:"conversationId"`
	Archived       bool   `json:"archived"`
}

type MessagingDeleteConversationOutput struct {
	Deleted bool `json:"deleted"`
}

type MessagingLeaveConversationOutput struct {
	Left bool `json:"left"`
}

type MessagingAddMemberInput struct {
	ConversationID string `json:"conversationId"`
	UserID         string `json:"userId"`
}

type MessagingAddMemberOutput struct {
	Added bool `json:"added"`
}

type MessagingEditMessageInput struct {
	MessageID        string  `json:"messageId"`
	Body             string  `json:"body"`
	ExpectedBody     *string `json:"expectedBody,omitempty"`
	ExpectedEditedAt *string `json:"expectedEditedAt,omitempty"`
}

type MessagingEditMessageOutput struct {
	MessageID        string `json:"messageId"`
	Body             string `json:"body"`
	ExpectedBody     string `json:"expectedBody"`
	ExpectedEditedAt string `json:"expectedEditedAt"`
	EditedAt         string `json:"editedAt"`
}

type MessagingRestoreMessageEditInput struct {
	MessageID        string `json:"messageId"`
	Body             string `json:"body"`
	ExpectedBody     string `json:"expectedBody"`
	ExpectedEditedAt string `json:"expectedEditedAt"`
}

type MessagingRestoreMessageEditOutput struct {
	MessageID        string `json:"messageId"`
	Body             string `json:"body"`
	ExpectedBody     string `json:"expectedBody"`
	ExpectedEditedAt string `json:"expectedEditedAt"`
	EditedAt         string `json:"editedAt"`
}

type MessagingDeleteMessageInput struct {
	MessageID                 string  `json:"messageId"`
	ExpectedDeletedAt         *string `json:"expectedDeletedAt,omitempty"`
	ExpectedDeletedAtProvided bool    `json:"-"`
}

type MessagingDeleteMessageOutput struct {
	MessageID         string  `json:"messageId"`
	Deleted           bool    `json:"deleted"`
	DeletedAt         *string `json:"deletedAt"`
	ExpectedDeletedAt string  `json:"expectedDeletedAt"`
}

type MessagingRestoreMessageDeleteInput struct {
	MessageID         string  `json:"messageId"`
	DeletedAt         *string `json:"deletedAt"`
	ExpectedDeletedAt string  `json:"expectedDeletedAt"`
}

type MessagingRestoreMessageDeleteOutput struct {
	MessageID         string  `json:"messageId"`
	ExpectedDeletedAt *string `json:"expectedDeletedAt"`
}

// ReadAtProvided separates an absent readAt (advance to now) from an explicit
// null (clear the cursor); zod's optional/nullable pair distinguishes them.
type MessagingAdvanceReadCursorInput struct {
	ConversationID string  `json:"conversationId"`
	ReadAt         *string `json:"readAt,omitempty"`
	ReadAtProvided bool    `json:"-"`
}

type MessagingRestoreReadCursorInput struct {
	ConversationID string  `json:"conversationId"`
	ReadAt         *string `json:"readAt"`
}

type MessagingReadCursorOutput struct {
	ConversationID string  `json:"conversationId"`
	PreviousReadAt *string `json:"previousReadAt"`
}

type MessagingMessageReactionInput struct {
	MessageID string `json:"messageId"`
	Emoji     string `json:"emoji"`
	Active    bool   `json:"active"`
}

type MessagingSetMessageReactionOutput struct {
	PreviousActive bool `json:"previousActive"`
	Active         bool `json:"active"`
}

type MessagingRestoreMessageReactionOutput struct {
	PreviousActive bool `json:"previousActive"`
}

type MessagingMessagePinInput struct {
	MessageID string `json:"messageId"`
	Pinned    bool   `json:"pinned"`
}

type MessagingSetMessagePinOutput struct {
	PreviousPinned bool `json:"previousPinned"`
	Pinned         bool `json:"pinned"`
}

type MessagingRestoreMessagePinOutput struct {
	PreviousPinned bool `json:"previousPinned"`
}

type MessagingUpdateConversationPresenceInput struct {
	ConversationID string `json:"conversationId"`
	Typing         bool   `json:"typing"`
}

type MessagingRestoreConversationPresenceInput struct {
	ConversationID string  `json:"conversationId"`
	LastSeenAt     *string `json:"lastSeenAt"`
	TypingUntil    *string `json:"typingUntil"`
}

type MessagingConversationPresenceOutput struct {
	PreviousLastSeenAt  *string `json:"previousLastSeenAt"`
	PreviousTypingUntil *string `json:"previousTypingUntil"`
}

type MessagingDeletePendingAttachmentInput struct {
	AttachmentID string `json:"attachmentId"`
}

type MessagingUploadMessageAttachmentInput struct {
	ConversationID string `json:"conversationId"`
	Filename       string `json:"filename"`
	MimeType       string `json:"mimeType"`
	ContentBase64  string `json:"contentBase64"`
}

type MessagingUploadMessageAttachmentOutput struct {
	AttachmentID string `json:"attachmentId"`
}

type MessagingDeletePendingAttachmentOutput struct {
	Removed bool `json:"removed"`
}

func parseMessagingInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case messagingSendMessageCapabilityID:
		return parseMessagingSendMessageInput(raw)
	case messagingListConversationsCapabilityID:
		return parseMessagingListConversationsInput(raw)
	case messagingReadMessagesCapabilityID:
		return parseMessagingReadMessagesInput(raw)
	case messagingListPeopleCapabilityID:
		return parseMessagingListPeopleInput(raw)
	case messagingCreateConversationCapabilityID:
		return parseMessagingCreateConversationInput(raw)
	case messagingUpdateConversationCapabilityID:
		return parseMessagingUpdateConversationInput(raw)
	case messagingArchiveConversationCapabilityID:
		return parseMessagingArchiveConversationInput(raw)
	case messagingDeleteConversationCapabilityID, messagingLeaveConversationCapabilityID:
		return parseMessagingConversationIDInput(raw)
	case messagingAddMemberCapabilityID:
		return parseMessagingAddMemberInput(raw)
	case messagingEditMessageCapabilityID:
		return parseMessagingEditMessageInput(raw)
	case messagingRestoreMessageEditCapabilityID:
		return parseMessagingRestoreMessageEditInput(raw)
	case messagingDeleteMessageCapabilityID:
		return parseMessagingDeleteMessageInput(raw)
	case messagingRestoreMessageDeleteCapabilityID:
		return parseMessagingRestoreMessageDeleteInput(raw)
	case messagingAdvanceReadCursorCapabilityID:
		return parseMessagingAdvanceReadCursorInput(raw)
	case messagingRestoreReadCursorCapabilityID:
		return parseMessagingRestoreReadCursorInput(raw)
	case messagingSetMessageReactionCapabilityID, messagingRestoreMessageReactionCapabilityID:
		return parseMessagingMessageReactionInput(raw)
	case messagingSetMessagePinCapabilityID, messagingRestoreMessagePinCapabilityID:
		return parseMessagingMessagePinInput(raw)
	case messagingUpdatePresenceCapabilityID:
		return parseMessagingUpdateConversationPresenceInput(raw)
	case messagingRestorePresenceCapabilityID:
		return parseMessagingRestoreConversationPresenceInput(raw)
	case messagingUploadAttachmentCapabilityID:
		return parseMessagingUploadMessageAttachmentInput(raw)
	case messagingDeletePendingAttachmentCapabilityID:
		return parseMessagingDeletePendingAttachmentInput(raw)
	default:
		return nil, errors.New("unsupported messaging capability")
	}
}

func messagingIsNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func messagingRequiredString(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("%s is required", key)
	}
	if messagingIsNull(raw) {
		return "", fmt.Errorf("%s must be a string", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

func messagingOptionalString(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	value, err := readOptionalString(raw)
	if err != nil {
		return nil, fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

func messagingRequiredBool(fields map[string]json.RawMessage, key string) (bool, error) {
	raw, ok := fields[key]
	if !ok {
		return false, fmt.Errorf("%s is required", key)
	}
	if messagingIsNull(raw) {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return value, nil
}

func messagingOptionalBool(fields map[string]json.RawMessage, key string) (*bool, error) {
	if _, ok := fields[key]; !ok {
		return nil, nil
	}
	value, err := messagingRequiredBool(fields, key)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func messagingBoundedLimit(fields map[string]json.RawMessage, key string, fallback int64) (int64, error) {
	if _, ok := fields[key]; !ok {
		return fallback, nil
	}
	value, err := requiredSafeInteger(fields, key)
	if err != nil {
		return 0, err
	}
	if value < 1 || value > messagingListItemLimitMax {
		return 0, fmt.Errorf("%s must be between 1 and %d", key, messagingListItemLimitMax)
	}
	return value, nil
}

func messagingOptionalArray(fields map[string]json.RawMessage, key string) ([]json.RawMessage, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	if messagingIsNull(raw) {
		return nil, fmt.Errorf("%s must be an array", key)
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("%s must be an array", key)
	}
	return items, nil
}

func messagingStringArrayUUIDs(fields map[string]json.RawMessage, key string, maxItems int) ([]string, error) {
	items, err := messagingOptionalArray(fields, key)
	if err != nil || items == nil {
		return nil, err
	}
	if len(items) > maxItems {
		return nil, fmt.Errorf("%s must contain at most %d item(s)", key, maxItems)
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		value, err := readOptionalString(item)
		if err != nil || value == nil || !projectUUIDPattern.MatchString(*value) {
			return nil, fmt.Errorf("%s items must be a UUID", key)
		}
		values = append(values, *value)
	}
	return values, nil
}

func messagingTrimsToString(fields map[string]json.RawMessage, key string, minLength, maxLength int) (*string, error) {
	value, err := messagingOptionalString(fields, key)
	if err != nil || value == nil {
		return nil, err
	}
	trimmed := strings.TrimFunc(*value, isJSWhitespace)
	length := utf16Length(trimmed)
	if length < minLength {
		return nil, fmt.Errorf("%s must contain at least %d character(s)", key, minLength)
	}
	if length > maxLength {
		return nil, fmt.Errorf("%s must be at most %d characters", key, maxLength)
	}
	return &trimmed, nil
}

func messagingParseDateTime(value string) (time.Time, error) {
	if !messagingDateTimePattern.MatchString(value) {
		return time.Time{}, errors.New("must be an ISO datetime")
	}
	// Go's RFC 3339 layouts require seconds, while zod's datetime() accepts a
	// bare hour and minute.
	candidate := value
	if len(value) == len("2006-01-02T15:04Z") {
		candidate = value[:len(value)-1] + ":00Z"
	}
	parsed, err := time.Parse(time.RFC3339Nano, candidate)
	if err != nil {
		return time.Time{}, errors.New("must be an ISO datetime")
	}
	return parsed.UTC(), nil
}

func messagingOptionalDateTime(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok || messagingIsNull(raw) {
		if ok {
			return nil, nil
		}
		return nil, fmt.Errorf("%s is required", key)
	}
	value, err := readOptionalString(raw)
	if err != nil || value == nil {
		return nil, fmt.Errorf("%s must be an ISO datetime", key)
	}
	if _, err := messagingParseDateTime(*value); err != nil {
		return nil, fmt.Errorf("%s must be an ISO datetime", key)
	}
	return value, nil
}

func messagingOptionalDateTimeString(fields map[string]json.RawMessage, key string) (*string, error) {
	value, err := messagingOptionalDateTime(fields, key)
	if err != nil || value == nil {
		return nil, err
	}
	parsed, _ := messagingParseDateTime(*value)
	formatted := messagingFormatTime(parsed)
	return &formatted, nil
}

func messagingMaybeDateTimeString(fields map[string]json.RawMessage, key string) (*string, error) {
	value, err := optionalString(fields, key)
	if err != nil || value == nil {
		return value, err
	}
	parsed, err := messagingParseDateTime(*value)
	if err != nil {
		return nil, fmt.Errorf("%s must be an ISO datetime", key)
	}
	formatted := messagingFormatTime(parsed)
	return &formatted, nil
}

func messagingRequiredDateTimeString(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := messagingRequiredString(fields, key)
	if err != nil {
		return "", err
	}
	parsed, err := messagingParseDateTime(value)
	if err != nil {
		return "", fmt.Errorf("%s must be an ISO datetime", key)
	}
	return messagingFormatTime(parsed), nil
}

func messagingFormatTime(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func messagingFormatOptionalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := messagingFormatTime(*value)
	return &formatted
}

func messagingNow() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

func messagingNextEditTime(previous *time.Time) time.Time {
	next := messagingNow()
	if previous != nil {
		previousMillisecond := previous.UTC().Truncate(time.Millisecond)
		if !next.After(previousMillisecond) {
			next = previousMillisecond.Add(time.Millisecond)
		}
	}
	return next
}

func messagingSupportedReaction(emoji string) bool {
	for _, supported := range messagingReactionEmoji {
		if emoji == supported {
			return true
		}
	}
	return false
}

func parseMessagingSendMessageInput(raw json.RawMessage) (MessagingSendMessageInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingSendMessageInput{}, err
	}
	var input MessagingSendMessageInput
	if input.ConversationID, err = messagingRequiredString(fields, "conversationId"); err != nil {
		return MessagingSendMessageInput{}, err
	}
	if input.Body, err = requiredCRMDealString(fields, "body", 0, messagingBodyMax); err != nil {
		return MessagingSendMessageInput{}, err
	}
	if input.ParentMessageID, err = projectOptionalUUID(fields, "parentMessageId"); err != nil {
		return MessagingSendMessageInput{}, err
	}
	if input.AttachmentIDs, err = messagingStringArrayUUIDs(fields, "attachmentIds", messagingAttachmentCountMax); err != nil {
		return MessagingSendMessageInput{}, err
	}
	mentions, err := messagingOptionalArray(fields, "mentions")
	if err != nil {
		return MessagingSendMessageInput{}, err
	}
	if mentions != nil {
		if len(mentions) > messagingMentionCountMax {
			return MessagingSendMessageInput{}, fmt.Errorf("mentions must contain at most %d item(s)", messagingMentionCountMax)
		}
		for _, rawMention := range mentions {
			mentionFields, err := decodeJSONObject(rawMention)
			if err != nil {
				return MessagingSendMessageInput{}, errors.New("mentions items must be an object")
			}
			mention := MessagingMention{}
			if mention.Type, err = messagingRequiredString(mentionFields, "type"); err != nil {
				return MessagingSendMessageInput{}, err
			}
			if mention.Type != "user" && mention.Type != "agent" {
				return MessagingSendMessageInput{}, errors.New("mentions type must be user or agent")
			}
			if mention.ID, err = requiredCRMDealString(mentionFields, "id", 1, messagingMentionIDMax); err != nil {
				return MessagingSendMessageInput{}, err
			}
			input.Mentions = append(input.Mentions, mention)
		}
	}
	return input, nil
}

func parseMessagingListConversationsInput(raw json.RawMessage) (MessagingListConversationsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingListConversationsInput{}, err
	}
	var input MessagingListConversationsInput
	if input.Query, err = messagingTrimsToString(fields, "query", 0, messagingQueryMax); err != nil {
		return MessagingListConversationsInput{}, err
	}
	if input.Limit, err = messagingBoundedLimit(fields, "limit", messagingConversationListLimit); err != nil {
		return MessagingListConversationsInput{}, err
	}
	return input, nil
}

func parseMessagingReadMessagesInput(raw json.RawMessage) (MessagingReadMessagesInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingReadMessagesInput{}, err
	}
	var input MessagingReadMessagesInput
	if input.ConversationID, err = messagingRequiredString(fields, "conversationId"); err != nil {
		return MessagingReadMessagesInput{}, err
	}
	if input.Limit, err = messagingBoundedLimit(fields, "limit", messagingReadMessagesDefLimit); err != nil {
		return MessagingReadMessagesInput{}, err
	}
	if input.Before, err = projectOptionalUUID(fields, "before"); err != nil {
		return MessagingReadMessagesInput{}, err
	}
	if input.Around, err = projectOptionalUUID(fields, "around"); err != nil {
		return MessagingReadMessagesInput{}, err
	}
	if input.Before != nil && input.Around != nil {
		return MessagingReadMessagesInput{}, errors.New("before and around cannot be combined")
	}
	return input, nil
}

func parseMessagingListPeopleInput(raw json.RawMessage) (MessagingListPeopleInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingListPeopleInput{}, err
	}
	var input MessagingListPeopleInput
	if input.Query, err = messagingTrimsToString(fields, "query", 1, messagingPeopleQueryMax); err != nil {
		return MessagingListPeopleInput{}, err
	}
	if _, ok := fields["limit"]; ok {
		limit, err := requiredSafeInteger(fields, "limit")
		if err != nil {
			return MessagingListPeopleInput{}, err
		}
		if limit < 1 || limit > messagingListItemLimitMax {
			return MessagingListPeopleInput{}, fmt.Errorf("limit must be between 1 and %d", messagingListItemLimitMax)
		}
		input.Limit = &limit
	}
	return input, nil
}

func parseMessagingCreateConversationInput(raw json.RawMessage) (MessagingCreateConversationInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingCreateConversationInput{}, err
	}
	var input MessagingCreateConversationInput
	if input.Title, err = requiredCRMDealString(fields, "title", 1, messagingTitleMax); err != nil {
		return MessagingCreateConversationInput{}, err
	}
	input.Kind = messagingConversationKindChannl
	if _, ok := fields["kind"]; ok {
		if input.Kind, err = messagingRequiredString(fields, "kind"); err != nil {
			return MessagingCreateConversationInput{}, err
		}
		if input.Kind != messagingConversationKindChannl && input.Kind != messagingConversationKindDM {
			return MessagingCreateConversationInput{}, errors.New("kind must be channel or dm")
		}
	}
	if _, ok := fields["agentEnabled"]; ok {
		if input.AgentEnabled, err = messagingRequiredBool(fields, "agentEnabled"); err != nil {
			return MessagingCreateConversationInput{}, err
		}
	}
	return input, nil
}

func parseMessagingUpdateConversationInput(raw json.RawMessage) (MessagingUpdateConversationInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingUpdateConversationInput{}, err
	}
	var input MessagingUpdateConversationInput
	if input.ConversationID, err = messagingRequiredString(fields, "conversationId"); err != nil {
		return MessagingUpdateConversationInput{}, err
	}
	if input.Title, err = messagingTrimsToString(fields, "title", 1, messagingTitleMax); err != nil {
		return MessagingUpdateConversationInput{}, err
	}
	if input.AgentEnabled, err = messagingOptionalBool(fields, "agentEnabled"); err != nil {
		return MessagingUpdateConversationInput{}, err
	}
	return input, nil
}

func parseMessagingArchiveConversationInput(raw json.RawMessage) (MessagingArchiveConversationInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingArchiveConversationInput{}, err
	}
	var input MessagingArchiveConversationInput
	if input.ConversationID, err = messagingRequiredString(fields, "conversationId"); err != nil {
		return MessagingArchiveConversationInput{}, err
	}
	input.Archived = true
	if _, ok := fields["archived"]; ok {
		if input.Archived, err = messagingRequiredBool(fields, "archived"); err != nil {
			return MessagingArchiveConversationInput{}, err
		}
	}
	return input, nil
}

func parseMessagingConversationIDInput(raw json.RawMessage) (MessagingConversationIDInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingConversationIDInput{}, err
	}
	var input MessagingConversationIDInput
	if input.ConversationID, err = messagingRequiredString(fields, "conversationId"); err != nil {
		return MessagingConversationIDInput{}, err
	}
	return input, nil
}

func parseMessagingAddMemberInput(raw json.RawMessage) (MessagingAddMemberInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingAddMemberInput{}, err
	}
	var input MessagingAddMemberInput
	if input.ConversationID, err = messagingRequiredString(fields, "conversationId"); err != nil {
		return MessagingAddMemberInput{}, err
	}
	if input.UserID, err = projectRequiredUUID(fields, "userId"); err != nil {
		return MessagingAddMemberInput{}, err
	}
	return input, nil
}

func parseMessagingEditMessageInput(raw json.RawMessage) (MessagingEditMessageInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingEditMessageInput{}, err
	}
	var input MessagingEditMessageInput
	if input.MessageID, err = messagingRequiredString(fields, "messageId"); err != nil {
		return MessagingEditMessageInput{}, err
	}
	if input.Body, err = requiredCRMDealString(fields, "body", 1, messagingBodyMax); err != nil {
		return MessagingEditMessageInput{}, err
	}
	if input.ExpectedBody, err = messagingOptionalBoundedString(fields, "expectedBody", 0, messagingBodyMax); err != nil {
		return MessagingEditMessageInput{}, err
	}
	if input.ExpectedEditedAt, err = messagingMaybeDateTimeString(fields, "expectedEditedAt"); err != nil {
		return MessagingEditMessageInput{}, err
	}
	return input, nil
}

func parseMessagingRestoreMessageEditInput(raw json.RawMessage) (MessagingRestoreMessageEditInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingRestoreMessageEditInput{}, err
	}
	var input MessagingRestoreMessageEditInput
	if input.MessageID, err = messagingRequiredString(fields, "messageId"); err != nil {
		return MessagingRestoreMessageEditInput{}, err
	}
	if input.Body, err = requiredCRMDealString(fields, "body", 0, messagingBodyMax); err != nil {
		return MessagingRestoreMessageEditInput{}, err
	}
	if input.ExpectedBody, err = requiredCRMDealString(fields, "expectedBody", 0, messagingBodyMax); err != nil {
		return MessagingRestoreMessageEditInput{}, err
	}
	if input.ExpectedEditedAt, err = messagingRequiredDateTimeString(fields, "expectedEditedAt"); err != nil {
		return MessagingRestoreMessageEditInput{}, err
	}
	return input, nil
}

func messagingOptionalBoundedString(fields map[string]json.RawMessage, key string, minLength, maxLength int) (*string, error) {
	value, err := optionalString(fields, key)
	if err != nil || value == nil {
		return value, err
	}
	if len(*value) < minLength || len(*value) > maxLength {
		return nil, fmt.Errorf("%s must contain between %d and %d characters", key, minLength, maxLength)
	}
	return value, nil
}

func parseMessagingDeleteMessageInput(raw json.RawMessage) (MessagingDeleteMessageInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingDeleteMessageInput{}, err
	}
	var input MessagingDeleteMessageInput
	if input.MessageID, err = messagingRequiredString(fields, "messageId"); err != nil {
		return MessagingDeleteMessageInput{}, err
	}
	if rawExpected, ok := fields["expectedDeletedAt"]; ok {
		input.ExpectedDeletedAtProvided = true
		if !bytes.Equal(bytes.TrimSpace(rawExpected), []byte("null")) {
			var expected string
			if err := json.Unmarshal(rawExpected, &expected); err != nil {
				return MessagingDeleteMessageInput{}, errors.New("expectedDeletedAt must be an ISO datetime or null")
			}
			parsed, err := messagingParseDateTime(expected)
			if err != nil {
				return MessagingDeleteMessageInput{}, errors.New("expectedDeletedAt must be an ISO datetime or null")
			}
			formatted := messagingFormatTime(parsed)
			input.ExpectedDeletedAt = &formatted
		}
	}
	return input, nil
}

func parseMessagingRestoreMessageDeleteInput(raw json.RawMessage) (MessagingRestoreMessageDeleteInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingRestoreMessageDeleteInput{}, err
	}
	var input MessagingRestoreMessageDeleteInput
	if input.MessageID, err = messagingRequiredString(fields, "messageId"); err != nil {
		return MessagingRestoreMessageDeleteInput{}, err
	}
	deletedAtRaw, ok := fields["deletedAt"]
	if !ok {
		return MessagingRestoreMessageDeleteInput{}, errors.New("deletedAt is required")
	}
	if !bytes.Equal(bytes.TrimSpace(deletedAtRaw), []byte("null")) {
		var deletedAt string
		if err := json.Unmarshal(deletedAtRaw, &deletedAt); err != nil {
			return MessagingRestoreMessageDeleteInput{}, errors.New("deletedAt must be an ISO datetime or null")
		}
		parsed, err := messagingParseDateTime(deletedAt)
		if err != nil {
			return MessagingRestoreMessageDeleteInput{}, errors.New("deletedAt must be an ISO datetime or null")
		}
		formatted := messagingFormatTime(parsed)
		input.DeletedAt = &formatted
	}
	if input.ExpectedDeletedAt, err = messagingRequiredDateTimeString(fields, "expectedDeletedAt"); err != nil {
		return MessagingRestoreMessageDeleteInput{}, err
	}
	return input, nil
}

func parseMessagingAdvanceReadCursorInput(raw json.RawMessage) (MessagingAdvanceReadCursorInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingAdvanceReadCursorInput{}, err
	}
	var input MessagingAdvanceReadCursorInput
	if input.ConversationID, err = projectRequiredUUID(fields, "conversationId"); err != nil {
		return MessagingAdvanceReadCursorInput{}, err
	}
	if _, ok := fields["readAt"]; !ok {
		return input, nil
	}
	input.ReadAtProvided = true
	if input.ReadAt, err = messagingOptionalDateTime(fields, "readAt"); err != nil {
		return MessagingAdvanceReadCursorInput{}, err
	}
	return input, nil
}

func parseMessagingRestoreReadCursorInput(raw json.RawMessage) (MessagingRestoreReadCursorInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingRestoreReadCursorInput{}, err
	}
	var input MessagingRestoreReadCursorInput
	if input.ConversationID, err = projectRequiredUUID(fields, "conversationId"); err != nil {
		return MessagingRestoreReadCursorInput{}, err
	}
	if input.ReadAt, err = messagingOptionalDateTime(fields, "readAt"); err != nil {
		return MessagingRestoreReadCursorInput{}, err
	}
	return input, nil
}

func parseMessagingMessageReactionInput(raw json.RawMessage) (MessagingMessageReactionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingMessageReactionInput{}, err
	}
	var input MessagingMessageReactionInput
	if input.MessageID, err = projectRequiredUUID(fields, "messageId"); err != nil {
		return MessagingMessageReactionInput{}, err
	}
	if input.Emoji, err = messagingRequiredString(fields, "emoji"); err != nil {
		return MessagingMessageReactionInput{}, err
	}
	if !messagingSupportedReaction(input.Emoji) {
		return MessagingMessageReactionInput{}, errors.New("emoji is not a supported reaction")
	}
	if input.Active, err = messagingRequiredBool(fields, "active"); err != nil {
		return MessagingMessageReactionInput{}, err
	}
	return input, nil
}

func parseMessagingMessagePinInput(raw json.RawMessage) (MessagingMessagePinInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingMessagePinInput{}, err
	}
	var input MessagingMessagePinInput
	if input.MessageID, err = projectRequiredUUID(fields, "messageId"); err != nil {
		return MessagingMessagePinInput{}, err
	}
	if input.Pinned, err = messagingRequiredBool(fields, "pinned"); err != nil {
		return MessagingMessagePinInput{}, err
	}
	return input, nil
}

func parseMessagingUpdateConversationPresenceInput(raw json.RawMessage) (MessagingUpdateConversationPresenceInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingUpdateConversationPresenceInput{}, err
	}
	var input MessagingUpdateConversationPresenceInput
	if input.ConversationID, err = projectRequiredUUID(fields, "conversationId"); err != nil {
		return MessagingUpdateConversationPresenceInput{}, err
	}
	if input.Typing, err = messagingRequiredBool(fields, "typing"); err != nil {
		return MessagingUpdateConversationPresenceInput{}, err
	}
	return input, nil
}

func parseMessagingRestoreConversationPresenceInput(raw json.RawMessage) (MessagingRestoreConversationPresenceInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingRestoreConversationPresenceInput{}, err
	}
	var input MessagingRestoreConversationPresenceInput
	if input.ConversationID, err = projectRequiredUUID(fields, "conversationId"); err != nil {
		return MessagingRestoreConversationPresenceInput{}, err
	}
	if input.LastSeenAt, err = messagingOptionalDateTimeString(fields, "lastSeenAt"); err != nil {
		return MessagingRestoreConversationPresenceInput{}, err
	}
	if input.TypingUntil, err = messagingOptionalDateTimeString(fields, "typingUntil"); err != nil {
		return MessagingRestoreConversationPresenceInput{}, err
	}
	return input, nil
}

func parseMessagingUploadMessageAttachmentInput(raw json.RawMessage) (MessagingUploadMessageAttachmentInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingUploadMessageAttachmentInput{}, err
	}
	var input MessagingUploadMessageAttachmentInput
	if input.ConversationID, err = projectRequiredUUID(fields, "conversationId"); err != nil {
		return MessagingUploadMessageAttachmentInput{}, err
	}
	if input.Filename, err = requiredCRMDealString(fields, "filename", 1, messagingFilenameMax); err != nil {
		return MessagingUploadMessageAttachmentInput{}, err
	}
	if input.MimeType, err = requiredCRMDealString(fields, "mimeType", 1, messagingMimeTypeMax); err != nil {
		return MessagingUploadMessageAttachmentInput{}, err
	}
	if input.ContentBase64, err = requiredCRMDealString(fields, "contentBase64", 4, messagingContentBase64Max); err != nil {
		return MessagingUploadMessageAttachmentInput{}, err
	}
	return input, nil
}

func parseMessagingDeletePendingAttachmentInput(raw json.RawMessage) (MessagingDeletePendingAttachmentInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return MessagingDeletePendingAttachmentInput{}, err
	}
	var input MessagingDeletePendingAttachmentInput
	if input.AttachmentID, err = projectRequiredUUID(fields, "attachmentId"); err != nil {
		return MessagingDeletePendingAttachmentInput{}, err
	}
	return input, nil
}

type messagingConversation struct {
	ID              string
	Kind            string
	Title           string
	CreatedByUserID *string
}

func messagingLoadConversation(ctx context.Context, tx pgx.Tx, orgID, conversationID string) (*messagingConversation, error) {
	var conversation messagingConversation
	err := tx.QueryRow(ctx, `
		SELECT id::text, kind, title, created_by_user_id::text
		FROM conversations
		WHERE id = $2::uuid AND org_id = $1::uuid AND deleted_at IS NULL
		LIMIT 1`, orgID, conversationID).Scan(&conversation.ID, &conversation.Kind, &conversation.Title, &conversation.CreatedByUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &conversation, nil
}

// Membership is the tenant boundary for internal messaging: org scope alone
// never confers access, because DMs are membership-scoped.
func messagingIsMember(ctx context.Context, tx pgx.Tx, orgID, conversationID string, userID *string) (bool, error) {
	if userID == nil {
		return false, nil
	}
	var member bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members m
			JOIN conversations c ON c.id = m.conversation_id
			WHERE m.conversation_id = $2::uuid AND m.user_id = $3::uuid AND c.org_id = $1::uuid
		)`, orgID, conversationID, *userID).Scan(&member)
	return member, err
}

func messagingRequireMember(ctx context.Context, tx pgx.Tx, orgID, conversationID string, userID *string) error {
	member, err := messagingIsMember(ctx, tx, orgID, conversationID, userID)
	if err != nil {
		return err
	}
	if !member {
		return errors.New("you are not a member of this conversation")
	}
	return nil
}

func messagingSendMessage(
	ctx context.Context, tx pgx.Tx, orgID, actorType string, userID *string,
	input MessagingSendMessageInput,
) (MessagingSendMessageOutput, error) {
	conversation, err := messagingLoadConversation(ctx, tx, orgID, input.ConversationID)
	if err != nil {
		return MessagingSendMessageOutput{}, err
	}
	if conversation == nil {
		return MessagingSendMessageOutput{}, errors.New("conversation not found")
	}
	if err := messagingRequireMember(ctx, tx, orgID, conversation.ID, userID); err != nil {
		return MessagingSendMessageOutput{}, err
	}
	if strings.TrimFunc(input.Body, isJSWhitespace) == "" && len(input.AttachmentIDs) == 0 {
		return MessagingSendMessageOutput{}, errors.New("write a message or attach a file")
	}
	if input.ParentMessageID != nil {
		var parentID string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM messages
			WHERE id = $2::uuid AND conversation_id = $3::uuid AND org_id = $1::uuid AND deleted_at IS NULL
			LIMIT 1`, orgID, *input.ParentMessageID, input.ConversationID).Scan(&parentID)
		if errors.Is(err, pgx.ErrNoRows) {
			return MessagingSendMessageOutput{}, errors.New("reply target not found in this conversation")
		}
		if err != nil {
			return MessagingSendMessageOutput{}, err
		}
	}
	senderType := "human"
	if actorType == "agent" {
		senderType = "agent"
	}
	var senderUserID *string
	if actorType == "human" {
		senderUserID = userID
	}
	var mentionsJSON []byte
	if len(input.Mentions) > 0 {
		if mentionsJSON, err = marshalJS(input.Mentions); err != nil {
			return MessagingSendMessageOutput{}, err
		}
	}
	var messageID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO messages (org_id, conversation_id, sender_type, sender_user_id, body, mentions, parent_message_id)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::jsonb, $7::uuid)
		RETURNING id::text`, orgID, input.ConversationID, senderType, senderUserID, input.Body, mentionsJSON, input.ParentMessageID).Scan(&messageID); err != nil {
		return MessagingSendMessageOutput{}, err
	}
	if len(input.AttachmentIDs) > 0 {
		if userID == nil || actorType != "human" {
			return MessagingSendMessageOutput{}, errors.New("only people can attach files")
		}
		attachmentIDs := uniqueMessagingIDs(input.AttachmentIDs)
		rows, err := tx.Query(ctx, `
			SELECT id::text FROM message_attachments
			WHERE id = ANY($2::uuid[]) AND org_id = $1::uuid
			  AND conversation_id = $3::uuid AND uploaded_by_user_id = $4::uuid AND message_id IS NULL
			ORDER BY id FOR UPDATE`,
			orgID, attachmentIDs, input.ConversationID, *userID)
		if err != nil {
			return MessagingSendMessageOutput{}, err
		}
		owned := 0
		for rows.Next() {
			owned++
			if err := rows.Err(); err != nil {
				rows.Close()
				return MessagingSendMessageOutput{}, err
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return MessagingSendMessageOutput{}, err
		}
		rows.Close()
		if owned != len(attachmentIDs) {
			return MessagingSendMessageOutput{}, errors.New("one or more attachments expired or are unavailable")
		}
		linked, err := tx.Exec(ctx, `
			UPDATE message_attachments SET message_id = $3::uuid
			WHERE id = ANY($2::uuid[]) AND org_id = $1::uuid
			  AND conversation_id = $4::uuid AND uploaded_by_user_id = $5::uuid AND message_id IS NULL`,
			orgID, attachmentIDs, messageID, input.ConversationID, *userID)
		if err != nil {
			return MessagingSendMessageOutput{}, err
		}
		if linked.RowsAffected() != int64(len(attachmentIDs)) {
			return MessagingSendMessageOutput{}, errors.New("one or more attachments expired or are unavailable")
		}
	}
	if len(input.Mentions) > 0 && actorType == "human" {
		if err := messagingNotifyMentions(ctx, tx, orgID, conversation, userID, input.Mentions, input.Body); err != nil {
			return MessagingSendMessageOutput{}, err
		}
	}
	return MessagingSendMessageOutput{MessageID: messageID}, nil
}

func uniqueMessagingIDs(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	unique := make([]string, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	return unique
}

func messagingNotifyMentions(
	ctx context.Context, tx pgx.Tx, orgID string, conversation *messagingConversation,
	senderID *string, mentions []MessagingMention, body string,
) error {
	var name, email *string
	err := tx.QueryRow(ctx, `SELECT name, email FROM users WHERE id = $1::uuid LIMIT 1`, *senderID).Scan(&name, &email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	senderLabel := "A colleague"
	if name != nil {
		senderLabel = *name
	} else if email != nil {
		senderLabel = *email
	}
	rows, err := tx.Query(ctx, `SELECT user_id::text FROM conversation_members WHERE conversation_id = $1::uuid`, conversation.ID)
	if err != nil {
		return err
	}
	memberIDs := map[string]struct{}{}
	for rows.Next() {
		var memberID string
		if err := rows.Scan(&memberID); err != nil {
			rows.Close()
			return err
		}
		memberIDs[memberID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	notificationBody := sliceUTF16CodeUnits(body, messagingNotificationBodyMax)
	title := fmt.Sprintf("%s mentioned you in %s", senderLabel, conversation.Title)
	for _, mention := range mentions {
		if mention.Type != "user" || senderID == nil || mention.ID == *senderID {
			continue
		}
		if _, ok := memberIDs[mention.ID]; !ok {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO notifications (org_id, user_id, kind, title, body, href)
			VALUES ($1::uuid, $2::uuid, 'mention', $3, $4, '/messages')`, orgID, mention.ID, title, notificationBody); err != nil {
			return err
		}
	}
	return nil
}

func messagingListConversations(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string,
) (MessagingListConversationsOutput, error) {
	// The capability accepts query and limit for wire compatibility. This
	// response lists the newest 100 memberships so Vite sees the full window.
	output := MessagingListConversationsOutput{Conversations: []MessagingConversationListItem{}}
	if userID == nil {
		return output, nil
	}
	output.Me = *userID
	rows, err := tx.Query(ctx, `
		SELECT c.id::text, c.kind, c.title, c.agent_enabled, c.archived_at,
		       c.created_by_user_id::text, last.created_at, last.body,
		       COALESCE(unread.count, 0)
		FROM conversations c
		JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $2::uuid
		LEFT JOIN LATERAL (
			SELECT msg.created_at, msg.body FROM messages msg
			WHERE msg.conversation_id = c.id AND msg.org_id = $1::uuid AND msg.deleted_at IS NULL
			ORDER BY msg.created_at DESC, msg.id DESC LIMIT 1
		) last ON true
		LEFT JOIN LATERAL (
			SELECT count(*) AS count FROM messages msg
			WHERE msg.conversation_id = c.id AND msg.org_id = $1::uuid AND msg.deleted_at IS NULL
			  AND msg.created_at > COALESCE(m.last_read_at, m.joined_at)
			  AND (msg.sender_user_id IS NULL OR msg.sender_user_id <> $2::uuid)
		) unread ON true
		WHERE c.org_id = $1::uuid AND c.deleted_at IS NULL
		ORDER BY c.created_at DESC
		LIMIT $3`, orgID, *userID, messagingConversationListLimit)
	if err != nil {
		return MessagingListConversationsOutput{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var item MessagingConversationListItem
		var archivedAt, lastMessageAt *time.Time
		var lastMessageBody *string
		var createdByUserID *string
		if err := rows.Scan(&item.ID, &item.Kind, &item.Title, &item.AgentEnabled, &archivedAt, &createdByUserID, &lastMessageAt, &lastMessageBody, &item.UnreadCount); err != nil {
			return MessagingListConversationsOutput{}, err
		}
		item.ArchivedAt = messagingFormatOptionalTime(archivedAt)
		if lastMessageAt != nil {
			body := "📎 Shared a file"
			if lastMessageBody != nil && *lastMessageBody != "" {
				body = *lastMessageBody
			}
			bodyRunes := []rune(body)
			if len(bodyRunes) > 80 {
				body = string(bodyRunes[:80])
			}
			item.LastMessage = &MessagingConversationLastMessage{At: messagingFormatTime(*lastMessageAt), Body: body}
		}
		item.CreatedByMe = createdByUserID != nil && userID != nil && *createdByUserID == *userID
		output.Conversations = append(output.Conversations, item)
	}
	if err := rows.Err(); err != nil {
		return MessagingListConversationsOutput{}, err
	}
	return output, nil
}

func messagingReadMessages(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingReadMessagesInput,
) (MessagingReadMessagesOutput, error) {
	if userID == nil || strings.TrimSpace(*userID) == "" {
		return MessagingReadMessagesOutput{}, errors.New("conversation not found")
	}
	conversation, err := messagingLoadConversation(ctx, tx, orgID, input.ConversationID)
	if err != nil {
		return MessagingReadMessagesOutput{}, err
	}
	if conversation == nil {
		return MessagingReadMessagesOutput{}, errors.New("conversation not found")
	}
	if err := messagingRequireMember(ctx, tx, orgID, conversation.ID, userID); err != nil {
		return MessagingReadMessagesOutput{}, err
	}
	var conversationSnapshot MessagingConversationSnapshot
	var conversationCreatedAt time.Time
	var conversationArchivedAt, conversationDeletedAt *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT id::text, org_id::text, kind, title, agent_enabled, created_by_user_id::text,
		       created_at, archived_at, deleted_at
		FROM conversations
		WHERE id = $2::uuid AND org_id = $1::uuid AND deleted_at IS NULL`,
		orgID, input.ConversationID,
	).Scan(
		&conversationSnapshot.ID, &conversationSnapshot.OrgID, &conversationSnapshot.Kind,
		&conversationSnapshot.Title, &conversationSnapshot.AgentEnabled,
		&conversationSnapshot.CreatedByUserID, &conversationCreatedAt,
		&conversationArchivedAt, &conversationDeletedAt,
	); err != nil {
		return MessagingReadMessagesOutput{}, err
	}
	conversationSnapshot.CreatedAt = messagingFormatTime(conversationCreatedAt)
	conversationSnapshot.ArchivedAt = messagingFormatOptionalTime(conversationArchivedAt)
	conversationSnapshot.DeletedAt = messagingFormatOptionalTime(conversationDeletedAt)

	var beforeCreatedAt *time.Time
	if input.Before != nil {
		var cursorCreatedAt time.Time
		if err := tx.QueryRow(ctx, `
			SELECT created_at FROM messages
			WHERE id = $3::uuid AND conversation_id = $2::uuid AND org_id = $1::uuid AND deleted_at IS NULL`,
			orgID, input.ConversationID, *input.Before,
		).Scan(&cursorCreatedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return MessagingReadMessagesOutput{}, errors.New("message cursor not found")
			}
			return MessagingReadMessagesOutput{}, err
		}
		beforeCreatedAt = &cursorCreatedAt
	}

	var rows pgx.Rows
	aroundRead := input.Around != nil
	if aroundRead {
		var targetCreatedAt time.Time
		if err := tx.QueryRow(ctx, `
			SELECT created_at FROM messages
			WHERE id = $3::uuid AND conversation_id = $2::uuid AND org_id = $1::uuid AND deleted_at IS NULL`,
			orgID, input.ConversationID, *input.Around,
		).Scan(&targetCreatedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return MessagingReadMessagesOutput{}, errors.New("message not found")
			}
			return MessagingReadMessagesOutput{}, err
		}
		rows, err = tx.Query(ctx, `
			WITH older_all AS MATERIALIZED (
				SELECT id, created_at FROM messages
				WHERE conversation_id = $2::uuid AND org_id = $1::uuid AND deleted_at IS NULL
				  AND (created_at, id) < ($3::timestamptz, $4::uuid)
				ORDER BY created_at DESC, id DESC LIMIT 31
			), selected AS (
				(SELECT id, created_at FROM older_all ORDER BY created_at DESC, id DESC LIMIT 30)
				UNION ALL (SELECT id, created_at FROM messages
				 WHERE id = $4::uuid AND conversation_id = $2::uuid AND org_id = $1::uuid AND deleted_at IS NULL)
				UNION ALL (SELECT id, created_at FROM messages
				 WHERE conversation_id = $2::uuid AND org_id = $1::uuid AND deleted_at IS NULL
				   AND (created_at, id) > ($3::timestamptz, $4::uuid)
				 ORDER BY created_at ASC, id ASC LIMIT 30)
			)
			SELECT m.id::text, m.sender_type, m.sender_user_id::text, m.body, m.created_at, m.edited_at,
			       m.parent_message_id::text, m.pinned_at, m.mentions,
			       (SELECT count(*) > 30 FROM older_all) AS has_more
			FROM selected s JOIN messages m ON m.id = s.id
			ORDER BY s.created_at ASC, s.id ASC`, orgID, input.ConversationID, targetCreatedAt, *input.Around)
	} else {
		rows, err = tx.Query(ctx, `
		SELECT id::text, sender_type, sender_user_id::text, body, created_at, edited_at,
		       parent_message_id::text, pinned_at, mentions
		FROM messages
		WHERE conversation_id = $2::uuid AND org_id = $1::uuid AND deleted_at IS NULL
		  AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
		ORDER BY created_at DESC, id DESC
		LIMIT $3`, orgID, input.ConversationID, input.Limit+1, beforeCreatedAt, input.Before)
	}
	if err != nil {
		return MessagingReadMessagesOutput{}, err
	}
	defer rows.Close()
	output := MessagingReadMessagesOutput{
		Conversation:   conversationSnapshot,
		Messages:       []MessagingMessageSnapshot{},
		Me:             *userID,
		Readers:        []MessagingReaderSnapshot{},
		PinnedMessages: []MessagingPinnedMessageSnapshot{},
	}
	for rows.Next() {
		var message MessagingMessageSnapshot
		var createdAt time.Time
		var editedAt, pinnedAt *time.Time
		var aroundHasMore bool
		if aroundRead {
			err = rows.Scan(
				&message.ID, &message.SenderType, &message.SenderUserID, &message.Body,
				&createdAt, &editedAt, &message.ParentMessageID, &pinnedAt, &message.Mentions, &aroundHasMore,
			)
		} else {
			err = rows.Scan(
				&message.ID, &message.SenderType, &message.SenderUserID, &message.Body,
				&createdAt, &editedAt, &message.ParentMessageID, &pinnedAt, &message.Mentions,
			)
		}
		if err != nil {
			return MessagingReadMessagesOutput{}, err
		}
		if aroundRead {
			output.HasMore = aroundHasMore
		}
		message.CreatedAt = messagingFormatTime(createdAt)
		message.EditedAt = messagingFormatOptionalTime(editedAt)
		message.PinnedAt = messagingFormatOptionalTime(pinnedAt)
		message.Mentions, err = messagingNormalizeMentions(message.Mentions)
		if err != nil {
			return MessagingReadMessagesOutput{}, err
		}
		message.Attachments = []MessagingMessageAttachment{}
		message.Reactions = []MessagingMessageReaction{}
		output.Messages = append(output.Messages, message)
	}
	if err := rows.Err(); err != nil {
		return MessagingReadMessagesOutput{}, err
	}
	if !aroundRead && int64(len(output.Messages)) > input.Limit {
		output.HasMore = true
		output.Messages = output.Messages[:input.Limit]
	}
	if !aroundRead {
		for left, right := 0, len(output.Messages)-1; left < right; left, right = left+1, right-1 {
			output.Messages[left], output.Messages[right] = output.Messages[right], output.Messages[left]
		}
	}
	if output.HasMore && len(output.Messages) > 0 {
		cursor := output.Messages[0].ID
		output.NextCursor = &cursor
	}
	rows.Close()

	messageIDs := make([]string, 0, len(output.Messages))
	messageIndex := make(map[string]int, len(output.Messages))
	for index := range output.Messages {
		messageIDs = append(messageIDs, output.Messages[index].ID)
		messageIndex[output.Messages[index].ID] = index
	}
	if len(messageIDs) > 0 {
		attachmentRows, err := tx.Query(ctx, `
			SELECT id::text, message_id::text, filename, mime_type, size_bytes
			FROM message_attachments
			WHERE org_id = $1::uuid AND conversation_id = $2::uuid AND message_id = ANY($3::uuid[])
			ORDER BY created_at ASC, id ASC`, orgID, input.ConversationID, messageIDs)
		if err != nil {
			return MessagingReadMessagesOutput{}, err
		}
		for attachmentRows.Next() {
			var attachment MessagingMessageAttachment
			var messageID string
			if err := attachmentRows.Scan(&attachment.ID, &messageID, &attachment.Filename, &attachment.MimeType, &attachment.SizeBytes); err != nil {
				attachmentRows.Close()
				return MessagingReadMessagesOutput{}, err
			}
			attachment.Href = "/api/message-attachments/" + attachment.ID
			if index, ok := messageIndex[messageID]; ok {
				output.Messages[index].Attachments = append(output.Messages[index].Attachments, attachment)
			}
		}
		if err := attachmentRows.Err(); err != nil {
			attachmentRows.Close()
			return MessagingReadMessagesOutput{}, err
		}
		attachmentRows.Close()

		reactionRows, err := tx.Query(ctx, `
			SELECT mr.message_id::text, mr.emoji, mr.user_id::text, COALESCE(u.name, u.email)
			FROM message_reactions mr
			JOIN users u ON u.id = mr.user_id
			WHERE mr.org_id = $1::uuid AND mr.message_id = ANY($2::uuid[])
			ORDER BY mr.message_id, mr.emoji, COALESCE(u.name, u.email), mr.user_id`, orgID, messageIDs)
		if err != nil {
			return MessagingReadMessagesOutput{}, err
		}
		type reactionKey struct{ messageID, emoji string }
		reactionIndexes := make(map[reactionKey]int)
		for reactionRows.Next() {
			var messageID, emoji, reactorID, name string
			if err := reactionRows.Scan(&messageID, &emoji, &reactorID, &name); err != nil {
				reactionRows.Close()
				return MessagingReadMessagesOutput{}, err
			}
			index, ok := messageIndex[messageID]
			if !ok {
				continue
			}
			key := reactionKey{messageID: messageID, emoji: emoji}
			reactionPosition, exists := reactionIndexes[key]
			if !exists {
				reactionPosition = len(output.Messages[index].Reactions)
				reactionIndexes[key] = reactionPosition
				output.Messages[index].Reactions = append(output.Messages[index].Reactions, MessagingMessageReaction{
					Emoji: emoji,
					Names: []string{},
				})
			}
			reaction := &output.Messages[index].Reactions[reactionPosition]
			reaction.Count++
			reaction.ReactedByMe = reaction.ReactedByMe || reactorID == *userID
			reaction.Names = append(reaction.Names, name)
		}
		if err := reactionRows.Err(); err != nil {
			reactionRows.Close()
			return MessagingReadMessagesOutput{}, err
		}
		reactionRows.Close()
	}

	readerRows, err := tx.Query(ctx, `
		SELECT cm.user_id::text, COALESCE(u.name, u.email), cm.last_read_at
		FROM conversation_members cm
		JOIN users u ON u.id = cm.user_id
		WHERE cm.conversation_id = $1::uuid
		ORDER BY COALESCE(u.name, u.email), cm.user_id`, input.ConversationID)
	if err != nil {
		return MessagingReadMessagesOutput{}, err
	}
	for readerRows.Next() {
		var reader MessagingReaderSnapshot
		var lastReadAt *time.Time
		if err := readerRows.Scan(&reader.UserID, &reader.Name, &lastReadAt); err != nil {
			readerRows.Close()
			return MessagingReadMessagesOutput{}, err
		}
		reader.LastReadAt = messagingFormatOptionalTime(lastReadAt)
		output.Readers = append(output.Readers, reader)
	}
	if err := readerRows.Err(); err != nil {
		readerRows.Close()
		return MessagingReadMessagesOutput{}, err
	}
	readerRows.Close()

	pinnedRows, err := tx.Query(ctx, `
		SELECT id::text, body, pinned_at
		FROM messages
		WHERE org_id = $1::uuid AND conversation_id = $2::uuid AND deleted_at IS NULL AND pinned_at IS NOT NULL
		ORDER BY pinned_at DESC, id DESC
		LIMIT 20`, orgID, input.ConversationID)
	if err != nil {
		return MessagingReadMessagesOutput{}, err
	}
	for pinnedRows.Next() {
		var pinned MessagingPinnedMessageSnapshot
		var pinnedAt time.Time
		if err := pinnedRows.Scan(&pinned.ID, &pinned.Body, &pinnedAt); err != nil {
			pinnedRows.Close()
			return MessagingReadMessagesOutput{}, err
		}
		pinned.PinnedAt = messagingFormatTime(pinnedAt)
		output.PinnedMessages = append(output.PinnedMessages, pinned)
	}
	if err := pinnedRows.Err(); err != nil {
		pinnedRows.Close()
		return MessagingReadMessagesOutput{}, err
	}
	pinnedRows.Close()
	return output, nil
}

func messagingNormalizeMentions(raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return json.RawMessage("null"), nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return nil, fmt.Errorf("invalid persisted message mentions: %w", err)
	}
	mentions := make([]MessagingMention, 0, len(entries))
	for _, entry := range entries {
		decoder := json.NewDecoder(bytes.NewReader(entry))
		decoder.DisallowUnknownFields()
		var mention MessagingMention
		if err := decoder.Decode(&mention); err != nil {
			return nil, fmt.Errorf("invalid persisted message mention: %w", err)
		}
		if (mention.Type != "user" && mention.Type != "agent") || len([]rune(mention.ID)) < 1 || len([]rune(mention.ID)) > 80 {
			return nil, errors.New("invalid persisted message mention")
		}
		mentions = append(mentions, mention)
	}
	return json.Marshal(mentions)
}

func messagingListPeople(
	ctx context.Context, tx pgx.Tx, orgID string, input MessagingListPeopleInput,
) (MessagingListPeopleOutput, error) {
	limit := int64(messagingPeopleListLimit)
	if input.Limit != nil {
		limit = *input.Limit
	}
	query := `
		SELECT u.id::text, COALESCE(u.name, u.email)
		FROM memberships ms
		JOIN users u ON u.id = ms.user_id
		WHERE ms.org_id = $1::uuid`
	args := []any{orgID}
	if input.Query != nil {
		args = append(args, "%"+messagingLikeEscaper.Replace(*input.Query)+"%")
		query += fmt.Sprintf(" AND (u.name ILIKE $%d OR u.email ILIKE $%d)", len(args), len(args))
	}
	args = append(args, limit)
	query += fmt.Sprintf(" ORDER BY u.name LIMIT $%d", len(args))
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return MessagingListPeopleOutput{}, err
	}
	defer rows.Close()
	output := MessagingListPeopleOutput{People: []MessagingPerson{}}
	seen := map[string]struct{}{}
	for rows.Next() {
		var person MessagingPerson
		if err := rows.Scan(&person.ID, &person.Name); err != nil {
			return MessagingListPeopleOutput{}, err
		}
		if _, ok := seen[person.ID]; ok {
			continue
		}
		seen[person.ID] = struct{}{}
		person.Type = "user"
		output.People = append(output.People, person)
	}
	if err := rows.Err(); err != nil {
		return MessagingListPeopleOutput{}, err
	}
	if input.Query == nil || messagingWorkmateQueryPattern.MatchString(*input.Query) {
		output.People = append(output.People, MessagingPerson{Type: "agent", ID: messagingWorkmateID, Name: messagingWorkmateName})
	}
	return output, nil
}

func messagingCreateConversation(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingCreateConversationInput,
) (MessagingConversationIDOutput, error) {
	if userID == nil {
		return MessagingConversationIDOutput{}, errors.New("conversation creation needs a named member")
	}
	var conversationID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO conversations (org_id, kind, title, agent_enabled, created_by_user_id)
		VALUES ($1::uuid, $2, $3, $4, $5::uuid)
		RETURNING id::text`, orgID, input.Kind, input.Title, input.AgentEnabled, *userID).Scan(&conversationID); err != nil {
		return MessagingConversationIDOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1::uuid, $2::uuid)`,
		conversationID, *userID); err != nil {
		return MessagingConversationIDOutput{}, err
	}
	return MessagingConversationIDOutput{ConversationID: conversationID}, nil
}

func messagingUpdateConversation(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingUpdateConversationInput,
) (MessagingConversationIDOutput, error) {
	if input.Title == nil && input.AgentEnabled == nil {
		return MessagingConversationIDOutput{}, errors.New("nothing to update")
	}
	if err := messagingRequireMember(ctx, tx, orgID, input.ConversationID, userID); err != nil {
		return MessagingConversationIDOutput{}, err
	}
	conversation, err := messagingLoadConversation(ctx, tx, orgID, input.ConversationID)
	if err != nil {
		return MessagingConversationIDOutput{}, err
	}
	if conversation == nil {
		return MessagingConversationIDOutput{}, errors.New("conversation not found")
	}
	if conversation.Kind == messagingConversationKindDM && input.Title != nil {
		return MessagingConversationIDOutput{}, errors.New("direct messages cannot be renamed")
	}
	sets := make([]string, 0, 2)
	args := []any{orgID, conversation.ID}
	if input.Title != nil {
		args = append(args, *input.Title)
		sets = append(sets, "title = $"+fmt.Sprint(len(args)))
	}
	if input.AgentEnabled != nil {
		args = append(args, *input.AgentEnabled)
		sets = append(sets, "agent_enabled = $"+fmt.Sprint(len(args)))
	}
	if _, err := tx.Exec(ctx, "UPDATE conversations SET "+strings.Join(sets, ", ")+" WHERE id = $2::uuid AND org_id = $1::uuid", args...); err != nil {
		return MessagingConversationIDOutput{}, err
	}
	return MessagingConversationIDOutput{ConversationID: conversation.ID}, nil
}

func messagingArchiveConversation(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingArchiveConversationInput,
) (MessagingArchiveConversationOutput, error) {
	if err := messagingRequireMember(ctx, tx, orgID, input.ConversationID, userID); err != nil {
		return MessagingArchiveConversationOutput{}, err
	}
	conversation, err := messagingLoadConversation(ctx, tx, orgID, input.ConversationID)
	if err != nil {
		return MessagingArchiveConversationOutput{}, err
	}
	if conversation == nil {
		return MessagingArchiveConversationOutput{}, errors.New("conversation not found")
	}
	if conversation.Kind == messagingConversationKindDM {
		return MessagingArchiveConversationOutput{}, errors.New("direct messages cannot be archived")
	}
	var archivedAt any
	if input.Archived {
		archivedAt = messagingNow()
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversations SET archived_at = $3::timestamptz
		WHERE id = $2::uuid AND org_id = $1::uuid`, orgID, conversation.ID, archivedAt); err != nil {
		return MessagingArchiveConversationOutput{}, err
	}
	return MessagingArchiveConversationOutput{ConversationID: conversation.ID, Archived: input.Archived}, nil
}

func messagingDeleteConversation(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingConversationIDInput,
) (MessagingDeleteConversationOutput, error) {
	conversation, err := messagingLoadConversation(ctx, tx, orgID, input.ConversationID)
	if err != nil {
		return MessagingDeleteConversationOutput{}, err
	}
	if conversation == nil {
		return MessagingDeleteConversationOutput{}, errors.New("conversation not found")
	}
	if conversation.Kind == messagingConversationKindDM {
		return MessagingDeleteConversationOutput{}, errors.New("direct messages are left, not deleted")
	}
	if userID == nil || conversation.CreatedByUserID == nil || *conversation.CreatedByUserID != *userID {
		return MessagingDeleteConversationOutput{}, errors.New("only the channel creator can delete it")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversations SET deleted_at = $3 WHERE id = $2::uuid AND org_id = $1::uuid`,
		orgID, conversation.ID, messagingNow()); err != nil {
		return MessagingDeleteConversationOutput{}, err
	}
	return MessagingDeleteConversationOutput{Deleted: true}, nil
}

func messagingLeaveConversation(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingConversationIDInput,
) (MessagingLeaveConversationOutput, error) {
	if userID == nil {
		return MessagingLeaveConversationOutput{}, errors.New("leaving needs a named member")
	}
	if err := messagingRequireMember(ctx, tx, orgID, input.ConversationID, userID); err != nil {
		return MessagingLeaveConversationOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM conversation_members
		WHERE conversation_id = $2::uuid AND user_id = $3::uuid
		  AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_members.conversation_id AND c.org_id = $1::uuid)`,
		orgID, input.ConversationID, *userID); err != nil {
		return MessagingLeaveConversationOutput{}, err
	}
	return MessagingLeaveConversationOutput{Left: true}, nil
}

func messagingAddMember(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingAddMemberInput,
) (MessagingAddMemberOutput, error) {
	if err := messagingRequireMember(ctx, tx, orgID, input.ConversationID, userID); err != nil {
		return MessagingAddMemberOutput{}, err
	}
	conversation, err := messagingLoadConversation(ctx, tx, orgID, input.ConversationID)
	if err != nil {
		return MessagingAddMemberOutput{}, err
	}
	if conversation == nil {
		return MessagingAddMemberOutput{}, errors.New("conversation not found")
	}
	if conversation.Kind == messagingConversationKindDM {
		return MessagingAddMemberOutput{}, errors.New("direct messages cannot gain members")
	}
	var existing string
	err = tx.QueryRow(ctx, `
		SELECT user_id::text FROM memberships WHERE org_id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
		orgID, input.UserID).Scan(&existing)
	if errors.Is(err, pgx.ErrNoRows) {
		return MessagingAddMemberOutput{}, errors.New("that person is not part of this organization")
	}
	if err != nil {
		return MessagingAddMemberOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1::uuid, $2::uuid)
		ON CONFLICT (conversation_id, user_id) DO NOTHING`, conversation.ID, input.UserID); err != nil {
		return MessagingAddMemberOutput{}, err
	}
	return MessagingAddMemberOutput{Added: true}, nil
}

func messagingLoadOwnMessage(ctx context.Context, tx pgx.Tx, orgID, messageID string) (string, string, *string, string, *time.Time, *time.Time, error) {
	var senderType, id, body string
	var senderUserID *string
	var editedAt, deletedAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT id::text, sender_type, sender_user_id::text, body, edited_at, deleted_at FROM messages
		WHERE id = $2::uuid AND org_id = $1::uuid LIMIT 1 FOR UPDATE`, orgID, messageID).Scan(&id, &senderType, &senderUserID, &body, &editedAt, &deletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil, "", nil, nil, errors.New("message not found")
	}
	if err != nil {
		return "", "", nil, "", nil, nil, err
	}
	return id, senderType, senderUserID, body, editedAt, deletedAt, nil
}

func messagingEditMessage(
	ctx context.Context, tx pgx.Tx, orgID, actorType string, userID *string, input MessagingEditMessageInput,
) (MessagingEditMessageOutput, error) {
	if actorType != "human" || userID == nil {
		return MessagingEditMessageOutput{}, errors.New("only your own human messages can be edited")
	}
	messageID, senderType, senderUserID, previousBody, previousEditedAt, _, err := messagingLoadOwnMessage(ctx, tx, orgID, input.MessageID)
	if err != nil {
		return MessagingEditMessageOutput{}, err
	}
	if senderType != "human" || senderUserID == nil || *senderUserID != *userID {
		return MessagingEditMessageOutput{}, errors.New("you can only edit your own messages")
	}
	if input.ExpectedBody != nil && previousBody != *input.ExpectedBody {
		return MessagingEditMessageOutput{}, errors.New("message changed since the inverse was recorded")
	}
	if input.ExpectedEditedAt != nil && (previousEditedAt == nil || messagingFormatTime(*previousEditedAt) != *input.ExpectedEditedAt) {
		return MessagingEditMessageOutput{}, errors.New("message changed since the inverse was recorded")
	}
	editedAt := messagingNextEditTime(previousEditedAt)
	if _, err := tx.Exec(ctx, `
		UPDATE messages SET body = $3, edited_at = $4 WHERE id = $2::uuid AND org_id = $1::uuid`,
		orgID, messageID, input.Body, editedAt); err != nil {
		return MessagingEditMessageOutput{}, err
	}
	formattedEditedAt := messagingFormatTime(editedAt)
	return MessagingEditMessageOutput{
		MessageID: messageID, Body: previousBody, ExpectedBody: input.Body,
		ExpectedEditedAt: formattedEditedAt, EditedAt: formattedEditedAt,
	}, nil
}

func messagingRestoreMessageEdit(
	ctx context.Context, tx pgx.Tx, orgID, actorType string, userID *string, input MessagingRestoreMessageEditInput,
) (MessagingRestoreMessageEditOutput, error) {
	if actorType != "human" || userID == nil {
		return MessagingRestoreMessageEditOutput{}, errors.New("only your own human messages can be restored")
	}
	messageID, senderType, senderUserID, currentBody, currentEditedAt, _, err := messagingLoadOwnMessage(ctx, tx, orgID, input.MessageID)
	if err != nil {
		return MessagingRestoreMessageEditOutput{}, err
	}
	if senderType != "human" || senderUserID == nil || *senderUserID != *userID {
		return MessagingRestoreMessageEditOutput{}, errors.New("you can only restore your own messages")
	}
	if currentBody != input.ExpectedBody || currentEditedAt == nil || messagingFormatTime(*currentEditedAt) != input.ExpectedEditedAt {
		return MessagingRestoreMessageEditOutput{}, errors.New("message changed since the inverse was recorded")
	}
	var hasMatchingReceipt bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM action_receipts
			WHERE org_id = $1::uuid AND capability_id = $2 AND ok = true AND outcome = 'known'
			  AND data->>'messageId' = $3 AND data->>'body' = $4 AND data->>'expectedBody' = $5
			  AND data->>'expectedEditedAt' = $6
		)`, orgID, messagingEditMessageCapabilityID, input.MessageID, input.Body, input.ExpectedBody, input.ExpectedEditedAt).Scan(&hasMatchingReceipt); err != nil {
		return MessagingRestoreMessageEditOutput{}, err
	}
	if !hasMatchingReceipt {
		return MessagingRestoreMessageEditOutput{}, errors.New("message restore requires a matching successful edit receipt")
	}
	editedAt := messagingNextEditTime(currentEditedAt)
	if _, err := tx.Exec(ctx, `
		UPDATE messages SET body = $3, edited_at = $4 WHERE id = $2::uuid AND org_id = $1::uuid`,
		orgID, messageID, input.Body, editedAt); err != nil {
		return MessagingRestoreMessageEditOutput{}, err
	}
	formattedEditedAt := messagingFormatTime(editedAt)
	return MessagingRestoreMessageEditOutput{
		MessageID: messageID, Body: input.ExpectedBody, ExpectedBody: input.Body,
		ExpectedEditedAt: formattedEditedAt, EditedAt: formattedEditedAt,
	}, nil
}

func messagingDeleteMessage(
	ctx context.Context, tx pgx.Tx, orgID, actorType string, userID *string, input MessagingDeleteMessageInput,
) (MessagingDeleteMessageOutput, error) {
	if actorType != "human" || userID == nil {
		return MessagingDeleteMessageOutput{}, errors.New("only your own human messages can be deleted")
	}
	messageID, senderType, senderUserID, _, _, currentDeletedAt, err := messagingLoadOwnMessage(ctx, tx, orgID, input.MessageID)
	if err != nil {
		return MessagingDeleteMessageOutput{}, err
	}
	if senderType != "human" || senderUserID == nil || *senderUserID != *userID {
		return MessagingDeleteMessageOutput{}, errors.New("you can only delete your own messages")
	}
	if input.ExpectedDeletedAtProvided && !messagingOptionalTimesEqual(currentDeletedAt, input.ExpectedDeletedAt) {
		return MessagingDeleteMessageOutput{}, errors.New("message deletion state changed since the inverse was recorded")
	}
	var lastDeleteTime *time.Time
	var lastDeleteTimeText *string
	if err := tx.QueryRow(ctx, `
		SELECT max(data->>'expectedDeletedAt') FROM action_receipts
		WHERE org_id = $1::uuid AND capability_id = $2 AND ok = true AND outcome = 'known'
		  AND data->>'messageId' = $3`, orgID, messagingDeleteMessageCapabilityID, messageID).Scan(&lastDeleteTimeText); err != nil {
		return MessagingDeleteMessageOutput{}, err
	}
	if lastDeleteTimeText != nil {
		parsed, err := messagingParseDateTime(*lastDeleteTimeText)
		if err != nil {
			return MessagingDeleteMessageOutput{}, errors.New("message has an invalid prior deletion receipt")
		}
		lastDeleteTime = &parsed
	}
	if currentDeletedAt != nil && (lastDeleteTime == nil || currentDeletedAt.After(*lastDeleteTime)) {
		lastDeleteTime = currentDeletedAt
	}
	deletedAt := messagingNextDeleteTime(lastDeleteTime)
	if _, err := tx.Exec(ctx, `
		UPDATE messages SET deleted_at = $3 WHERE id = $2::uuid AND org_id = $1::uuid`,
		orgID, messageID, deletedAt); err != nil {
		return MessagingDeleteMessageOutput{}, err
	}
	return MessagingDeleteMessageOutput{
		MessageID: messageID, Deleted: true, DeletedAt: messagingFormatOptionalTime(currentDeletedAt),
		ExpectedDeletedAt: messagingFormatTime(deletedAt),
	}, nil
}

func messagingOptionalTimesEqual(left *time.Time, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return messagingFormatTime(*left) == *right
}

func messagingRestoreMessageDelete(
	ctx context.Context, tx pgx.Tx, orgID, actorType string, userID *string, input MessagingRestoreMessageDeleteInput,
) (MessagingRestoreMessageDeleteOutput, error) {
	if actorType != "human" || userID == nil {
		return MessagingRestoreMessageDeleteOutput{}, errors.New("only your own human messages can be restored")
	}
	messageID, senderType, senderUserID, _, _, currentDeletedAt, err := messagingLoadOwnMessage(ctx, tx, orgID, input.MessageID)
	if err != nil {
		return MessagingRestoreMessageDeleteOutput{}, err
	}
	if senderType != "human" || senderUserID == nil || *senderUserID != *userID {
		return MessagingRestoreMessageDeleteOutput{}, errors.New("you can only restore your own messages")
	}
	if currentDeletedAt == nil || messagingFormatTime(*currentDeletedAt) != input.ExpectedDeletedAt {
		return MessagingRestoreMessageDeleteOutput{}, errors.New("message deletion state changed since the inverse was recorded")
	}
	var hasMatchingReceipt bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM action_receipts
			WHERE org_id = $1::uuid AND capability_id = $2 AND ok = true AND outcome = 'known'
			  AND data->>'messageId' = $3
			  AND data->>'expectedDeletedAt' = $4
			  AND data->>'deletedAt' IS NOT DISTINCT FROM $5::text
		)`, orgID, messagingDeleteMessageCapabilityID, input.MessageID, input.ExpectedDeletedAt, input.DeletedAt).Scan(&hasMatchingReceipt); err != nil {
		return MessagingRestoreMessageDeleteOutput{}, err
	}
	if !hasMatchingReceipt {
		return MessagingRestoreMessageDeleteOutput{}, errors.New("message restore requires a matching successful delete receipt")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE messages SET deleted_at = $3 WHERE id = $2::uuid AND org_id = $1::uuid`,
		orgID, messageID, input.DeletedAt); err != nil {
		return MessagingRestoreMessageDeleteOutput{}, err
	}
	return MessagingRestoreMessageDeleteOutput{MessageID: messageID, ExpectedDeletedAt: input.DeletedAt}, nil
}

func messagingNextDeleteTime(previous *time.Time) time.Time {
	next := messagingNow()
	if previous != nil {
		previousMillisecond := previous.UTC().Truncate(time.Millisecond)
		if !next.After(previousMillisecond) {
			next = previousMillisecond.Add(time.Millisecond)
		}
	}
	return next
}

func messagingAdvanceReadCursor(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingAdvanceReadCursorInput,
) (MessagingReadCursorOutput, error) {
	if err := messagingRequireMember(ctx, tx, orgID, input.ConversationID, userID); err != nil {
		return MessagingReadCursorOutput{}, err
	}
	var lastReadAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT m.last_read_at FROM conversation_members m
		JOIN conversations c ON c.id = m.conversation_id
		WHERE m.conversation_id = $2::uuid AND m.user_id = $3::uuid
		  AND c.org_id = $1::uuid AND c.deleted_at IS NULL
		LIMIT 1`, orgID, input.ConversationID, *userID).Scan(&lastReadAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return MessagingReadCursorOutput{}, errors.New("conversation not found")
	}
	if err != nil {
		return MessagingReadCursorOutput{}, err
	}
	var next any
	if !input.ReadAtProvided {
		next = messagingNow()
	} else if input.ReadAt != nil {
		parsed, err := messagingParseDateTime(*input.ReadAt)
		if err != nil {
			return MessagingReadCursorOutput{}, err
		}
		next = parsed
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversation_members SET last_read_at = $4
		WHERE conversation_id = $2::uuid AND user_id = $3::uuid
		  AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_members.conversation_id AND c.org_id = $1::uuid)`,
		orgID, input.ConversationID, *userID, next); err != nil {
		return MessagingReadCursorOutput{}, err
	}
	return MessagingReadCursorOutput{
		ConversationID: input.ConversationID,
		PreviousReadAt: messagingFormatOptionalTime(lastReadAt),
	}, nil
}

func messagingRestoreReadCursor(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingRestoreReadCursorInput,
) (MessagingReadCursorOutput, error) {
	if err := messagingRequireMember(ctx, tx, orgID, input.ConversationID, userID); err != nil {
		return MessagingReadCursorOutput{}, err
	}
	var lastReadAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT m.last_read_at FROM conversation_members m
		JOIN conversations c ON c.id = m.conversation_id
		WHERE m.conversation_id = $2::uuid AND m.user_id = $3::uuid AND c.org_id = $1::uuid
		LIMIT 1`, orgID, input.ConversationID, *userID).Scan(&lastReadAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return MessagingReadCursorOutput{}, errors.New("conversation not found")
	}
	if err != nil {
		return MessagingReadCursorOutput{}, err
	}
	var next any
	if input.ReadAt != nil {
		parsed, err := messagingParseDateTime(*input.ReadAt)
		if err != nil {
			return MessagingReadCursorOutput{}, err
		}
		next = parsed
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversation_members SET last_read_at = $4
		WHERE conversation_id = $2::uuid AND user_id = $3::uuid
		  AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_members.conversation_id AND c.org_id = $1::uuid)`,
		orgID, input.ConversationID, *userID, next); err != nil {
		return MessagingReadCursorOutput{}, err
	}
	return MessagingReadCursorOutput{
		ConversationID: input.ConversationID,
		PreviousReadAt: messagingFormatOptionalTime(lastReadAt),
	}, nil
}

// The TypeScript path reports one message for both a missing row and a
// non-member, so membership failures must not leak the conversation.
func messagingLoadMemberMessage(ctx context.Context, tx pgx.Tx, orgID, messageID string, userID *string) error {
	if userID == nil {
		return errors.New("message not found")
	}
	var conversationID string
	err := tx.QueryRow(ctx, `
		SELECT conversation_id::text FROM messages
		WHERE id = $2::uuid AND org_id = $1::uuid AND deleted_at IS NULL
		LIMIT 1`, orgID, messageID).Scan(&conversationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("message not found")
	}
	if err != nil {
		return err
	}
	if err := messagingRequireMember(ctx, tx, orgID, conversationID, userID); err != nil {
		return errors.New("message not found")
	}
	return nil
}

func messagingApplyReaction(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingMessageReactionInput,
) (bool, error) {
	if userID == nil {
		return false, errors.New("reactions need a named member")
	}
	if err := messagingLoadMemberMessage(ctx, tx, orgID, input.MessageID, userID); err != nil {
		return false, err
	}
	var existing string
	err := tx.QueryRow(ctx, `
		SELECT user_id::text FROM message_reactions
		WHERE org_id = $1::uuid AND message_id = $2::uuid AND user_id = $3::uuid AND emoji = $4
		LIMIT 1`, orgID, input.MessageID, *userID, input.Emoji).Scan(&existing)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	previousActive := err == nil
	if input.Active {
		if _, err := tx.Exec(ctx, `
			INSERT INTO message_reactions (org_id, message_id, user_id, emoji)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
			ON CONFLICT (message_id, user_id, emoji) DO NOTHING`, orgID, input.MessageID, *userID, input.Emoji); err != nil {
			return false, err
		}
		return previousActive, nil
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM message_reactions
		WHERE org_id = $1::uuid AND message_id = $2::uuid AND user_id = $3::uuid AND emoji = $4`,
		orgID, input.MessageID, *userID, input.Emoji); err != nil {
		return false, err
	}
	return previousActive, nil
}

func messagingSetMessageReaction(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingMessageReactionInput,
) (MessagingSetMessageReactionOutput, error) {
	previousActive, err := messagingApplyReaction(ctx, tx, orgID, userID, input)
	if err != nil {
		return MessagingSetMessageReactionOutput{}, err
	}
	return MessagingSetMessageReactionOutput{PreviousActive: previousActive, Active: input.Active}, nil
}

func messagingRestoreMessageReaction(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingMessageReactionInput,
) (MessagingRestoreMessageReactionOutput, error) {
	previousActive, err := messagingApplyReaction(ctx, tx, orgID, userID, input)
	if err != nil {
		return MessagingRestoreMessageReactionOutput{}, err
	}
	return MessagingRestoreMessageReactionOutput{PreviousActive: previousActive}, nil
}

func messagingApplyPin(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingMessagePinInput,
) (bool, error) {
	if userID == nil {
		return false, errors.New("pinning needs a named member")
	}
	var messageID string
	var pinnedAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT id::text, pinned_at FROM messages
		WHERE id = $2::uuid AND org_id = $1::uuid AND deleted_at IS NULL
		LIMIT 1`, orgID, input.MessageID).Scan(&messageID, &pinnedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, errors.New("message not found")
	}
	if err != nil {
		return false, err
	}
	if err := messagingLoadMemberMessage(ctx, tx, orgID, messageID, userID); err != nil {
		return false, err
	}
	var pinnedAtValue any
	var pinnedByUserID any
	if input.Pinned {
		pinnedAtValue = messagingNow()
		pinnedByUserID = *userID
	}
	if _, err := tx.Exec(ctx, `
		UPDATE messages SET pinned_at = $3, pinned_by_user_id = $4
		WHERE id = $2::uuid AND org_id = $1::uuid`, orgID, messageID, pinnedAtValue, pinnedByUserID); err != nil {
		return false, err
	}
	return pinnedAt != nil, nil
}

func messagingSetMessagePin(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingMessagePinInput,
) (MessagingSetMessagePinOutput, error) {
	previousPinned, err := messagingApplyPin(ctx, tx, orgID, userID, input)
	if err != nil {
		return MessagingSetMessagePinOutput{}, err
	}
	return MessagingSetMessagePinOutput{PreviousPinned: previousPinned, Pinned: input.Pinned}, nil
}

func messagingRestoreMessagePin(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingMessagePinInput,
) (MessagingRestoreMessagePinOutput, error) {
	previousPinned, err := messagingApplyPin(ctx, tx, orgID, userID, input)
	if err != nil {
		return MessagingRestoreMessagePinOutput{}, err
	}
	return MessagingRestoreMessagePinOutput{PreviousPinned: previousPinned}, nil
}

func messagingLoadPresence(
	ctx context.Context, tx pgx.Tx, orgID, conversationID string, userID string,
) (*time.Time, *time.Time, error) {
	var lastSeenAt time.Time
	var typingUntil *time.Time
	err := tx.QueryRow(ctx, `
		SELECT last_seen_at, typing_until FROM conversation_presence
		WHERE org_id = $1::uuid AND conversation_id = $2::uuid AND user_id = $3::uuid
		LIMIT 1`, orgID, conversationID, userID).Scan(&lastSeenAt, &typingUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return &lastSeenAt, typingUntil, nil
}

func messagingUpdateConversationPresence(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingUpdateConversationPresenceInput,
) (MessagingConversationPresenceOutput, error) {
	if err := messagingRequireMember(ctx, tx, orgID, input.ConversationID, userID); err != nil {
		return MessagingConversationPresenceOutput{}, err
	}
	lastSeenAt, typingUntil, err := messagingLoadPresence(ctx, tx, orgID, input.ConversationID, *userID)
	if err != nil {
		return MessagingConversationPresenceOutput{}, err
	}
	now := messagingNow()
	var nextTypingUntil any
	if input.Typing {
		nextTypingUntil = now.Add(messagingTypingWindow)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_presence (org_id, conversation_id, user_id, last_seen_at, typing_until)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
		ON CONFLICT (conversation_id, user_id) DO UPDATE
		SET org_id = $1::uuid, last_seen_at = $4, typing_until = $5`,
		orgID, input.ConversationID, *userID, now, nextTypingUntil); err != nil {
		return MessagingConversationPresenceOutput{}, err
	}
	return MessagingConversationPresenceOutput{
		PreviousLastSeenAt:  messagingFormatOptionalTime(lastSeenAt),
		PreviousTypingUntil: messagingFormatOptionalTime(typingUntil),
	}, nil
}

func messagingRestoreConversationPresence(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingRestoreConversationPresenceInput,
) (MessagingConversationPresenceOutput, error) {
	if err := messagingRequireMember(ctx, tx, orgID, input.ConversationID, userID); err != nil {
		return MessagingConversationPresenceOutput{}, err
	}
	lastSeenAt, typingUntil, err := messagingLoadPresence(ctx, tx, orgID, input.ConversationID, *userID)
	if err != nil {
		return MessagingConversationPresenceOutput{}, err
	}
	if input.LastSeenAt == nil {
		if _, err := tx.Exec(ctx, `
			DELETE FROM conversation_presence
			WHERE org_id = $1::uuid AND conversation_id = $2::uuid AND user_id = $3::uuid`,
			orgID, input.ConversationID, *userID); err != nil {
			return MessagingConversationPresenceOutput{}, err
		}
		return MessagingConversationPresenceOutput{
			PreviousLastSeenAt:  messagingFormatOptionalTime(lastSeenAt),
			PreviousTypingUntil: messagingFormatOptionalTime(typingUntil),
		}, nil
	}
	var restoreLastSeen any
	var restoreTypingUntil any
	if restoreLastSeen, err = messagingParseDateTime(*input.LastSeenAt); err != nil {
		return MessagingConversationPresenceOutput{}, err
	}
	if input.TypingUntil != nil {
		if restoreTypingUntil, err = messagingParseDateTime(*input.TypingUntil); err != nil {
			return MessagingConversationPresenceOutput{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_presence (org_id, conversation_id, user_id, last_seen_at, typing_until)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
		ON CONFLICT (conversation_id, user_id) DO UPDATE
		SET org_id = $1::uuid, last_seen_at = $4, typing_until = $5`,
		orgID, input.ConversationID, *userID, restoreLastSeen, restoreTypingUntil); err != nil {
		return MessagingConversationPresenceOutput{}, err
	}
	return MessagingConversationPresenceOutput{
		PreviousLastSeenAt:  messagingFormatOptionalTime(lastSeenAt),
		PreviousTypingUntil: messagingFormatOptionalTime(typingUntil),
	}, nil
}

// messagingDecodeAttachment mirrors the TypeScript check: decode leniently,
// re-encode, and require the canonical form so whitespace, stray characters,
// and non-canonical padding are refused.
func messagingDecodeAttachment(value string) ([]byte, error) {
	invalid := errors.New("attachment must be valid base64 and at most 5 MB")
	trimmed := strings.TrimRight(value, "=")
	decoded, err := base64.RawStdEncoding.DecodeString(trimmed)
	if err != nil {
		return nil, invalid
	}
	if base64.RawStdEncoding.EncodeToString(decoded) != trimmed {
		return nil, invalid
	}
	if len(decoded) == 0 || len(decoded) > messagingAttachmentBytesMax {
		return nil, invalid
	}
	return decoded, nil
}

func messagingSanitizeFilename(filename string) string {
	replaced := strings.Map(func(r rune) rune {
		if r == '\\' || r == '/' || r == 0 {
			return '_'
		}
		return r
	}, filename)
	return sliceUTF16CodeUnits(replaced, messagingFilenameMax)
}

func messagingUploadMessageAttachment(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingUploadMessageAttachmentInput,
) (MessagingUploadMessageAttachmentOutput, error) {
	if err := messagingRequireMember(ctx, tx, orgID, input.ConversationID, userID); err != nil {
		return MessagingUploadMessageAttachmentOutput{}, err
	}
	content, err := messagingDecodeAttachment(input.ContentBase64)
	if err != nil {
		return MessagingUploadMessageAttachmentOutput{}, err
	}
	conversation, err := messagingLoadConversation(ctx, tx, orgID, input.ConversationID)
	if err != nil {
		return MessagingUploadMessageAttachmentOutput{}, err
	}
	if conversation == nil {
		return MessagingUploadMessageAttachmentOutput{}, errors.New("conversation not found")
	}
	var attachmentID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO message_attachments (org_id, conversation_id, filename, mime_type, size_bytes, content, uploaded_by_user_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)
		RETURNING id::text`, orgID, input.ConversationID, messagingSanitizeFilename(input.Filename),
		input.MimeType, len(content), content, *userID).Scan(&attachmentID); err != nil {
		return MessagingUploadMessageAttachmentOutput{}, err
	}
	return MessagingUploadMessageAttachmentOutput{AttachmentID: attachmentID}, nil
}

func messagingDeletePendingAttachment(
	ctx context.Context, tx pgx.Tx, orgID string, userID *string, input MessagingDeletePendingAttachmentInput,
) (MessagingDeletePendingAttachmentOutput, error) {
	if userID == nil {
		return MessagingDeletePendingAttachmentOutput{}, errors.New("attachments need a named member")
	}
	var attachmentID, conversationID string
	err := tx.QueryRow(ctx, `
		SELECT id::text, conversation_id::text FROM message_attachments
		WHERE id = $2::uuid AND org_id = $1::uuid AND uploaded_by_user_id = $3::uuid AND message_id IS NULL
		LIMIT 1 FOR UPDATE`, orgID, input.AttachmentID, *userID).Scan(&attachmentID, &conversationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return MessagingDeletePendingAttachmentOutput{}, errors.New("pending attachment not found")
	}
	if err != nil {
		return MessagingDeletePendingAttachmentOutput{}, err
	}
	member, err := messagingIsMember(ctx, tx, orgID, conversationID, userID)
	if err != nil {
		return MessagingDeletePendingAttachmentOutput{}, err
	}
	if !member {
		return MessagingDeletePendingAttachmentOutput{}, errors.New("pending attachment not found")
	}
	deleted, err := tx.Exec(ctx, `
		DELETE FROM message_attachments
		WHERE id = $2::uuid AND org_id = $1::uuid AND uploaded_by_user_id = $3::uuid AND message_id IS NULL`,
		orgID, attachmentID, *userID)
	if err != nil {
		return MessagingDeletePendingAttachmentOutput{}, err
	}
	if deleted.RowsAffected() != 1 {
		return MessagingDeletePendingAttachmentOutput{}, errors.New("pending attachment not found")
	}
	return MessagingDeletePendingAttachmentOutput{Removed: true}, nil
}
