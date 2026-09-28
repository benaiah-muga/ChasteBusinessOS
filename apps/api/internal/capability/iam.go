package capability

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

var iamRoleKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

type IAMListMembersInput struct{}

type IAMCreateRoleInput struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

type IAMUpdateRolePermissionsInput struct {
	RoleID      string   `json:"roleId"`
	Permissions []string `json:"permissions"`
}

type IAMAssignRoleInput struct {
	UserID string `json:"userId"`
	RoleID string `json:"roleId"`
}

type IAMInviteMemberInput struct {
	Email         string `json:"email"`
	RoleID        string `json:"roleId"`
	ExpiresInDays int    `json:"expiresInDays"`
}

type IAMListMembersOutput struct {
	Members []IAMMember `json:"members"`
	Roles   []IAMRole   `json:"roles"`
}

type IAMMember struct {
	UserID   string   `json:"userId"`
	Name     *string  `json:"name"`
	Email    string   `json:"email"`
	RoleKeys []string `json:"roleKeys"`
}

type IAMRole struct {
	ID          string   `json:"id"`
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	IsSystem    bool     `json:"isSystem"`
	Permissions []string `json:"permissions"`
}

type IAMCreateRoleOutput struct {
	RoleID string `json:"roleId"`
}

type IAMUpdateRolePermissionsOutput struct {
	PermissionCount int `json:"permissionCount"`
}

type IAMAssignRoleOutput struct {
	Assigned bool `json:"assigned"`
}

type IAMInviteMemberOutput struct {
	InvitationID string `json:"invitationId"`
	Token        string `json:"token"`
	ExpiresAt    string `json:"expiresAt"`
}

func parseIAMInput(capabilityID string, raw json.RawMessage) (any, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return nil, err
	}
	switch capabilityID {
	case iamListMembersCapabilityID:
		return IAMListMembersInput{}, nil
	case iamCreateRoleCapabilityID:
		key, err := iamRequiredString(fields, "key")
		if err != nil || !iamRoleKeyPattern.MatchString(key) {
			return nil, errors.New("key must match ^[a-z][a-z0-9-]*$")
		}
		name, err := iamRequiredString(fields, "name")
		if err != nil || utf16Length(name) < 1 || utf16Length(name) > 60 {
			return nil, errors.New("name must be between 1 and 60 characters")
		}
		return IAMCreateRoleInput{Key: key, Name: name}, nil
	case iamUpdateRolePermissionsCapabilityID:
		roleID, err := iamRequiredString(fields, "roleId")
		if err != nil {
			return nil, err
		}
		permissionsRaw, ok := fields["permissions"]
		if !ok || string(permissionsRaw) == "null" {
			return nil, errors.New("permissions must be an array")
		}
		var permissions []string
		if err := json.Unmarshal(permissionsRaw, &permissions); err != nil || permissions == nil || len(permissions) > 200 {
			return nil, errors.New("permissions must be an array with at most 200 entries")
		}
		for _, permission := range permissions {
			if permission == "" {
				return nil, errors.New("permission keys must be non-empty strings")
			}
		}
		return IAMUpdateRolePermissionsInput{RoleID: roleID, Permissions: permissions}, nil
	case iamAssignRoleCapabilityID:
		userID, err := iamRequiredString(fields, "userId")
		if err != nil {
			return nil, err
		}
		roleID, err := iamRequiredString(fields, "roleId")
		if err != nil {
			return nil, err
		}
		return IAMAssignRoleInput{UserID: userID, RoleID: roleID}, nil
	case iamInviteMemberCapabilityID:
		email, err := iamRequiredString(fields, "email")
		if err != nil || !iamValidEmail(email) {
			return nil, errors.New("email must be a valid email address")
		}
		roleID, err := iamRequiredString(fields, "roleId")
		if err != nil {
			return nil, err
		}
		days := 7
		if rawDays, exists := fields["expiresInDays"]; exists {
			if strings.TrimSpace(string(rawDays)) == "null" || json.Unmarshal(rawDays, &days) != nil || days < 1 || days > 30 {
				return nil, errors.New("expiresInDays must be an integer between 1 and 30")
			}
		}
		return IAMInviteMemberInput{Email: email, RoleID: roleID, ExpiresInDays: days}, nil
	default:
		return nil, fmt.Errorf("unsupported IAM capability %q", capabilityID)
	}
}

func iamRequiredString(fields map[string]json.RawMessage, name string) (string, error) {
	var value string
	raw, ok := fields[name]
	if !ok || json.Unmarshal(raw, &value) != nil || value == "" {
		return "", fmt.Errorf("%s must be a non-empty string", name)
	}
	return value, nil
}

func iamValidEmail(value string) bool {
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value && strings.Contains(value, "@")
}

func iamListMembers(ctx context.Context, tx pgx.Tx, orgID string) (IAMListMembersOutput, error) {
	output := IAMListMembersOutput{Members: []IAMMember{}, Roles: []IAMRole{}}
	rows, err := tx.Query(ctx, `
		SELECT id::text, key, name, is_system
		FROM roles WHERE org_id = $1::uuid ORDER BY key`, orgID)
	if err != nil {
		return output, err
	}
	roleIndexes := make(map[string]int)
	for rows.Next() {
		var role IAMRole
		if err := rows.Scan(&role.ID, &role.Key, &role.Name, &role.IsSystem); err != nil {
			rows.Close()
			return output, err
		}
		role.Permissions = []string{}
		roleIndexes[role.ID] = len(output.Roles)
		output.Roles = append(output.Roles, role)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return output, err
	}
	rows.Close()

	rows, err = tx.Query(ctx, `SELECT role_id::text, permission_key FROM role_permissions WHERE org_id = $1::uuid ORDER BY permission_key`, orgID)
	if err != nil {
		return output, err
	}
	for rows.Next() {
		var roleID, permission string
		if err := rows.Scan(&roleID, &permission); err != nil {
			rows.Close()
			return output, err
		}
		if i, ok := roleIndexes[roleID]; ok {
			output.Roles[i].Permissions = append(output.Roles[i].Permissions, permission)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return output, err
	}
	rows.Close()

	rows, err = tx.Query(ctx, `
		SELECT m.user_id::text, u.name, u.email
		FROM memberships m JOIN users u ON u.id = m.user_id
		WHERE m.org_id = $1::uuid ORDER BY u.email`, orgID)
	if err != nil {
		return output, err
	}
	memberIndexes := make(map[string]int)
	for rows.Next() {
		var member IAMMember
		if err := rows.Scan(&member.UserID, &member.Name, &member.Email); err != nil {
			rows.Close()
			return output, err
		}
		member.RoleKeys = []string{}
		memberIndexes[member.UserID] = len(output.Members)
		output.Members = append(output.Members, member)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return output, err
	}
	rows.Close()

	rows, err = tx.Query(ctx, `
		SELECT ur.user_id::text, r.key
		FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.org_id = ur.org_id
		WHERE ur.org_id = $1::uuid ORDER BY r.key`, orgID)
	if err != nil {
		return output, err
	}
	defer rows.Close()
	for rows.Next() {
		var userID, roleKey string
		if err := rows.Scan(&userID, &roleKey); err != nil {
			return output, err
		}
		if i, ok := memberIndexes[userID]; ok {
			output.Members[i].RoleKeys = append(output.Members[i].RoleKeys, roleKey)
		}
	}
	return output, rows.Err()
}

func iamCreateRole(ctx context.Context, tx pgx.Tx, orgID string, input IAMCreateRoleInput) (IAMCreateRoleOutput, error) {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM roles WHERE org_id = $1::uuid AND key = $2)`, orgID, input.Key).Scan(&exists); err != nil {
		return IAMCreateRoleOutput{}, err
	}
	if exists {
		return IAMCreateRoleOutput{}, fmt.Errorf("role %q already exists", input.Key)
	}
	var roleID string
	err := tx.QueryRow(ctx, `INSERT INTO roles (org_id, key, name) VALUES ($1::uuid, $2, $3) RETURNING id::text`, orgID, input.Key, input.Name).Scan(&roleID)
	return IAMCreateRoleOutput{RoleID: roleID}, err
}

func iamUpdateRolePermissions(ctx context.Context, tx pgx.Tx, orgID string, input IAMUpdateRolePermissionsInput) (IAMUpdateRolePermissionsOutput, error) {
	var roleID, key string
	var isSystem bool
	err := tx.QueryRow(ctx, `SELECT id::text, key, is_system FROM roles WHERE id = $1::uuid AND org_id = $2::uuid`, input.RoleID, orgID).Scan(&roleID, &key, &isSystem)
	if errors.Is(err, pgx.ErrNoRows) {
		return IAMUpdateRolePermissionsOutput{}, errors.New("role not found")
	}
	if err != nil {
		return IAMUpdateRolePermissionsOutput{}, err
	}
	if isSystem && key == "owner" {
		return IAMUpdateRolePermissionsOutput{}, errors.New("the owner role cannot be edited")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1::uuid`, roleID); err != nil {
		return IAMUpdateRolePermissionsOutput{}, err
	}
	unique := make([]string, 0, len(input.Permissions))
	seen := make(map[string]struct{}, len(input.Permissions))
	for _, permission := range input.Permissions {
		if _, exists := seen[permission]; exists {
			continue
		}
		seen[permission] = struct{}{}
		unique = append(unique, permission)
	}
	for _, permission := range unique {
		if _, err := tx.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, $2, $3::uuid)`, roleID, permission, orgID); err != nil {
			return IAMUpdateRolePermissionsOutput{}, err
		}
	}
	return IAMUpdateRolePermissionsOutput{PermissionCount: len(unique)}, nil
}

func iamAssignRole(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input IAMAssignRoleInput) (IAMAssignRoleOutput, error) {
	orgID := claims.OrganizationID
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, orgID, "iam.owner-grants"); err != nil {
		return IAMAssignRoleOutput{}, err
	}
	var memberID string
	err := tx.QueryRow(ctx, `SELECT user_id::text FROM memberships WHERE user_id = $1::uuid AND org_id = $2::uuid`, input.UserID, orgID).Scan(&memberID)
	if errors.Is(err, pgx.ErrNoRows) {
		return IAMAssignRoleOutput{}, errors.New("user is not a member of this organization")
	}
	if err != nil {
		return IAMAssignRoleOutput{}, err
	}
	var roleID, roleKey string
	err = tx.QueryRow(ctx, `SELECT id::text, key FROM roles WHERE id = $1::uuid AND org_id = $2::uuid`, input.RoleID, orgID).Scan(&roleID, &roleKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return IAMAssignRoleOutput{}, errors.New("role not found")
	}
	if err != nil {
		return IAMAssignRoleOutput{}, err
	}
	if roleKey != "owner" {
		if err := iamAssertNotLastOwner(ctx, tx, orgID, input.UserID); err != nil {
			return IAMAssignRoleOutput{}, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_roles WHERE user_id = $1::uuid AND org_id = $2::uuid`, input.UserID, orgID); err != nil {
		return IAMAssignRoleOutput{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO user_roles (user_id, role_id, org_id, assigned_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`, input.UserID, roleID, orgID, claims.ActorID); err != nil {
		return IAMAssignRoleOutput{}, err
	}
	return IAMAssignRoleOutput{Assigned: true}, nil
}

func iamAssertNotLastOwner(ctx context.Context, tx pgx.Tx, orgID, userID string) error {
	var held bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.org_id = ur.org_id
			WHERE ur.user_id = $1::uuid AND ur.org_id = $2::uuid AND r.key = 'owner'
		)`, userID, orgID).Scan(&held); err != nil || !held {
		return err
	}
	rows, err := tx.Query(ctx, `
		SELECT ur.user_id::text FROM user_roles ur
		JOIN roles r ON r.id = ur.role_id AND r.org_id = ur.org_id
		WHERE ur.org_id = $1::uuid AND r.key = 'owner' FOR UPDATE OF ur`, orgID)
	if err != nil {
		return err
	}
	owners := 0
	for rows.Next() {
		var ownerID string
		if err := rows.Scan(&ownerID); err != nil {
			rows.Close()
			return err
		}
		if ownerID != userID {
			owners++
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if owners == 0 {
		return errors.New("cannot remove the organization's last owner: grant the owner role to someone else first")
	}
	return nil
}

func iamInviteMember(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, now time.Time, input IAMInviteMemberInput) (IAMInviteMemberOutput, error) {
	if claims.ActorType != "human" || claims.ActorID == nil {
		return IAMInviteMemberOutput{}, errors.New("member invitations require a human actor; ask your principal to send the invite")
	}
	var roleID string
	err := tx.QueryRow(ctx, `SELECT id::text FROM roles WHERE id = $1::uuid AND org_id = $2::uuid`, input.RoleID, claims.OrganizationID).Scan(&roleID)
	if errors.Is(err, pgx.ErrNoRows) {
		return IAMInviteMemberOutput{}, errors.New("role not found")
	}
	if err != nil {
		return IAMInviteMemberOutput{}, err
	}
	randomToken := make([]byte, 24)
	if _, err := rand.Read(randomToken); err != nil {
		return IAMInviteMemberOutput{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(randomToken)
	expiresAt := now.Add(time.Duration(input.ExpiresInDays) * 24 * time.Hour)
	var invitationID string
	err = tx.QueryRow(ctx, `
		INSERT INTO invitations (org_id, email, role_id, token, invited_by_user_id, expires_at)
		VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6) RETURNING id::text`,
		claims.OrganizationID, strings.ToLower(input.Email), roleID, token, *claims.ActorID, expiresAt).Scan(&invitationID)
	if err != nil {
		return IAMInviteMemberOutput{}, err
	}
	return IAMInviteMemberOutput{InvitationID: invitationID, Token: token, ExpiresAt: expiresAt.UTC().Format("2006-01-02T15:04:05.000Z07:00")}, nil
}
