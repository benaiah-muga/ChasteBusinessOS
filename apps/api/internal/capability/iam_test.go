package capability

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

func TestGoIAMCapabilityContractsAndParsers(t *testing.T) {
	cases := []struct {
		id         string
		raw        string
		permission string
		risk       string
		want       any
	}{
		{iamListMembersCapabilityID, `{}`, "iam.read", "read", IAMListMembersInput{}},
		{iamCreateRoleCapabilityID, `{"key":"clerk-1","name":"Counter clerk"}`, "iam.admin", "identity", IAMCreateRoleInput{Key: "clerk-1", Name: "Counter clerk"}},
		{iamUpdateRolePermissionsCapabilityID, `{"roleId":"role-1","permissions":["crm.read","pos.sell"]}`, "iam.admin", "identity", IAMUpdateRolePermissionsInput{RoleID: "role-1", Permissions: []string{"crm.read", "pos.sell"}}},
		{iamAssignRoleCapabilityID, `{"userId":"user-1","roleId":"role-1"}`, "iam.admin", "identity", IAMAssignRoleInput{UserID: "user-1", RoleID: "role-1"}},
		{iamInviteMemberCapabilityID, `{"email":"clerk@example.com","roleId":"role-1"}`, "iam.admin", "write", IAMInviteMemberInput{Email: "clerk@example.com", RoleID: "role-1", ExpiresInDays: 7}},
	}
	for _, test := range cases {
		t.Run(test.id, func(t *testing.T) {
			spec, exists := capabilitySpecs[test.id]
			if !supportedCapability(test.id) || !exists || spec.module != "iam" || spec.permission != test.permission || spec.risk != test.risk {
				t.Fatalf("capability %q spec=%+v supported=%t", test.id, spec, supportedCapability(test.id))
			}
			parsed, err := parseIAMInput(test.id, json.RawMessage(test.raw))
			if err != nil {
				t.Fatal(err)
			}
			gotJSON, err := marshalJS(parsed)
			if err != nil {
				t.Fatal(err)
			}
			wantJSON, err := marshalJS(test.want)
			if err != nil {
				t.Fatal(err)
			}
			if string(gotJSON) != string(wantJSON) {
				t.Fatalf("parsed=%s want=%s", gotJSON, wantJSON)
			}
			if hash, err := canonicalInputHash(parsed); err != nil || hash == "" {
				t.Fatalf("canonical hash=%q err=%v", hash, err)
			}
			if permission, ok := permissionForCapability(test.id); !ok || permission != test.permission {
				t.Fatalf("approval permission=%q ok=%t", permission, ok)
			}
		})
	}

	invalid := []struct{ id, raw string }{
		{iamListMembersCapabilityID, `[]`},
		{iamCreateRoleCapabilityID, `{"key":"Owner","name":"Owner"}`},
		{iamCreateRoleCapabilityID, `{"key":"clerk","name":""}`},
		{iamCreateRoleCapabilityID, `{"key":"clerk","name":"` + strings.Repeat("x", 61) + `"}`},
		{iamUpdateRolePermissionsCapabilityID, `{"roleId":"r","permissions":[""]}`},
		{iamInviteMemberCapabilityID, `{"email":"bad","roleId":"r"}`},
		{iamInviteMemberCapabilityID, `{"email":"a@example.com","roleId":"r","expiresInDays":31}`},
		{iamInviteMemberCapabilityID, `{"email":"a@example.com","roleId":"r","expiresInDays":null}`},
	}
	for _, test := range invalid {
		if _, err := parseIAMInput(test.id, json.RawMessage(test.raw)); err == nil {
			t.Errorf("parseIAMInput(%s, %s) accepted invalid input", test.id, test.raw)
		}
	}
}

func TestGoIAMConcurrentLastOwnerReassignmentKeepsOneOwner(t *testing.T) {
	fx := newExecutorFixture(t)
	grantWavePermission(t, fx, "iam.admin")
	ownerRoleID := executorUUID(t)
	otherOwnerID := executorUUID(t)
	otherAuthUserID := "go-iam-concurrent-user-" + executorUUID(t)
	otherSessionID := "go-iam-concurrent-session-" + executorUUID(t)
	otherEmail := "go-iam-concurrent-" + executorUUID(t)[:8] + "@fixture.test"
	clerkRoleID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO roles (id, org_id, key, name, is_system) VALUES ($1::uuid, $2::uuid, 'owner', 'Owner', true), ($3::uuid, $2::uuid, 'clerk', 'Clerk', false)`, ownerRoleID, fx.orgID, clerkRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'iam.admin', $2::uuid)`, ownerRoleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE user_roles SET role_id = $1::uuid WHERE user_id = $2::uuid AND org_id = $3::uuid`, ownerRoleID, fx.userID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Second fixture owner')`, otherOwnerID, otherEmail); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO auth_user (id, name, email, email_verified) VALUES ($1, 'Second fixture owner', $2, true)`, otherAuthUserID, otherEmail); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO auth_session (id, expires_at, token, user_id) VALUES ($1, $2, $3, $4)`, otherSessionID, time.Now().Add(time.Hour), "token-"+executorUUID(t), otherAuthUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, fx.orgID, otherOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO user_roles (user_id, role_id, org_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, otherOwnerID, ownerRoleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		if _, err := fx.owner.Exec(cleanupCtx, `DELETE FROM user_roles WHERE user_id = $1::uuid`, otherOwnerID); err != nil {
			t.Errorf("delete concurrent owner grants: %v", err)
		}
		if _, err := fx.owner.Exec(cleanupCtx, `DELETE FROM memberships WHERE user_id = $1::uuid`, otherOwnerID); err != nil {
			t.Errorf("delete concurrent owner membership: %v", err)
		}
		if _, err := fx.owner.Exec(cleanupCtx, `DELETE FROM auth_session WHERE id = $1`, otherSessionID); err != nil {
			t.Errorf("delete concurrent owner session: %v", err)
		}
		if _, err := fx.owner.Exec(cleanupCtx, `DELETE FROM auth_user WHERE id = $1`, otherAuthUserID); err != nil {
			t.Errorf("delete concurrent auth user: %v", err)
		}
		if _, err := fx.owner.Exec(cleanupCtx, `DELETE FROM users WHERE id = $1::uuid`, otherOwnerID); err != nil {
			t.Errorf("delete concurrent owner: %v", err)
		}
	})

	type outcome struct {
		result Result
		err    error
	}
	start := make(chan struct{})
	results := make(chan outcome, 2)
	owners := []struct {
		userID, sessionID string
	}{
		{fx.userID, fx.authSessionID},
		{otherOwnerID, otherSessionID},
	}
	for i, owner := range owners {
		rawInput := json.RawMessage(`{"userId":"` + owner.userID + `","roleId":"` + clerkRoleID + `"}`)
		claims := waveModuleClaims(fx, iamAssignRoleCapabilityID, "iam.admin", rawInput, "human", "", "owner-reassignment-"+string(rune('a'+i)))
		claims.Subject = owner.userID
		claims.AuthSessionID = owner.sessionID
		actorID := owner.userID
		claims.ActorID = &actorID
		go func(claims authbridge.CapabilityClaims, raw json.RawMessage) {
			<-start
			result, err := fx.executor.Execute(fx.ctx, claims, iamAssignRoleCapabilityID, raw)
			results <- outcome{result: result, err: err}
		}(claims, rawInput)
	}
	close(start)
	passed := 0
	refused := 0
	for range owners {
		select {
		case result := <-results:
			if result.err == nil && result.result.OK {
				passed++
			} else if result.err != nil && strings.Contains(result.err.Error(), "last owner") {
				refused++
			} else {
				t.Fatalf("concurrent reassignment result=%+v err=%v", result.result, result.err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("concurrent owner reassignments did not finish")
		}
	}
	if passed != 1 || refused != 1 {
		t.Fatalf("concurrent reassignment successes=%d last-owner refusals=%d, want one each", passed, refused)
	}
	if got := fx.count(`SELECT count(*) FROM user_roles ur JOIN roles r ON r.id=ur.role_id AND r.org_id=ur.org_id WHERE ur.org_id=$1::uuid AND r.key='owner'`, fx.orgID); got != 1 {
		t.Fatalf("owner grants after concurrent reassignment=%d, want exactly one", got)
	}
}

func TestGoIAMCapabilitiesGovernedParity(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	grantWavePermission(t, fx, "iam.admin")
	grantWavePermission(t, fx, "iam.read")
	ownerRoleID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO roles (id, org_id, key, name, is_system) VALUES ($1::uuid, $2::uuid, 'owner', 'Owner', true)`, ownerRoleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	for _, permission := range []string{"iam.admin", "iam.read"} {
		if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, $2, $3::uuid)`, ownerRoleID, permission, fx.orgID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE user_roles SET role_id = $1::uuid WHERE user_id = $2::uuid AND org_id = $3::uuid`, ownerRoleID, fx.userID, fx.orgID); err != nil {
		t.Fatal(err)
	}

	roleInput := json.RawMessage(`{"key":"clerk","name":"Counter Clerk"}`)
	created := approveModuleWrite(t, fx, iamCreateRoleCapabilityID, "iam.admin", roleInput)
	var roleOutput IAMCreateRoleOutput
	if err := json.Unmarshal(created.Data, &roleOutput); err != nil || !created.OK || !isUUID(roleOutput.RoleID) {
		t.Fatalf("created=%+v output=%+v err=%v", created, roleOutput, err)
	}

	permissionInput := json.RawMessage(`{"roleId":"` + roleOutput.RoleID + `","permissions":["crm.read","pos.sell","crm.read"]}`)
	updated, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamUpdateRolePermissionsCapabilityID, "iam.admin", permissionInput, "human", "", ""), iamUpdateRolePermissionsCapabilityID, permissionInput)
	var permissionsOutput IAMUpdateRolePermissionsOutput
	if err != nil || json.Unmarshal(updated.Data, &permissionsOutput) != nil || !updated.OK || permissionsOutput.PermissionCount != 2 {
		t.Fatalf("update result=%+v output=%+v err=%v", updated, permissionsOutput, err)
	}
	if got := fx.count(`SELECT count(*) FROM role_permissions WHERE role_id=$1::uuid AND org_id=$2::uuid`, roleOutput.RoleID, fx.orgID); got != 2 {
		t.Fatalf("deduplicated role permission rows=%d, want 2", got)
	}
	ownerPermissions, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamUpdateRolePermissionsCapabilityID, "iam.admin", json.RawMessage(`{"roleId":"`+ownerRoleID+`","permissions":[]}`), "human", "", ""), iamUpdateRolePermissionsCapabilityID, json.RawMessage(`{"roleId":"`+ownerRoleID+`","permissions":[]}`))
	if err == nil || ownerPermissions.OK {
		t.Fatalf("owner role permissions update result=%+v err=%v, want immutable role refusal", ownerPermissions, err)
	}

	memberID := executorUUID(t)
	memberEmail := "new.member+" + memberID + "@example.test"
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'New Member')`, memberID, memberEmail); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, fx.orgID, memberID); err != nil {
		t.Fatal(err)
	}
	assignInput := json.RawMessage(`{"userId":"` + memberID + `","roleId":"` + roleOutput.RoleID + `"}`)
	assigned, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamAssignRoleCapabilityID, "iam.admin", assignInput, "human", "", ""), iamAssignRoleCapabilityID, assignInput)
	if err != nil || !assigned.OK || string(assigned.Data) != `{"assigned":true}` {
		t.Fatalf("assign result=%+v err=%v", assigned, err)
	}
	lastOwnerInput := json.RawMessage(`{"userId":"` + fx.userID + `","roleId":"` + roleOutput.RoleID + `"}`)
	lastOwnerResult, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamAssignRoleCapabilityID, "iam.admin", lastOwnerInput, "human", "", ""), iamAssignRoleCapabilityID, lastOwnerInput)
	if err == nil || lastOwnerResult.OK {
		t.Fatalf("last owner assignment=%+v err=%v, want refusal", lastOwnerResult, err)
	}

	inviteInput := json.RawMessage(`{"email":"Clerk@Example.Test","roleId":"` + roleOutput.RoleID + `","expiresInDays":3}`)
	invited, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamInviteMemberCapabilityID, "iam.admin", inviteInput, "human", "", ""), iamInviteMemberCapabilityID, inviteInput)
	var inviteOutput IAMInviteMemberOutput
	if err != nil || json.Unmarshal(invited.Data, &inviteOutput) != nil || !invited.OK || inviteOutput.Token == "" {
		t.Fatalf("invite result=%+v output=%+v err=%v", invited, inviteOutput, err)
	}
	var storedEmail, storedToken string
	var expiresAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT email, token, expires_at FROM invitations WHERE id=$1::uuid AND org_id=$2::uuid`, inviteOutput.InvitationID, fx.orgID).Scan(&storedEmail, &storedToken, &expiresAt); err != nil {
		t.Fatal(err)
	}
	if storedEmail != "clerk@example.test" || storedToken != inviteOutput.Token || time.Until(expiresAt) < 2*24*time.Hour {
		t.Fatalf("stored invitation email=%q tokenMatches=%t expires=%s", storedEmail, storedToken == inviteOutput.Token, expiresAt)
	}
	agentInviteClaims := waveModuleClaims(fx, iamInviteMemberCapabilityID, "iam.admin", inviteInput, "agent", fx.agentSession, "")
	if _, err := fx.executor.Execute(fx.ctx, agentInviteClaims, iamInviteMemberCapabilityID, inviteInput); err == nil || !strings.Contains(err.Error(), "member invitations require a human actor") {
		t.Fatalf("agent invitation err=%v, want human-only refusal", err)
	}
	var invitationCount int
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*)::int FROM invitations WHERE org_id=$1::uuid`, fx.orgID).Scan(&invitationCount); err != nil {
		t.Fatal(err)
	}
	if invitationCount != 1 {
		t.Fatalf("agent request created an invitation before human approval: count=%d, want 1", invitationCount)
	}

	listInput := json.RawMessage(`{}`)
	listed, err := fx.executor.Execute(fx.ctx, waveModuleClaims(fx, iamListMembersCapabilityID, "iam.read", listInput, "human", "", ""), iamListMembersCapabilityID, listInput)
	var listOutput IAMListMembersOutput
	if err != nil || json.Unmarshal(listed.Data, &listOutput) != nil || !listed.OK {
		t.Fatalf("list result=%+v output=%+v err=%v", listed, listOutput, err)
	}
	if len(listOutput.Members) != 2 || len(listOutput.Roles) != 3 {
		t.Fatalf("list members=%d roles=%d, want two members and three fixture, owner, and custom roles", len(listOutput.Members), len(listOutput.Roles))
	}
	var pending int
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*)::int FROM approvals WHERE org_id=$1::uuid AND capability_id=$2 AND status='pending'`, fx.orgID, iamCreateRoleCapabilityID).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("approved role changes left %d pending approvals", pending)
	}
}
