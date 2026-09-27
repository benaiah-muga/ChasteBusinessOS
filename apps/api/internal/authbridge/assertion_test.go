package authbridge

import (
	"strings"
	"testing"
	"time"
)

const testSecret = "0123456789abcdef0123456789abcdef"
const typescriptAssertion = "eyJhdWQiOiJnby5wb2xpY3kucmVhZCIsInN1YiI6InVzZXItMSIsIm9yZ19pZCI6Im9yZy0xIiwiY2FuX2VkaXQiOnRydWUsImlhdCI6MTAwMCwiZXhwIjoxMDMwfQ.iK5rgaQSDOrRqdmU7ztTuJdHeo1lZMGlhOPQT67UYuM"
const typescriptLedgerAssertion = "eyJhdWQiOiJnby5sZWRnZXIucmVhZCIsInN1YiI6InVzZXItMSIsIm9yZ19pZCI6Im9yZy0xIiwiY2FuX2VkaXQiOmZhbHNlLCJjYW5fcmVhZF9sZWRnZXIiOnRydWUsImlhdCI6MTAwMCwiZXhwIjoxMDMwfQ.L-Mh_GnnjTTh_Gg_Ea3o8U2zHJQ5799UgPi9as7GmHM"

func TestOrgSwitchAudienceIsDistinct(t *testing.T) {
	if OrgSwitchAudience != "go.org.switch" || OrgSwitchAudience == PolicyReadAudience || OrgSwitchAudience == LedgerReadAudience {
		t.Fatalf("org switch audience = %q, want distinct go.org.switch audience", OrgSwitchAudience)
	}
}

func TestVerifyAcceptsTypeScriptAssertion(t *testing.T) {
	claims, err := Verify(testSecret, typescriptAssertion, PolicyReadAudience, time.Unix(1000, 0))
	if err != nil {
		t.Fatal(err)
	}
	if claims.Subject != "user-1" || claims.OrganizationID != "org-1" || !claims.CanEdit {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestSignMatchesTypeScriptAssertion(t *testing.T) {
	got, err := Sign(testSecret, Claims{
		Audience:       PolicyReadAudience,
		Subject:        "user-1",
		OrganizationID: "org-1",
		CanEdit:        true,
		IssuedAt:       1000,
		ExpiresAt:      1030,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != typescriptAssertion {
		t.Fatalf("assertion = %q, want %q", got, typescriptAssertion)
	}
}

func TestVerifyAndSignMatchTypeScriptLedgerAssertion(t *testing.T) {
	claims, err := Verify(testSecret, typescriptLedgerAssertion, LedgerReadAudience, time.Unix(1000, 0))
	if err != nil {
		t.Fatal(err)
	}
	if claims.Subject != "user-1" || claims.OrganizationID != "org-1" || !claims.CanReadLedger {
		t.Fatalf("unexpected claims: %+v", claims)
	}
	got, err := Sign(testSecret, Claims{
		Audience:       LedgerReadAudience,
		Subject:        "user-1",
		OrganizationID: "org-1",
		CanReadLedger:  true,
		IssuedAt:       1000,
		ExpiresAt:      1030,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != typescriptLedgerAssertion {
		t.Fatalf("ledger assertion = %q, want %q", got, typescriptLedgerAssertion)
	}
}

func TestVerifyRejectsTamperingExpiryAndWrongAudience(t *testing.T) {
	parts := strings.Split(typescriptAssertion, ".")
	for name, test := range map[string]struct {
		token    string
		audience string
		now      time.Time
	}{
		"tampered payload": {token: parts[0] + "a." + parts[1], audience: PolicyReadAudience, now: time.Unix(1000, 0)},
		"expired":          {token: typescriptAssertion, audience: PolicyReadAudience, now: time.Unix(1030, 0)},
		"wrong audience":   {token: typescriptAssertion, audience: "go.policy.write", now: time.Unix(1000, 0)},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Verify(testSecret, test.token, test.audience, test.now); err == nil {
				t.Fatal("Verify accepted an invalid assertion")
			}
		})
	}
}

func TestCapabilityAssertionRoundTripsTypeScriptClaimShape(t *testing.T) {
	actorID := "22222222-2222-4222-8222-222222222222"
	claims := CapabilityClaims{
		Audience:       CapabilityExecuteAudience,
		Subject:        actorID,
		OrganizationID: "11111111-1111-4111-8111-111111111111",
		CapabilityID:   "crm.createCustomer",
		InputSHA256:    strings.Repeat("a", 64),
		ActorID:        &actorID,
		ActorType:      "agent",
		Permissions:    []string{"crm.read", "crm.write"},
		AuthSessionID:  "better-auth-session",
		AgentSessionID: "33333333-3333-4333-8333-333333333333",
		IntentID:       "intent-42",
		IssuedAt:       1000,
		ExpiresAt:      1030,
	}
	token, err := SignCapability(testSecret, claims)
	if err != nil {
		t.Fatal(err)
	}
	got, err := VerifyCapability(testSecret, token, time.Unix(1000, 0))
	if err != nil {
		t.Fatal(err)
	}
	if got.Audience != claims.Audience || got.Subject != claims.Subject || got.OrganizationID != claims.OrganizationID ||
		got.CapabilityID != claims.CapabilityID || got.InputSHA256 != claims.InputSHA256 || got.ActorType != claims.ActorType ||
		got.AuthSessionID != claims.AuthSessionID || got.AgentSessionID != claims.AgentSessionID || got.IntentID != claims.IntentID ||
		got.ActorID == nil || *got.ActorID != actorID || len(got.Permissions) != 2 || got.Permissions[0] != "crm.read" || got.Permissions[1] != "crm.write" {
		t.Fatalf("verified capability claims = %+v, want signed claims %+v", got, claims)
	}
}

func TestVerifyCapabilityRejectsWrongScopeMalformedClaimsAndLongLifetime(t *testing.T) {
	actorID := "22222222-2222-4222-8222-222222222222"
	base := CapabilityClaims{
		Audience:       CapabilityExecuteAudience,
		Subject:        actorID,
		OrganizationID: "11111111-1111-4111-8111-111111111111",
		CapabilityID:   "crm.createCustomer",
		InputSHA256:    strings.Repeat("a", 64),
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    []string{"crm.write"},
		AuthSessionID:  "better-auth-session",
		IssuedAt:       1000,
		ExpiresAt:      1030,
	}
	for name, mutate := range map[string]func(*CapabilityClaims){
		"wrong audience":     func(c *CapabilityClaims) { c.Audience = LedgerReadAudience },
		"empty digest":       func(c *CapabilityClaims) { c.InputSHA256 = "" },
		"empty session":      func(c *CapabilityClaims) { c.AuthSessionID = "" },
		"unsupported actor":  func(c *CapabilityClaims) { c.ActorType = "system" },
		"unsorted authority": func(c *CapabilityClaims) { c.Permissions = []string{"crm.write", "crm.read"} },
		"long lifetime":      func(c *CapabilityClaims) { c.ExpiresAt = 1031 },
	} {
		t.Run(name, func(t *testing.T) {
			claims := base
			claims.Permissions = append([]string(nil), base.Permissions...)
			mutate(&claims)
			token, err := SignCapability(testSecret, claims)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := VerifyCapability(testSecret, token, time.Unix(1000, 0)); err == nil {
				t.Fatal("VerifyCapability accepted an out-of-scope or malformed assertion")
			}
		})
	}
}

func TestApprovalDecisionAssertionRoundTripsAndDerivesCapabilityClaims(t *testing.T) {
	now := time.Unix(2000, 0)
	actorID := "22222222-2222-4222-8222-222222222222"
	comment := "Please confirm the invoice."
	claims := ApprovalDecisionClaims{
		Audience:       ApprovalDecisionAudience,
		Subject:        actorID,
		OrganizationID: "11111111-1111-4111-8111-111111111111",
		CapabilityID:   "accounting.recordPayment",
		InputSHA256:    strings.Repeat("b", 64),
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    []string{"accounting.post", "accounting.read"},
		AuthSessionID:  "better-auth-session",
		ApprovalID:     "33333333-3333-4333-8333-333333333333",
		Decision:       "approve",
		Comment:        &comment,
		IssuedAt:       now.Unix(),
		ExpiresAt:      now.Add(30 * time.Second).Unix(),
	}
	token, err := SignApprovalDecision(testSecret, claims)
	if err != nil {
		t.Fatal(err)
	}
	got, err := VerifyApprovalDecision(testSecret, token, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.Subject != claims.Subject || got.OrganizationID != claims.OrganizationID || got.AuthSessionID != claims.AuthSessionID ||
		got.ApprovalID != claims.ApprovalID || got.Decision != claims.Decision || got.Comment == nil || *got.Comment != comment {
		t.Fatalf("verified decision claims = %+v, want %+v", got, claims)
	}
	capabilityClaims := got.CapabilityClaims()
	if capabilityClaims.Audience != CapabilityExecuteAudience || capabilityClaims.CapabilityID != claims.CapabilityID ||
		capabilityClaims.InputSHA256 != claims.InputSHA256 || capabilityClaims.ActorType != "human" ||
		capabilityClaims.ActorID == nil || *capabilityClaims.ActorID != actorID || capabilityClaims.AuthSessionID != claims.AuthSessionID {
		t.Fatalf("derived capability claims = %+v", capabilityClaims)
	}
}

func TestVerifyApprovalDecisionRejectsWrongAudienceSignatureAndMalformedClaims(t *testing.T) {
	now := time.Unix(2000, 0)
	actorID := "22222222-2222-4222-8222-222222222222"
	base := ApprovalDecisionClaims{
		Audience:       ApprovalDecisionAudience,
		Subject:        actorID,
		OrganizationID: "11111111-1111-4111-8111-111111111111",
		CapabilityID:   "accounting.recordPayment",
		InputSHA256:    strings.Repeat("b", 64),
		ActorID:        &actorID,
		ActorType:      "human",
		Permissions:    []string{"accounting.post"},
		AuthSessionID:  "better-auth-session",
		ApprovalID:     "33333333-3333-4333-8333-333333333333",
		Decision:       "reject",
		IssuedAt:       now.Unix(),
		ExpiresAt:      now.Add(30 * time.Second).Unix(),
	}
	for name, mutate := range map[string]func(*ApprovalDecisionClaims){
		"wrong audience":   func(c *ApprovalDecisionClaims) { c.Audience = CapabilityExecuteAudience },
		"agent actor":      func(c *ApprovalDecisionClaims) { c.ActorType = "agent" },
		"actor mismatch":   func(c *ApprovalDecisionClaims) { c.Subject = "44444444-4444-4444-8444-444444444444" },
		"invalid decision": func(c *ApprovalDecisionClaims) { c.Decision = "skip" },
		"missing session":  func(c *ApprovalDecisionClaims) { c.AuthSessionID = " " },
		"long lifetime":    func(c *ApprovalDecisionClaims) { c.ExpiresAt = now.Add(31 * time.Second).Unix() },
		"long UTF-16 comment": func(c *ApprovalDecisionClaims) {
			comment := strings.Repeat("😀", 1001)
			c.Comment = &comment
		},
	} {
		t.Run(name, func(t *testing.T) {
			claims := base
			claims.Permissions = append([]string(nil), base.Permissions...)
			mutate(&claims)
			token, err := SignApprovalDecision(testSecret, claims)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := VerifyApprovalDecision(testSecret, token, now); err == nil {
				t.Fatal("VerifyApprovalDecision accepted malformed claims")
			}
		})
	}

	token, err := SignApprovalDecision(testSecret, base)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	badSignature := parts[0] + ".x" + parts[1][1:]
	if _, err := VerifyApprovalDecision(testSecret, badSignature, now); err == nil {
		t.Fatal("VerifyApprovalDecision accepted a bad signature")
	}
}
