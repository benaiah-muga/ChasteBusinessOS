package capability

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Port of apps/web/src/server/harness-approval.ts and the composition identity
// checks in apps/web/src/server/harness-compositions.ts. A harness composition
// is immutable and self-attesting: the stored profile, bundles, and patches
// must re-hash to the persisted digests before an approval can name it. There
// is no separate signature on the row, so digest verification is the whole
// integrity contract here; plugin manifests keep their ed25519 verification in
// the creator capability.

const harnessApproveCompositionCapabilityID = "harness.approveComposition"

var (
	harnessProfileIDPattern   = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	harnessModuleIDPattern    = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	harnessVersionPattern     = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	harnessDigestPattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	harnessRestrictedProfiles = map[string]bool{"erp-prod": true, "erp-review": true, "erp-worker": true}
)

type HarnessApproveCompositionInput struct {
	CompositionID     string `json:"compositionId"`
	CompositionDigest string `json:"compositionDigest"`
}

type HarnessApproveCompositionOutput struct {
	CompositionID     string `json:"compositionId"`
	CompositionDigest string `json:"compositionDigest"`
	Status            string `json:"status"`
}

// ── Stored composition shapes (mirror of @chaste/harness schemas) ──

type harnessAuthority struct {
	AllowSourceWrites     bool `json:"allowSourceWrites"`
	AllowProcessLaunch    bool `json:"allowProcessLaunch"`
	AllowCodeExecution    bool `json:"allowCodeExecution"`
	AllowRegistryMutation bool `json:"allowRegistryMutation"`
	AllowNetwork          bool `json:"allowNetwork"`
}

type harnessProfile struct {
	ID             string           `json:"id"`
	Version        string           `json:"version"`
	Environment    string           `json:"environment"`
	Authority      harnessAuthority `json:"authority"`
	AllowedModules []string         `json:"allowedModules"`
}

type harnessBundleManifest struct {
	ID                string    `json:"id"`
	Version           string    `json:"version"`
	ServiceIDs        []string  `json:"serviceIds"`
	RequiredBundleIDs *[]string `json:"requiredBundleIds,omitempty"`
}

type harnessConfigPatch struct {
	ID      string                     `json:"id"`
	Version string                     `json:"version"`
	Values  map[string]json.RawMessage `json:"values"`
}

// ── Parsers ──

// harnessIsNull reports an explicit JSON null. encoding/json treats null as
// "leave the target unchanged" for strings, bools, and slices, so every
// required field needs this guard to fail closed the way Zod does.
func harnessIsNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func harnessRequiredString(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("%s is required", key)
	}
	if harnessIsNull(raw) {
		return "", fmt.Errorf("%s must be a string", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

func harnessRequiredBool(fields map[string]json.RawMessage, key string) (bool, error) {
	raw, ok := fields[key]
	if !ok {
		return false, fmt.Errorf("authority.%s is required", key)
	}
	if harnessIsNull(raw) {
		return false, fmt.Errorf("authority.%s must be a boolean", key)
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, fmt.Errorf("authority.%s must be a boolean", key)
	}
	return value, nil
}

func harnessRequiredStrings(fields map[string]json.RawMessage, key string) ([]string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	if harnessIsNull(raw) {
		return nil, fmt.Errorf("%s must be an array of strings", key)
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("%s must be an array of strings", key)
	}
	return values, nil
}

func harnessNonEmptyStrings(values []string, key string) ([]string, error) {
	for _, value := range values {
		if value == "" {
			return nil, fmt.Errorf("%s must not contain empty strings", key)
		}
	}
	return values, nil
}

// harnessParseProfile mirrors assertHarnessProfile: it strips unknown keys the
// way Zod does, applies the allowedModules default, and refuses any restricted
// environment that widens authority.
func harnessParseProfile(raw json.RawMessage) (harnessProfile, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return harnessProfile{}, errors.New("harness profile must be an object")
	}
	var profile harnessProfile
	if profile.ID, err = harnessRequiredString(fields, "id"); err != nil {
		return harnessProfile{}, err
	}
	if !harnessProfileIDPattern.MatchString(profile.ID) {
		return harnessProfile{}, errors.New("harness profile id must be lowercase kebab")
	}
	if profile.Version, err = harnessRequiredString(fields, "version"); err != nil {
		return harnessProfile{}, err
	}
	if !harnessVersionPattern.MatchString(profile.Version) {
		return harnessProfile{}, errors.New("harness profile version must be semver x.y.z")
	}
	if profile.Environment, err = harnessRequiredString(fields, "environment"); err != nil {
		return harnessProfile{}, err
	}
	switch profile.Environment {
	case "erp-prod", "erp-dev", "erp-review", "erp-worker":
	default:
		return harnessProfile{}, errors.New("harness profile environment is not a known harness environment")
	}
	rawAuthority, ok := fields["authority"]
	if !ok {
		return harnessProfile{}, errors.New("authority is required")
	}
	authorityFields, err := decodeJSONObject(rawAuthority)
	if err != nil {
		return harnessProfile{}, errors.New("authority must be an object")
	}
	if profile.Authority.AllowSourceWrites, err = harnessRequiredBool(authorityFields, "allowSourceWrites"); err != nil {
		return harnessProfile{}, err
	}
	if profile.Authority.AllowProcessLaunch, err = harnessRequiredBool(authorityFields, "allowProcessLaunch"); err != nil {
		return harnessProfile{}, err
	}
	if profile.Authority.AllowCodeExecution, err = harnessRequiredBool(authorityFields, "allowCodeExecution"); err != nil {
		return harnessProfile{}, err
	}
	if profile.Authority.AllowRegistryMutation, err = harnessRequiredBool(authorityFields, "allowRegistryMutation"); err != nil {
		return harnessProfile{}, err
	}
	if profile.Authority.AllowNetwork, err = harnessRequiredBool(authorityFields, "allowNetwork"); err != nil {
		return harnessProfile{}, err
	}
	profile.AllowedModules = []string{}
	if _, present := fields["allowedModules"]; present {
		modules, err := harnessRequiredStrings(fields, "allowedModules")
		if err != nil {
			return harnessProfile{}, err
		}
		for _, module := range modules {
			if !harnessModuleIDPattern.MatchString(module) {
				return harnessProfile{}, errors.New("allowedModules entries must be lowercase module ids")
			}
		}
		profile.AllowedModules = modules
	}
	if harnessRestrictedProfiles[profile.Environment] {
		forbidden := harnessForbiddenAuthority(profile.Authority)
		if len(forbidden) > 0 {
			return harnessProfile{}, fmt.Errorf("profile %s expands restricted authority: %s", profile.ID, strings.Join(forbidden, ", "))
		}
	}
	return profile, nil
}

// harnessForbiddenAuthority lists the authority a restricted environment may
// never grant. Network is the one capability a restricted harness keeps.
func harnessForbiddenAuthority(authority harnessAuthority) []string {
	granted := map[string]bool{
		"allowSourceWrites":     authority.AllowSourceWrites,
		"allowProcessLaunch":    authority.AllowProcessLaunch,
		"allowCodeExecution":    authority.AllowCodeExecution,
		"allowRegistryMutation": authority.AllowRegistryMutation,
	}
	forbidden := make([]string, 0, len(granted))
	for key, enabled := range granted {
		if enabled {
			forbidden = append(forbidden, key)
		}
	}
	sort.Strings(forbidden)
	return forbidden
}

func harnessParseBundles(raw json.RawMessage) ([]harnessBundleManifest, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, errors.New("harness composition bundles must be an array")
	}
	var elements []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &elements); err != nil {
		return nil, errors.New("harness composition bundles must be an array of objects")
	}
	bundles := make([]harnessBundleManifest, 0, len(elements))
	for _, element := range elements {
		if element == nil {
			return nil, errors.New("harness composition bundles must be an array of objects")
		}
		var bundle harnessBundleManifest
		var err error
		if bundle.ID, err = harnessRequiredString(element, "id"); err != nil {
			return nil, err
		}
		if bundle.ID == "" {
			return nil, errors.New("bundle id must not be empty")
		}
		if bundle.Version, err = harnessRequiredString(element, "version"); err != nil {
			return nil, err
		}
		if bundle.Version == "" {
			return nil, errors.New("bundle version must not be empty")
		}
		if bundle.ServiceIDs, err = harnessRequiredStrings(element, "serviceIds"); err != nil {
			return nil, err
		}
		if bundle.ServiceIDs, err = harnessNonEmptyStrings(bundle.ServiceIDs, "serviceIds"); err != nil {
			return nil, err
		}
		if _, present := element["requiredBundleIds"]; present {
			required, err := harnessRequiredStrings(element, "requiredBundleIds")
			if err != nil {
				return nil, err
			}
			if required, err = harnessNonEmptyStrings(required, "requiredBundleIds"); err != nil {
				return nil, err
			}
			bundle.RequiredBundleIDs = &required
		}
		bundles = append(bundles, bundle)
	}
	return bundles, nil
}

func harnessParsePatches(raw json.RawMessage) ([]harnessConfigPatch, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, errors.New("harness composition patches must be an array")
	}
	var elements []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &elements); err != nil {
		return nil, errors.New("harness composition patches must be an array of objects")
	}
	patches := make([]harnessConfigPatch, 0, len(elements))
	for _, element := range elements {
		if element == nil {
			return nil, errors.New("harness composition patches must be an array of objects")
		}
		var patch harnessConfigPatch
		var err error
		if patch.ID, err = harnessRequiredString(element, "id"); err != nil {
			return nil, err
		}
		if patch.ID == "" {
			return nil, errors.New("patch id must not be empty")
		}
		if patch.Version, err = harnessRequiredString(element, "version"); err != nil {
			return nil, err
		}
		if patch.Version == "" {
			return nil, errors.New("patch version must not be empty")
		}
		rawValues, present := element["values"]
		if !present {
			return nil, errors.New("values is required")
		}
		patch.Values = map[string]json.RawMessage{}
		if err := json.Unmarshal(rawValues, &patch.Values); err != nil || patch.Values == nil {
			return nil, errors.New("values must be a record")
		}
		patches = append(patches, patch)
	}
	return patches, nil
}

// ── Digest identity ──

// harnessCanonicalJSON mirrors @chaste/harness canonicalJson: sorted keys, no
// whitespace, JS string escaping. It fails closed rather than substituting a
// "null" canonical form, because a wrong digest would still look like a verdict.
func harnessCanonicalJSON(value any) (string, error) {
	encoded, err := marshalJS(value)
	if err != nil {
		return "", err
	}
	if !json.Valid(encoded) {
		return "", errors.New("harness composition parts do not canonicalize")
	}
	return creatorCanonicalJSONFromRaw(encoded), nil
}

func harnessProfileDigest(profile harnessProfile) (string, error) {
	canonical, err := harnessCanonicalJSON(profile)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(digest[:]), nil
}

func harnessCompositionDigest(profile harnessProfile, bundles []harnessBundleManifest, patches []harnessConfigPatch) (string, error) {
	canonical, err := harnessCanonicalJSON(struct {
		Profile harnessProfile          `json:"profile"`
		Bundles []harnessBundleManifest `json:"bundles"`
		Patches []harnessConfigPatch    `json:"patches"`
	}{Profile: profile, Bundles: bundles, Patches: patches})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(digest[:]), nil
}

// harnessAssertPersistedIdentity mirrors assertPersistedIdentity. A row whose
// stored parts no longer re-hash to the persisted digests is treated as
// tampered, and the approval is refused before any digest comparison happens.
func harnessAssertPersistedIdentity(
	compositionID, storedProfileDigest, storedCompositionDigest string,
	profile json.RawMessage, bundles, patches json.RawMessage,
) error {
	parsedProfile, err := harnessParseProfile(profile)
	if err != nil {
		return err
	}
	parsedBundles, err := harnessParseBundles(bundles)
	if err != nil {
		return err
	}
	parsedPatches, err := harnessParsePatches(patches)
	if err != nil {
		return err
	}
	profileDigest, err := harnessProfileDigest(parsedProfile)
	if err != nil {
		return err
	}
	if profileDigest != storedProfileDigest {
		return fmt.Errorf("harness composition %s has an invalid profile digest", compositionID)
	}
	compositionDigest, err := harnessCompositionDigest(parsedProfile, parsedBundles, parsedPatches)
	if err != nil {
		return err
	}
	if compositionDigest != storedCompositionDigest {
		return fmt.Errorf("harness composition %s has an invalid composition digest", compositionID)
	}
	return nil
}

// harnessAssertApprovalIdentity is the exact-payload check between the digest
// the approver asked for and the digest the org actually owns.
func harnessAssertApprovalIdentity(storedCompositionDigest, requestedCompositionDigest string) error {
	if storedCompositionDigest != requestedCompositionDigest {
		return errors.New("harness composition identity no longer matches the approval request")
	}
	return nil
}

// ParseHarnessApproveCompositionInput mirrors harnessCompositionApprovalPayloadSchema.
func ParseHarnessApproveCompositionInput(raw json.RawMessage) (HarnessApproveCompositionInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return HarnessApproveCompositionInput{}, err
	}
	var input HarnessApproveCompositionInput
	if input.CompositionID, err = projectRequiredUUID(fields, "compositionId"); err != nil {
		return HarnessApproveCompositionInput{}, err
	}
	rawDigest, ok := fields["compositionDigest"]
	if !ok {
		return HarnessApproveCompositionInput{}, errors.New("compositionDigest is required")
	}
	if err := json.Unmarshal(rawDigest, &input.CompositionDigest); err != nil {
		return HarnessApproveCompositionInput{}, errors.New("compositionDigest must be a 64-character lowercase hex digest")
	}
	if !harnessDigestPattern.MatchString(input.CompositionDigest) {
		return HarnessApproveCompositionInput{}, errors.New("compositionDigest must be a 64-character lowercase hex digest")
	}
	return input, nil
}

func parseHarnessInput(capabilityID string, raw json.RawMessage) (any, error) {
	if capabilityID != harnessApproveCompositionCapabilityID {
		return nil, errors.New("unsupported harness capability")
	}
	return ParseHarnessApproveCompositionInput(raw)
}

// ── Handler ──

func harnessApproveComposition(ctx context.Context, tx pgx.Tx, orgID string, input HarnessApproveCompositionInput) (HarnessApproveCompositionOutput, error) {
	var compositionID, storedCompositionDigest, storedProfileDigest string
	var profile, bundles, patches []byte
	err := tx.QueryRow(ctx, `
		SELECT id::text, composition_digest, profile_digest, profile, bundles, patches
		FROM harness_compositions
		WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`,
		input.CompositionID, orgID).Scan(
		&compositionID, &storedCompositionDigest, &storedProfileDigest, &profile, &bundles, &patches)
	if errors.Is(err, pgx.ErrNoRows) {
		return HarnessApproveCompositionOutput{}, errors.New("harness composition not found for organization")
	}
	if err != nil {
		return HarnessApproveCompositionOutput{}, err
	}
	if err := harnessAssertPersistedIdentity(compositionID, storedProfileDigest, storedCompositionDigest, profile, bundles, patches); err != nil {
		return HarnessApproveCompositionOutput{}, err
	}
	if err := harnessAssertApprovalIdentity(storedCompositionDigest, input.CompositionDigest); err != nil {
		return HarnessApproveCompositionOutput{}, err
	}
	return HarnessApproveCompositionOutput{
		CompositionID:     compositionID,
		CompositionDigest: storedCompositionDigest,
		Status:            "approved",
	}, nil
}

// ── Registry wiring ──

func harnessCapabilitySpecEntries() map[string]capabilitySpec {
	return map[string]capabilitySpec{
		harnessApproveCompositionCapabilityID: {module: "harness", permission: "harness.approve", risk: "identity"},
	}
}

// RegisterHarnessCapabilities publishes the ported harness metadata to the
// executor registry. Safe to call more than once.
func RegisterHarnessCapabilities() {
	for capabilityID, spec := range harnessCapabilitySpecEntries() {
		capabilitySpecs[capabilityID] = spec
	}
}
