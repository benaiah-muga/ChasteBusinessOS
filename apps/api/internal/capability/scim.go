package capability

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

type SCIMProvisionUserInput struct {
	Operation string  `json:"operation"`
	Email     string  `json:"email,omitempty"`
	Name      *string `json:"name,omitempty"`
	UserID    string  `json:"userId,omitempty"`
}

type SCIMProvisionUserOutput struct {
	ID       string  `json:"id,omitempty"`
	Email    string  `json:"email,omitempty"`
	Name     *string `json:"name,omitempty"`
	Active   bool    `json:"active"`
	Found    bool    `json:"found"`
	Conflict string  `json:"conflict,omitempty"`
}

const scimAutomaticIntentPrefix = "scim:auto:"

const (
	SCIMTokenCreateCapabilityID = "iam.createSCIMToken"
	SCIMTokenRevokeCapabilityID = "iam.revokeSCIMToken"
)

type SCIMTokenCreateInput struct {
	TokenHash     string `json:"tokenHash"`
	Label         string `json:"label"`
	ExpiresInDays int    `json:"expiresInDays"`
}

type SCIMTokenRevokeInput struct {
	TokenID string `json:"tokenId"`
}

type SCIMTokenCreateOutput struct {
	TokenID   string    `json:"tokenId"`
	Label     string    `json:"label"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type SCIMTokenRevokeOutput struct {
	TokenID string `json:"tokenId"`
	Revoked bool   `json:"revoked"`
}

func ParseSCIMTokenCreateInput(raw json.RawMessage) (SCIMTokenCreateInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SCIMTokenCreateInput{}, err
	}
	for key := range fields {
		switch key {
		case "tokenHash", "label", "expiresInDays":
		default:
			return SCIMTokenCreateInput{}, fmt.Errorf("%s is not supported", key)
		}
	}
	var input SCIMTokenCreateInput
	if input.TokenHash, err = iamRequiredString(fields, "tokenHash"); err != nil || len(input.TokenHash) != 64 {
		return SCIMTokenCreateInput{}, errors.New("tokenHash must be a SHA-256 hex digest")
	}
	decodedHash, err := hex.DecodeString(input.TokenHash)
	if err != nil || len(decodedHash) != sha256.Size || strings.ToLower(input.TokenHash) != input.TokenHash {
		return SCIMTokenCreateInput{}, errors.New("tokenHash must be a lowercase SHA-256 hex digest")
	}
	if rawLabel, ok := fields["label"]; !ok || json.Unmarshal(rawLabel, &input.Label) != nil || utf16Length(input.Label) > 120 || strings.ContainsAny(input.Label, "\r\n\x00") {
		return SCIMTokenCreateInput{}, errors.New("label must be a string with at most 120 characters")
	}
	if rawDays, ok := fields["expiresInDays"]; !ok || json.Unmarshal(rawDays, &input.ExpiresInDays) != nil || input.ExpiresInDays < 1 || input.ExpiresInDays > 365 {
		return SCIMTokenCreateInput{}, errors.New("expiresInDays must be an integer between 1 and 365")
	}
	return input, nil
}

func ParseSCIMTokenRevokeInput(raw json.RawMessage) (SCIMTokenRevokeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SCIMTokenRevokeInput{}, err
	}
	for key := range fields {
		if key != "tokenId" {
			return SCIMTokenRevokeInput{}, fmt.Errorf("%s is not supported", key)
		}
	}
	var input SCIMTokenRevokeInput
	if input.TokenID, err = iamRequiredString(fields, "tokenId"); err != nil || !isUUID(input.TokenID) {
		return SCIMTokenRevokeInput{}, errors.New("tokenId must be a valid UUID")
	}
	return input, nil
}

func createSCIMToken(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SCIMTokenCreateInput, now time.Time) (SCIMTokenCreateOutput, error) {
	var output SCIMTokenCreateOutput
	output.Label = input.Label
	output.ExpiresAt = now.UTC().Add(time.Duration(input.ExpiresInDays) * 24 * time.Hour)
	err := tx.QueryRow(ctx, `
		INSERT INTO scim_tokens (org_id, token_hash, label, expires_at, created_by_user_id)
		VALUES ($1::uuid, $2, $3, $4, $5::uuid)
		RETURNING id::text, label, expires_at`,
		claims.OrganizationID, input.TokenHash, input.Label, output.ExpiresAt, claims.Subject,
	).Scan(&output.TokenID, &output.Label, &output.ExpiresAt)
	return output, err
}

func revokeSCIMToken(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SCIMTokenRevokeInput) (SCIMTokenRevokeOutput, error) {
	result, err := tx.Exec(ctx, `
		UPDATE scim_tokens SET active = false
		WHERE org_id = $1::uuid AND id = $2::uuid AND active = true`, claims.OrganizationID, input.TokenID)
	if err != nil {
		return SCIMTokenRevokeOutput{}, err
	}
	return SCIMTokenRevokeOutput{TokenID: input.TokenID, Revoked: result.RowsAffected() > 0}, nil
}

// ExecuteSCIMProvisionUser is the only external-actor entry into the
// capability executor. The IdP token is an explicit external actor, not a
// human session, and is revalidated inside the same organization transaction
// that performs and audits the provisioning action.
func (e *Executor) ExecuteSCIMProvisionUser(
	ctx context.Context,
	orgID string,
	scimTokenID string,
	intentID string,
	rawInput json.RawMessage,
) (Result, error) {
	if !isUUID(orgID) || !isUUID(scimTokenID) || strings.TrimSpace(intentID) == "" || len(intentID) > 160 {
		return Result{}, ErrScopeMismatch
	}
	digest, err := InputHash(rawInput)
	if err != nil {
		return Result{}, err
	}
	actorID := scimTokenID
	claims := authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		Subject:        "",
		OrganizationID: orgID,
		CapabilityID:   scimProvisionUserCapabilityID,
		InputSHA256:    digest,
		ActorID:        &actorID,
		ActorType:      "external",
		Permissions:    []string{"iam.scim.provision"},
		IntentID:       intentID,
	}
	return e.executeWithFinalizer(ctx, claims, scimProvisionUserCapabilityID, rawInput, false, "", nil, nil, true)
}

func ParseSCIMProvisionUserInput(raw json.RawMessage) (SCIMProvisionUserInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SCIMProvisionUserInput{}, err
	}
	for key := range fields {
		switch key {
		case "operation", "email", "name", "userId":
		default:
			return SCIMProvisionUserInput{}, fmt.Errorf("%s is not supported", key)
		}
	}
	operation, err := iamRequiredString(fields, "operation")
	if err != nil {
		return SCIMProvisionUserInput{}, err
	}
	input := SCIMProvisionUserInput{Operation: operation}
	switch operation {
	case "provision":
		input.Email, err = iamRequiredString(fields, "email")
		if err != nil || !scimValidEmail(input.Email) {
			return SCIMProvisionUserInput{}, errors.New("email must be a valid address")
		}
		input.Email = normalizeIdentityEmail(input.Email)
		if value, exists := fields["name"]; exists {
			var name string
			if json.Unmarshal(value, &name) != nil {
				return SCIMProvisionUserInput{}, errors.New("name must be a string")
			}
			name = strings.TrimSpace(name)
			if utf16Length(name) > 100 {
				return SCIMProvisionUserInput{}, errors.New("name must be at most 100 characters")
			}
			if name != "" {
				input.Name = &name
			}
		}
		if _, exists := fields["userId"]; exists {
			return SCIMProvisionUserInput{}, errors.New("userId is not valid for provisioning")
		}
	case "deactivate":
		input.UserID, err = iamRequiredString(fields, "userId")
		if err != nil || !isUUID(input.UserID) {
			return SCIMProvisionUserInput{}, errors.New("userId must be a valid UUID")
		}
		if _, exists := fields["email"]; exists {
			return SCIMProvisionUserInput{}, errors.New("email is not valid for deactivation")
		}
		if _, exists := fields["name"]; exists {
			return SCIMProvisionUserInput{}, errors.New("name is not valid for deactivation")
		}
	default:
		return SCIMProvisionUserInput{}, errors.New("operation must be provision or deactivate")
	}
	return input, nil
}

func scimValidEmail(value string) bool {
	if len(value) > 320 || strings.TrimSpace(value) != value {
		return false
	}
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value && validCustomerEmail(value)
}

func verifySCIMActor(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, now time.Time) error {
	if claims.ActorType != "external" || claims.Subject != "" || claims.ActorID == nil ||
		!isUUID(*claims.ActorID) || claims.AuthSessionID != "" || claims.AgentSessionID != "" ||
		claims.CapabilityID != scimProvisionUserCapabilityID || claims.Permissions == nil ||
		len(claims.Permissions) != 1 || claims.Permissions[0] != "iam.scim.provision" {
		return ErrSessionInvalid
	}
	var active bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM scim_tokens
		WHERE id = $1::uuid AND org_id = $2::uuid AND active = true
		  AND (expires_at IS NULL OR expires_at > $3)
	)`, *claims.ActorID, claims.OrganizationID, now).Scan(&active)
	if err != nil {
		return err
	}
	if !active {
		return ErrSessionInvalid
	}
	return nil
}

func scimProvisionUser(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SCIMProvisionUserInput) (SCIMProvisionUserOutput, error) {
	if input.Operation == "provision" {
		var member SCIMProvisionUserOutput
		err := tx.QueryRow(ctx, `
			SELECT user_id::text, email, name
			FROM public.chaste_resolve_or_create_scim_user($1::uuid, $2::uuid, $3, $4)`,
			*claims.ActorID, claims.OrganizationID, input.Email, input.Name,
		).Scan(&member.ID, &member.Email, &member.Name)
		if errors.Is(err, pgx.ErrNoRows) {
			return SCIMProvisionUserOutput{}, ErrSessionInvalid
		}
		if err != nil {
			return SCIMProvisionUserOutput{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)
			ON CONFLICT (org_id, user_id) DO NOTHING`, claims.OrganizationID, member.ID); err != nil {
			return SCIMProvisionUserOutput{}, err
		}
		member.Active = true
		member.Found = true
		return member, nil
	}

	var member SCIMProvisionUserOutput
	err := tx.QueryRow(ctx, `
		SELECT u.id::text, u.email, u.name
		FROM memberships m JOIN users u ON u.id = m.user_id
		WHERE m.org_id = $1::uuid AND u.id = $2::uuid
		FOR UPDATE OF m`, claims.OrganizationID, input.UserID).Scan(&member.ID, &member.Email, &member.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return SCIMProvisionUserOutput{Found: false}, nil
	}
	if err != nil {
		return SCIMProvisionUserOutput{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, claims.OrganizationID, "iam.owner-grants"); err != nil {
		return SCIMProvisionUserOutput{}, err
	}
	if err := iamAssertNotLastOwner(ctx, tx, claims.OrganizationID, member.ID); err != nil {
		if strings.Contains(err.Error(), "cannot remove the organization's last owner") {
			member.Found = true
			member.Active = true
			member.Conflict = "last_owner"
			return member, nil
		}
		return SCIMProvisionUserOutput{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM memberships WHERE org_id = $1::uuid AND user_id = $2::uuid`, claims.OrganizationID, member.ID); err != nil {
		return SCIMProvisionUserOutput{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_roles WHERE org_id = $1::uuid AND user_id = $2::uuid`, claims.OrganizationID, member.ID); err != nil {
		return SCIMProvisionUserOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE invitations SET status = 'revoked'
		WHERE org_id = $1::uuid AND status = 'pending' AND lower(email) = lower($2)`,
		claims.OrganizationID, member.Email,
	); err != nil {
		return SCIMProvisionUserOutput{}, err
	}
	member.Active = false
	member.Found = true
	return member, nil
}

func SCIMProvisionIntentID(tokenID string, idempotencyKey string) (string, error) {
	if !isUUID(tokenID) || !isUUID(idempotencyKey) {
		return "", ErrScopeMismatch
	}
	hash := sha256.Sum256([]byte(idempotencyKey))
	return "scim:" + tokenID + ":" + hex.EncodeToString(hash[:]), nil
}

// SCIMAutomaticIntentID gives standard clients without an idempotency header
// a marker that the executor resolves to a membership-state generation inside
// the organization transaction. Committed deactivation receipts advance that
// generation, so retries in one state replay while a later provision after a
// deactivation gets a new intent.
func SCIMAutomaticIntentID(tokenID string) (string, error) {
	if !isUUID(tokenID) {
		return "", ErrScopeMismatch
	}
	return scimAutomaticIntentPrefix + tokenID, nil
}

func isSCIMAutomaticIntent(intentID, tokenID string) bool {
	return intentID == scimAutomaticIntentPrefix+tokenID
}

func resolveSCIMAutomaticIntentID(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, raw json.RawMessage) (string, error) {
	input, err := ParseSCIMProvisionUserInput(raw)
	if err != nil {
		return "", err
	}
	tokenID := *claims.ActorID
	userID := input.UserID
	active := false
	if input.Operation == "provision" {
		var email, name string
		err := tx.QueryRow(ctx, `
			SELECT user_id::text, email, name
			FROM public.chaste_resolve_or_create_scim_user($1::uuid, $2::uuid, $3, $4)`,
			tokenID, claims.OrganizationID, input.Email, input.Name,
		).Scan(&userID, &email, &name)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrSessionInvalid
		}
		if err != nil {
			return "", err
		}
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid)`,
			claims.OrganizationID, userID).Scan(&active); err != nil {
			return "", err
		}
	} else if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id=$1::uuid AND user_id=$2::uuid)`,
		claims.OrganizationID, userID).Scan(&active); err != nil {
		return "", err
	}
	var deactivationCount int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*)
		FROM action_receipts
		WHERE org_id=$1::uuid AND capability_id=$2
		  AND data->>'id'=$3 AND data->>'found'='true' AND data->>'active'='false'`,
		claims.OrganizationID, scimProvisionUserCapabilityID, userID).Scan(&deactivationCount); err != nil {
		return "", err
	}
	generation := deactivationCount
	if input.Operation == "deactivate" && !active && generation > 0 {
		generation--
	}
	return fmt.Sprintf("scim:auto:%s:%s:%s:%d", tokenID, input.Operation, userID, generation), nil
}

func scimAutomaticReceiptCacheable(input any, data json.RawMessage) bool {
	parsed, ok := input.(SCIMProvisionUserInput)
	if !ok {
		return false
	}
	var output SCIMProvisionUserOutput
	if err := json.Unmarshal(data, &output); err != nil || !output.Found {
		return false
	}
	switch parsed.Operation {
	case "provision":
		return output.Active && output.Conflict == ""
	case "deactivate":
		return !output.Active && output.Conflict == ""
	default:
		return false
	}
}
