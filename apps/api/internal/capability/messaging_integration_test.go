package capability

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

type messagingFixture struct {
	*executorFixture
	colleagueID  string
	nonMemberID  string
	otherOrgUser string
}

func messagingUserPointer(id string) *string {
	return &id
}

func newMessagingFixture(t *testing.T) *messagingFixture {
	t.Helper()
	fx := &messagingFixture{executorFixture: newExecutorFixture(t)}
	fx.colleagueID = executorUUID(t)
	fx.nonMemberID = executorUUID(t)
	fx.otherOrgUser = executorUUID(t)
	seed := func(orgID, userID, label string) {
		t.Helper()
		if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, $3)`,
			userID, label+"-"+userID[:8]+"@messaging.test", label); err != nil {
			t.Fatal(err)
		}
		if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, orgID, userID); err != nil {
			t.Fatal(err)
		}
	}
	seed(fx.orgID, fx.colleagueID, "Messaging colleague")
	seed(fx.orgID, fx.nonMemberID, "Messaging non member")
	seed(fx.otherOrgID, fx.otherOrgUser, "Messaging foreign colleague")
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, fx.otherOrgID, fx.userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		for _, userID := range []string{fx.colleagueID, fx.nonMemberID, fx.otherOrgUser} {
			for _, statement := range []string{
				`DELETE FROM messages WHERE sender_user_id = $1::uuid`,
				`DELETE FROM message_attachments WHERE uploaded_by_user_id = $1::uuid`,
				`DELETE FROM message_reactions WHERE user_id = $1::uuid`,
				`DELETE FROM conversation_presence WHERE user_id = $1::uuid`,
				`DELETE FROM conversation_members WHERE user_id = $1::uuid`,
				`DELETE FROM conversations WHERE created_by_user_id = $1::uuid`,
				`DELETE FROM memberships WHERE user_id = $1::uuid`,
				`DELETE FROM users WHERE id = $1::uuid`,
			} {
				if _, err := fx.owner.Exec(cleanupCtx, statement, userID); err != nil {
					t.Errorf("clean messaging fixture with %q: %v", statement, err)
				}
			}
		}
	})
	return fx
}

func (fx *messagingFixture) createChannel(t *testing.T, userID, title string) string {
	t.Helper()
	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		return messagingCreateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(userID), MessagingCreateConversationInput{
			Title: title, Kind: messagingConversationKindChannl,
		})
	})
	if err != nil {
		t.Fatalf("messagingCreateConversation: %v", err)
	}
	return created.ConversationID
}

func (fx *messagingFixture) addMember(t *testing.T, actorID, conversationID, userID string) {
	t.Helper()
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingAddMemberOutput, error) {
		return messagingAddMember(fx.ctx, tx, fx.orgID, messagingUserPointer(actorID), MessagingAddMemberInput{
			ConversationID: conversationID, UserID: userID,
		})
	}); err != nil {
		t.Fatalf("messagingAddMember: %v", err)
	}
}

// Direct messages manage their own membership at creation, so the capability
// refuses to add one; the fixture seeds that row the way the TypeScript
// lifecycle test does.
func (fx *messagingFixture) seedMember(t *testing.T, conversationID, userID string) {
	t.Helper()
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1::uuid, $2::uuid)
		ON CONFLICT (conversation_id, user_id) DO NOTHING`, conversationID, userID); err != nil {
		t.Fatal(err)
	}
}

func (fx *messagingFixture) send(t *testing.T, actorID, conversationID, body string) string {
	t.Helper()
	sent, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
		return messagingSendMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(actorID), MessagingSendMessageInput{
			ConversationID: conversationID, Body: body,
		})
	})
	if err != nil {
		t.Fatalf("messagingSendMessage: %v", err)
	}
	return sent.MessageID
}

func (fx *messagingFixture) count(query string, args ...any) int64 {
	fx.t.Helper()
	var count int64
	if err := fx.owner.QueryRow(fx.ctx, query, args...).Scan(&count); err != nil {
		fx.t.Fatal(err)
	}
	return count
}

func TestMessagingConversationLifecycleGovernsMembershipAndTenant(t *testing.T) {
	fx := newMessagingFixture(t)
	channel := fx.createChannel(t, fx.userID, "lifecycle")
	fx.addMember(t, fx.userID, channel, fx.colleagueID)

	renamed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		return messagingUpdateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingUpdateConversationInput{
			ConversationID: channel, Title: messagingUserPointer("renamed"),
		})
	})
	if err != nil || renamed.ConversationID != channel {
		t.Fatalf("member rename=%+v err=%v, want the same channel", renamed, err)
	}
	var title string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT title FROM conversations WHERE id=$1::uuid`, channel).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "renamed" {
		t.Fatalf("channel title=%q, want renamed", title)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		return messagingUpdateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.colleagueID), MessagingUpdateConversationInput{
			ConversationID: channel, Title: messagingUserPointer("colleague"),
		})
	})
	if err != nil {
		t.Fatalf("member rename by a joined colleague: %v", err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		return messagingUpdateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingUpdateConversationInput{
			ConversationID: channel, Title: messagingUserPointer("hijack"),
		})
	})
	if err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("non-member rename err=%v, want a membership refusal", err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		return messagingUpdateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingUpdateConversationInput{ConversationID: channel})
	})
	if err == nil || err.Error() != "nothing to update" {
		t.Fatalf("empty update err=%v, want a nothing-to-update refusal", err)
	}

	archived, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingArchiveConversationOutput, error) {
		return messagingArchiveConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingArchiveConversationInput{
			ConversationID: channel, Archived: true,
		})
	})
	if err != nil || !archived.Archived || archived.ConversationID != channel {
		t.Fatalf("archive=%+v err=%v, want an archived channel", archived, err)
	}
	if fx.count(`SELECT count(*) FROM conversations WHERE id=$1::uuid AND archived_at IS NOT NULL`, channel) != 1 {
		t.Fatal("archive did not stamp archived_at")
	}
	restored, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingArchiveConversationOutput, error) {
		return messagingArchiveConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingArchiveConversationInput{
			ConversationID: channel, Archived: false,
		})
	})
	if err != nil || restored.Archived {
		t.Fatalf("restore=%+v err=%v, want an unarchived channel", restored, err)
	}
	if fx.count(`SELECT count(*) FROM conversations WHERE id=$1::uuid AND archived_at IS NULL`, channel) != 1 {
		t.Fatal("restore did not clear archived_at")
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingAddMemberOutput, error) {
		return messagingAddMember(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingAddMemberInput{
			ConversationID: channel, UserID: fx.otherOrgUser,
		})
	}); err == nil || err.Error() != "that person is not part of this organization" {
		t.Fatalf("addMember with a foreign user err=%v, want an organization refusal", err)
	}
	if fx.count(`SELECT count(*) FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, channel, fx.otherOrgUser) != 0 {
		t.Fatal("a foreign user joined the channel")
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingAddMemberOutput, error) {
		return messagingAddMember(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingAddMemberInput{
			ConversationID: channel, UserID: fx.nonMemberID,
		})
	})
	if err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("addMember by a non-member err=%v, want a membership refusal", err)
	}

	left, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingLeaveConversationOutput, error) {
		return messagingLeaveConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.colleagueID), MessagingConversationIDInput{ConversationID: channel})
	})
	if err != nil || !left.Left {
		t.Fatalf("leaveConversation=%+v err=%v, want a left result", left, err)
	}
	if fx.count(`SELECT count(*) FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, channel, fx.colleagueID) != 0 {
		t.Fatal("leaveConversation kept the membership row")
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingLeaveConversationOutput, error) {
		return messagingLeaveConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.colleagueID), MessagingConversationIDInput{ConversationID: channel})
	})
	if err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("second leaveConversation err=%v, want a membership refusal", err)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeleteConversationOutput, error) {
		return messagingDeleteConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.colleagueID), MessagingConversationIDInput{ConversationID: channel})
	})
	if err == nil || err.Error() != "only the channel creator can delete it" {
		t.Fatalf("deleteConversation by a non-creator err=%v, want a creator refusal", err)
	}
	deleted, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeleteConversationOutput, error) {
		return messagingDeleteConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingConversationIDInput{ConversationID: channel})
	})
	if err != nil || !deleted.Deleted {
		t.Fatalf("deleteConversation=%+v err=%v, want a deleted result", deleted, err)
	}
	if fx.count(`SELECT count(*) FROM conversations WHERE id=$1::uuid AND deleted_at IS NOT NULL`, channel) != 1 {
		t.Fatal("deleteConversation did not tombstone the channel")
	}
	listed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingListConversationsOutput, error) {
		return messagingListConversations(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID))
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(mustMarshalJSON(t, listed), channel) {
		t.Fatal("listConversations still lists a soft-deleted channel")
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{ConversationID: channel, Limit: 10})
	})
	if err == nil || err.Error() != "conversation not found" {
		t.Fatalf("readMessages on a deleted channel err=%v, want not found", err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
		return messagingSendMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingSendMessageInput{
			ConversationID: channel, Body: "should be refused",
		})
	})
	if err == nil || err.Error() != "conversation not found" {
		t.Fatalf("sendMessage on a deleted channel err=%v, want not found", err)
	}
}

func TestMessagingDirectMessagesRefuseChannelOperations(t *testing.T) {
	fx := newMessagingFixture(t)
	direct, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		return messagingCreateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingCreateConversationInput{
			Title: "with-colleague", Kind: messagingConversationKindDM, AgentEnabled: true,
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	fx.seedMember(t, direct.ConversationID, fx.colleagueID)

	if fx.count(`SELECT count(*) FROM conversations WHERE id=$1::uuid AND agent_enabled`, direct.ConversationID) != 1 {
		t.Fatal("createConversation did not keep agent_enabled")
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		return messagingUpdateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingUpdateConversationInput{
			ConversationID: direct.ConversationID, Title: messagingUserPointer("renamed dm"),
		})
	}); err == nil || err.Error() != "direct messages cannot be renamed" {
		t.Fatalf("rename a direct message err=%v, want a DM refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingArchiveConversationOutput, error) {
		return messagingArchiveConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingArchiveConversationInput{
			ConversationID: direct.ConversationID, Archived: true,
		})
	}); err == nil || err.Error() != "direct messages cannot be archived" {
		t.Fatalf("archive a direct message err=%v, want a DM refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeleteConversationOutput, error) {
		return messagingDeleteConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingConversationIDInput{ConversationID: direct.ConversationID})
	}); err == nil || err.Error() != "direct messages are left, not deleted" {
		t.Fatalf("delete a direct message err=%v, want a DM refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingAddMemberOutput, error) {
		return messagingAddMember(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingAddMemberInput{
			ConversationID: direct.ConversationID, UserID: fx.nonMemberID,
		})
	}); err == nil || err.Error() != "direct messages cannot gain members" {
		t.Fatalf("addMember on a direct message err=%v, want a DM refusal", err)
	}
	agentOnly, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		return messagingUpdateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingUpdateConversationInput{
			ConversationID: direct.ConversationID, AgentEnabled: messagingBoolPointer(false),
		})
	})
	if err != nil || agentOnly.ConversationID != direct.ConversationID {
		t.Fatalf("toggling workmate participation on a direct message=%+v err=%v", agentOnly, err)
	}
}

func messagingBoolPointer(value bool) *bool {
	return &value
}

func TestMessagingMessagesAreOwnedByTheirHumanSender(t *testing.T) {
	fx := newMessagingFixture(t)
	channel := fx.createChannel(t, fx.userID, "edits")
	fx.addMember(t, fx.userID, channel, fx.colleagueID)
	messageID := fx.send(t, fx.userID, channel, "original wording")

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingEditMessageOutput, error) {
		return messagingEditMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.colleagueID), MessagingEditMessageInput{
			MessageID: messageID, Body: "hijacked",
		})
	}); err == nil || err.Error() != "you can only edit your own messages" {
		t.Fatalf("edit by another member err=%v, want an ownership refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingEditMessageOutput, error) {
		return messagingEditMessage(fx.ctx, tx, fx.orgID, "agent", messagingUserPointer(fx.userID), MessagingEditMessageInput{
			MessageID: messageID, Body: "agent edit",
		})
	}); err == nil || err.Error() != "only your own human messages can be edited" {
		t.Fatalf("edit by an agent err=%v, want a human-sender refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeleteMessageOutput, error) {
		return messagingDeleteMessage(fx.ctx, tx, fx.orgID, "agent", messagingUserPointer(fx.userID), MessagingDeleteMessageInput{MessageID: messageID})
	}); err == nil || err.Error() != "only your own human messages can be deleted" {
		t.Fatalf("delete by an agent err=%v, want a human-sender refusal", err)
	}
	unknownMessage, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingEditMessageOutput, error) {
		return messagingEditMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingEditMessageInput{
			MessageID: executorUUID(t), Body: "nowhere",
		})
	})
	if err == nil || err.Error() != "message not found" {
		t.Fatalf("edit of an unknown message=%+v err=%v, want not found", unknownMessage, err)
	}

	edited, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingEditMessageOutput, error) {
		return messagingEditMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingEditMessageInput{
			MessageID: messageID, Body: "corrected wording",
		})
	})
	if err != nil || edited.MessageID != messageID {
		t.Fatalf("edit by the sender=%+v err=%v", edited, err)
	}
	if _, parseErr := time.Parse("2006-01-02T15:04:05.000Z", edited.EditedAt); parseErr != nil {
		t.Fatalf("editedAt=%q is not millisecond ISO with a Z suffix: %v", edited.EditedAt, parseErr)
	}
	var body string
	var editedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT body, edited_at FROM messages WHERE id=$1::uuid`, messageID).Scan(&body, &editedAt); err != nil {
		t.Fatal(err)
	}
	if body != "corrected wording" || editedAt == nil {
		t.Fatalf("stored message body=%q editedAt=%v, want the correction and an edit stamp", body, editedAt)
	}

	read, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.colleagueID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 30,
		})
	})
	if err != nil || len(read.Messages) != 1 {
		t.Fatalf("readMessages=%+v err=%v, want the one visible message", read, err)
	}
	if read.Messages[0].Body != "corrected wording" || read.Messages[0].SenderType != "human" ||
		read.Messages[0].SenderUserID == nil || *read.Messages[0].SenderUserID != fx.userID || read.Messages[0].EditedAt == nil {
		t.Fatalf("read message=%+v, want the human sender with an edit stamp", read.Messages[0])
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeleteMessageOutput, error) {
		return messagingDeleteMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.colleagueID), MessagingDeleteMessageInput{MessageID: messageID})
	}); err == nil || err.Error() != "you can only delete your own messages" {
		t.Fatalf("delete by another member err=%v, want an ownership refusal", err)
	}
	deleted, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeleteMessageOutput, error) {
		return messagingDeleteMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingDeleteMessageInput{MessageID: messageID})
	})
	if err != nil || !deleted.Deleted {
		t.Fatalf("delete by the sender=%+v err=%v", deleted, err)
	}
	afterDelete, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 30,
		})
	})
	if err != nil || len(afterDelete.Messages) != 0 {
		t.Fatalf("readMessages after delete=%+v err=%v, want no rows", afterDelete, err)
	}
	if fx.count(`SELECT count(*) FROM messages WHERE id=$1::uuid AND deleted_at IS NOT NULL`, messageID) != 1 {
		t.Fatal("deleteMessage dropped the row instead of tombstoning it")
	}
}

func TestMessagingReadCursorReactionPinAndPresenceRestorePairs(t *testing.T) {
	fx := newMessagingFixture(t)
	channel := fx.createChannel(t, fx.userID, "collaboration")
	fx.addMember(t, fx.userID, channel, fx.colleagueID)
	messageID := fx.send(t, fx.userID, channel, "A searchable parent message")
	colleague := messagingUserPointer(fx.colleagueID)

	advance := func(input MessagingAdvanceReadCursorInput) (MessagingReadCursorOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadCursorOutput, error) {
			return messagingAdvanceReadCursor(fx.ctx, tx, fx.orgID, colleague, input)
		})
	}
	first, err := advance(MessagingAdvanceReadCursorInput{ConversationID: channel})
	if err != nil || first.PreviousReadAt != nil || first.ConversationID != channel {
		t.Fatalf("first advanceReadCursor=%+v err=%v, want a null previous read position", first, err)
	}
	var stored *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT last_read_at FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`,
		channel, fx.colleagueID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == nil {
		t.Fatal("advanceReadCursor did not store a read position")
	}
	second, err := advance(MessagingAdvanceReadCursorInput{ConversationID: channel, ReadAt: messagingUserPointer("2026-09-20T00:00:00.000Z"), ReadAtProvided: true})
	if err != nil || second.PreviousReadAt == nil {
		t.Fatalf("second advanceReadCursor=%+v err=%v, want the previous position echoed", second, err)
	}
	restored, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadCursorOutput, error) {
		return messagingRestoreReadCursor(fx.ctx, tx, fx.orgID, colleague, MessagingRestoreReadCursorInput{
			ConversationID: channel, ReadAt: second.PreviousReadAt,
		})
	})
	if err != nil || restored.PreviousReadAt == nil || *restored.PreviousReadAt != "2026-09-20T00:00:00.000Z" {
		t.Fatalf("restoreReadCursor=%+v err=%v, want the earlier position restored", restored, err)
	}
	cleared, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadCursorOutput, error) {
		return messagingRestoreReadCursor(fx.ctx, tx, fx.orgID, colleague, MessagingRestoreReadCursorInput{ConversationID: channel, ReadAt: nil})
	})
	if err != nil || cleared.PreviousReadAt == nil {
		t.Fatalf("restoreReadCursor to null=%+v err=%v, want the prior position echoed", cleared, err)
	}
	if fx.count(`SELECT count(*) FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid AND last_read_at IS NULL`, channel, fx.colleagueID) != 1 {
		t.Fatal("restoreReadCursor did not clear the read position")
	}
	if _, err := advance(MessagingAdvanceReadCursorInput{ConversationID: channel, ReadAt: messagingUserPointer("2026-09-20T00:00:00.000Z"), ReadAtProvided: true}); err == nil {
		_ = err
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadCursorOutput, error) {
		return messagingAdvanceReadCursor(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingAdvanceReadCursorInput{ConversationID: channel})
	}); err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("advanceReadCursor by a non-member err=%v, want a membership refusal", err)
	}

	setReaction := func(active bool) (MessagingSetMessageReactionOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSetMessageReactionOutput, error) {
			return messagingSetMessageReaction(fx.ctx, tx, fx.orgID, colleague, MessagingMessageReactionInput{
				MessageID: messageID, Emoji: "\U0001F44D", Active: active,
			})
		})
	}
	added, err := setReaction(true)
	if err != nil || added.PreviousActive || !added.Active {
		t.Fatalf("first reaction=%+v err=%v, want a fresh active reaction", added, err)
	}
	again, err := setReaction(true)
	if err != nil || !again.PreviousActive {
		t.Fatalf("repeat reaction=%+v err=%v, want the previous active flag", again, err)
	}
	restoredReaction, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingRestoreMessageReactionOutput, error) {
		return messagingRestoreMessageReaction(fx.ctx, tx, fx.orgID, colleague, MessagingMessageReactionInput{
			MessageID: messageID, Emoji: "\U0001F44D", Active: false,
		})
	})
	if err != nil || !restoredReaction.PreviousActive {
		t.Fatalf("restoreMessageReaction=%+v err=%v, want the reaction reversed", restoredReaction, err)
	}
	if fx.count(`SELECT count(*) FROM message_reactions WHERE message_id=$1::uuid AND user_id=$2::uuid`, messageID, fx.colleagueID) != 0 {
		t.Fatal("restoreMessageReaction did not remove the reaction")
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSetMessageReactionOutput, error) {
		return messagingSetMessageReaction(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingMessageReactionInput{
			MessageID: messageID, Emoji: "\U0001F44D", Active: true,
		})
	}); err == nil || err.Error() != "message not found" {
		t.Fatalf("reaction by a non-member err=%v, want a message-not-found refusal", err)
	}

	setPin := func(pinned bool) (MessagingSetMessagePinOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSetMessagePinOutput, error) {
			return messagingSetMessagePin(fx.ctx, tx, fx.orgID, colleague, MessagingMessagePinInput{MessageID: messageID, Pinned: pinned})
		})
	}
	pinned, err := setPin(true)
	if err != nil || pinned.PreviousPinned || !pinned.Pinned {
		t.Fatalf("first pin=%+v err=%v, want a fresh pin", pinned, err)
	}
	rePinned, err := setPin(true)
	if err != nil || !rePinned.PreviousPinned {
		t.Fatalf("repeat pin=%+v err=%v, want the previous pinned flag", rePinned, err)
	}
	restoredPin, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingRestoreMessagePinOutput, error) {
		return messagingRestoreMessagePin(fx.ctx, tx, fx.orgID, colleague, MessagingMessagePinInput{MessageID: messageID, Pinned: false})
	})
	if err != nil || !restoredPin.PreviousPinned {
		t.Fatalf("restoreMessagePin=%+v err=%v, want the pin reversed", restoredPin, err)
	}
	if fx.count(`SELECT count(*) FROM messages WHERE id=$1::uuid AND pinned_at IS NULL AND pinned_by_user_id IS NULL`, messageID) != 1 {
		t.Fatal("restoreMessagePin left pin state behind")
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSetMessagePinOutput, error) {
		return messagingSetMessagePin(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingMessagePinInput{MessageID: messageID, Pinned: true})
	}); err == nil || err.Error() != "message not found" {
		t.Fatalf("pin by a non-member err=%v, want a message-not-found refusal", err)
	}

	presence := func(typing bool) (MessagingConversationPresenceOutput, error) {
		return dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationPresenceOutput, error) {
			return messagingUpdateConversationPresence(fx.ctx, tx, fx.orgID, colleague, MessagingUpdateConversationPresenceInput{
				ConversationID: channel, Typing: typing,
			})
		})
	}
	firstPresence, err := presence(true)
	if err != nil || firstPresence.PreviousLastSeenAt != nil || firstPresence.PreviousTypingUntil != nil {
		t.Fatalf("first presence=%+v err=%v, want no prior presence", firstPresence, err)
	}
	var typingUntil *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT typing_until FROM conversation_presence WHERE conversation_id=$1::uuid AND user_id=$2::uuid`,
		channel, fx.colleagueID).Scan(&typingUntil); err != nil {
		t.Fatal(err)
	}
	if typingUntil == nil {
		t.Fatal("updateConversationPresence did not set typing_until")
	}
	secondPresence, err := presence(false)
	if err != nil || secondPresence.PreviousLastSeenAt == nil || secondPresence.PreviousTypingUntil == nil {
		t.Fatalf("second presence=%+v err=%v, want the prior presence echoed", secondPresence, err)
	}
	if fx.count(`SELECT count(*) FROM conversation_presence WHERE conversation_id=$1::uuid AND user_id=$2::uuid AND typing_until IS NULL`, channel, fx.colleagueID) != 1 {
		t.Fatal("updateConversationPresence did not clear typing_until")
	}
	clearedPresence, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationPresenceOutput, error) {
		return messagingRestoreConversationPresence(fx.ctx, tx, fx.orgID, colleague, MessagingRestoreConversationPresenceInput{
			ConversationID: channel, LastSeenAt: nil, TypingUntil: nil,
		})
	})
	if err != nil || clearedPresence.PreviousLastSeenAt == nil {
		t.Fatalf("restoreConversationPresence to null=%+v err=%v", clearedPresence, err)
	}
	if fx.count(`SELECT count(*) FROM conversation_presence WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, channel, fx.colleagueID) != 0 {
		t.Fatal("restoreConversationPresence to null did not delete the presence row")
	}
	restoredPresence, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationPresenceOutput, error) {
		return messagingRestoreConversationPresence(fx.ctx, tx, fx.orgID, colleague, MessagingRestoreConversationPresenceInput{
			ConversationID: channel,
			LastSeenAt:     messagingUserPointer("2026-09-20T00:00:00.000Z"),
			TypingUntil:    messagingUserPointer("2026-09-20T00:00:08.000Z"),
		})
	})
	if err != nil || restoredPresence.PreviousLastSeenAt != nil {
		t.Fatalf("restoreConversationPresence=%+v err=%v", restoredPresence, err)
	}
	if fx.count(`SELECT count(*) FROM conversation_presence WHERE conversation_id=$1::uuid AND user_id=$2::uuid AND last_seen_at=$3::timestamptz AND typing_until=$4::timestamptz`,
		channel, fx.colleagueID, "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:08.000Z") != 1 {
		t.Fatal("restoreConversationPresence did not restore the earlier presence timestamps")
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationPresenceOutput, error) {
		return messagingUpdateConversationPresence(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingUpdateConversationPresenceInput{
			ConversationID: channel, Typing: true,
		})
	}); err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("presence update by a non-member err=%v, want a membership refusal", err)
	}
}

func TestMessagingAgentSendAndMentionNotifications(t *testing.T) {
	fx := newMessagingFixture(t)
	channel := fx.createChannel(t, fx.userID, "mentions")
	fx.addMember(t, fx.userID, channel, fx.colleagueID)
	other := fx.createChannel(t, fx.userID, "elsewhere")

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
		return messagingSendMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingSendMessageInput{
			ConversationID: channel, Body: "   ",
		})
	}); err == nil || err.Error() != "write a message or attach a file" {
		t.Fatalf("blank message err=%v, want a write-something refusal", err)
	}

	agentMessage, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
		return messagingSendMessage(fx.ctx, tx, fx.orgID, "agent", messagingUserPointer(fx.userID), MessagingSendMessageInput{
			ConversationID: channel, Body: "The agent speaks here",
			Mentions: []MessagingMention{
				{Type: "user", ID: fx.colleagueID},
				{Type: "user", ID: fx.userID},
				{Type: "user", ID: fx.nonMemberID},
				{Type: "agent", ID: messagingWorkmateID},
			},
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if fx.count(`SELECT count(*) FROM messages WHERE id=$1::uuid AND sender_type='agent' AND sender_user_id IS NULL`, agentMessage.MessageID) != 1 {
		t.Fatal("an agent send did not record an agent sender without a user id")
	}
	if fx.count(`SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND kind='mention' AND user_id=$2::uuid`,
		fx.orgID, fx.colleagueID) != 0 {
		t.Fatal("an agent send created a mention notification, which the TypeScript path reserves for human actors")
	}
	if fx.count(`SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND user_id=$2::uuid`, fx.orgID, fx.nonMemberID) != 0 {
		t.Fatal("a non-member received a mention notification")
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
		return messagingSendMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.colleagueID), MessagingSendMessageInput{
			ConversationID: channel, Body: "Colleague reply",
			Mentions: []MessagingMention{{Type: "user", ID: fx.userID}},
		})
	}); err != nil {
		t.Fatal(err)
	}
	if fx.count(`SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND kind='mention' AND user_id=$2::uuid AND body='Colleague reply'`,
		fx.orgID, fx.userID) != 1 {
		t.Fatal("a human mention did not create exactly one notification")
	}

	reply, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
		return messagingSendMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingSendMessageInput{
			ConversationID: channel, Body: "A threaded reply", ParentMessageID: messagingUserPointer(agentMessage.MessageID),
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if fx.count(`SELECT count(*) FROM messages WHERE id=$1::uuid AND parent_message_id=$2::uuid`, reply.MessageID, agentMessage.MessageID) != 1 {
		t.Fatal("the threaded reply did not record its parent")
	}
	foreignRoot := fx.send(t, fx.userID, other, "elsewhere root")
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
		return messagingSendMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingSendMessageInput{
			ConversationID: channel, Body: "Cross-conversation reply", ParentMessageID: messagingUserPointer(foreignRoot),
		})
	}); err == nil || err.Error() != "reply target not found in this conversation" {
		t.Fatalf("cross-conversation reply err=%v, want a reply-target refusal", err)
	}

	listed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingListConversationsOutput, error) {
		return messagingListConversations(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID))
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Conversations) != 2 {
		t.Fatalf("listConversations returned %d rows, want the two membership-scoped channels", len(listed.Conversations))
	}
	byID := map[string]MessagingConversationListItem{}
	for _, item := range listed.Conversations {
		byID[item.ID] = item
	}
	if !byID[channel].CreatedByMe || byID[channel].Kind != messagingConversationKindChannl ||
		byID[channel].Title != "mentions" || byID[channel].ArchivedAt != nil || byID[channel].LastMessageAt == nil {
		t.Fatalf("listed channel=%+v, want the creator's channel with latest activity", byID[channel])
	}
	if _, parseErr := time.Parse("2006-01-02T15:04:05.000Z", *byID[channel].LastMessageAt); parseErr != nil {
		t.Fatalf("lastMessageAt=%q is not millisecond ISO with a Z suffix", *byID[channel].LastMessageAt)
	}

	people, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingListPeopleOutput, error) {
		return messagingListPeople(fx.ctx, tx, fx.orgID, MessagingListPeopleInput{
			Query: messagingUserPointer("Messaging colleague"),
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(people.People) != 1 || people.People[0].Type != "user" || people.People[0].ID != fx.colleagueID {
		t.Fatalf("listPeople=%+v, want only the matching organization member", people.People)
	}
	all, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingListPeopleOutput, error) {
		return messagingListPeople(fx.ctx, tx, fx.orgID, MessagingListPeopleInput{})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(all.People) != 4 {
		t.Fatalf("listPeople returned %d rows, want three members plus the workmate", len(all.People))
	}
	last := all.People[len(all.People)-1]
	if last.Type != "agent" || last.ID != messagingWorkmateID || last.Name != messagingWorkmateName {
		t.Fatalf("listPeople workmate row=%+v, want the agent entry last", last)
	}
	for _, person := range all.People {
		if person.ID == fx.otherOrgUser {
			t.Fatalf("listPeople leaked a foreign organization member: %+v", person)
		}
	}
	workmateQuery, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingListPeopleOutput, error) {
		return messagingListPeople(fx.ctx, tx, fx.orgID, MessagingListPeopleInput{Query: messagingUserPointer("chaste")})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(workmateQuery.People) != 1 || workmateQuery.People[0].Type != "agent" {
		t.Fatalf("listPeople with a workmate query=%+v, want only the agent entry", workmateQuery.People)
	}
}

func TestMessagingAttachmentsArePrivateAndPendingOnly(t *testing.T) {
	fx := newMessagingFixture(t)
	channel := fx.createChannel(t, fx.userID, "private-features")
	fx.addMember(t, fx.userID, channel, fx.colleagueID)
	fx.send(t, fx.userID, channel, "Member only")

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingUploadMessageAttachmentOutput, error) {
		return messagingUploadMessageAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingUploadMessageAttachmentInput{
			ConversationID: channel, Filename: "private.txt", MimeType: "text/plain",
			ContentBase64: "bm8=",
		})
	}); err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("upload by a non-member err=%v, want a membership refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingUploadMessageAttachmentOutput, error) {
		return messagingUploadMessageAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingUploadMessageAttachmentInput{
			ConversationID: channel, Filename: "private.txt", MimeType: "text/plain", ContentBase64: "not base64!",
		})
	}); err == nil || err.Error() != "attachment must be valid base64 and at most 5 MB" {
		t.Fatalf("upload with a malformed payload err=%v, want a base64 refusal", err)
	}

	uploaded, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingUploadMessageAttachmentOutput, error) {
		return messagingUploadMessageAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingUploadMessageAttachmentInput{
			ConversationID: channel, Filename: "../brief.txt", MimeType: "text/plain",
			ContentBase64: "aGVsbG8gZnJvbSBhIHByaXZhdGUgYXR0YWNobWVudA==",
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	var filename, mimeType string
	var sizeBytes int64
	var content []byte
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT filename, mime_type, size_bytes, content FROM message_attachments WHERE id=$1::uuid`,
		uploaded.AttachmentID).Scan(&filename, &mimeType, &sizeBytes, &content); err != nil {
		t.Fatal(err)
	}
	if filename != ".._brief.txt" || mimeType != "text/plain" || sizeBytes != 31 || string(content) != "hello from a private attachment" {
		t.Fatalf("stored attachment filename=%q mime=%q size=%d content=%q", filename, mimeType, sizeBytes, content)
	}

	sentWithFile, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
		return messagingSendMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingSendMessageInput{
			ConversationID: channel, Body: "", AttachmentIDs: []string{uploaded.AttachmentID, uploaded.AttachmentID},
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if fx.count(`SELECT count(*) FROM message_attachments WHERE id=$1::uuid AND message_id=$2::uuid`, uploaded.AttachmentID, sentWithFile.MessageID) != 1 {
		t.Fatal("sending a message did not attach the pending upload")
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeletePendingAttachmentOutput, error) {
		return messagingDeletePendingAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingDeletePendingAttachmentInput{
			AttachmentID: uploaded.AttachmentID,
		})
	}); err == nil || err.Error() != "pending attachment not found" {
		t.Fatalf("deletePendingAttachment on a sent upload err=%v, want not found", err)
	}

	pending, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingUploadMessageAttachmentOutput, error) {
		return messagingUploadMessageAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.colleagueID), MessagingUploadMessageAttachmentInput{
			ConversationID: channel, Filename: "draft.txt", MimeType: "text/plain", ContentBase64: "ZHJhZnQ=",
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeletePendingAttachmentOutput, error) {
		return messagingDeletePendingAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingDeletePendingAttachmentInput{
			AttachmentID: pending.AttachmentID,
		})
	}); err == nil || err.Error() != "pending attachment not found" {
		t.Fatalf("deletePendingAttachment for another uploader err=%v, want not found", err)
	}
	removed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeletePendingAttachmentOutput, error) {
		return messagingDeletePendingAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.colleagueID), MessagingDeletePendingAttachmentInput{
			AttachmentID: pending.AttachmentID,
		})
	})
	if err != nil || !removed.Removed {
		t.Fatalf("deletePendingAttachment=%+v err=%v, want a removed result", removed, err)
	}
	if fx.count(`SELECT count(*) FROM message_attachments WHERE id=$1::uuid`, pending.AttachmentID) != 0 {
		t.Fatal("deletePendingAttachment left the pending upload behind")
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
		return messagingSendMessage(fx.ctx, tx, fx.orgID, "agent", messagingUserPointer(fx.userID), MessagingSendMessageInput{
			ConversationID: channel, Body: "agent file", AttachmentIDs: []string{uploaded.AttachmentID},
		})
	}); err == nil || err.Error() != "only people can attach files" {
		t.Fatalf("agent attachment err=%v, want a people-only refusal", err)
	}
	unknown, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingUploadMessageAttachmentOutput, error) {
		return messagingUploadMessageAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingUploadMessageAttachmentInput{
			ConversationID: channel, Filename: "second.txt", MimeType: "text/plain", ContentBase64: "c2Vjb25k",
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
		return messagingSendMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingSendMessageInput{
			ConversationID: channel, Body: "mixed", AttachmentIDs: []string{unknown.AttachmentID, executorUUID(t)},
		})
	}); err == nil || err.Error() != "one or more attachments expired or are unavailable" {
		t.Fatalf("send with an unknown attachment err=%v, want an unavailable-attachment refusal", err)
	}
	if fx.count(`SELECT count(*) FROM message_attachments WHERE id=$1::uuid AND message_id IS NULL`, unknown.AttachmentID) != 1 {
		t.Fatal("a refused send consumed the pending upload")
	}
}

func TestMessagingRefusesCrossOrganizationConversations(t *testing.T) {
	fx := newMessagingFixture(t)
	var foreignID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO conversations (org_id, kind, title, created_by_user_id)
		VALUES ($1::uuid, 'channel', 'Foreign channel', $2::uuid) RETURNING id::text`, fx.otherOrgID, fx.otherOrgUser).Scan(&foreignID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1::uuid, $2::uuid)`, foreignID, fx.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO messages (org_id, conversation_id, sender_type, sender_user_id, body)
		VALUES ($1::uuid, $2::uuid, 'human', $3::uuid, 'Foreign message')`, fx.otherOrgID, foreignID, fx.otherOrgUser); err != nil {
		t.Fatal(err)
	}

	own := fx.createChannel(t, fx.userID, "Own channel")
	ownMessages, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: own, Limit: 30,
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ownMessages.Messages) != 0 {
		t.Fatalf("own channel returned %d messages, want none", len(ownMessages.Messages))
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: foreignID, Limit: 30,
		})
	})
	if err == nil || err.Error() != "conversation not found" {
		t.Fatalf("readMessages across organizations err=%v, want not found", err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		return messagingUpdateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingUpdateConversationInput{
			ConversationID: foreignID, Title: messagingUserPointer("hijack"),
		})
	})
	if err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("updateConversation across organizations err=%v, want a membership refusal", err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeleteConversationOutput, error) {
		return messagingDeleteConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingConversationIDInput{ConversationID: foreignID})
	})
	if err == nil || err.Error() != "conversation not found" {
		t.Fatalf("deleteConversation across organizations err=%v, want not found", err)
	}
	if fx.count(`SELECT count(*) FROM conversations WHERE id=$1::uuid AND deleted_at IS NOT NULL`, foreignID) != 0 {
		t.Fatal("a cross-organization delete touched the foreign channel")
	}

	ownList, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingListConversationsOutput, error) {
		return messagingListConversations(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID))
	})
	if err != nil {
		t.Fatal(err)
	}
	foreignList, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (MessagingListConversationsOutput, error) {
		return messagingListConversations(fx.ctx, tx, fx.otherOrgID, messagingUserPointer(fx.userID))
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ownList.Conversations) != 1 || ownList.Conversations[0].ID != own {
		t.Fatalf("own organization list=%+v, want only its own channel", ownList.Conversations)
	}
	if len(foreignList.Conversations) != 1 || foreignList.Conversations[0].ID != foreignID ||
		foreignList.Conversations[0].Title != "Foreign channel" || foreignList.Conversations[0].CreatedByMe {
		t.Fatalf("foreign organization list=%+v, want only the foreign channel it created", foreignList.Conversations)
	}
	if foreignList.Conversations[0].LastMessageAt == nil {
		t.Fatal("foreign organization list did not resolve lastMessageAt")
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", *foreignList.Conversations[0].LastMessageAt); err != nil {
		t.Fatalf("foreign lastMessageAt=%q is not millisecond ISO with a Z suffix", *foreignList.Conversations[0].LastMessageAt)
	}
	anonymous, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingListConversationsOutput, error) {
		return messagingListConversations(fx.ctx, tx, fx.orgID, nil)
	})
	if err != nil || len(anonymous.Conversations) != 0 {
		t.Fatalf("actor-less listConversations=%+v err=%v, want an empty list", anonymous, err)
	}
}

func TestMessagingReadMessagesPreservesLegacyOrderingAndLimit(t *testing.T) {
	fx := newMessagingFixture(t)
	channel := fx.createChannel(t, fx.userID, "ordering")
	for index := 0; index < 5; index++ {
		fx.send(t, fx.userID, channel, "message")
	}
	rows, err := fx.owner.Query(fx.ctx, `
		UPDATE messages SET created_at = $2::timestamptz
		WHERE conversation_id = $1::uuid AND id = (
			SELECT id FROM messages WHERE conversation_id = $1::uuid ORDER BY created_at ASC LIMIT 1)`,
		channel, time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	rows.Close()

	limited, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 2,
		})
	})
	if err != nil || len(limited.Messages) != 2 {
		t.Fatalf("readMessages limit=2 returned %d rows err=%v, want the two oldest", len(limited.Messages), err)
	}
	if limited.Messages[0].CreatedAt != "2026-09-01T08:00:00.000Z" || limited.Messages[1].CreatedAt == limited.Messages[0].CreatedAt {
		t.Fatalf("readMessages order=%+v, want ascending created order", limited.Messages)
	}
	full, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 30,
		})
	})
	if err != nil || len(full.Messages) != 5 {
		t.Fatalf("readMessages returned %d rows err=%v, want five", len(full.Messages), err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 30,
		})
	}); err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("readMessages by a non-member err=%v, want a membership refusal", err)
	}
}

func mustMarshalJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestMessagingCanonicalInputHashesAreStable(t *testing.T) {
	parsed, err := parseMessagingInput(messagingSendMessageCapabilityID,
		json.RawMessage(`{"conversationId":"c","body":"hi","unknown":1}`))
	if err != nil {
		t.Fatal(err)
	}
	hash, err := canonicalHash(parsed)
	if err != nil {
		t.Fatal(err)
	}
	repeat, err := parseMessagingInput(messagingSendMessageCapabilityID, json.RawMessage(`{"body":"hi","conversationId":"c"}`))
	if err != nil {
		t.Fatal(err)
	}
	repeatHash, err := canonicalHash(repeat)
	if err != nil {
		t.Fatal(err)
	}
	if hash != repeatHash {
		t.Fatalf("canonical hash %s != %s for the same payload with a different key order", hash, repeatHash)
	}
	cursor, err := parseMessagingInput(messagingAdvanceReadCursorCapabilityID,
		json.RawMessage(`{"conversationId":"3f0d2c14-9a1b-4c2d-8e3f-1a2b3c4d5e6f","readAt":null}`))
	if err != nil {
		t.Fatal(err)
	}
	cursorHash, err := canonicalHash(cursor)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cursorHash, "sha256:") && cursorHash == "" {
		t.Fatalf("canonical hash for the read cursor input=%q", cursorHash)
	}
	if !reflect.DeepEqual(messagingCapabilitySpecs[messagingSendMessageCapabilityID].InverseFields, []string{"messageId"}) {
		t.Fatal("sendMessage inverse fields changed")
	}
}
