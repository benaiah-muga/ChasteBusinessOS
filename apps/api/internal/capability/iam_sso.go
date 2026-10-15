package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	iamCreateSSOConnectionCapabilityID  = "iam.createSSOConnection"
	iamDisableSSOConnectionCapabilityID = "iam.disableSSOConnection"
	iamRestoreSSOConnectionCapabilityID = "iam.restoreSSOConnection"
)

const (
	IAMCreateSSOConnectionCapabilityID  = iamCreateSSOConnectionCapabilityID
	IAMDisableSSOConnectionCapabilityID = iamDisableSSOConnectionCapabilityID
)

var iamSSODomainLabelPattern = regexp.MustCompile(`(?i)^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

type IAMCreateSSOConnectionInput struct {
	Protocol       string  `json:"protocol"`
	Label          string  `json:"label"`
	IDPEntityID    string  `json:"idpEntityId"`
	SSOURL         string  `json:"ssoUrl"`
	IDPCertificate *string `json:"idpCertificate"`
	Domain         *string `json:"domain"`
}

type IAMSSOConnectionIDInput struct {
	ConnectionID string `json:"connectionId"`
}

type IAMSSOConnectionOutput struct {
	ConnectionID string `json:"connectionId"`
}

func init() {
	capabilitySpecs[iamCreateSSOConnectionCapabilityID] = capabilitySpec{
		module: "iam", permission: "iam.admin", risk: "identity",
		inverseCapabilityID: iamDisableSSOConnectionCapabilityID, inverseInputSource: "output", inverseFields: []string{"connectionId"},
	}
	capabilitySpecs[iamDisableSSOConnectionCapabilityID] = capabilitySpec{
		module: "iam", permission: "iam.admin", risk: "identity",
		inverseCapabilityID: iamRestoreSSOConnectionCapabilityID, inverseInputSource: "output", inverseFields: []string{"connectionId"},
	}
	capabilitySpecs[iamRestoreSSOConnectionCapabilityID] = capabilitySpec{
		module: "iam", permission: "iam.admin", risk: "identity",
		inverseCapabilityID: iamDisableSSOConnectionCapabilityID, inverseInputSource: "output", inverseFields: []string{"connectionId"},
	}
}

func parseIAMSSOCreateInput(raw json.RawMessage) (IAMCreateSSOConnectionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return IAMCreateSSOConnectionInput{}, err
	}
	for key := range fields {
		switch key {
		case "protocol", "label", "idpEntityId", "ssoUrl", "idpCertificate", "domain":
		default:
			return IAMCreateSSOConnectionInput{}, fmt.Errorf("unexpected field %q", key)
		}
	}
	input := IAMCreateSSOConnectionInput{}
	if input.Protocol, err = iamRequiredString(fields, "protocol"); err != nil {
		return input, err
	}
	if input.Label, err = iamRequiredString(fields, "label"); err != nil {
		return input, err
	}
	if input.IDPEntityID, err = iamRequiredString(fields, "idpEntityId"); err != nil {
		return input, err
	}
	if input.SSOURL, err = iamRequiredString(fields, "ssoUrl"); err != nil {
		return input, err
	}
	if input.IDPCertificate, err = iamSSOOptionalString(fields, "idpCertificate"); err != nil {
		return input, err
	}
	if input.Domain, err = iamSSOOptionalString(fields, "domain"); err != nil {
		return input, err
	}
	if err := validateIAMSSOCreateInput(&input); err != nil {
		return input, err
	}
	return input, nil
}

func parseIAMSSOConnectionIDInput(raw json.RawMessage) (IAMSSOConnectionIDInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return IAMSSOConnectionIDInput{}, err
	}
	if len(fields) != 1 {
		return IAMSSOConnectionIDInput{}, errors.New("connectionId is the only accepted field")
	}
	connectionID, err := iamRequiredString(fields, "connectionId")
	if err != nil || !isUUID(connectionID) {
		return IAMSSOConnectionIDInput{}, errors.New("connectionId must be a UUID")
	}
	return IAMSSOConnectionIDInput{ConnectionID: connectionID}, nil
}

func iamSSOOptionalString(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok || string(raw) == "null" {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("%s must be a string or null", key)
	}
	return &value, nil
}

func validateIAMSSOCreateInput(input *IAMCreateSSOConnectionInput) error {
	input.Protocol = strings.TrimSpace(input.Protocol)
	input.Label = strings.TrimSpace(input.Label)
	input.IDPEntityID = strings.TrimSpace(input.IDPEntityID)
	input.SSOURL = strings.TrimSpace(input.SSOURL)
	if input.Protocol != "saml" && input.Protocol != "oidc" {
		return errors.New("protocol must be saml or oidc")
	}
	if utf16Length(input.Label) < 1 || utf16Length(input.Label) > 200 || strings.ContainsAny(input.Label, "\r\n\x00") ||
		input.IDPEntityID == "" || len(input.IDPEntityID) > 2048 || strings.ContainsAny(input.IDPEntityID, "\r\n\x00") {
		return errors.New("label and idpEntityId are required and must be bounded text")
	}
	parsed, err := url.ParseRequestURI(input.SSOURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("ssoUrl must be an absolute http or https URL without credentials or fragments")
	}
	if input.IDPCertificate != nil {
		certificate := strings.TrimSpace(*input.IDPCertificate)
		if certificate == "" || len(certificate) > 64*1024 {
			return errors.New("idpCertificate must contain at most 65536 characters")
		}
		input.IDPCertificate = &certificate
	}
	if input.Domain != nil {
		domain := strings.TrimSpace(*input.Domain)
		if domain != "" && !validIAMSSODomain(domain) {
			return errors.New("domain must be a bare hostname")
		}
		if domain == "" {
			input.Domain = nil
		} else {
			domain = strings.ToLower(domain)
			input.Domain = &domain
		}
	}
	return nil
}

func validIAMSSODomain(domain string) bool {
	if len(domain) > 253 || strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return false
	}
	for _, label := range strings.Split(domain, ".") {
		if !iamSSODomainLabelPattern.MatchString(label) {
			return false
		}
	}
	return true
}

func iamCreateSSOConnection(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input IAMCreateSSOConnectionInput) (IAMSSOConnectionOutput, error) {
	if claims.ActorID == nil || !isUUID(*claims.ActorID) {
		return IAMSSOConnectionOutput{}, errors.New("SSO connection creation requires a human actor")
	}
	var output IAMSSOConnectionOutput
	err := tx.QueryRow(ctx, `
		INSERT INTO sso_connections (org_id, protocol, label, idp_entity_id, sso_url, idp_certificate, domain, created_by_user_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid)
		RETURNING id::text`, claims.OrganizationID, input.Protocol, input.Label, input.IDPEntityID, input.SSOURL, input.IDPCertificate, input.Domain, *claims.ActorID).Scan(&output.ConnectionID)
	return output, err
}

func iamDisableSSOConnection(ctx context.Context, tx pgx.Tx, orgID string, input IAMSSOConnectionIDInput) (IAMSSOConnectionOutput, error) {
	var output IAMSSOConnectionOutput
	err := tx.QueryRow(ctx, `
		UPDATE sso_connections SET status = 'disabled'
		WHERE org_id = $1::uuid AND id = $2::uuid AND status = 'active'
		RETURNING id::text`, orgID, input.ConnectionID).Scan(&output.ConnectionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return output, IAMDomainError("SSO connection not found or already disabled")
	}
	return output, err
}

func iamRestoreSSOConnection(ctx context.Context, tx pgx.Tx, orgID string, input IAMSSOConnectionIDInput) (IAMSSOConnectionOutput, error) {
	var output IAMSSOConnectionOutput
	err := tx.QueryRow(ctx, `
		UPDATE sso_connections SET status = 'active'
		WHERE org_id = $1::uuid AND id = $2::uuid AND status = 'disabled'
		RETURNING id::text`, orgID, input.ConnectionID).Scan(&output.ConnectionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return output, IAMDomainError("SSO connection not found or already active")
	}
	return output, err
}
