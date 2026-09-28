package authbridge

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const PolicyReadAudience = "go.policy.read"
const LedgerReadAudience = "go.ledger.read"
const OrgSwitchAudience = "go.org.switch"
const CapabilityExecuteAudience = "go.capability.execute"
const ApprovalDecisionAudience = "go.approval.decide"
const ApprovalInboxReadAudience = "go.approvals.inbox.read"

var ErrInvalidAssertion = errors.New("invalid session assertion")

type Claims struct {
	Audience       string `json:"aud"`
	Subject        string `json:"sub"`
	OrganizationID string `json:"org_id"`
	CanEdit        bool   `json:"can_edit"`
	CanReadLedger  bool   `json:"can_read_ledger,omitempty"`
	IssuedAt       int64  `json:"iat"`
	ExpiresAt      int64  `json:"exp"`
}

// CapabilityClaims are signed by the BFF after resolving the current user and
// action context. The Go API still rechecks session, membership, roles, module
// state, and policy against PostgreSQL before it performs a write.
type CapabilityClaims struct {
	Audience       string   `json:"aud"`
	Subject        string   `json:"sub"`
	OrganizationID string   `json:"org_id"`
	CapabilityID   string   `json:"capability_id"`
	InputSHA256    string   `json:"input_sha256"`
	ActorID        *string  `json:"actor_id"`
	ActorType      string   `json:"actor_type"`
	Permissions    []string `json:"permissions"`
	AuthSessionID  string   `json:"auth_session_id"`
	AgentSessionID string   `json:"agent_session_id,omitempty"`
	IntentID       string   `json:"intent_id,omitempty"`
	IssuedAt       int64    `json:"iat"`
	ExpiresAt      int64    `json:"exp"`
}

// ApprovalDecisionClaims authorize one human decision for one existing
// capability payload. They deliberately omit payload data: the Go decider
// loads the stored approval payload and checks InputSHA256 before execution.
type ApprovalDecisionClaims struct {
	Audience       string   `json:"aud"`
	Subject        string   `json:"sub"`
	OrganizationID string   `json:"org_id"`
	CapabilityID   string   `json:"capability_id"`
	InputSHA256    string   `json:"input_sha256"`
	ActorID        *string  `json:"actor_id"`
	ActorType      string   `json:"actor_type"`
	Permissions    []string `json:"permissions"`
	AuthSessionID  string   `json:"auth_session_id"`
	ApprovalID     string   `json:"approval_id"`
	Decision       string   `json:"decision"`
	Comment        *string  `json:"comment"`
	IssuedAt       int64    `json:"iat"`
	ExpiresAt      int64    `json:"exp"`
}

type ApprovalInboxClaims struct {
	Audience       string   `json:"aud"`
	Subject        string   `json:"sub"`
	OrganizationID string   `json:"org_id"`
	InputSHA256    string   `json:"input_sha256"`
	ActorID        *string  `json:"actor_id"`
	ActorType      string   `json:"actor_type"`
	Permissions    []string `json:"permissions"`
	AuthSessionID  string   `json:"auth_session_id"`
	IssuedAt       int64    `json:"iat"`
	ExpiresAt      int64    `json:"exp"`
}

func VerifyApprovalInbox(secret, token string, now time.Time) (ApprovalInboxClaims, error) {
	var claims ApprovalInboxClaims
	if len([]byte(secret)) < 32 || len(token) == 0 || len(token) > 4096 {
		return claims, ErrInvalidAssertion
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return claims, ErrInvalidAssertion
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, ErrInvalidAssertion
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return claims, ErrInvalidAssertion
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return ApprovalInboxClaims{}, ErrInvalidAssertion
	}
	nowUnix := now.Unix()
	if claims.Audience != ApprovalInboxReadAudience || !isUUID(claims.Subject) || !isUUID(claims.OrganizationID) ||
		claims.ActorID == nil || *claims.ActorID != claims.Subject || claims.ActorType != "human" ||
		strings.TrimSpace(claims.AuthSessionID) == "" || !isSHA256Hex(claims.InputSHA256) ||
		claims.IssuedAt > nowUnix+5 || claims.IssuedAt < nowUnix-60 || claims.ExpiresAt <= nowUnix ||
		claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt-claims.IssuedAt > 30 || claims.ExpiresAt > nowUnix+30 {
		return ApprovalInboxClaims{}, ErrInvalidAssertion
	}
	for index, permission := range claims.Permissions {
		if strings.TrimSpace(permission) == "" || (index > 0 && claims.Permissions[index-1] >= permission) {
			return ApprovalInboxClaims{}, ErrInvalidAssertion
		}
	}
	return claims, nil
}

func isUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if char != '-' {
				return false
			}
			continue
		}
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}

// CapabilityClaims returns the signed authority subset consumed by the
// existing decider. The approval decision audience is replaced with the
// capability audience only after the distinct decision assertion verifies.
func (claims ApprovalDecisionClaims) CapabilityClaims() CapabilityClaims {
	return CapabilityClaims{
		Audience:       CapabilityExecuteAudience,
		Subject:        claims.Subject,
		OrganizationID: claims.OrganizationID,
		CapabilityID:   claims.CapabilityID,
		InputSHA256:    claims.InputSHA256,
		ActorID:        claims.ActorID,
		ActorType:      claims.ActorType,
		Permissions:    claims.Permissions,
		AuthSessionID:  claims.AuthSessionID,
		IssuedAt:       claims.IssuedAt,
		ExpiresAt:      claims.ExpiresAt,
	}
}

func Sign(secret string, claims Claims) (string, error) {
	return sign(secret, claims)
}

func SignCapability(secret string, claims CapabilityClaims) (string, error) {
	return sign(secret, claims)
}

func SignApprovalDecision(secret string, claims ApprovalDecisionClaims) (string, error) {
	return sign(secret, claims)
}

func sign(secret string, claims any) (string, error) {
	if len([]byte(secret)) < 32 {
		return "", ErrInvalidAssertion
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", ErrInvalidAssertion
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(encodedPayload))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encodedPayload + "." + signature, nil
}

func Verify(secret, token, audience string, now time.Time) (Claims, error) {
	var claims Claims
	if len([]byte(secret)) < 32 || len(token) == 0 || len(token) > 4096 {
		return claims, ErrInvalidAssertion
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return claims, ErrInvalidAssertion
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, ErrInvalidAssertion
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return claims, ErrInvalidAssertion
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return Claims{}, ErrInvalidAssertion
	}
	nowUnix := now.Unix()
	if claims.Audience != audience || strings.TrimSpace(claims.Subject) == "" ||
		strings.TrimSpace(claims.OrganizationID) == "" || claims.IssuedAt > nowUnix+5 ||
		claims.IssuedAt < nowUnix-60 || claims.ExpiresAt <= nowUnix ||
		claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt-claims.IssuedAt > 60 ||
		claims.ExpiresAt > nowUnix+60 {
		return Claims{}, ErrInvalidAssertion
	}
	return claims, nil
}

func VerifyCapability(secret, token string, now time.Time) (CapabilityClaims, error) {
	var claims CapabilityClaims
	if len([]byte(secret)) < 32 || len(token) == 0 || len(token) > 4096 {
		return claims, ErrInvalidAssertion
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return claims, ErrInvalidAssertion
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, ErrInvalidAssertion
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return claims, ErrInvalidAssertion
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return CapabilityClaims{}, ErrInvalidAssertion
	}
	nowUnix := now.Unix()
	if claims.Audience != CapabilityExecuteAudience || strings.TrimSpace(claims.Subject) == "" ||
		strings.TrimSpace(claims.OrganizationID) == "" || strings.TrimSpace(claims.CapabilityID) == "" ||
		!isSHA256Hex(claims.InputSHA256) || strings.TrimSpace(claims.ActorType) == "" ||
		strings.TrimSpace(claims.AuthSessionID) == "" || claims.IssuedAt > nowUnix+5 ||
		claims.IssuedAt < nowUnix-60 || claims.ExpiresAt <= nowUnix ||
		claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt-claims.IssuedAt > 30 ||
		claims.ExpiresAt > nowUnix+30 {
		return CapabilityClaims{}, ErrInvalidAssertion
	}
	if claims.ActorType != "human" && claims.ActorType != "agent" {
		return CapabilityClaims{}, ErrInvalidAssertion
	}
	if claims.ActorID == nil || strings.TrimSpace(*claims.ActorID) == "" {
		return CapabilityClaims{}, ErrInvalidAssertion
	}
	for index, permission := range claims.Permissions {
		if strings.TrimSpace(permission) == "" || (index > 0 && claims.Permissions[index-1] >= permission) {
			return CapabilityClaims{}, ErrInvalidAssertion
		}
	}
	if claims.ActorType == "agent" && strings.TrimSpace(claims.AgentSessionID) == "" {
		return CapabilityClaims{}, ErrInvalidAssertion
	}
	return claims, nil
}

func VerifyApprovalDecision(secret, token string, now time.Time) (ApprovalDecisionClaims, error) {
	var claims ApprovalDecisionClaims
	if len([]byte(secret)) < 32 || len(token) == 0 || len(token) > 4096 {
		return claims, ErrInvalidAssertion
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return claims, ErrInvalidAssertion
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, ErrInvalidAssertion
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return claims, ErrInvalidAssertion
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return ApprovalDecisionClaims{}, ErrInvalidAssertion
	}
	nowUnix := now.Unix()
	if claims.Audience != ApprovalDecisionAudience || strings.TrimSpace(claims.Subject) == "" ||
		strings.TrimSpace(claims.OrganizationID) == "" || strings.TrimSpace(claims.CapabilityID) == "" ||
		!isSHA256Hex(claims.InputSHA256) || claims.ActorID == nil || strings.TrimSpace(*claims.ActorID) == "" ||
		*claims.ActorID != claims.Subject || claims.ActorType != "human" ||
		strings.TrimSpace(claims.AuthSessionID) == "" || strings.TrimSpace(claims.ApprovalID) == "" ||
		(claims.Decision != "approve" && claims.Decision != "reject") ||
		claims.Comment != nil && utf16Length(*claims.Comment) > 2000 ||
		claims.IssuedAt > nowUnix+5 || claims.IssuedAt < nowUnix-60 || claims.ExpiresAt <= nowUnix ||
		claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt-claims.IssuedAt > 30 || claims.ExpiresAt > nowUnix+30 {
		return ApprovalDecisionClaims{}, ErrInvalidAssertion
	}
	for index, permission := range claims.Permissions {
		if strings.TrimSpace(permission) == "" || (index > 0 && claims.Permissions[index-1] >= permission) {
			return ApprovalDecisionClaims{}, ErrInvalidAssertion
		}
	}
	return claims, nil
}

func utf16Length(value string) int {
	length := 0
	for _, char := range value {
		if char > 0xffff {
			length += 2
		} else {
			length++
		}
	}
	return length
}

func isSHA256Hex(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, char := range value {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}
