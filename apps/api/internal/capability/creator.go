package capability

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
	whatwgurl "github.com/nlnwa/whatwg-url/url"
)

const (
	creatorSubmitProposalCapabilityID      = "creator.submitProposal"
	creatorListProposalsCapabilityID       = "creator.listProposals"
	creatorScaffoldCapabilityID            = "creator.scaffoldCapability"
	creatorVerifyPluginCapabilityID        = "creator.verifyPlugin"
	creatorPublishListingCapabilityID      = "creator.publishListing"
	creatorRetractListingCapabilityID      = "creator.retractListing"
	creatorInstallListingCapabilityID      = "creator.installListing"
	creatorUninstallListingCapabilityID    = "creator.uninstallListing"
	creatorListMarketplaceCapabilityID     = "creator.listMarketplace"
	creatorStageCandidateCapabilityID      = "creator.stageCandidate"
	creatorPromoteCandidateCapabilityID    = "creator.promoteCandidate"
	creatorRollbackCandidateCapabilityID   = "creator.rollbackCandidate"
	creatorRecordCanaryOutcomeCapabilityID = "creator.recordCanaryOutcome"
)

var (
	creatorSlugPattern        = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	creatorActionPattern      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*$`)
	creatorModulePattern      = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	creatorVersionPattern     = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	creatorCapIDPattern       = regexp.MustCompile(`^[a-z][a-z0-9]*\.[A-Za-z][A-Za-z0-9]*$`)
	creatorFieldNamePattern   = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9]*$`)
	creatorDigestPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	creatorArtifactRefPattern = regexp.MustCompile(`^(artifact|git)://[^\s]+$`)
	creatorEvidenceRefPattern = regexp.MustCompile(`^(artifact|evidence|git)://[^\s]+$`)
)

// ── Plugin manifest verification (mirror of @chaste/plugin-kit) ──

type CreatorPluginManifest struct {
	FormatVersion float64           `json:"formatVersion"`
	Slug          string            `json:"slug"`
	Name          string            `json:"name"`
	Version       string            `json:"version"`
	Summary       string            `json:"summary"`
	Capabilities  []string          `json:"capabilities"`
	Risks         map[string]string `json:"risks"`
	Homepage      *string           `json:"homepage,omitempty"`
	License       string            `json:"license"`
}

func creatorCanonicalJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "null"
	}
	return creatorCanonicalJSONFromRaw(encoded)
}

func creatorCanonicalJSONFromRaw(encoded []byte) string {
	trimmed := strings.TrimSpace(string(encoded))
	if len(trimmed) > 0 && trimmed[0] == '"' {
		canonical, err := creatorCanonicalJSONStringFromRaw(json.RawMessage(trimmed))
		if err == nil {
			return canonical
		}
	}
	var value any
	if err := json.Unmarshal(encoded, &value); err != nil {
		return "null"
	}
	return creatorCanonicalValue(value)
}

func creatorCanonicalValue(value any) string {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, creatorCanonicalJSONString(key)+":"+creatorCanonicalValue(typed[key]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, creatorCanonicalValue(item))
		}
		return "[" + strings.Join(parts, ",") + "]"
	case string:
		return creatorCanonicalJSONString(typed)
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return "null"
		}
		return string(encoded)
	}
}

func creatorCanonicalJSONString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `""`
	}
	var canonical strings.Builder
	for index := 0; index < len(encoded); {
		if encoded[index] != '\\' || index+1 >= len(encoded) {
			canonical.WriteByte(encoded[index])
			index++
			continue
		}
		if encoded[index+1] != 'u' || index+6 >= len(encoded) {
			canonical.Write(encoded[index : index+2])
			index += 2
			continue
		}
		code := string(encoded[index+2 : index+6])
		switch code {
		case "003c":
			canonical.WriteByte('<')
		case "003e":
			canonical.WriteByte('>')
		case "0026":
			canonical.WriteByte('&')
		case "2028":
			canonical.WriteRune('\u2028')
		case "2029":
			canonical.WriteRune('\u2029')
		default:
			canonical.Write(encoded[index : index+6])
		}
		index += 6
	}
	return canonical.String()
}

func creatorCanonicalJSONStringFromRaw(raw json.RawMessage) (string, error) {
	// encoding/json replaces lone UTF-16 surrogates, but PluginKit signs their escaped form.
	if !json.Valid(raw) || len(strings.TrimSpace(string(raw))) < 2 || strings.TrimSpace(string(raw))[0] != '"' {
		return "", errors.New("expected a JSON string")
	}
	var original string
	if err := json.Unmarshal(raw, &original); err != nil {
		return "", err
	}
	var rewritten strings.Builder
	usedSentinels := make(map[rune]uint16)
	nextSentinel := rune(0xF0000)
	insideString := false
	for index := 0; index < len(raw); {
		if !insideString {
			if raw[index] == '"' {
				insideString = true
			}
			rewritten.WriteByte(raw[index])
			index++
			continue
		}
		if raw[index] == '"' {
			insideString = false
			rewritten.WriteByte(raw[index])
			index++
			continue
		}
		if raw[index] != '\\' || index+1 >= len(raw) {
			rewritten.WriteByte(raw[index])
			index++
			continue
		}
		if raw[index+1] != 'u' || index+6 > len(raw) {
			rewritten.Write(raw[index : index+2])
			index += 2
			continue
		}
		code, err := strconv.ParseUint(string(raw[index+2:index+6]), 16, 16)
		if err != nil {
			return "", errors.New("invalid JSON unicode escape")
		}
		surrogate := uint16(code)
		paired := surrogate >= 0xD800 && surrogate <= 0xDBFF && index+12 <= len(raw) &&
			raw[index+6] == '\\' && raw[index+7] == 'u'
		if paired {
			low, lowErr := strconv.ParseUint(string(raw[index+8:index+12]), 16, 16)
			paired = lowErr == nil && low >= 0xDC00 && low <= 0xDFFF
		}
		if surrogate < 0xD800 || surrogate > 0xDFFF || paired {
			width := 6
			if paired {
				width = 12
			}
			rewritten.Write(raw[index : index+width])
			index += width
			continue
		}
		for nextSentinel <= 0xFFFFD {
			sentinelText := string(nextSentinel)
			if !strings.Contains(original, sentinelText) {
				break
			}
			nextSentinel++
		}
		if nextSentinel > 0xFFFFD {
			return "", errors.New("cannot preserve escaped surrogate in JSON string")
		}
		usedSentinels[nextSentinel] = surrogate
		rewritten.WriteString(string(nextSentinel))
		nextSentinel++
		index += 6
	}
	var decoded string
	if err := json.Unmarshal([]byte(rewritten.String()), &decoded); err != nil {
		return "", err
	}
	canonical := creatorCanonicalJSONString(decoded)
	for sentinel, surrogate := range usedSentinels {
		canonical = strings.ReplaceAll(canonical, string(sentinel), fmt.Sprintf(`\u%04x`, surrogate))
	}
	return canonical, nil
}

func creatorManifestDigest(manifest CreatorPluginManifest) (string, error) {
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(creatorCanonicalJSONFromRaw(encoded)))
	return fmt.Sprintf("%x", digest), nil
}

func creatorManifestDigestFromRaw(raw json.RawMessage, manifest CreatorPluginManifest) (string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return "", err
	}
	stringField := func(name, fallback string) (string, error) {
		value, present := fields[name]
		if !present {
			return creatorCanonicalJSONString(fallback), nil
		}
		return creatorCanonicalJSONStringFromRaw(value)
	}
	name, err := stringField("name", "")
	if err != nil {
		return "", err
	}
	summary, err := stringField("summary", "")
	if err != nil {
		return "", err
	}
	license, err := stringField("license", "Apache-2.0")
	if err != nil {
		return "", err
	}
	version, err := stringField("version", "")
	if err != nil {
		return "", err
	}
	slug, err := stringField("slug", "")
	if err != nil {
		return "", err
	}
	parts := []string{
		`"capabilities":` + creatorCanonicalJSON(manifest.Capabilities),
		`"formatVersion":1`,
	}
	if rawHomepage, present := fields["homepage"]; present {
		homepage, err := creatorCanonicalJSONStringFromRaw(rawHomepage)
		if err != nil {
			return "", err
		}
		parts = append(parts, `"homepage":`+homepage)
	}
	parts = append(parts,
		`"license":`+license,
		`"name":`+name,
		`"risks":`+creatorCanonicalJSON(manifest.Risks),
		`"slug":`+slug,
		`"summary":`+summary,
		`"version":`+version,
	)
	digest := sha256.Sum256([]byte("{" + strings.Join(parts, ",") + "}"))
	return fmt.Sprintf("%x", digest), nil
}

func creatorValidateManifest(raw json.RawMessage) (CreatorPluginManifest, error) {
	var manifest CreatorPluginManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return CreatorPluginManifest{}, errors.New("manifest must be an object")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return CreatorPluginManifest{}, errors.New("manifest must be an object")
	}
	if rawRisks, present := fields["risks"]; !present || strings.TrimSpace(string(rawRisks)) == "null" || manifest.Risks == nil {
		return CreatorPluginManifest{}, errors.New("risks must be an object")
	}
	if rawLicense, present := fields["license"]; present && strings.TrimSpace(string(rawLicense)) == "null" {
		return CreatorPluginManifest{}, errors.New("license must be a string")
	}
	if manifest.FormatVersion != 1 {
		return CreatorPluginManifest{}, errors.New("formatVersion must be 1")
	}
	if len(manifest.Slug) < 3 || len(manifest.Slug) > 64 || !creatorSlugPattern.MatchString(manifest.Slug) {
		return CreatorPluginManifest{}, errors.New("slug must be lowercase kebab")
	}
	if manifest.Name == "" || utf16Length(manifest.Name) > 120 {
		return CreatorPluginManifest{}, errors.New("name must be between 1 and 120 characters")
	}
	if !creatorVersionPattern.MatchString(manifest.Version) {
		return CreatorPluginManifest{}, errors.New("version must be semver x.y.z")
	}
	if utf16Length(manifest.Summary) < 10 || utf16Length(manifest.Summary) > 500 {
		return CreatorPluginManifest{}, errors.New("summary must be between 10 and 500 characters")
	}
	if rawHomepage, present := fields["homepage"]; present {
		var homepage string
		if err := json.Unmarshal(rawHomepage, &homepage); err != nil {
			return CreatorPluginManifest{}, errors.New("homepage must be a valid URL")
		}
		parsed, err := whatwgurl.Parse(homepage)
		if err != nil || parsed.Scheme() == "" {
			return CreatorPluginManifest{}, errors.New("homepage must be a valid URL")
		}
	}
	if len(manifest.Capabilities) < 1 || len(manifest.Capabilities) > 100 {
		return CreatorPluginManifest{}, errors.New("capabilities must have between 1 and 100 items")
	}
	for _, capID := range manifest.Capabilities {
		if !creatorCapIDPattern.MatchString(capID) {
			return CreatorPluginManifest{}, errors.New("capability ids must be module-qualified")
		}
	}
	validRisks := map[string]bool{"read": true, "write": true, "money": true, "identity": true, "destructive": true, "secret": true}
	for capID, risk := range manifest.Risks {
		if !validRisks[risk] {
			return CreatorPluginManifest{}, errors.New("risk classes must be read, write, money, identity, destructive or secret")
		}
		_ = capID
	}
	if _, present := fields["license"]; !present {
		manifest.License = "Apache-2.0"
	}
	return manifest, nil
}

func creatorVerifyPlugin(manifestRaw json.RawMessage, signatureBase64, publisherPublicKeyBase64 string) (bool, string, CreatorPluginManifest) {
	manifest, err := creatorValidateManifest(manifestRaw)
	if err != nil {
		return false, fmt.Sprintf("manifest fails schema: %s", err.Error()), manifest
	}
	for _, capID := range manifest.Capabilities {
		if _, declared := manifest.Risks[capID]; !declared {
			return false, fmt.Sprintf("capability %s has no declared risk class", capID), manifest
		}
	}
	for riskCapID := range manifest.Risks {
		found := false
		for _, capID := range manifest.Capabilities {
			if capID == riskCapID {
				found = true
				break
			}
		}
		if !found {
			return false, "risks declare capability ids not present in capabilities[]", manifest
		}
	}
	publicKeyBytes, err := base64.StdEncoding.DecodeString(publisherPublicKeyBase64)
	if err != nil {
		return false, "malformed public key or signature encoding", manifest
	}
	publicKey, err := x509.ParsePKIXPublicKey(publicKeyBytes)
	if err != nil {
		return false, "malformed public key or signature encoding", manifest
	}
	ed25519Key, ok := publicKey.(ed25519.PublicKey)
	if !ok {
		return false, "malformed public key or signature encoding", manifest
	}
	digest, err := creatorManifestDigestFromRaw(manifestRaw, manifest)
	if err != nil {
		return false, "malformed public key or signature encoding", manifest
	}
	signature, err := base64.StdEncoding.DecodeString(signatureBase64)
	if err != nil {
		return false, "malformed public key or signature encoding", manifest
	}
	digestBytes, err := hex.DecodeString(digest)
	if err != nil {
		return false, "malformed public key or signature encoding", manifest
	}
	if ed25519.Verify(ed25519Key, digestBytes, signature) {
		return true, "", manifest
	}
	return false, "signature does not match manifest digest", manifest
}

// ── Scaffolding renderers (mirror of creator/src/scaffold.ts) ──

type CreatorScaffoldField struct {
	Name        string  `json:"name"`
	Type        string  `json:"type"`
	Description *string `json:"description,omitempty"`
}

type CreatorScaffoldSpec struct {
	Module      string                 `json:"module"`
	Action      string                 `json:"action"`
	Title       string                 `json:"title"`
	Intent      string                 `json:"intent"`
	Risk        string                 `json:"risk"`
	Permission  string                 `json:"permission"`
	InputFields []CreatorScaffoldField `json:"inputFields"`
}

func creatorZodTypeFor(fieldType string) string {
	switch fieldType {
	case "number":
		return "z.number()"
	case "boolean":
		return "z.boolean()"
	default:
		return "z.string()"
	}
}

func creatorCap(module string) string {
	parts := strings.FieldsFunc(module, func(r rune) bool { return r == '-' || r == '_' })
	var out strings.Builder
	for _, part := range parts {
		if part == "" {
			continue
		}
		out.WriteString(strings.ToUpper(part[:1]) + part[1:])
	}
	return out.String()
}

func creatorRenderCapabilitySource(spec CreatorScaffoldSpec) (string, error) {
	var fields strings.Builder
	for _, field := range spec.InputFields {
		fields.WriteString("      " + field.Name + ": " + creatorZodTypeFor(field.Type))
		if field.Description != nil {
			encoded, _ := json.Marshal(*field.Description)
			fields.WriteString(".describe(" + string(encoded) + ")")
		}
		fields.WriteString(",")
		fields.WriteString("\n")
	}
	capID := spec.Module + "." + spec.Action
	titleEncoded, _ := json.Marshal(spec.Title)
	intentEncoded, _ := json.Marshal(spec.Intent)
	moduleEncoded, _ := json.Marshal(spec.Module)
	riskEncoded, _ := json.Marshal(spec.Risk)
	permissionEncoded, _ := json.Marshal(spec.Permission)
	source := `import { z } from "zod";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

// Generated by Creator Mode scaffold; reviewed as a governed proposal.
const ` + spec.Action + ` = (deps: ModuleDeps) =>
  defineCapability({
    id: "` + capID + `",
    title: ` + string(titleEncoded) + `,
    intent: ` + string(intentEncoded) + `,
    module: ` + string(moduleEncoded) + `,
    risk: ` + string(riskEncoded) + `,
    permission: ` + string(permissionEncoded) + `,
    input: z.object({
` + fields.String() + `    }),
    output: z.object({ ok: z.boolean() }),
    execute: async (ctx, input) => {
      // TODO(proposal): implement against deps.db within ctx.actor.orgId scope.
      void deps;
      void input;
      return { ok: true };
    },
  });

export function register` + creatorCap(spec.Module) + `Capabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(` + spec.Action + `(deps));
}
`
	return source, nil
}

func creatorRenderTestSkeleton(spec CreatorScaffoldSpec) string {
	capID := spec.Module + "." + spec.Action
	return `import { describe, expect, it } from "vitest";

describe("` + capID + `", () => {
  it("conforms to the capability contract", async () => {
    const { assertWellFormedCapability } = await import("@chaste/kernel");
    // Import the registered capability here once wired into its module.
    expect(true).toBe(true); // placeholder replaced by proposal tests
  });
});
`
}

func creatorRenderRiskDoc(spec CreatorScaffoldSpec) string {
	var inverseNote string
	switch {
	case spec.Risk == "read":
		inverseNote = "Read-only: no state changes, no inverse needed."
	case spec.Risk == "destructive" || spec.Risk == "identity":
		inverseNote = fmt.Sprintf("Always human-approved (%s class). Inverse must be declared before merge.", spec.Risk)
	default:
		inverseNote = fmt.Sprintf("%s-class: declare an inverse or justify the conformance warning in review.", spec.Risk)
	}
	moneyNote := "no direct money movement."
	if spec.Risk == "money" {
		moneyNote = "amounts in integer minor units; policy thresholds apply."
	}
	return `# Risk assessment: ` + spec.Module + `.` + spec.Action + `

- Risk class: ` + spec.Risk + `
- Required permission: ` + spec.Permission + `
- Blast radius: scoped to org rows via ctx.actor.orgId.
- Reversibility: ` + inverseNote + `
- Money handling: ` + moneyNote + `
- Reviewer checklist:
  - [ ] Input schema rejects hostile values
  - [ ] Org scoping on every query
  - [ ] Ledger writes balanced (if any)
  - [ ] Tests cover failure paths
`
}

func creatorRenderProposalDiff(spec CreatorScaffoldSpec, filePath string) (string, error) {
	source, err := creatorRenderCapabilitySource(spec)
	if err != nil {
		return "", err
	}
	lines := strings.Split(source, "\n")
	var body strings.Builder
	for _, line := range lines {
		body.WriteString("+" + line + "\n")
	}
	return `--- /dev/null
+++ b/` + filePath + `
@@ -0,0 +1,` + fmt.Sprintf("%d", len(lines)) + ` @@
` + body.String(), nil
}

// ── Inputs and outputs ──

type CreatorSubmitProposalInput struct {
	Title          string  `json:"title"`
	Summary        string  `json:"summary"`
	DiffText       string  `json:"diffText"`
	TestEvidence   *string `json:"testEvidence,omitempty"`
	RiskAssessment string  `json:"riskAssessment"`
	GapTicketID    *string `json:"gapTicketId,omitempty"`
}

type CreatorSubmitProposalOutput struct {
	ProposalID string `json:"proposalId"`
}

type CreatorListProposalsInput struct {
	Status *string `json:"status,omitempty"`
}

type CreatorProposalListItem struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}

type CreatorListProposalsOutput struct {
	Proposals []CreatorProposalListItem `json:"proposals"`
}

type CreatorScaffoldInput struct {
	Module           string                 `json:"module"`
	Action           string                 `json:"action"`
	Title            string                 `json:"title"`
	Intent           string                 `json:"intent"`
	Risk             string                 `json:"risk"`
	Permission       string                 `json:"permission"`
	GapTicketID      *string                `json:"gapTicketId,omitempty"`
	InputFields      []CreatorScaffoldField `json:"inputFields"`
	SubmitAsProposal bool                   `json:"submitAsProposal"`
}

type CreatorScaffoldOutput struct {
	Files      []CreatorGeneratedFile `json:"files"`
	ProposalID *string                `json:"proposalId,omitempty"`
}

type CreatorGeneratedFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type CreatorVerifyPluginInput struct {
	Manifest                 json.RawMessage `json:"manifest"`
	SignatureBase64          string          `json:"signatureBase64"`
	PublisherPublicKeyBase64 string          `json:"publisherPublicKeyBase64"`
}

type CreatorVerifyPluginOutput struct {
	Valid  bool    `json:"valid"`
	Reason *string `json:"reason,omitempty"`
}

type CreatorPublishListingInput struct {
	Manifest                 json.RawMessage `json:"manifest"`
	SignatureBase64          string          `json:"signatureBase64"`
	PublisherPublicKeyBase64 string          `json:"publisherPublicKeyBase64"`
}

type CreatorPublishListingOutput struct {
	ListingID string `json:"listingId"`
	Slug      string `json:"slug"`
	Status    string `json:"status"`
}

type CreatorRetractListingInput struct {
	Slug string `json:"slug"`
}

type CreatorRetractListingOutput struct {
	Retracted bool `json:"retracted"`
}

type CreatorInstallListingInput struct {
	ListingID string `json:"listingId"`
}

type CreatorInstallListingOutput struct {
	Installed bool   `json:"installed"`
	Slug      string `json:"slug"`
	Version   string `json:"version"`
}

type CreatorUninstallListingInput struct {
	ListingID string `json:"listingId"`
}

type CreatorUninstallListingOutput struct {
	Uninstalled bool `json:"uninstalled"`
}

type CreatorListMarketplaceInput struct{}

type CreatorMarketplaceListing struct {
	ID                string            `json:"id"`
	Slug              string            `json:"slug"`
	Name              string            `json:"name"`
	Version           string            `json:"version"`
	Summary           string            `json:"summary"`
	Status            string            `json:"status"`
	CapabilityIDs     []json.RawMessage `json:"capabilityIds"`
	InstalledByOrgIDs json.RawMessage   `json:"installedByOrgIds"`
	InstalledHere     bool              `json:"installedHere"`
	UpdatedAt         time.Time         `json:"updatedAt"`
}

type CreatorListMarketplaceOutput struct {
	Listings []CreatorMarketplaceListing `json:"listings"`
}

type CreatorStageCandidateInput struct {
	ProposalID      string `json:"proposalId"`
	GapTicketID     string `json:"gapTicketId"`
	CandidateDigest string `json:"candidateDigest"`
	ArtifactRef     string `json:"artifactRef"`
}

type CreatorReleaseOutput struct {
	ReleaseID       string `json:"releaseId"`
	Status          string `json:"status"`
	GapTicketID     string `json:"gapTicketId"`
	CandidateDigest string `json:"candidateDigest"`
	ArtifactRef     string `json:"artifactRef"`
}

type CreatorPromoteCandidateInput struct {
	ReleaseID       string `json:"releaseId"`
	CandidateDigest string `json:"candidateDigest"`
}

type CreatorRollbackCandidateInput struct {
	ReleaseID       string `json:"releaseId"`
	CandidateDigest string `json:"candidateDigest"`
}

type CreatorRecordCanaryOutcomeInput struct {
	ReleaseID       string         `json:"releaseId"`
	GapTicketID     string         `json:"gapTicketId"`
	CandidateDigest string         `json:"candidateDigest"`
	Verdict         string         `json:"verdict"`
	EvidenceRef     string         `json:"evidenceRef"`
	Metrics         map[string]any `json:"metrics"`
}

type CreatorRecordCanaryOutcomeOutput struct {
	OutcomeID       string `json:"outcomeId"`
	ReleaseID       string `json:"releaseId"`
	GapTicketID     string `json:"gapTicketId"`
	CandidateDigest string `json:"candidateDigest"`
	Phase           string `json:"phase"`
	Verdict         string `json:"verdict"`
}

// ── Parsers ──

func creatorParseScaffoldSpec(fields map[string]json.RawMessage) (CreatorScaffoldSpec, *string, error) {
	spec := CreatorScaffoldSpec{InputFields: []CreatorScaffoldField{}}
	var gapTicketID *string
	var err error
	if spec.Module, err = requiredCRMDealString(fields, "module", 0, 0); err != nil {
		return spec, nil, err
	}
	if !creatorModulePattern.MatchString(spec.Module) {
		return spec, nil, errors.New("module must be a lowercase-kebab name")
	}
	if spec.Action, err = requiredCRMDealString(fields, "action", 0, 0); err != nil {
		return spec, nil, err
	}
	if !creatorActionPattern.MatchString(spec.Action) {
		return spec, nil, errors.New("action must be a PascalOrCamel name")
	}
	if spec.Title, err = requiredCRMDealString(fields, "title", 4, 120); err != nil {
		return spec, nil, err
	}
	if spec.Intent, err = requiredCRMDealString(fields, "intent", 20, 500); err != nil {
		return spec, nil, err
	}
	if spec.Risk, err = projectRequiredEnum(fields, "risk", []string{"read", "write", "money", "identity", "destructive", "secret"}); err != nil {
		return spec, nil, err
	}
	if spec.Permission, err = requiredCRMDealString(fields, "permission", 3, 0); err != nil {
		return spec, nil, err
	}
	if rawGap, ok := fields["gapTicketId"]; ok {
		if strings.TrimSpace(string(rawGap)) == "null" {
			return spec, nil, errors.New("gapTicketId must be a UUID")
		}
		gapID, err := projectRequiredUUID(fields, "gapTicketId")
		if err != nil {
			return spec, nil, err
		}
		gapTicketID = &gapID
	}
	rawFields, ok := fields["inputFields"]
	if ok {
		if trimmed := strings.TrimSpace(string(rawFields)); trimmed == "" || trimmed[0] != '[' {
			return spec, nil, errors.New("inputFields must be an array of objects")
		}
		var parsed []CreatorScaffoldField
		if err := json.Unmarshal(rawFields, &parsed); err != nil {
			return spec, nil, errors.New("inputFields must be an array of objects")
		}
		var rawFieldList []map[string]json.RawMessage
		if err := json.Unmarshal(rawFields, &rawFieldList); err != nil {
			return spec, nil, errors.New("inputFields must be an array of objects")
		}
		if len(parsed) > 20 {
			return spec, nil, errors.New("inputFields must have at most 20 items")
		}
		for i, field := range parsed {
			if rawDescription, present := rawFieldList[i]["description"]; present && strings.TrimSpace(string(rawDescription)) == "null" {
				return spec, nil, errors.New("input field description must be a string")
			}
			if !creatorFieldNamePattern.MatchString(field.Name) {
				return spec, nil, errors.New("input field names must be alphanumeric")
			}
			switch field.Type {
			case "string", "number", "boolean":
			default:
				return spec, nil, errors.New("input field type must be string, number or boolean")
			}
			if field.Description != nil && utf16Length(*field.Description) > 200 {
				return spec, nil, errors.New("input field description must be at most 200 characters")
			}
		}
		spec.InputFields = parsed
	}
	return spec, gapTicketID, nil
}

func ParseCreatorSubmitProposalInput(raw json.RawMessage) (CreatorSubmitProposalInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatorSubmitProposalInput{}, err
	}
	var input CreatorSubmitProposalInput
	if input.Title, err = requiredCRMDealString(fields, "title", 4, 120); err != nil {
		return CreatorSubmitProposalInput{}, err
	}
	if input.Summary, err = requiredCRMDealString(fields, "summary", 20, 4000); err != nil {
		return CreatorSubmitProposalInput{}, err
	}
	if input.DiffText, err = requiredCRMDealString(fields, "diffText", 10, 100000); err != nil {
		return CreatorSubmitProposalInput{}, err
	}
	if rawEvidence, ok := fields["testEvidence"]; ok {
		var evidence string
		if strings.TrimSpace(string(rawEvidence)) == "null" || json.Unmarshal(rawEvidence, &evidence) != nil {
			return CreatorSubmitProposalInput{}, errors.New("testEvidence must be a string")
		}
		if utf16Length(evidence) > 20000 {
			return CreatorSubmitProposalInput{}, errors.New("testEvidence must be at most 20000 characters")
		}
		input.TestEvidence = &evidence
	}
	if input.RiskAssessment, err = requiredCRMDealString(fields, "riskAssessment", 10, 4000); err != nil {
		return CreatorSubmitProposalInput{}, err
	}
	if _, ok := fields["gapTicketId"]; ok {
		if strings.TrimSpace(string(fields["gapTicketId"])) == "null" {
			return CreatorSubmitProposalInput{}, errors.New("gapTicketId must be a UUID")
		}
		gapID, err := projectRequiredUUID(fields, "gapTicketId")
		if err != nil {
			return CreatorSubmitProposalInput{}, err
		}
		input.GapTicketID = &gapID
	}
	return input, nil
}

func ParseCreatorListProposalsInput(raw json.RawMessage) (CreatorListProposalsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatorListProposalsInput{}, err
	}
	var input CreatorListProposalsInput
	if rawStatus, ok := fields["status"]; ok {
		var status string
		if strings.TrimSpace(string(rawStatus)) == "null" || json.Unmarshal(rawStatus, &status) != nil {
			return CreatorListProposalsInput{}, errors.New("status must be a string")
		}
		switch status {
		case "in_review", "approved", "rejected", "merged":
		default:
			return CreatorListProposalsInput{}, errors.New("status must be in_review, approved, rejected or merged")
		}
		input.Status = &status
	}
	return input, nil
}

func ParseCreatorScaffoldInput(raw json.RawMessage) (CreatorScaffoldInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatorScaffoldInput{}, err
	}
	spec, gapTicketID, err := creatorParseScaffoldSpec(fields)
	if err != nil {
		return CreatorScaffoldInput{}, err
	}
	input := CreatorScaffoldInput{Module: spec.Module, Action: spec.Action, Title: spec.Title, Intent: spec.Intent, Risk: spec.Risk, Permission: spec.Permission, GapTicketID: gapTicketID, InputFields: spec.InputFields, SubmitAsProposal: true}
	if rawSubmit, ok := fields["submitAsProposal"]; ok {
		if strings.TrimSpace(string(rawSubmit)) == "null" || json.Unmarshal(rawSubmit, &input.SubmitAsProposal) != nil {
			return CreatorScaffoldInput{}, errors.New("submitAsProposal must be a boolean")
		}
	}
	return input, nil
}

func ParseCreatorVerifyPluginInput(raw json.RawMessage) (CreatorVerifyPluginInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatorVerifyPluginInput{}, err
	}
	var input CreatorVerifyPluginInput
	rawManifest, ok := fields["manifest"]
	if !ok {
		return CreatorVerifyPluginInput{}, errors.New("manifest is required")
	}
	input.Manifest = rawManifest
	if input.SignatureBase64, err = requiredCRMDealString(fields, "signatureBase64", 0, 0); err != nil {
		return CreatorVerifyPluginInput{}, err
	}
	if input.PublisherPublicKeyBase64, err = requiredCRMDealString(fields, "publisherPublicKeyBase64", 0, 0); err != nil {
		return CreatorVerifyPluginInput{}, err
	}
	return input, nil
}

func ParseCreatorPublishListingInput(raw json.RawMessage) (CreatorPublishListingInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatorPublishListingInput{}, err
	}
	var input CreatorPublishListingInput
	rawManifest, ok := fields["manifest"]
	if !ok {
		return CreatorPublishListingInput{}, errors.New("manifest is required")
	}
	if _, err := creatorValidateManifest(rawManifest); err != nil {
		return CreatorPublishListingInput{}, err
	}
	input.Manifest = rawManifest
	if input.SignatureBase64, err = requiredCRMDealString(fields, "signatureBase64", 16, 0); err != nil {
		return CreatorPublishListingInput{}, err
	}
	if input.PublisherPublicKeyBase64, err = requiredCRMDealString(fields, "publisherPublicKeyBase64", 16, 0); err != nil {
		return CreatorPublishListingInput{}, err
	}
	return input, nil
}

func ParseCreatorRetractListingInput(raw json.RawMessage) (CreatorRetractListingInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatorRetractListingInput{}, err
	}
	var input CreatorRetractListingInput
	if input.Slug, err = requiredCRMDealString(fields, "slug", 0, 0); err != nil {
		return CreatorRetractListingInput{}, err
	}
	return input, nil
}

func ParseCreatorListingIDInput(raw json.RawMessage) (CreatorInstallListingInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatorInstallListingInput{}, err
	}
	var input CreatorInstallListingInput
	if input.ListingID, err = requiredCRMDealString(fields, "listingId", 0, 0); err != nil {
		return CreatorInstallListingInput{}, err
	}
	return input, nil
}

func ParseCreatorStageCandidateInput(raw json.RawMessage) (CreatorStageCandidateInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatorStageCandidateInput{}, err
	}
	var input CreatorStageCandidateInput
	if input.ProposalID, err = projectRequiredUUID(fields, "proposalId"); err != nil {
		return CreatorStageCandidateInput{}, err
	}
	if input.GapTicketID, err = projectRequiredUUID(fields, "gapTicketId"); err != nil {
		return CreatorStageCandidateInput{}, err
	}
	if rawDigest, ok := fields["candidateDigest"]; ok {
		var digest string
		if err := json.Unmarshal(rawDigest, &digest); err != nil || !creatorDigestPattern.MatchString(digest) {
			return CreatorStageCandidateInput{}, errors.New("candidateDigest must be a 64-hex digest")
		}
		input.CandidateDigest = digest
	} else {
		return CreatorStageCandidateInput{}, errors.New("candidateDigest is required")
	}
	if input.ArtifactRef, err = requiredCRMDealString(fields, "artifactRef", 0, 0); err != nil {
		return CreatorStageCandidateInput{}, err
	}
	if !creatorArtifactRefPattern.MatchString(input.ArtifactRef) {
		return CreatorStageCandidateInput{}, errors.New("immutable artifact reference required")
	}
	return input, nil
}

func ParseCreatorPromoteCandidateInput(raw json.RawMessage) (CreatorPromoteCandidateInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatorPromoteCandidateInput{}, err
	}
	var input CreatorPromoteCandidateInput
	if input.ReleaseID, err = projectRequiredUUID(fields, "releaseId"); err != nil {
		return CreatorPromoteCandidateInput{}, err
	}
	if rawDigest, ok := fields["candidateDigest"]; ok {
		var digest string
		if err := json.Unmarshal(rawDigest, &digest); err != nil || !creatorDigestPattern.MatchString(digest) {
			return CreatorPromoteCandidateInput{}, errors.New("candidateDigest must be a 64-hex digest")
		}
		input.CandidateDigest = digest
	} else {
		return CreatorPromoteCandidateInput{}, errors.New("candidateDigest is required")
	}
	return input, nil
}

func ParseCreatorRollbackCandidateInput(raw json.RawMessage) (CreatorRollbackCandidateInput, error) {
	parsed, err := ParseCreatorPromoteCandidateInput(raw)
	return CreatorRollbackCandidateInput{ReleaseID: parsed.ReleaseID, CandidateDigest: parsed.CandidateDigest}, err
}

func ParseCreatorRecordCanaryOutcomeInput(raw json.RawMessage) (CreatorRecordCanaryOutcomeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return CreatorRecordCanaryOutcomeInput{}, err
	}
	var input CreatorRecordCanaryOutcomeInput
	if input.ReleaseID, err = projectRequiredUUID(fields, "releaseId"); err != nil {
		return CreatorRecordCanaryOutcomeInput{}, err
	}
	if input.GapTicketID, err = projectRequiredUUID(fields, "gapTicketId"); err != nil {
		return CreatorRecordCanaryOutcomeInput{}, err
	}
	if rawDigest, ok := fields["candidateDigest"]; ok {
		var digest string
		if err := json.Unmarshal(rawDigest, &digest); err != nil || !creatorDigestPattern.MatchString(digest) {
			return CreatorRecordCanaryOutcomeInput{}, errors.New("candidateDigest must be a 64-hex digest")
		}
		input.CandidateDigest = digest
	} else {
		return CreatorRecordCanaryOutcomeInput{}, errors.New("candidateDigest is required")
	}
	if input.Verdict, err = projectRequiredEnum(fields, "verdict", []string{"pass", "fail"}); err != nil {
		return CreatorRecordCanaryOutcomeInput{}, err
	}
	if input.EvidenceRef, err = requiredCRMDealString(fields, "evidenceRef", 0, 0); err != nil {
		return CreatorRecordCanaryOutcomeInput{}, err
	}
	if !creatorEvidenceRefPattern.MatchString(input.EvidenceRef) {
		return CreatorRecordCanaryOutcomeInput{}, errors.New("immutable evidence reference required")
	}
	if rawMetrics, ok := fields["metrics"]; ok {
		if strings.TrimSpace(string(rawMetrics)) == "null" {
			return CreatorRecordCanaryOutcomeInput{}, errors.New("metrics must be an object of scalars")
		}
		var metrics map[string]any
		if err := json.Unmarshal(rawMetrics, &metrics); err != nil {
			return CreatorRecordCanaryOutcomeInput{}, errors.New("metrics must be an object of scalars")
		}
		for _, value := range metrics {
			switch value.(type) {
			case string, float64, bool:
			default:
				return CreatorRecordCanaryOutcomeInput{}, errors.New("metrics must be an object of scalars")
			}
		}
		input.Metrics = metrics
	} else {
		input.Metrics = map[string]any{}
	}
	return input, nil
}

func parseCreatorInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case creatorSubmitProposalCapabilityID:
		return ParseCreatorSubmitProposalInput(raw)
	case creatorListProposalsCapabilityID:
		return ParseCreatorListProposalsInput(raw)
	case creatorScaffoldCapabilityID:
		return ParseCreatorScaffoldInput(raw)
	case creatorVerifyPluginCapabilityID:
		return ParseCreatorVerifyPluginInput(raw)
	case creatorPublishListingCapabilityID:
		return ParseCreatorPublishListingInput(raw)
	case creatorRetractListingCapabilityID:
		return ParseCreatorRetractListingInput(raw)
	case creatorInstallListingCapabilityID, creatorUninstallListingCapabilityID:
		return ParseCreatorListingIDInput(raw)
	case creatorListMarketplaceCapabilityID:
		if _, err := decodeJSONObject(raw); err != nil {
			return nil, err
		}
		return CreatorListMarketplaceInput{}, nil
	case creatorStageCandidateCapabilityID:
		return ParseCreatorStageCandidateInput(raw)
	case creatorPromoteCandidateCapabilityID:
		return ParseCreatorPromoteCandidateInput(raw)
	case creatorRollbackCandidateCapabilityID:
		return ParseCreatorRollbackCandidateInput(raw)
	case creatorRecordCanaryOutcomeCapabilityID:
		return ParseCreatorRecordCanaryOutcomeInput(raw)
	default:
		return nil, errors.New("unsupported creator capability")
	}
}

// ── Execute functions ──

func creatorVerifyGapTicket(ctx context.Context, tx pgx.Tx, orgID, gapTicketID string) error {
	var origin string
	err := tx.QueryRow(ctx, `SELECT origin FROM tickets WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`,
		gapTicketID, orgID).Scan(&origin)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("capability gap ticket not found for organization")
	}
	if err != nil {
		return err
	}
	if origin != "capability_gap" {
		return errors.New("outcome must link to a capability gap ticket")
	}
	return nil
}

func creatorSubmitProposal(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreatorSubmitProposalInput) (CreatorSubmitProposalOutput, error) {
	if input.GapTicketID != nil {
		if err := creatorVerifyGapTicket(ctx, tx, claims.OrganizationID, *input.GapTicketID); err != nil {
			return CreatorSubmitProposalOutput{}, err
		}
	}
	var proposalID string
	var gapTicketID any
	if input.GapTicketID != nil {
		gapTicketID = *input.GapTicketID
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO creator_proposals (org_id, title, summary, diff_text, test_evidence, risk_assessment, gap_ticket_id, status, session_id, proposed_by_actor_type, proposed_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, 'in_review', NULLIF($8,'')::uuid, $9, $10)
		RETURNING id::text`,
		claims.OrganizationID, input.Title, input.Summary, input.DiffText, input.TestEvidence, input.RiskAssessment,
		gapTicketID, claims.AgentSessionID, claims.ActorType, claims.ActorID).Scan(&proposalID); err != nil {
		return CreatorSubmitProposalOutput{}, err
	}
	return CreatorSubmitProposalOutput{ProposalID: proposalID}, nil
}

func creatorListProposals(ctx context.Context, tx pgx.Tx, orgID string, input CreatorListProposalsInput) (CreatorListProposalsOutput, error) {
	query := `SELECT id::text, title, status, created_at FROM creator_proposals WHERE org_id=$1::uuid`
	args := []any{orgID}
	if input.Status != nil {
		args = append(args, *input.Status)
		query += fmt.Sprintf(" AND status=$%d", len(args))
	}
	query += " ORDER BY created_at DESC LIMIT 50"
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return CreatorListProposalsOutput{}, err
	}
	defer rows.Close()
	out := CreatorListProposalsOutput{Proposals: []CreatorProposalListItem{}}
	for rows.Next() {
		var item CreatorProposalListItem
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.Title, &item.Status, &createdAt); err != nil {
			return CreatorListProposalsOutput{}, err
		}
		item.CreatedAt = createdAt.UTC().Format("2006-01-02T15:04:05.000Z07:00")
		out.Proposals = append(out.Proposals, item)
	}
	return out, rows.Err()
}

func creatorScaffoldCapability(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreatorScaffoldInput) (CreatorScaffoldOutput, error) {
	if input.GapTicketID != nil {
		if err := creatorVerifyGapTicket(ctx, tx, claims.OrganizationID, *input.GapTicketID); err != nil {
			return CreatorScaffoldOutput{}, err
		}
	}
	spec := CreatorScaffoldSpec{
		Module: input.Module, Action: input.Action, Title: input.Title, Intent: input.Intent,
		Risk: input.Risk, Permission: input.Permission, InputFields: input.InputFields,
	}
	filePath := fmt.Sprintf("modules/%s/src/%s.ts", input.Module, input.Action)
	source, err := creatorRenderCapabilitySource(spec)
	if err != nil {
		return CreatorScaffoldOutput{}, err
	}
	out := CreatorScaffoldOutput{Files: []CreatorGeneratedFile{
		{Path: filePath, Content: source},
		{Path: fmt.Sprintf("modules/%s/src/%s.test.ts", input.Module, input.Action), Content: creatorRenderTestSkeleton(spec)},
		{Path: fmt.Sprintf("docs/proposals/%s-%s-risk.md", input.Module, input.Action), Content: creatorRenderRiskDoc(spec)},
	}}
	if !input.SubmitAsProposal {
		return out, nil
	}
	diff, err := creatorRenderProposalDiff(spec, filePath)
	if err != nil {
		return CreatorScaffoldOutput{}, err
	}
	summary := fmt.Sprintf("%s, %s\n\nRisk class %s, permission %s. Generated by Creator Mode scaffolding; awaiting human review.", spec.Title, spec.Intent, spec.Risk, spec.Permission)
	var gapTicketID any
	if input.GapTicketID != nil {
		gapTicketID = *input.GapTicketID
	}
	var proposalID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO creator_proposals (org_id, title, summary, diff_text, test_evidence, risk_assessment, gap_ticket_id, status, session_id, proposed_by_actor_type, proposed_by_actor_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, 'in_review', NULLIF($8,'')::uuid, $9, $10)
		RETURNING id::text`,
		claims.OrganizationID, fmt.Sprintf("New capability: %s.%s", spec.Module, spec.Action), summary,
		diff, creatorRenderTestSkeleton(spec), creatorRenderRiskDoc(spec), gapTicketID,
		claims.AgentSessionID, claims.ActorType, claims.ActorID).Scan(&proposalID); err != nil {
		return CreatorScaffoldOutput{}, err
	}
	out.ProposalID = &proposalID
	return out, nil
}

func creatorVerifyPluginCapability(ctx context.Context, input CreatorVerifyPluginInput) (CreatorVerifyPluginOutput, error) {
	valid, reason, _ := creatorVerifyPlugin(input.Manifest, input.SignatureBase64, input.PublisherPublicKeyBase64)
	out := CreatorVerifyPluginOutput{Valid: valid}
	if reason != "" {
		out.Reason = &reason
	}
	return out, nil
}

func creatorPublishListing(ctx context.Context, tx pgx.Tx, orgID string, input CreatorPublishListingInput) (CreatorPublishListingOutput, error) {
	valid, reason, manifest := creatorVerifyPlugin(input.Manifest, input.SignatureBase64, input.PublisherPublicKeyBase64)
	if !valid {
		return CreatorPublishListingOutput{}, fmt.Errorf("refused: %s", reason)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 42))`, manifest.Slug); err != nil {
		return CreatorPublishListingOutput{}, err
	}
	var existingID, existingVersion string
	var existingOrgID string
	err := tx.QueryRow(ctx, `
		SELECT id::text, version, submitted_by_org_id::text FROM marketplace_listings WHERE slug=$1 LIMIT 1`,
		manifest.Slug).Scan(&existingID, &existingVersion, &existingOrgID)
	hasExisting := !errors.Is(err, pgx.ErrNoRows)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return CreatorPublishListingOutput{}, err
	}
	if hasExisting && existingOrgID != orgID {
		return CreatorPublishListingOutput{}, fmt.Errorf("slug %q is owned by another publisher", manifest.Slug)
	}
	if hasExisting && existingVersion == manifest.Version {
		return CreatorPublishListingOutput{}, fmt.Errorf("%s@%s is already published", manifest.Slug, manifest.Version)
	}
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		return CreatorPublishListingOutput{}, err
	}
	capabilityIDs, err := json.Marshal(manifest.Capabilities)
	if err != nil {
		return CreatorPublishListingOutput{}, err
	}
	var listingID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO marketplace_listings (slug, name, version, summary, manifest, signature, publisher_public_key, capability_ids, status, submitted_by_org_id, updated_at)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, 'verified', $9::uuid, $10)
		ON CONFLICT (slug) DO UPDATE SET
			name=$2, version=$3, summary=$4, manifest=$5::jsonb, signature=$6, publisher_public_key=$7,
			capability_ids=$8::jsonb, status='verified', submitted_by_org_id=$9::uuid, updated_at=$10
		WHERE marketplace_listings.submitted_by_org_id=$9::uuid
		RETURNING id::text`,
		manifest.Slug, manifest.Name, manifest.Version, manifest.Summary, string(manifestJSON),
		input.SignatureBase64, input.PublisherPublicKeyBase64, string(capabilityIDs), orgID, time.Now()).Scan(&listingID); err != nil {
		return CreatorPublishListingOutput{}, err
	}
	return CreatorPublishListingOutput{ListingID: listingID, Slug: manifest.Slug, Status: "verified"}, nil
}

func creatorRetractListing(ctx context.Context, tx pgx.Tx, orgID string, input CreatorRetractListingInput) (CreatorRetractListingOutput, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE marketplace_listings SET status='rejected', updated_at=$3
		WHERE slug=$1 AND submitted_by_org_id=$2::uuid`,
		input.Slug, orgID, time.Now())
	if err != nil {
		return CreatorRetractListingOutput{}, err
	}
	if tag.RowsAffected() == 0 {
		return CreatorRetractListingOutput{}, errors.New("no such listing published by your org")
	}
	return CreatorRetractListingOutput{Retracted: true}, nil
}

func creatorListingJSONField(listingJSON []byte, field string) string {
	var manifest map[string]any
	_ = json.Unmarshal(listingJSON, &manifest)
	return toJSONString(manifest[field])
}

func creatorInstallListing(ctx context.Context, tx pgx.Tx, orgID string, input CreatorInstallListingInput) (CreatorInstallListingOutput, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 43))`, input.ListingID); err != nil {
		return CreatorInstallListingOutput{}, err
	}
	var listingID, slug, version, status, signature, publisherKey string
	var manifestJSON json.RawMessage
	var installedJSON []byte
	err := tx.QueryRow(ctx, `
		SELECT id::text, slug, version, status, manifest, signature, publisher_public_key, installed_by_org_ids
		FROM marketplace_listings WHERE id=$1::uuid LIMIT 1`, input.ListingID).Scan(
		&listingID, &slug, &version, &status, &manifestJSON, &signature, &publisherKey, &installedJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreatorInstallListingOutput{}, errors.New("listing not found")
	}
	if err != nil {
		return CreatorInstallListingOutput{}, err
	}
	if status != "verified" {
		return CreatorInstallListingOutput{}, fmt.Errorf("listing is %s; refusing install", status)
	}
	valid, reason, _ := creatorVerifyPlugin(manifestJSON, signature, publisherKey)
	if !valid {
		return CreatorInstallListingOutput{}, fmt.Errorf("signature no longer verifies: %s", reason)
	}
	var installed []string
	_ = json.Unmarshal(installedJSON, &installed)
	hasInstaller := false
	for _, installer := range installed {
		if installer == orgID {
			hasInstaller = true
			break
		}
	}
	if !hasInstaller {
		installed = append(installed, orgID)
	}
	encoded, err := json.Marshal(installed)
	if err != nil {
		return CreatorInstallListingOutput{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE marketplace_listings SET installed_by_org_ids=$2::jsonb, updated_at=$3 WHERE id=$1::uuid`,
		listingID, string(encoded), time.Now()); err != nil {
		return CreatorInstallListingOutput{}, err
	}
	return CreatorInstallListingOutput{Installed: true, Slug: slug, Version: version}, nil
}

func creatorUninstallListing(ctx context.Context, tx pgx.Tx, orgID string, input CreatorUninstallListingInput) (CreatorUninstallListingOutput, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 43))`, input.ListingID); err != nil {
		return CreatorUninstallListingOutput{}, err
	}
	var listingID, signature, publisherKey string
	var manifestJSON json.RawMessage
	var installedJSON []byte
	err := tx.QueryRow(ctx, `
		SELECT id::text, manifest, signature, publisher_public_key, installed_by_org_ids
		FROM marketplace_listings WHERE id=$1::uuid LIMIT 1`, input.ListingID).Scan(
		&listingID, &manifestJSON, &signature, &publisherKey, &installedJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreatorUninstallListingOutput{}, errors.New("listing not found")
	}
	if err != nil {
		return CreatorUninstallListingOutput{}, err
	}
	valid, _, _ := creatorVerifyPlugin(manifestJSON, signature, publisherKey)
	_ = valid
	var installed []string
	_ = json.Unmarshal(installedJSON, &installed)
	var kept []string
	for _, installer := range installed {
		if installer != orgID {
			kept = append(kept, installer)
		}
	}
	encoded, err := json.Marshal(kept)
	if err != nil {
		return CreatorUninstallListingOutput{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE marketplace_listings SET installed_by_org_ids=$2::jsonb, updated_at=$3 WHERE id=$1::uuid`,
		listingID, string(encoded), time.Now()); err != nil {
		return CreatorUninstallListingOutput{}, err
	}
	return CreatorUninstallListingOutput{Uninstalled: true}, nil
}

func creatorListMarketplace(ctx context.Context, tx pgx.Tx, orgID string) (CreatorListMarketplaceOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, slug, name, version, summary, status, capability_ids,
			installed_by_org_ids, updated_at
		FROM marketplace_listings
		ORDER BY updated_at DESC LIMIT 100`)
	if err != nil {
		return CreatorListMarketplaceOutput{}, err
	}
	defer rows.Close()
	out := CreatorListMarketplaceOutput{Listings: []CreatorMarketplaceListing{}}
	for rows.Next() {
		var listing CreatorMarketplaceListing
		var capabilitiesJSON, installedJSON []byte
		if err := rows.Scan(&listing.ID, &listing.Slug, &listing.Name, &listing.Version, &listing.Summary,
			&listing.Status, &capabilitiesJSON, &installedJSON, &listing.UpdatedAt); err != nil {
			return CreatorListMarketplaceOutput{}, err
		}
		listing.InstalledByOrgIDs = json.RawMessage(installedJSON)
		if len(listing.InstalledByOrgIDs) == 0 {
			listing.InstalledByOrgIDs = json.RawMessage("null")
		}
		if err := json.Unmarshal(capabilitiesJSON, &listing.CapabilityIDs); err != nil || listing.CapabilityIDs == nil {
			listing.CapabilityIDs = []json.RawMessage{}
		}
		var installed []json.RawMessage
		if err := json.Unmarshal(installedJSON, &installed); err != nil || installed == nil {
			installed = []json.RawMessage{}
		}
		listing.InstalledHere = false
		for _, installerRaw := range installed {
			var installer string
			if err := json.Unmarshal(installerRaw, &installer); err == nil && installer == orgID {
				listing.InstalledHere = true
				break
			}
		}
		listing.UpdatedAt = jsDate(listing.UpdatedAt)
		out.Listings = append(out.Listings, listing)
	}
	return out, rows.Err()
}

func creatorVerifiedCandidate(ctx context.Context, tx pgx.Tx, orgID, proposalID, candidateDigest string) (gapTicketID string, err error) {
	var status string
	var testEvidence *string
	var proposalGapTicketID *string
	err = tx.QueryRow(ctx, `
		SELECT status, gap_ticket_id::text, test_evidence FROM creator_proposals
		WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`, proposalID, orgID).Scan(&status, &proposalGapTicketID, &testEvidence)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errors.New("creator proposal not found for organization")
	}
	if err != nil {
		return "", err
	}
	if status != "approved" {
		return "", fmt.Errorf("proposal is %s; approval is required before release", status)
	}
	if testEvidence == nil {
		return "", errors.New("proposal lacks valid isolated candidate evidence")
	}
	var evidence struct {
		Kind            string   `json:"kind"`
		BaselineCommit  string   `json:"baselineCommit"`
		CandidateDigest string   `json:"candidateDigest"`
		Files           []string `json:"files"`
		Verification    struct {
			Passed                bool   `json:"passed"`
			Network               string `json:"network"`
			ProductionCredentials bool   `json:"productionCredentials"`
		} `json:"verification"`
	}
	if err := json.Unmarshal([]byte(*testEvidence), &evidence); err != nil ||
		evidence.Kind != "isolated_creator_candidate" ||
		utf16Length(evidence.BaselineCommit) < 7 ||
		!creatorDigestPattern.MatchString(evidence.CandidateDigest) ||
		len(evidence.Files) < 1 ||
		!evidence.Verification.Passed ||
		evidence.Verification.Network == "" ||
		evidence.Verification.ProductionCredentials {
		return "", errors.New("proposal lacks valid isolated candidate evidence")
	}
	for _, file := range evidence.Files {
		if file == "" {
			return "", errors.New("proposal lacks valid isolated candidate evidence")
		}
	}
	if evidence.CandidateDigest != candidateDigest {
		return "", errors.New("candidate digest does not match verified evidence")
	}
	if proposalGapTicketID == nil {
		return "", errors.New("proposal lacks valid isolated candidate evidence")
	}
	return *proposalGapTicketID, nil
}

func creatorStageCandidate(ctx context.Context, tx pgx.Tx, orgID string, input CreatorStageCandidateInput) (CreatorReleaseOutput, error) {
	gapTicketID, err := creatorVerifiedCandidate(ctx, tx, orgID, input.ProposalID, input.CandidateDigest)
	if err != nil {
		return CreatorReleaseOutput{}, err
	}
	if gapTicketID != input.GapTicketID {
		return CreatorReleaseOutput{}, errors.New("candidate proposal is not linked to the requested capability gap")
	}
	if err := creatorVerifyGapTicket(ctx, tx, orgID, input.GapTicketID); err != nil {
		return CreatorReleaseOutput{}, err
	}
	stageKey := strings.Join([]string{orgID, input.ProposalID, input.CandidateDigest, input.ArtifactRef}, ":")
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, stageKey); err != nil {
		return CreatorReleaseOutput{}, err
	}
	var existingID, existingStatus, existingGapTicketID, existingDigest, existingArtifactRef string
	err = tx.QueryRow(ctx, `
		SELECT id::text, status, gap_ticket_id::text, candidate_digest, artifact_ref
		FROM creator_evolution_releases
		WHERE org_id=$1::uuid AND proposal_id=$2::uuid AND candidate_digest=$3 AND artifact_ref=$4 AND status='staged'
		LIMIT 1`, orgID, input.ProposalID, input.CandidateDigest, input.ArtifactRef).Scan(
		&existingID, &existingStatus, &existingGapTicketID, &existingDigest, &existingArtifactRef)
	if err == nil {
		if existingGapTicketID != input.GapTicketID {
			return CreatorReleaseOutput{}, errors.New("release gap ticket does not match the requested gap")
		}
		return CreatorReleaseOutput{ReleaseID: existingID, Status: "staged", GapTicketID: existingGapTicketID, CandidateDigest: existingDigest, ArtifactRef: existingArtifactRef}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CreatorReleaseOutput{}, err
	}
	var releaseID string
	var releaseGapTicketID, releaseDigest, releaseArtifactRef string
	if err := tx.QueryRow(ctx, `
		INSERT INTO creator_evolution_releases (org_id, proposal_id, gap_ticket_id, candidate_digest, artifact_ref, status)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'staged')
		RETURNING id::text, gap_ticket_id::text, candidate_digest, artifact_ref`,
		orgID, input.ProposalID, input.GapTicketID, input.CandidateDigest, input.ArtifactRef).Scan(
		&releaseID, &releaseGapTicketID, &releaseDigest, &releaseArtifactRef); err != nil {
		return CreatorReleaseOutput{}, err
	}
	return CreatorReleaseOutput{ReleaseID: releaseID, Status: "staged", GapTicketID: releaseGapTicketID, CandidateDigest: releaseDigest, ArtifactRef: releaseArtifactRef}, nil
}

func creatorPromoteCandidate(ctx context.Context, tx pgx.Tx, orgID string, input CreatorPromoteCandidateInput) (CreatorReleaseOutput, error) {
	var releaseID, status, gapTicketID, digest, artifactRef string
	err := tx.QueryRow(ctx, `
		SELECT id::text, status, gap_ticket_id::text, candidate_digest, artifact_ref
		FROM creator_evolution_releases WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`,
		input.ReleaseID, orgID).Scan(&releaseID, &status, &gapTicketID, &digest, &artifactRef)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreatorReleaseOutput{}, errors.New("creator evolution release not found for organization")
	}
	if err != nil {
		return CreatorReleaseOutput{}, err
	}
	if digest != input.CandidateDigest {
		return CreatorReleaseOutput{}, errors.New("release digest mismatch")
	}
	if status != "staged" {
		return CreatorReleaseOutput{}, fmt.Errorf("release is %s; only staged artifacts may be promoted", status)
	}
	var promotedID, promotedGapTicketID, promotedDigest, promotedArtifactRef string
	err = tx.QueryRow(ctx, `
		UPDATE creator_evolution_releases SET status='promoted', promoted_at=$3
		WHERE id=$1::uuid AND org_id=$2::uuid AND status='staged'
		RETURNING id::text, gap_ticket_id::text, candidate_digest, artifact_ref`,
		releaseID, orgID, time.Now()).Scan(&promotedID, &promotedGapTicketID, &promotedDigest, &promotedArtifactRef)
	if err != nil {
		return CreatorReleaseOutput{}, errors.New("release changed before promotion")
	}
	return CreatorReleaseOutput{ReleaseID: promotedID, Status: "promoted", GapTicketID: promotedGapTicketID, CandidateDigest: promotedDigest, ArtifactRef: promotedArtifactRef}, nil
}

func creatorRollbackCandidate(ctx context.Context, tx pgx.Tx, orgID string, input CreatorRollbackCandidateInput) (CreatorReleaseOutput, error) {
	var releaseID, digest, artifactRef string
	err := tx.QueryRow(ctx, `
		UPDATE creator_evolution_releases SET status='rolled_back', rolled_back_at=$4
		WHERE id=$1::uuid AND org_id=$2::uuid AND candidate_digest=$3 AND status IN ('staged','promoted')
		RETURNING id::text, candidate_digest, artifact_ref`,
		input.ReleaseID, orgID, input.CandidateDigest, time.Now()).Scan(&releaseID, &digest, &artifactRef)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreatorReleaseOutput{}, errors.New("release not found or digest mismatch")
	}
	if err != nil {
		return CreatorReleaseOutput{}, err
	}
	return CreatorReleaseOutput{ReleaseID: releaseID, Status: "rolled_back", CandidateDigest: digest, ArtifactRef: artifactRef}, nil
}

func creatorRecordCanaryOutcome(ctx context.Context, tx pgx.Tx, orgID string, input CreatorRecordCanaryOutcomeInput) (CreatorRecordCanaryOutcomeOutput, error) {
	var releaseID, status, gapTicketID, digest string
	err := tx.QueryRow(ctx, `
		SELECT id::text, status, gap_ticket_id::text, candidate_digest
		FROM creator_evolution_releases WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`,
		input.ReleaseID, orgID).Scan(&releaseID, &status, &gapTicketID, &digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreatorRecordCanaryOutcomeOutput{}, errors.New("creator evolution release not found for organization")
	}
	if err != nil {
		return CreatorRecordCanaryOutcomeOutput{}, err
	}
	if status != "promoted" {
		return CreatorRecordCanaryOutcomeOutput{}, fmt.Errorf("release is %s; canary evidence requires a promoted release", status)
	}
	if digest != input.CandidateDigest {
		return CreatorRecordCanaryOutcomeOutput{}, errors.New("release digest mismatch")
	}
	if gapTicketID != input.GapTicketID {
		return CreatorRecordCanaryOutcomeOutput{}, errors.New("outcome gap ticket does not match the release")
	}
	if err := creatorVerifyGapTicket(ctx, tx, orgID, input.GapTicketID); err != nil {
		return CreatorRecordCanaryOutcomeOutput{}, err
	}
	metricsJSON, err := json.Marshal(input.Metrics)
	if err != nil {
		return CreatorRecordCanaryOutcomeOutput{}, err
	}
	var outcomeID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO creator_evolution_outcomes (org_id, release_id, gap_ticket_id, candidate_digest, phase, verdict, evidence_ref, metrics)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'canary', $5, $6, $7::jsonb)
		RETURNING id::text`,
		orgID, releaseID, input.GapTicketID, input.CandidateDigest, input.Verdict, input.EvidenceRef, string(metricsJSON)).Scan(&outcomeID); err != nil {
		return CreatorRecordCanaryOutcomeOutput{}, err
	}
	return CreatorRecordCanaryOutcomeOutput{
		OutcomeID: outcomeID, ReleaseID: releaseID, GapTicketID: gapTicketID,
		CandidateDigest: digest, Phase: "canary", Verdict: input.Verdict,
	}, nil
}
