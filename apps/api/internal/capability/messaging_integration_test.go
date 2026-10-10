package capability

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
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

func executeMessagingCapability(fx *messagingFixture, capabilityID, input, intent string) (Result, error) {
	raw := json.RawMessage(input)
	claims := fx.humanClaims(raw, intent)
	claims.CapabilityID = capabilityID
	claims.Permissions = []string{"messaging.write"}
	return fx.executor.Execute(fx.ctx, claims, capabilityID, raw)
}

func TestMessagingEditRestoreRequiresReceiptAndReplaysGuardedInverse(t *testing.T) {
	fx := newMessagingFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'messaging.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	channel := fx.createChannel(t, fx.userID, "guarded edits")
	messageID := fx.send(t, fx.userID, channel, "original wording")

	edit, err := executeMessagingCapability(fx, messagingEditMessageCapabilityID,
		`{"messageId":"`+messageID+`","body":"corrected wording"}`, "message-edit-inverse-edit")
	if err != nil || !edit.OK {
		t.Fatalf("edit result=%+v err=%v", edit, err)
	}
	var editSnapshot MessagingEditMessageOutput
	if err := json.Unmarshal(edit.Data, &editSnapshot); err != nil {
		t.Fatal(err)
	}
	if editSnapshot.Body != "original wording" || editSnapshot.ExpectedBody != "corrected wording" || editSnapshot.ExpectedEditedAt == "" || editSnapshot.EditedAt == "" {
		t.Fatalf("edit inverse snapshot=%+v", editSnapshot)
	}
	fabricated := `{"messageId":"` + messageID + `","body":"invented original","expectedBody":"corrected wording","expectedEditedAt":"` + editSnapshot.ExpectedEditedAt + `"}`
	if result, err := executeMessagingCapability(fx, messagingRestoreMessageEditCapabilityID, fabricated, "message-edit-fabricated-restore"); err == nil || !strings.Contains(err.Error(), "matching successful edit receipt") {
		t.Fatalf("restore fabricated snapshot result=%+v err=%v, want receipt proof rejection", result, err)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingRestoreMessageEditOutput, error) {
		return messagingRestoreMessageEdit(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.colleagueID), MessagingRestoreMessageEditInput{
			MessageID: messageID, Body: editSnapshot.Body, ExpectedBody: editSnapshot.ExpectedBody, ExpectedEditedAt: editSnapshot.ExpectedEditedAt,
		})
	}); err == nil || err.Error() != "you can only restore your own messages" {
		t.Fatalf("restore by different author err=%v, want author refusal", err)
	}

	var wrongTenant MessagingRestoreMessageEditOutput
	_, tenantErr := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (MessagingRestoreMessageEditOutput, error) {
		return messagingRestoreMessageEdit(fx.ctx, tx, fx.otherOrgID, "human", messagingUserPointer(fx.userID), MessagingRestoreMessageEditInput{
			MessageID: messageID, Body: editSnapshot.Body, ExpectedBody: editSnapshot.ExpectedBody, ExpectedEditedAt: editSnapshot.ExpectedEditedAt,
		})
	})
	if tenantErr == nil || tenantErr.Error() != "message not found" {
		t.Fatalf("restore in foreign tenant=%+v err=%v, want tenant-isolated not found", wrongTenant, tenantErr)
	}

	restoreInput, err := json.Marshal(MessagingRestoreMessageEditInput{
		MessageID: editSnapshot.MessageID, Body: editSnapshot.Body, ExpectedBody: editSnapshot.ExpectedBody, ExpectedEditedAt: editSnapshot.ExpectedEditedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	restored, err := executeMessagingCapability(fx, messagingRestoreMessageEditCapabilityID, string(restoreInput), "message-edit-inverse-restore")
	if err != nil || !restored.OK {
		t.Fatalf("restore from edit receipt result=%+v err=%v", restored, err)
	}
	var restoreSnapshot MessagingRestoreMessageEditOutput
	if err := json.Unmarshal(restored.Data, &restoreSnapshot); err != nil {
		t.Fatal(err)
	}
	if restoreSnapshot.MessageID != messageID || restoreSnapshot.Body != "corrected wording" || restoreSnapshot.ExpectedBody != "original wording" {
		t.Fatalf("restore inverse snapshot=%+v", restoreSnapshot)
	}
	restoreReplay, err := executeMessagingCapability(fx, messagingRestoreMessageEditCapabilityID, string(restoreInput), "message-edit-inverse-restore")
	var replaySnapshot MessagingRestoreMessageEditOutput
	if err := json.Unmarshal(restoreReplay.Data, &replaySnapshot); err != nil {
		t.Fatal(err)
	}
	if err != nil || !restoreReplay.OK || !restoreReplay.Replayed || !reflect.DeepEqual(replaySnapshot, restoreSnapshot) {
		t.Fatalf("restore receipt replay=%+v err=%v", restoreReplay, err)
	}

	editInput, err := json.Marshal(MessagingEditMessageInput{
		MessageID: restoreSnapshot.MessageID, Body: restoreSnapshot.Body, ExpectedBody: &restoreSnapshot.ExpectedBody,
		ExpectedEditedAt: &restoreSnapshot.ExpectedEditedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	redone, err := executeMessagingCapability(fx, messagingEditMessageCapabilityID, string(editInput), "message-edit-inverse-redo")
	if err != nil || !redone.OK {
		t.Fatalf("redo from restore receipt result=%+v err=%v", redone, err)
	}
	var currentBody string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT body FROM messages WHERE id=$1::uuid AND org_id=$2::uuid`, messageID, fx.orgID).Scan(&currentBody); err != nil {
		t.Fatal(err)
	}
	if currentBody != "corrected wording" {
		t.Fatalf("body after reciprocal inverse=%q, want corrected wording", currentBody)
	}

	var redoSnapshot MessagingEditMessageOutput
	if err := json.Unmarshal(redone.Data, &redoSnapshot); err != nil {
		t.Fatal(err)
	}
	changeToC, err := json.Marshal(MessagingEditMessageInput{
		MessageID: messageID, Body: "later wording", ExpectedBody: &redoSnapshot.ExpectedBody, ExpectedEditedAt: &redoSnapshot.ExpectedEditedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	changed, err := executeMessagingCapability(fx, messagingEditMessageCapabilityID, string(changeToC), "message-edit-aba-to-c")
	if err != nil || !changed.OK {
		t.Fatalf("edit to C result=%+v err=%v", changed, err)
	}
	var changedSnapshot MessagingEditMessageOutput
	if err := json.Unmarshal(changed.Data, &changedSnapshot); err != nil {
		t.Fatal(err)
	}
	backToB, err := json.Marshal(MessagingEditMessageInput{
		MessageID: messageID, Body: redoSnapshot.ExpectedBody, ExpectedBody: &changedSnapshot.ExpectedBody,
		ExpectedEditedAt: &changedSnapshot.ExpectedEditedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result, err := executeMessagingCapability(fx, messagingEditMessageCapabilityID, string(backToB), "message-edit-aba-back-to-b"); err != nil || !result.OK {
		t.Fatalf("edit back to B result=%+v err=%v", result, err)
	}
	if result, err := executeMessagingCapability(fx, messagingRestoreMessageEditCapabilityID, string(restoreInput), "message-edit-stale-restore"); err == nil || !strings.Contains(err.Error(), "message changed since the inverse") {
		t.Fatalf("restore after A-B-C-B result=%+v err=%v, want stale revision refusal", result, err)
	}
}

func TestMessagingDeleteRestoreRequiresReceiptAndGuardsABA(t *testing.T) {
	fx := newMessagingFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'messaging.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	channel := fx.createChannel(t, fx.userID, "guarded deletes")
	messageID := fx.send(t, fx.userID, channel, "message to restore")

	deletedResult, err := executeMessagingCapability(fx, messagingDeleteMessageCapabilityID,
		`{"messageId":"`+messageID+`"}`, "message-delete-inverse-delete")
	if err != nil || !deletedResult.OK {
		t.Fatalf("delete result=%+v err=%v", deletedResult, err)
	}
	var deleted MessagingDeleteMessageOutput
	if err := json.Unmarshal(deletedResult.Data, &deleted); err != nil {
		t.Fatal(err)
	}
	if deleted.MessageID != messageID || !deleted.Deleted || deleted.DeletedAt != nil || deleted.ExpectedDeletedAt == "" {
		t.Fatalf("delete inverse snapshot=%+v", deleted)
	}
	fabricated := `{"messageId":"` + messageID + `","deletedAt":"2020-01-01T00:00:00.000Z","expectedDeletedAt":"` + deleted.ExpectedDeletedAt + `"}`
	if result, err := executeMessagingCapability(fx, messagingRestoreMessageDeleteCapabilityID, fabricated, "message-delete-fabricated-restore"); err == nil || !strings.Contains(err.Error(), "matching successful delete receipt") {
		t.Fatalf("restore fabricated snapshot result=%+v err=%v, want receipt proof rejection", result, err)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingRestoreMessageDeleteOutput, error) {
		return messagingRestoreMessageDelete(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.colleagueID), MessagingRestoreMessageDeleteInput{
			MessageID: messageID, DeletedAt: deleted.DeletedAt, ExpectedDeletedAt: deleted.ExpectedDeletedAt,
		})
	}); err == nil || err.Error() != "you can only restore your own messages" {
		t.Fatalf("restore by different author err=%v, want author refusal", err)
	}
	var foreignTenant MessagingRestoreMessageDeleteOutput
	_, tenantErr := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (MessagingRestoreMessageDeleteOutput, error) {
		return messagingRestoreMessageDelete(fx.ctx, tx, fx.otherOrgID, "human", messagingUserPointer(fx.userID), MessagingRestoreMessageDeleteInput{
			MessageID: messageID, DeletedAt: deleted.DeletedAt, ExpectedDeletedAt: deleted.ExpectedDeletedAt,
		})
	})
	if tenantErr == nil || tenantErr.Error() != "message not found" {
		t.Fatalf("restore in foreign tenant=%+v err=%v, want tenant-isolated not found", foreignTenant, tenantErr)
	}

	restoreInput, err := json.Marshal(MessagingRestoreMessageDeleteInput{
		MessageID: deleted.MessageID, DeletedAt: deleted.DeletedAt, ExpectedDeletedAt: deleted.ExpectedDeletedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	restored, err := executeMessagingCapability(fx, messagingRestoreMessageDeleteCapabilityID, string(restoreInput), "message-delete-inverse-restore")
	if err != nil || !restored.OK {
		t.Fatalf("restore from delete receipt result=%+v err=%v", restored, err)
	}
	var restoredSnapshot MessagingRestoreMessageDeleteOutput
	if err := json.Unmarshal(restored.Data, &restoredSnapshot); err != nil {
		t.Fatal(err)
	}
	if restoredSnapshot.MessageID != messageID || restoredSnapshot.ExpectedDeletedAt != nil {
		t.Fatalf("restore inverse snapshot=%+v, want active state", restoredSnapshot)
	}
	replay, err := executeMessagingCapability(fx, messagingRestoreMessageDeleteCapabilityID, string(restoreInput), "message-delete-inverse-restore")
	var replaySnapshot MessagingRestoreMessageDeleteOutput
	if json.Unmarshal(replay.Data, &replaySnapshot) != nil || err != nil || !replay.OK || !replay.Replayed || !reflect.DeepEqual(replaySnapshot, restoredSnapshot) {
		t.Fatalf("restore receipt replay=%+v snapshot=%+v err=%v", replay, replaySnapshot, err)
	}

	redoInput := `{"messageId":"` + restoredSnapshot.MessageID + `","expectedDeletedAt":null}`
	redone, err := executeMessagingCapability(fx, messagingDeleteMessageCapabilityID, redoInput, "message-delete-inverse-redo")
	if err != nil || !redone.OK {
		t.Fatalf("redo delete from restore receipt result=%+v err=%v", redone, err)
	}
	var redoneSnapshot MessagingDeleteMessageOutput
	if err := json.Unmarshal(redone.Data, &redoneSnapshot); err != nil {
		t.Fatal(err)
	}
	if redoneSnapshot.DeletedAt != nil || redoneSnapshot.ExpectedDeletedAt <= deleted.ExpectedDeletedAt {
		t.Fatalf("redo delete snapshot=%+v, want active prior state and a fresh timestamp", redoneSnapshot)
	}
	staleRestore, err := executeMessagingCapability(fx, messagingRestoreMessageDeleteCapabilityID, string(restoreInput), "message-delete-stale-restore")
	if err == nil || staleRestore.OK || !strings.Contains(err.Error(), "deletion state changed") {
		t.Fatalf("old restore after delete/restore/delete=%+v err=%v, want ABA guard refusal", staleRestore, err)
	}
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

func TestMessagingCreateConversationPersistsChannelStateAndCreatorMembership(t *testing.T) {
	fx := newMessagingFixture(t)
	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		input, err := parseMessagingCreateConversationInput(json.RawMessage(`{"title":"Vite channel","agentEnabled":true}`))
		if err != nil {
			return MessagingConversationIDOutput{}, err
		}
		return messagingCreateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), input)
	})
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}

	var orgID, title, createdBy string
	var agentEnabled bool
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text, title, created_by_user_id::text, agent_enabled
		FROM conversations WHERE id = $1::uuid`, created.ConversationID,
	).Scan(&orgID, &title, &createdBy, &agentEnabled); err != nil {
		t.Fatalf("load created channel: %v", err)
	}
	if orgID != fx.orgID || title != "Vite channel" || createdBy != fx.userID || !agentEnabled {
		t.Fatalf("created channel = org %q title %q creator %q agentEnabled %v", orgID, title, createdBy, agentEnabled)
	}
	if got := fx.count(`SELECT count(*) FROM conversation_members WHERE conversation_id = $1::uuid AND user_id = $2::uuid`, created.ConversationID, fx.userID); got != 1 {
		t.Fatalf("creator membership count = %d, want 1", got)
	}
}

func TestMessagingAddMemberExecutorContractReplayAndConcurrentDuplicates(t *testing.T) {
	fx := newMessagingFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'messaging.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	channel := fx.createChannel(t, fx.userID, "member invitations")
	input := fmt.Sprintf(`{"conversationId":%q,"userId":%q}`, channel, fx.colleagueID)

	added, err := executeMessagingCapability(fx, messagingAddMemberCapabilityID, input, "messaging-add-member-contract")
	if err != nil || !added.OK || string(added.Data) != `{"added":true}` {
		t.Fatalf("addMember result=%+v data=%s err=%v, want exact {added:true} contract", added, added.Data, err)
	}
	replay, err := executeMessagingCapability(fx, messagingAddMemberCapabilityID, input, "messaging-add-member-contract")
	var replayOutput MessagingAddMemberOutput
	if json.Unmarshal(replay.Data, &replayOutput) != nil || err != nil || !replay.OK || !replay.Replayed || replayOutput.Added != true {
		t.Fatalf("addMember replay=%+v err=%v, want stable receipt replay", replay, err)
	}
	if count := fx.count(`SELECT count(*) FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, channel, fx.colleagueID); count != 1 {
		t.Fatalf("membership rows after replay=%d, want one", count)
	}

	// A regular member has the same invitation permission as the creator.
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, fx.orgID, fx.otherOrgUser); err != nil {
		t.Fatal(err)
	}
	memberInput := fmt.Sprintf(`{"conversationId":%q,"userId":%q}`, channel, fx.otherOrgUser)
	memberAdded, err := executeMessagingCapability(fx, messagingAddMemberCapabilityID, memberInput, "messaging-add-member-by-member")
	if err != nil || !memberAdded.OK || string(memberAdded.Data) != `{"added":true}` {
		t.Fatalf("member add result=%+v err=%v, want regular member to invite", memberAdded, err)
	}

	// Different intents can race after a caller loses a response. Both should
	// succeed and the unique membership row should still be singular.
	raceInput := fmt.Sprintf(`{"conversationId":%q,"userId":%q}`, channel, fx.nonMemberID)
	start := make(chan struct{})
	type addResult struct {
		result Result
		err    error
	}
	results := make(chan addResult, 2)
	var workers sync.WaitGroup
	for index := 0; index < 2; index++ {
		workers.Add(1)
		go func(index int) {
			defer workers.Done()
			<-start
			result, err := executeMessagingCapability(fx, messagingAddMemberCapabilityID, raceInput, fmt.Sprintf("messaging-add-member-race-%d", index))
			results <- addResult{result: result, err: err}
		}(index)
	}
	close(start)
	workers.Wait()
	close(results)
	for result := range results {
		if result.err != nil || !result.result.OK || string(result.result.Data) != `{"added":true}` {
			t.Errorf("concurrent add result=%+v err=%v, want success with exact output", result.result, result.err)
		}
	}
	if count := fx.count(`SELECT count(*) FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, channel, fx.nonMemberID); count != 1 {
		t.Fatalf("membership rows after concurrent adds=%d, want one", count)
	}
}

func TestMessagingUpdateConversationMatchesViteContractAndReplaysReceipt(t *testing.T) {
	fx := newMessagingFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'messaging.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	channel := fx.createChannel(t, fx.userID, "settings channel")
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE conversations SET agent_enabled=true WHERE id=$1::uuid AND org_id=$2::uuid`, channel, fx.orgID); err != nil {
		t.Fatal(err)
	}

	input := `{"conversationId":"` + channel + `","title":"Updated settings","agentEnabled":false,"extra":"ignored like the Vite capability schema"}`
	result, err := executeMessagingCapability(fx, messagingUpdateConversationCapabilityID, input, "messaging-update-vite-contract")
	if err != nil || !result.OK {
		t.Fatalf("update conversation result=%+v err=%v", result, err)
	}
	if string(result.Data) != `{"conversationId":"`+channel+`"}` {
		t.Fatalf("update conversation output=%s, want the Vite {conversationId} contract", result.Data)
	}
	var title string
	var agentEnabled bool
	if err := fx.owner.QueryRow(fx.ctx, `SELECT title, agent_enabled FROM conversations WHERE id=$1::uuid AND org_id=$2::uuid`, channel, fx.orgID).Scan(&title, &agentEnabled); err != nil {
		t.Fatal(err)
	}
	if title != "Updated settings" || agentEnabled {
		t.Fatalf("updated conversation title=%q agentEnabled=%v, want Updated settings and false", title, agentEnabled)
	}

	replayed, err := executeMessagingCapability(fx, messagingUpdateConversationCapabilityID, input, "messaging-update-vite-contract")
	var replayedOutput MessagingConversationIDOutput
	if unmarshalErr := json.Unmarshal(replayed.Data, &replayedOutput); unmarshalErr != nil {
		t.Fatal(unmarshalErr)
	}
	if err != nil || !replayed.OK || !replayed.Replayed || replayedOutput.ConversationID != channel {
		t.Fatalf("same-intent update receipt replay=%+v err=%v, want the original Vite output", replayed, err)
	}

	// Explicit false is a real update; omission must preserve the existing setting.
	agentOnly := `{"conversationId":"` + channel + `","agentEnabled":true}`
	agentResult, err := executeMessagingCapability(fx, messagingUpdateConversationCapabilityID, agentOnly, "messaging-update-vite-agent-toggle")
	if err != nil || !agentResult.OK || string(agentResult.Data) != `{"conversationId":"`+channel+`"}` {
		t.Fatalf("agent-only update result=%+v err=%v", agentResult, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT title, agent_enabled FROM conversations WHERE id=$1::uuid AND org_id=$2::uuid`, channel, fx.orgID).Scan(&title, &agentEnabled); err != nil {
		t.Fatal(err)
	}
	if title != "Updated settings" || !agentEnabled {
		t.Fatalf("agent-only update changed title or missed toggle: title=%q agentEnabled=%v", title, agentEnabled)
	}
}

func TestMessagingArchiveConversationMatchesViteContractAndReplaysReceipt(t *testing.T) {
	fx := newMessagingFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'messaging.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	channel := fx.createChannel(t, fx.userID, "archive contract")
	fx.addMember(t, fx.userID, channel, fx.colleagueID)

	input := `{"conversationId":"` + channel + `","archived":true}`
	result, err := executeMessagingCapability(fx, messagingArchiveConversationCapabilityID, input, "messaging-archive-vite-contract")
	if err != nil || !result.OK {
		t.Fatalf("archive conversation result=%+v err=%v", result, err)
	}
	if string(result.Data) != `{"conversationId":"`+channel+`","archived":true}` {
		t.Fatalf("archive output=%s, want the Vite {conversationId, archived} contract", result.Data)
	}
	var archivedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT archived_at FROM conversations WHERE id=$1::uuid AND org_id=$2::uuid`, channel, fx.orgID).Scan(&archivedAt); err != nil {
		t.Fatalf("load archive timestamp: %v", err)
	}

	replayed, err := executeMessagingCapability(fx, messagingArchiveConversationCapabilityID, input, "messaging-archive-vite-contract")
	var replayedOutput MessagingArchiveConversationOutput
	if unmarshalErr := json.Unmarshal(replayed.Data, &replayedOutput); unmarshalErr != nil {
		t.Fatalf("decode replayed archive output: %v", unmarshalErr)
	}
	if err != nil || !replayed.OK || !replayed.Replayed || replayedOutput.ConversationID != channel || !replayedOutput.Archived {
		t.Fatalf("same-intent archive receipt replay=%+v err=%v, want the original Vite output", replayed, err)
	}
	var replayedArchivedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT archived_at FROM conversations WHERE id=$1::uuid AND org_id=$2::uuid`, channel, fx.orgID).Scan(&replayedArchivedAt); err != nil {
		t.Fatalf("load replayed archive timestamp: %v", err)
	}
	if !replayedArchivedAt.Equal(archivedAt) {
		t.Fatalf("replayed archive changed archived_at from %s to %s", archivedAt, replayedArchivedAt)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingArchiveConversationOutput, error) {
		return messagingArchiveConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingArchiveConversationInput{
			ConversationID: channel, Archived: false,
		})
	})
	if err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("non-member archive err=%v, want a membership refusal", err)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.otherOrgID, func(tx pgx.Tx) (MessagingArchiveConversationOutput, error) {
		return messagingArchiveConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingArchiveConversationInput{
			ConversationID: channel, Archived: false,
		})
	})
	if err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("cross-organization archive err=%v, want a membership refusal", err)
	}
	if got := fx.count(`SELECT count(*) FROM conversations WHERE id=$1::uuid AND org_id=$2::uuid AND archived_at IS NOT NULL`, channel, fx.orgID); got != 1 {
		t.Fatalf("denied archive changed channel archive state, rows=%d", got)
	}

	// Archiving and restoring are the same reversible capability with an explicit state value.
	restoredInput := `{"conversationId":"` + channel + `","archived":false}`
	restored, err := executeMessagingCapability(fx, messagingArchiveConversationCapabilityID, restoredInput, "messaging-archive-vite-restore")
	if err != nil || !restored.OK || string(restored.Data) != `{"conversationId":"`+channel+`","archived":false}` {
		t.Fatalf("restore conversation result=%+v err=%v", restored, err)
	}
	if got := fx.count(`SELECT count(*) FROM conversations WHERE id=$1::uuid AND org_id=$2::uuid AND archived_at IS NULL`, channel, fx.orgID); got != 1 {
		t.Fatalf("restore did not clear archived_at, rows=%d", got)
	}
}

func TestMessagingLeaveConversationMatchesViteContractAndReplaysReceipt(t *testing.T) {
	fx := newMessagingFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'messaging.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}

	// Leaving is allowed for the channel creator even when they are the only
	// member, matching the existing Vite capability contract.
	channel := fx.createChannel(t, fx.userID, "leave contract")
	input := `{"conversationId":"` + channel + `"}`
	result, err := executeMessagingCapability(fx, messagingLeaveConversationCapabilityID, input, "messaging-leave-vite-contract")
	if err != nil || !result.OK || string(result.Data) != `{"left":true}` {
		t.Fatalf("leave conversation result=%+v err=%v, want Vite {left:true} contract", result, err)
	}
	if got := fx.count(`SELECT count(*) FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, channel, fx.userID); got != 0 {
		t.Fatalf("creator leave kept membership row, count=%d", got)
	}

	replayed, err := executeMessagingCapability(fx, messagingLeaveConversationCapabilityID, input, "messaging-leave-vite-contract")
	var replayedOutput MessagingLeaveConversationOutput
	if unmarshalErr := json.Unmarshal(replayed.Data, &replayedOutput); unmarshalErr != nil {
		t.Fatal(unmarshalErr)
	}
	if err != nil || !replayed.OK || !replayed.Replayed || !replayedOutput.Left {
		t.Fatalf("same-intent leave replay=%+v err=%v, want original Vite {left:true} output", replayed, err)
	}
	if got := fx.count(`SELECT count(*) FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, channel, fx.userID); got != 0 {
		t.Fatalf("receipt replay restored membership, count=%d", got)
	}

	// The membership check and delete must be tenant scoped even if malformed
	// data contains a membership row for this user in another organization's DM.
	var foreignConversation string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO conversations (org_id, kind, title, created_by_user_id)
		VALUES ($1::uuid, 'dm', 'foreign dm', $2::uuid) RETURNING id::text`, fx.otherOrgID, fx.otherOrgUser).Scan(&foreignConversation); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `
		INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1::uuid, $2::uuid)`, foreignConversation, fx.userID); err != nil {
		t.Fatal(err)
	}
	foreignInput := `{"conversationId":"` + foreignConversation + `"}`
	foreignResult, err := executeMessagingCapability(fx, messagingLeaveConversationCapabilityID, foreignInput, "messaging-leave-foreign-tenant")
	if err == nil || err.Error() != "you are not a member of this conversation" || foreignResult.OK {
		t.Fatalf("cross-tenant leave result=%+v err=%v, want a membership refusal", foreignResult, err)
	}
	if got := fx.count(`SELECT count(*) FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, foreignConversation, fx.userID); got != 1 {
		t.Fatalf("cross-tenant leave changed foreign membership, count=%d", got)
	}

	// Direct-message members can leave too; there is no channel-only or
	// creator-only restriction on this capability.
	direct, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingConversationIDOutput, error) {
		return messagingCreateConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingCreateConversationInput{
			Title: "leaveable dm", Kind: messagingConversationKindDM,
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	fx.seedMember(t, direct.ConversationID, fx.colleagueID)
	left, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingLeaveConversationOutput, error) {
		return messagingLeaveConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.colleagueID), MessagingConversationIDInput{
			ConversationID: direct.ConversationID,
		})
	})
	if err != nil || !left.Left {
		t.Fatalf("DM member leave=%+v err=%v, want {left:true}", left, err)
	}
	if got := fx.count(`SELECT count(*) FROM conversation_members WHERE conversation_id=$1::uuid AND user_id=$2::uuid`, direct.ConversationID, fx.colleagueID); got != 0 {
		t.Fatalf("DM leave kept membership row, count=%d", got)
	}

	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingLeaveConversationOutput, error) {
		return messagingLeaveConversation(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingConversationIDInput{
			ConversationID: direct.ConversationID,
		})
	})
	if err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("non-member DM leave err=%v, want a membership refusal", err)
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
	if listed.Me != fx.userID {
		t.Fatalf("listConversations me=%q, want authenticated actor %q", listed.Me, fx.userID)
	}
	if len(listed.Conversations) != 2 {
		t.Fatalf("listConversations returned %d rows, want the two membership-scoped channels", len(listed.Conversations))
	}
	byID := map[string]MessagingConversationListItem{}
	for _, item := range listed.Conversations {
		byID[item.ID] = item
	}
	if !byID[channel].CreatedByMe || byID[channel].Kind != messagingConversationKindChannl ||
		byID[channel].Title != "mentions" || byID[channel].ArchivedAt != nil || byID[channel].LastMessage == nil ||
		byID[channel].LastMessage.Body != "A threaded reply" || byID[channel].UnreadCount != 2 {
		t.Fatalf("listed channel=%+v, want the creator's channel with latest activity", byID[channel])
	}
	for index := 0; index < 51; index++ {
		fx.createChannel(t, fx.userID, fmt.Sprintf("list window %02d", index))
	}
	listedPastFifty, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingListConversationsOutput, error) {
		return messagingListConversations(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID))
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(listedPastFifty.Conversations) != 53 {
		t.Fatalf("listConversations returned %d rows after adding 51 memberships, want all 53", len(listedPastFifty.Conversations))
	}
	if _, parseErr := time.Parse(time.RFC3339Nano, byID[channel].LastMessage.At); parseErr != nil {
		t.Fatalf("lastMessage.at=%q is not an ISO timestamp", byID[channel].LastMessage.At)
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

func TestMessagingDeletePendingAttachmentSerializesWithSend(t *testing.T) {
	fx := newMessagingFixture(t)
	channel := fx.createChannel(t, fx.userID, "attachment-delete-race")
	upload := func() string {
		t.Helper()
		pending, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingUploadMessageAttachmentOutput, error) {
			return messagingUploadMessageAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingUploadMessageAttachmentInput{
				ConversationID: channel, Filename: "draft.txt", MimeType: "text/plain", ContentBase64: "ZHJhZnQ=",
			})
		})
		if err != nil {
			t.Fatal(err)
		}
		return pending.AttachmentID
	}
	backendPID := func(tx pgx.Tx) (int32, error) {
		var pid int32
		err := tx.QueryRow(fx.ctx, `SELECT pg_backend_pid()`).Scan(&pid)
		return pid, err
	}
	waitForLockHolder := func(t *testing.T, pid int32) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			var waitType string
			if err := fx.owner.QueryRow(fx.ctx, `
				SELECT COALESCE(wait_event_type, '') FROM pg_stat_activity WHERE pid = $1`, pid).Scan(&waitType); err != nil {
				t.Fatalf("inspect blocked PostgreSQL backend %d: %v", pid, err)
			}
			if waitType == "Lock" {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("PostgreSQL backend %d did not enter a lock wait", pid)
	}

	t.Run("send locks before delete", func(t *testing.T) {
		attachmentID := upload()
		type sendResult struct {
			output MessagingSendMessageOutput
			err    error
		}
		type startResult struct {
			pid int32
			err error
		}
		sendReady := make(chan error, 1)
		releaseSend := make(chan struct{})
		sendReleased, sendFinished := false, false
		releaseSendTx := func() {
			if !sendReleased {
				close(releaseSend)
				sendReleased = true
			}
		}
		sendDone := make(chan sendResult, 1)
		deleteLaunched, deleteFinished := false, false
		deleteDone := make(chan error, 1)
		defer func() {
			releaseSendTx()
			if !sendFinished {
				<-sendDone
			}
			if deleteLaunched && !deleteFinished {
				<-deleteDone
			}
		}()
		go func() {
			output, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
				result, err := messagingSendMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingSendMessageInput{
					ConversationID: channel, Body: "Send owns attachment", AttachmentIDs: []string{attachmentID},
				})
				sendReady <- err
				if err != nil {
					return result, err
				}
				<-releaseSend
				return result, nil
			})
			sendDone <- sendResult{output: output, err: err}
		}()
		select {
		case err := <-sendReady:
			if err != nil {
				t.Fatalf("messagingSendMessage before readiness: %v", err)
			}
		case result := <-sendDone:
			sendFinished = true
			if result.err != nil {
				t.Fatalf("messagingSendMessage before readiness: %v", result.err)
			}
			t.Fatal("messagingSendMessage completed without entering the lock-holding section")
		}

		deleteStart := make(chan startResult, 1)
		deleteLaunched = true
		go func() {
			_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeletePendingAttachmentOutput, error) {
				pid, err := backendPID(tx)
				if err != nil {
					deleteStart <- startResult{err: err}
					return MessagingDeletePendingAttachmentOutput{}, err
				}
				deleteStart <- startResult{pid: pid}
				return messagingDeletePendingAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingDeletePendingAttachmentInput{
					AttachmentID: attachmentID,
				})
			})
			deleteDone <- err
		}()
		var deletePID int32
		select {
		case started := <-deleteStart:
			if started.err != nil {
				t.Fatalf("start delete transaction: %v", started.err)
			}
			deletePID = started.pid
		case err := <-deleteDone:
			deleteFinished = true
			t.Fatalf("delete completed before acquiring the send-held row: %v", err)
		}
		waitForLockHolder(t, deletePID)
		releaseSendTx()
		sent := <-sendDone
		sendFinished = true
		if sent.err != nil {
			t.Fatalf("messagingSendMessage: %v", sent.err)
		}
		if err := <-deleteDone; err == nil || err.Error() != "pending attachment not found" {
			deleteFinished = true
			t.Fatalf("delete after send err=%v, want pending attachment not found", err)
		}
		deleteFinished = true
		if fx.count(`SELECT count(*) FROM message_attachments WHERE id=$1::uuid AND message_id=$2::uuid`, attachmentID, sent.output.MessageID) != 1 {
			t.Fatal("delete removed an attachment committed by messagingSendMessage")
		}
	})

	t.Run("delete locks before send", func(t *testing.T) {
		attachmentID := upload()
		type startResult struct {
			pid int32
			err error
		}
		delReady := make(chan error, 1)
		releaseDelete := make(chan struct{})
		deleteReleased, deleteFinished := false, false
		releaseDeleteTx := func() {
			if !deleteReleased {
				close(releaseDelete)
				deleteReleased = true
			}
		}
		deleteDone := make(chan error, 1)
		sendLaunched, sendFinished := false, false
		sendDone := make(chan error, 1)
		defer func() {
			releaseDeleteTx()
			if !deleteFinished {
				<-deleteDone
			}
			if sendLaunched && !sendFinished {
				<-sendDone
			}
		}()
		go func() {
			_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingDeletePendingAttachmentOutput, error) {
				removed, err := messagingDeletePendingAttachment(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingDeletePendingAttachmentInput{
					AttachmentID: attachmentID,
				})
				delReady <- err
				if err != nil {
					return removed, err
				}
				<-releaseDelete
				return removed, nil
			})
			deleteDone <- err
		}()
		select {
		case err := <-delReady:
			if err != nil {
				t.Fatalf("messagingDeletePendingAttachment before readiness: %v", err)
			}
		case err := <-deleteDone:
			deleteFinished = true
			t.Fatalf("messagingDeletePendingAttachment completed before readiness: %v", err)
		}

		sendStart := make(chan startResult, 1)
		sendLaunched = true
		go func() {
			_, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingSendMessageOutput, error) {
				pid, err := backendPID(tx)
				if err != nil {
					sendStart <- startResult{err: err}
					return MessagingSendMessageOutput{}, err
				}
				sendStart <- startResult{pid: pid}
				return messagingSendMessage(fx.ctx, tx, fx.orgID, "human", messagingUserPointer(fx.userID), MessagingSendMessageInput{
					ConversationID: channel, Body: "Send loses attachment race", AttachmentIDs: []string{attachmentID},
				})
			})
			sendDone <- err
		}()
		var sendPID int32
		select {
		case started := <-sendStart:
			if started.err != nil {
				t.Fatalf("start send transaction: %v", started.err)
			}
			sendPID = started.pid
		case err := <-sendDone:
			sendFinished = true
			t.Fatalf("send completed before blocking on delete-held row: %v", err)
		}
		waitForLockHolder(t, sendPID)
		releaseDeleteTx()
		if err := <-deleteDone; err != nil {
			deleteFinished = true
			t.Fatalf("messagingDeletePendingAttachment: %v", err)
		}
		deleteFinished = true
		if err := <-sendDone; err == nil || err.Error() != "one or more attachments expired or are unavailable" {
			sendFinished = true
			t.Fatalf("send after delete err=%v, want unavailable attachment", err)
		}
		sendFinished = true
		if fx.count(`SELECT count(*) FROM message_attachments WHERE id=$1::uuid`, attachmentID) != 0 {
			t.Fatal("messagingSendMessage affected a deleted attachment")
		}
		if fx.count(`SELECT count(*) FROM messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND body='Send loses attachment race'`, fx.orgID, channel) != 0 {
			t.Fatal("messagingSendMessage committed a message after its attachment was deleted")
		}
	})
}

func TestMessagingUploadRedactsAuditAndSkipsSecretRiskApprovalPayload(t *testing.T) {
	fx := newMessagingFixture(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'messaging.write', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	conversationID := fx.createChannel(t, fx.userID, "private upload audit")
	content := []byte("private-attachment-canary-4d3b")
	contentBase64 := base64.StdEncoding.EncodeToString(content)
	input, err := json.Marshal(MessagingUploadMessageAttachmentInput{
		ConversationID: conversationID,
		Filename:       "private.txt",
		MimeType:       "text/plain",
		ContentBase64:  contentBase64,
	})
	if err != nil {
		t.Fatal(err)
	}
	fx.addPolicy(messagingUploadAttachmentCapabilityID, "read", []string{"secret"})
	claims := fx.humanClaims(input, "messaging-private-upload-audit")
	claims.CapabilityID = messagingUploadAttachmentCapabilityID
	claims.Permissions = []string{"messaging.write"}
	result, err := fx.executor.Execute(fx.ctx, claims, messagingUploadAttachmentCapabilityID, input)
	if err != nil || !result.OK || result.PendingApproval {
		t.Fatalf("upload result=%+v err=%v, want immediate private draft staging", result, err)
	}
	var output MessagingUploadMessageAttachmentOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	var storedContent []byte
	if err := fx.owner.QueryRow(fx.ctx, `SELECT content FROM message_attachments WHERE id=$1::uuid AND org_id=$2::uuid`, output.AttachmentID, fx.orgID).Scan(&storedContent); err != nil {
		t.Fatal(err)
	}
	if string(storedContent) != string(content) {
		t.Fatal("upload did not preserve the private attachment bytes")
	}
	var auditPayload string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT payload::text FROM ledger_events
		WHERE org_id=$1::uuid AND capability_id=$2 AND kind='capability.executed'
		ORDER BY seq DESC LIMIT 1`, fx.orgID, messagingUploadAttachmentCapabilityID).Scan(&auditPayload); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(auditPayload, `"input"`) || !strings.Contains(auditPayload, "[REDACTED: secret-class]") {
		t.Fatalf("upload audit payload=%s, want the secret-class redaction marker", auditPayload)
	}
	for _, secret := range []string{contentBase64, string(content)} {
		if strings.Contains(auditPayload, secret) {
			t.Fatalf("upload audit payload leaks attachment content: %s", auditPayload)
		}
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND capability_id=$2`, fx.orgID, messagingUploadAttachmentCapabilityID); got != 0 {
		t.Fatalf("upload created %d approval records under secret-risk policy, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, messagingUploadAttachmentCapabilityID); got != 0 {
		t.Fatalf("upload created %d approval audit events, want none", got)
	}
	if got := fx.count(`SELECT count(*) FROM notifications WHERE org_id=$1::uuid AND kind='approval.requested'`, fx.orgID); got != 0 {
		t.Fatalf("upload created %d approval notifications, want none", got)
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
	if foreignList.Conversations[0].LastMessage == nil || foreignList.Conversations[0].LastMessage.Body != "Foreign message" {
		t.Fatal("foreign organization list did not resolve its latest message body")
	}
	if _, err := time.Parse(time.RFC3339Nano, foreignList.Conversations[0].LastMessage.At); err != nil {
		t.Fatalf("foreign lastMessage.at=%q is not an ISO timestamp", foreignList.Conversations[0].LastMessage.At)
	}
	anonymous, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingListConversationsOutput, error) {
		return messagingListConversations(fx.ctx, tx, fx.orgID, nil)
	})
	if err != nil || len(anonymous.Conversations) != 0 || anonymous.Me != "" {
		t.Fatalf("actor-less listConversations=%+v err=%v, want an empty list", anonymous, err)
	}
}

func TestMessagingReadMessagesReturnsLatestWindowInDisplayOrder(t *testing.T) {
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
		t.Fatalf("readMessages limit=2 returned %d rows err=%v, want the two latest", len(limited.Messages), err)
	}
	if limited.Messages[0].CreatedAt == "2026-09-01T08:00:00.000Z" || limited.Messages[1].CreatedAt <= limited.Messages[0].CreatedAt {
		t.Fatalf("readMessages order=%+v, want the latest two in ascending display order", limited.Messages)
	}
	if !limited.HasMore || limited.NextCursor == nil || *limited.NextCursor != limited.Messages[0].ID || limited.Me != fx.userID {
		t.Fatalf("readMessages pagination/actor=%+v, want latest-page cursor and current actor", limited)
	}
	full, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 30,
		})
	})
	if err != nil || len(full.Messages) != 5 {
		t.Fatalf("readMessages returned %d rows err=%v, want five", len(full.Messages), err)
	}
	if full.HasMore || full.NextCursor != nil || len(full.Readers) != 1 || full.Readers[0].UserID != fx.userID || full.Conversation.ID != channel {
		t.Fatalf("readMessages full contract=%+v, want conversation, member readers, and no older page", full)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE messages SET created_at = $2::timestamptz WHERE conversation_id = $1::uuid`,
		channel, time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	var orderedIDs []string
	orderedRows, err := fx.owner.Query(fx.ctx, `SELECT id::text FROM messages WHERE conversation_id = $1::uuid AND deleted_at IS NULL ORDER BY created_at, id`, channel)
	if err != nil {
		t.Fatal(err)
	}
	for orderedRows.Next() {
		var id string
		if err := orderedRows.Scan(&id); err != nil {
			orderedRows.Close()
			t.Fatal(err)
		}
		orderedIDs = append(orderedIDs, id)
	}
	if err := orderedRows.Err(); err != nil {
		orderedRows.Close()
		t.Fatal(err)
	}
	orderedRows.Close()
	before := orderedIDs[3]
	older, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 2, Before: &before,
		})
	})
	if err != nil || len(older.Messages) != 2 || older.Messages[0].ID != orderedIDs[1] || older.Messages[1].ID != orderedIDs[2] ||
		!older.HasMore || older.NextCursor == nil || *older.NextCursor != orderedIDs[1] {
		t.Fatalf("readMessages older page=%+v err=%v, want stable keyset page before %s", older, err, before)
	}
	oldestBefore := *older.NextCursor
	oldestPage, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 2, Before: &oldestBefore,
		})
	})
	if err != nil || len(oldestPage.Messages) != 1 || oldestPage.Messages[0].ID != orderedIDs[0] || oldestPage.HasMore || oldestPage.NextCursor != nil {
		t.Fatalf("readMessages oldest page=%+v err=%v, want final older row and no cursor", oldestPage, err)
	}
	foreignChannel := fx.createChannel(t, fx.userID, "foreign cursor")
	foreignCursor := fx.send(t, fx.userID, foreignChannel, "not a cursor for this conversation")
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 2, Before: &foreignCursor,
		})
	}); err == nil || err.Error() != "message cursor not found" {
		t.Fatalf("readMessages cross-conversation cursor err=%v, want cursor refusal", err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE messages SET deleted_at = now() WHERE id = $1::uuid`, before); err != nil {
		t.Fatal(err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 2, Before: &before,
		})
	}); err == nil || err.Error() != "message cursor not found" {
		t.Fatalf("readMessages deleted cursor err=%v, want cursor refusal", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.nonMemberID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 30,
		})
	}); err == nil || err.Error() != "you are not a member of this conversation" {
		t.Fatalf("readMessages by a non-member err=%v, want a membership refusal", err)
	}
}

func TestMessagingReadMessagesAroundUsesStableBoundedWindow(t *testing.T) {
	fx := newMessagingFixture(t)
	channel := fx.createChannel(t, fx.userID, "around window")
	for index := 0; index < 65; index++ {
		fx.send(t, fx.userID, channel, "around message")
	}
	tiedTimestamp := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE messages SET created_at = $2 WHERE conversation_id = $1::uuid`, channel, tiedTimestamp); err != nil {
		t.Fatal(err)
	}
	orderedRows, err := fx.owner.Query(fx.ctx, `SELECT id::text FROM messages WHERE conversation_id = $1::uuid AND deleted_at IS NULL ORDER BY created_at, id`, channel)
	if err != nil {
		t.Fatal(err)
	}
	var orderedIDs []string
	for orderedRows.Next() {
		var id string
		if err := orderedRows.Scan(&id); err != nil {
			orderedRows.Close()
			t.Fatal(err)
		}
		orderedIDs = append(orderedIDs, id)
	}
	if err := orderedRows.Err(); err != nil {
		orderedRows.Close()
		t.Fatal(err)
	}
	orderedRows.Close()
	if len(orderedIDs) != 65 {
		t.Fatalf("fixture has %d messages, want 65", len(orderedIDs))
	}
	target := orderedIDs[35]
	around, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 5, Around: &target,
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(around.Messages) != 60 || around.Messages[30].ID != target || around.Messages[0].ID != orderedIDs[5] || around.Messages[59].ID != orderedIDs[64] {
		t.Fatalf("around window starts/target/ends unexpectedly: count=%d first=%v target=%v last=%v", len(around.Messages), around.Messages[0].ID, around.Messages[30].ID, around.Messages[len(around.Messages)-1].ID)
	}
	for index, message := range around.Messages {
		if message.ID != orderedIDs[index+5] {
			t.Fatalf("around message[%d]=%s, want tied-timestamp order %s", index, message.ID, orderedIDs[index+5])
		}
	}
	if !around.HasMore || around.NextCursor == nil || *around.NextCursor != orderedIDs[5] {
		t.Fatalf("around older pagination=%+v, want hasMore and oldest visible cursor %s", around, orderedIDs[5])
	}

	foreignChannel := fx.createChannel(t, fx.userID, "foreign around target")
	foreignTarget := fx.send(t, fx.userID, foreignChannel, "belongs to another conversation")
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 60, Around: &foreignTarget,
		})
	}); err == nil || err.Error() != "message not found" {
		t.Fatalf("readMessages around cross-conversation target err=%v, want target refusal", err)
	}
	deletedTarget := orderedIDs[1]
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE messages SET deleted_at = now() WHERE id = $1::uuid`, deletedTarget); err != nil {
		t.Fatal(err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (MessagingReadMessagesOutput, error) {
		return messagingReadMessages(fx.ctx, tx, fx.orgID, messagingUserPointer(fx.userID), MessagingReadMessagesInput{
			ConversationID: channel, Limit: 60, Around: &deletedTarget,
		})
	}); err == nil || err.Error() != "message not found" {
		t.Fatalf("readMessages around deleted target err=%v, want target refusal", err)
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
	unguardedEdit, err := parseMessagingInput(messagingEditMessageCapabilityID, json.RawMessage(`{"messageId":"m","body":"corrected"}`))
	if err != nil {
		t.Fatal(err)
	}
	guardedEdit, err := parseMessagingInput(messagingEditMessageCapabilityID,
		json.RawMessage(`{"messageId":"m","body":"corrected","expectedEditedAt":"2026-09-20T00:00:00.000Z"}`))
	if err != nil {
		t.Fatal(err)
	}
	unguardedHash, err := canonicalHash(unguardedEdit)
	if err != nil {
		t.Fatal(err)
	}
	guardedHash, err := canonicalHash(guardedEdit)
	if err != nil {
		t.Fatal(err)
	}
	if unguardedHash == guardedHash {
		t.Fatal("canonical edit hash ignored the expectedEditedAt inverse guard")
	}
	if !reflect.DeepEqual(messagingCapabilitySpecs[messagingSendMessageCapabilityID].InverseFields, []string{"messageId"}) {
		t.Fatal("sendMessage inverse fields changed")
	}
	if !reflect.DeepEqual(messagingCapabilitySpecs[messagingEditMessageCapabilityID].InverseFields,
		[]string{"messageId", "body", "expectedBody", "expectedEditedAt"}) {
		t.Fatal("editMessage inverse fields changed")
	}
}
