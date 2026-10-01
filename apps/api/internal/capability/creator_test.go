package capability

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

const creatorTestManifest = `{"formatVersion":1,"slug":"acme-warehouse","name":"Acme Warehouse Tools","version":"1.2.3","summary":"Extra warehouse capabilities from Acme: cycle counting and bin transfers.","capabilities":["acme.cycleCount","acme.binTransfer"],"risks":{"acme.cycleCount":"write","acme.binTransfer":"write"},"license":"Apache-2.0"}`

func TestCreatorCanonicalJSONMatchesJavaScriptJSONStringifyEscaping(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "less than greater than and ampersand remain literal",
			raw:  `{"value":"<>&"}`,
			want: `{"value":"<>&"}`,
		},
		{
			name: "line separators remain literal",
			raw:  `{"value":"\u2028\u2029"}`,
			want: "{\"value\":\"\u2028\u2029\"}",
		},
		{
			name: "literal unicode escape text stays escaped",
			raw:  `{"value":"\\u003c"}`,
			want: `{"value":"\\u003c"}`,
		},
		{
			name: "unicode escape for less than becomes literal less than",
			raw:  `{"value":"\u003c"}`,
			want: `{"value":"<"}`,
		},
		{
			name: "lone UTF-16 surrogate stays escaped",
			raw:  `"\ud800"`,
			want: `"\ud800"`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := creatorCanonicalJSONFromRaw([]byte(test.raw)); got != test.want {
				t.Errorf("creatorCanonicalJSONFromRaw(%s) = %q, want JavaScript JSON.stringify result %q", test.raw, got, test.want)
			}
		})
	}
}

func TestCreatorManifestDigestPreservesLoneSurrogateEscapes(t *testing.T) {
	raw := strings.Replace(creatorTestManifest, `"Acme Warehouse Tools"`, `"\ud800"`, 1)
	manifest, err := creatorValidateManifest(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	canonical := `{"capabilities":["acme.cycleCount","acme.binTransfer"],"formatVersion":1,"license":"Apache-2.0","name":"\ud800","risks":{"acme.binTransfer":"write","acme.cycleCount":"write"},"slug":"acme-warehouse","summary":"Extra warehouse capabilities from Acme: cycle counting and bin transfers.","version":"1.2.3"}`
	want := sha256.Sum256([]byte(canonical))
	got, err := creatorManifestDigestFromRaw(json.RawMessage(raw), manifest)
	if err != nil || got != hex.EncodeToString(want[:]) {
		t.Errorf("creatorManifestDigestFromRaw() = %q, %v; want JS canonical digest %x", got, err, want)
	}
}

func creatorTestPublisher(t *testing.T, manifest CreatorPluginManifest) (string, string) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := creatorManifestDigest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	digestBytes, err := hex.DecodeString(digest)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(privateKey, digestBytes)
	return base64.StdEncoding.EncodeToString(signature), base64.StdEncoding.EncodeToString(publicDER)
}

func TestCreatorManifestValidationMatchesPluginKitBoundaries(t *testing.T) {
	manifest, err := creatorValidateManifest(json.RawMessage(creatorTestManifest))
	if err != nil {
		t.Fatalf("creatorValidateManifest(valid) error = %v", err)
	}
	if manifest.License != "Apache-2.0" || len(manifest.Capabilities) != 2 {
		t.Fatalf("manifest = %+v, expected normalized license and capabilities", manifest)
	}
	for _, numericVersion := range []string{`1.0`, `1e0`} {
		raw := strings.Replace(creatorTestManifest, `"formatVersion":1`, `"formatVersion":`+numericVersion, 1)
		if _, err := creatorValidateManifest(json.RawMessage(raw)); err != nil {
			t.Errorf("formatVersion %s should parse as JavaScript number 1: %v", numericVersion, err)
		}
	}
	omittedLicense := strings.TrimSuffix(creatorTestManifest, `,"license":"Apache-2.0"}`) + "}"
	if parsed, err := creatorValidateManifest(json.RawMessage(omittedLicense)); err != nil || parsed.License != "Apache-2.0" {
		t.Errorf("omitted license = %q, %v; want default Apache-2.0", parsed.License, err)
	}
	emptyLicense := strings.TrimSuffix(creatorTestManifest, "}") + `,"license":""}`
	if parsed, err := creatorValidateManifest(json.RawMessage(emptyLicense)); err != nil || parsed.License != "" {
		t.Errorf("explicit empty license = %q, %v; want empty string preserved", parsed.License, err)
	}

	nameJSON, err := json.Marshal(strings.Repeat("😀", 60))
	if err != nil {
		t.Fatal(err)
	}
	summaryJSON, err := json.Marshal(strings.Repeat("😀", 250))
	if err != nil {
		t.Fatal(err)
	}
	utf16Boundaries := strings.Replace(creatorTestManifest, `"Acme Warehouse Tools"`, string(nameJSON), 1)
	utf16Boundaries = strings.Replace(utf16Boundaries, `"Extra warehouse capabilities from Acme: cycle counting and bin transfers."`, string(summaryJSON), 1)
	if _, err := creatorValidateManifest(json.RawMessage(utf16Boundaries)); err != nil {
		t.Errorf("manifest with 120 UTF-16-unit name and 500-unit summary was rejected: %v", err)
	}
	canonical := `{"capabilities":["acme.cycleCount","acme.binTransfer"],"formatVersion":1,"license":"Apache-2.0","name":"Acme Warehouse Tools","risks":{"acme.binTransfer":"write","acme.cycleCount":"write"},"slug":"acme-warehouse","summary":"Extra warehouse capabilities from Acme: cycle counting and bin transfers.","version":"1.2.3"}`
	wantDigest := sha256.Sum256([]byte(canonical))
	gotDigest, err := creatorManifestDigest(manifest)
	if err != nil || gotDigest != hex.EncodeToString(wantDigest[:]) {
		t.Errorf("creatorManifestDigest() = %q, %v; want PluginKit canonical digest %x", gotDigest, err, wantDigest)
	}

	withUnknownProperty := strings.TrimSuffix(creatorTestManifest, "}") + `,"unknown":"discarded"}`
	if _, err := creatorValidateManifest(json.RawMessage(withUnknownProperty)); err != nil {
		t.Errorf("manifest parser should strip unknown object properties like z.object(): %v", err)
	}
	for _, test := range []struct {
		name string
		url  string
	}{
		{"WHATWG host normalization without slashes", "http:example.com"},
		{"WHATWG host normalization with empty authority", "http:///example.com"},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := strings.TrimSuffix(creatorTestManifest, "}") + `,"homepage":` + string(mustJSON(t, test.url)) + "}"
			if _, err := creatorValidateManifest(json.RawMessage(raw)); err != nil {
				t.Errorf("creatorValidateManifest rejected WHATWG-valid URL %q: %v", test.url, err)
			}
		})
	}

	invalid := []struct {
		name string
		raw  string
	}{
		{"root must be object", `[]`},
		{"wrong format version", strings.Replace(creatorTestManifest, `"formatVersion":1`, `"formatVersion":2`, 1)},
		{"slug pattern", strings.Replace(creatorTestManifest, `"acme-warehouse"`, `"Acme Warehouse"`, 1)},
		{"version semver", strings.Replace(creatorTestManifest, `"1.2.3"`, `"1.2"`, 1)},
		{"homepage null", strings.TrimSuffix(creatorTestManifest, "}") + `,"homepage":null}`},
		{"homepage URL", strings.TrimSuffix(creatorTestManifest, "}") + `,"homepage":"not a URL"}`},
		{"homepage port out of range", strings.TrimSuffix(creatorTestManifest, "}") + `,"homepage":"https://example.com:99999"}`},
		{"license null", strings.Replace(creatorTestManifest, `"license":"Apache-2.0"`, `"license":null`, 1)},
		{"risks null", strings.Replace(creatorTestManifest, `"risks":{"acme.cycleCount":"write","acme.binTransfer":"write"}`, `"risks":null`, 1)},
		{"capability qualified", strings.Replace(creatorTestManifest, `"acme.cycleCount"`, `"cycleCount"`, 1)},
		{"risk enum", strings.Replace(creatorTestManifest, `"acme.binTransfer":"write"`, `"acme.binTransfer":"critical"`, 1)},
	}
	for _, test := range invalid {
		t.Run(test.name, func(t *testing.T) {
			if _, err := creatorValidateManifest(json.RawMessage(test.raw)); err == nil {
				t.Errorf("creatorValidateManifest accepted %s", test.raw)
			}
		})
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestCreatorVerifyPluginMatchesPluginKitSignatureAndConsistencyRules(t *testing.T) {
	var manifest CreatorPluginManifest
	if err := json.Unmarshal([]byte(creatorTestManifest), &manifest); err != nil {
		t.Fatal(err)
	}
	signature, publicKey := creatorTestPublisher(t, manifest)
	valid, reason, verified := creatorVerifyPlugin(json.RawMessage(creatorTestManifest), signature, publicKey)
	if !valid || reason != "" || verified.Slug != manifest.Slug {
		t.Fatalf("creatorVerifyPlugin(valid signature) = (%v, %q, %+v)", valid, reason, verified)
	}

	// Key order and insignificant JSON whitespace do not change the manifest digest.
	reordered := `{"license":"Apache-2.0", "risks":{"acme.binTransfer":"write", "acme.cycleCount":"write"}, "capabilities":["acme.cycleCount","acme.binTransfer"], "summary":"Extra warehouse capabilities from Acme: cycle counting and bin transfers.", "version":"1.2.3", "name":"Acme Warehouse Tools", "slug":"acme-warehouse", "formatVersion":1}`
	if valid, reason, _ = creatorVerifyPlugin(json.RawMessage(reordered), signature, publicKey); !valid {
		t.Errorf("reordered equivalent manifest rejected: %s", reason)
	}

	tampered := strings.Replace(creatorTestManifest, `"1.2.3"`, `"9.9.9"`, 1)
	if valid, reason, _ = creatorVerifyPlugin(json.RawMessage(tampered), signature, publicKey); valid || !strings.Contains(reason, "does not match") {
		t.Errorf("tampered manifest result = (%v, %q), want signature mismatch", valid, reason)
	}

	missingRisk := strings.Replace(creatorTestManifest, `,"acme.binTransfer":"write"`, "", 1)
	if valid, reason, _ = creatorVerifyPlugin(json.RawMessage(missingRisk), signature, publicKey); valid || !strings.Contains(reason, "no declared risk") {
		t.Errorf("missing risk result = (%v, %q), want undeclared-risk rejection", valid, reason)
	}

	extraRisk := strings.Replace(creatorTestManifest, `,"acme.binTransfer":"write"`, `,"acme.binTransfer":"write","acme.ghost":"read"`, 1)
	if valid, reason, _ = creatorVerifyPlugin(json.RawMessage(extraRisk), signature, publicKey); valid || !strings.Contains(reason, "not present") {
		t.Errorf("unknown risk capability result = (%v, %q), want consistency rejection", valid, reason)
	}
	for _, input := range []struct {
		name      string
		signature string
		publicKey string
	}{
		{"bad signature encoding", "!", publicKey},
		{"bad public key encoding", signature, "!"},
	} {
		t.Run(input.name, func(t *testing.T) {
			if valid, reason, _ := creatorVerifyPlugin(json.RawMessage(creatorTestManifest), input.signature, input.publicKey); valid || !strings.Contains(reason, "malformed") {
				t.Errorf("creatorVerifyPlugin() = (%v, %q), want malformed material rejection", valid, reason)
			}
		})
	}
}

func TestCreatorVerifyPluginAcceptsPluginKitGoldenSignature(t *testing.T) {
	manifest := json.RawMessage(`{"formatVersion":1,"slug":"acme-warehouse","name":"Acme <Warehouse> Tools & Supply","version":"1.2.3","summary":"Extra warehouse capabilities from Acme, including cycle counting and bin transfers.","capabilities":["acme.cycleCount","acme.binTransfer"],"risks":{"acme.cycleCount":"write","acme.binTransfer":"write"},"license":"Apache-2.0"}`)
	const signature = "+LmTqPWiFFIznuNvp1ctaYS4s17YIP7WF79zgRGFPKLusrcHvNhq/0UW6V6rGEZKzBgXeApkJFKX/mJ9eZP7Aw=="
	const publicKey = "MCowBQYDK2VwAyEA0wYsCm6LdxqS3KooXybscTlv78TDVrZqQ7HgFnWN1oE="

	valid, reason, _ := creatorVerifyPlugin(manifest, signature, publicKey)
	if !valid || reason != "" {
		t.Fatalf("creatorVerifyPlugin(PluginKit golden signature) = (%v, %q), want valid signature", valid, reason)
	}
}

func TestCreatorParsersRejectMalformedInputsAndStripUnknownFields(t *testing.T) {
	verifyRaw := `{"manifest":` + creatorTestManifest + `,"signatureBase64":"sig","publisherPublicKeyBase64":"key","unknown":true}`
	verify, err := ParseCreatorVerifyPluginInput(json.RawMessage(verifyRaw))
	if err != nil || string(verify.Manifest) != creatorTestManifest || verify.SignatureBase64 != "sig" || verify.PublisherPublicKeyBase64 != "key" {
		t.Fatalf("ParseCreatorVerifyPluginInput() = %+v, %v", verify, err)
	}
	for _, raw := range []string{
		`[]`, `null`, `{"manifest":` + creatorTestManifest,
		`{"signatureBase64":"s","publisherPublicKeyBase64":"k"}`,
		`{"manifest":{},"signatureBase64":4,"publisherPublicKeyBase64":"k"}`,
		`{"manifest":{},"signatureBase64":"s","publisherPublicKeyBase64":"k"} {}`,
	} {
		if _, err := ParseCreatorVerifyPluginInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreatorVerifyPluginInput accepted malformed input %s", raw)
		}
	}

	scaffoldRaw := `{"module":"warehouse","action":"cycleCount","title":"Cycle count adjustment","intent":"Record a cycle-count variance against stock with a reason and actor attribution","risk":"write","permission":"inventory.write","inputFields":[{"name":"sku","type":"string","description":"item SKU","unknown":"discarded"}],"unknown":"discarded"}`
	scaffold, err := ParseCreatorScaffoldInput(json.RawMessage(scaffoldRaw))
	if err != nil || !scaffold.SubmitAsProposal || len(scaffold.InputFields) != 1 || scaffold.InputFields[0].Description == nil || *scaffold.InputFields[0].Description != "item SKU" {
		t.Fatalf("ParseCreatorScaffoldInput() = %+v, %v", scaffold, err)
	}
	for _, raw := range []string{
		`[]`, `null`, `{"module":"warehouse","action":"cycleCount"}`,
		strings.Replace(scaffoldRaw, `"inputFields":[`, `"inputFields":null,"discardedFields":[`, 1),
		strings.Replace(scaffoldRaw, `"inputFields":[`, `"inputFields":null`, 1),
		strings.Replace(scaffoldRaw, `"description":"item SKU"`, `"description":null`, 1),
		strings.TrimSuffix(scaffoldRaw, `}`) + `,"submitAsProposal":null}`,
		strings.TrimSuffix(scaffoldRaw, `}`) + `,"gapTicketId":null}`,
		strings.Replace(scaffoldRaw, `"risk":"write"`, `"risk":"critical"`, 1),
		strings.Replace(scaffoldRaw, `"type":"string"`, `"type":"object"`, 1),
		strings.Replace(scaffoldRaw, `"submitAsProposal"`, `"submitAsProposal"`, 1)[:len(scaffoldRaw)-1] + `,"submitAsProposal":"yes"}`,
	} {
		if _, err := ParseCreatorScaffoldInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreatorScaffoldInput accepted malformed input %s", raw)
		}
	}

	withoutInputFields := strings.Replace(scaffoldRaw, `,"inputFields":[{"name":"sku","type":"string","description":"item SKU","unknown":"discarded"}]`, "", 1)
	defaultedScaffold, err := ParseCreatorScaffoldInput(json.RawMessage(withoutInputFields))
	if err != nil || defaultedScaffold.InputFields == nil || len(defaultedScaffold.InputFields) != 0 {
		t.Fatalf("omitted inputFields = %#v, %v; want a default empty array", defaultedScaffold.InputFields, err)
	}
	emptyFields, err := ParseCreatorScaffoldInput(json.RawMessage(strings.Replace(withoutInputFields, `"unknown":"discarded"`, `"inputFields":[],"unknown":"discarded"`, 1)))
	if err != nil {
		t.Fatalf("explicit empty inputFields parse: %v", err)
	}
	omittedHash, err := canonicalHash(defaultedScaffold)
	if err != nil {
		t.Fatal(err)
	}
	emptyHash, err := canonicalHash(emptyFields)
	if err != nil || omittedHash != emptyHash {
		t.Errorf("omitted and empty inputFields hashes = %q and %q, %v; want equal approval payload hashes", omittedHash, emptyHash, err)
	}
}

func TestCreatorInputStringLimitsCountUTF16Units(t *testing.T) {
	base := `{"module":"warehouse","action":"cycleCount","title":"Cycle count adjustment","intent":"Record a cycle-count variance against stock with a reason and actor attribution","risk":"write","permission":"inventory.write"}`
	acceptedDescription := strings.TrimSuffix(base, `}`) + `,"inputFields":[{"name":"sku","type":"string","description":` + string(mustJSON(t, strings.Repeat("😀", 100))) + `}]}`
	if _, err := ParseCreatorScaffoldInput(json.RawMessage(acceptedDescription)); err != nil {
		t.Errorf("200 UTF-16-unit description was rejected: %v", err)
	}
	rejectedDescription := strings.TrimSuffix(base, `}`) + `,"inputFields":[{"name":"sku","type":"string","description":` + string(mustJSON(t, strings.Repeat("😀", 101))) + `}]}`
	if _, err := ParseCreatorScaffoldInput(json.RawMessage(rejectedDescription)); err == nil {
		t.Error("201 UTF-16-unit description was accepted")
	}
	proposal := `{"title":"A valid proposal title","summary":"A sufficiently long proposal summary","diffText":"A sufficiently long unified diff","riskAssessment":"A sufficiently long risk assessment","testEvidence":` + string(mustJSON(t, strings.Repeat("😀", 10_000))) + `}`
	if _, err := ParseCreatorSubmitProposalInput(json.RawMessage(proposal)); err != nil {
		t.Errorf("20,000 UTF-16-unit testEvidence was rejected: %v", err)
	}
	tooLongEvidence := strings.TrimSuffix(proposal, `}`) + strings.Repeat("😀", 1) + `}`
	if _, err := ParseCreatorSubmitProposalInput(json.RawMessage(tooLongEvidence)); err == nil {
		t.Error("20,002 UTF-16-unit testEvidence was accepted")
	}
	for _, malformed := range []string{
		strings.Replace(proposal, `"testEvidence":`, `"testEvidence":null,"unused":`, 1),
		`{"title":"A valid proposal title","summary":"A sufficiently long proposal summary","diffText":"A sufficiently long unified diff","riskAssessment":"A sufficiently long risk assessment","gapTicketId":null}`,
	} {
		if _, err := ParseCreatorSubmitProposalInput(json.RawMessage(malformed)); err == nil {
			t.Errorf("optional Creator string accepted explicit null: %s", malformed)
		}
	}
}

func TestCreatorOptionalInputsRejectExplicitNull(t *testing.T) {
	for _, input := range []struct {
		name string
		raw  string
	}{
		{
			name: "proposal status",
			raw:  `{"status":null}`,
		},
		{
			name: "canary metrics",
			raw:  `{"releaseId":"00000000-0000-4000-8000-000000000001","gapTicketId":"00000000-0000-4000-8000-000000000002","candidateDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","verdict":"pass","evidenceRef":"evidence://canary-1","metrics":null}`,
		},
	} {
		t.Run(input.name, func(t *testing.T) {
			var err error
			switch input.name {
			case "proposal status":
				_, err = ParseCreatorListProposalsInput(json.RawMessage(input.raw))
			case "canary metrics":
				_, err = ParseCreatorRecordCanaryOutcomeInput(json.RawMessage(input.raw))
			}
			if err == nil {
				t.Errorf("parser accepted explicit null: %s", input.raw)
			}
		})
	}
}

func TestCreatorScaffoldRenderersMatchCreatorModuleContracts(t *testing.T) {
	description := `Customer's "preferred" warehouse`
	spec := CreatorScaffoldSpec{
		Module: "stock-room", Action: "cycleCount", Title: "Cycle count adjustment",
		Intent: "Record a cycle-count variance against stock with a reason and actor attribution",
		Risk:   "write", Permission: "inventory.write",
		InputFields: []CreatorScaffoldField{
			{Name: "sku", Type: "string", Description: &description},
			{Name: "countedThousandths", Type: "number"},
			{Name: "force", Type: "boolean"},
		},
	}
	source, err := creatorRenderCapabilitySource(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		`id: "stock-room.cycleCount"`,
		`registerStockRoomCapabilities(registry: CapabilityRegistry, deps: ModuleDeps)`,
		`sku: z.string().describe("Customer's \"preferred\" warehouse"),`,
		`countedThousandths: z.number(),`,
		`force: z.boolean(),`,
		`TODO(proposal): implement against deps.db within ctx.actor.orgId scope.`,
	} {
		if !strings.Contains(source, expected) {
			t.Errorf("renderCapabilitySource output missing %q:\n%s", expected, source)
		}
	}

	testSkeleton := creatorRenderTestSkeleton(spec)
	if !strings.Contains(testSkeleton, `describe("stock-room.cycleCount"`) || !strings.Contains(testSkeleton, `expect(true).toBe(true)`) {
		t.Errorf("renderTestSkeleton() = %q, missing generated capability contract skeleton", testSkeleton)
	}
	riskDoc := creatorRenderRiskDoc(spec)
	for _, expected := range []string{
		`# Risk assessment: stock-room.cycleCount`,
		`- Risk class: write`,
		`- Required permission: inventory.write`,
		`write-class: declare an inverse or justify the conformance warning in review.`,
		`- [ ] Org scoping on every query`,
	} {
		if !strings.Contains(riskDoc, expected) {
			t.Errorf("renderRiskDoc() missing %q:\n%s", expected, riskDoc)
		}
	}
	filePath := "modules/stock-room/src/cycleCount.ts"
	diff, err := creatorRenderProposalDiff(spec, filePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(diff, "--- /dev/null\n+++ b/"+filePath+"\n") || !strings.Contains(diff, "+  registry.register(cycleCount(deps));") {
		t.Errorf("renderProposalDiff() = %q, missing expected generated file and additions", diff)
	}
}
