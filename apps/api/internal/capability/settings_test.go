package capability

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const settingsManifestPath = "../../../../docs/migration/capabilities.json"

// settingsPlaintextCanary stands in for a provider API key. Every assertion in
// the leak tests below is only meaningful because this value really is sealed
// inside settingsCanaryCiphertext, which the test verifies by decrypting it.
const settingsPlaintextCanary = "nvapi-PLAINTEXT-CANARY-9f2b7c1d-must-never-be-logged"

// settingsCanaryCiphertext returns a v1 AES-GCM provider credential in the
// exact format apps/web/src/server/ai-secrets.ts produces.
func settingsCanaryCiphertext(t *testing.T) string {
	t.Helper()
	secret := "settings-test-encryption-secret"
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", secret)
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, iv, []byte(settingsPlaintextCanary), nil)
	ciphertext, tag := sealed[:len(sealed)-gcm.Overhead()], sealed[len(sealed)-gcm.Overhead():]
	return "v1:" +
		base64.RawURLEncoding.EncodeToString(iv) + ":" +
		base64.RawURLEncoding.EncodeToString(tag) + ":" +
		base64.RawURLEncoding.EncodeToString(ciphertext)
}

func settingsCanaryConfig(ciphertext string) string {
	return `{"provider":"nvidia","baseUrl":"https://integrate.api.nvidia.com/v1",` +
		`"models":{"primary":"moonshotai/kimi-k2.6","fast":"meta/muse-glimmer-30b",` +
		`"reasoning":"nvidia/nemotron-3-ultra-550b-a55b","embeddings":"nvidia/nv-embedqa-e5-v5"},` +
		`"encryptedApiKey":` + jsonString(ciphertext) + `,"keyHint":"••••cdef",` +
		`"updatedAt":"2026-01-01T00:00:00.000Z"}`
}

func jsonString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

// ── Manifest helpers shared with harness_test.go ──

func readMigrationManifest(t *testing.T, capabilityID string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(settingsManifestPath)
	if err != nil {
		t.Fatalf("read migration manifest: %v", err)
	}
	var manifest struct {
		Capabilities []map[string]any `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("decode migration manifest: %v", err)
	}
	for _, entry := range manifest.Capabilities {
		if entry["id"] == capabilityID {
			return entry
		}
	}
	t.Fatalf("migration manifest has no %s entry", capabilityID)
	return nil
}

func manifestStringList(t *testing.T, value any) []string {
	t.Helper()
	items, ok := value.([]any)
	if !ok {
		t.Fatalf("expected a JSON array, got %T", value)
	}
	list := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			t.Fatalf("expected a JSON string, got %T", item)
		}
		list = append(list, text)
	}
	return list
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// assertManifestOutput marshals a capability output and checks it against the
// manifest outputSchema: every required key present, no undeclared keys.
func assertManifestOutput(t *testing.T, capabilityID string, value any) []byte {
	t.Helper()
	schema, _ := readMigrationManifest(t, capabilityID)["outputSchema"].(map[string]any)
	if schema == nil {
		t.Fatalf("%s has no outputSchema in the migration manifest", capabilityID)
	}
	encoded, err := marshalJS(value)
	if err != nil {
		t.Fatalf("marshal %s output: %v", capabilityID, err)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &object); err != nil {
		t.Fatalf("decode %s output %s: %v", capabilityID, encoded, err)
	}
	if additional, ok := schema["additionalProperties"].(bool); !ok || additional {
		t.Fatalf("%s outputSchema must set additionalProperties:false", capabilityID)
	}
	required := manifestStringList(t, schema["required"])
	for _, key := range required {
		if _, present := object[key]; !present {
			t.Errorf("%s output %s is missing required key %q", capabilityID, encoded, key)
		}
	}
	for key := range object {
		if !containsString(required, key) {
			t.Errorf("%s output %s has undeclared key %q", capabilityID, encoded, key)
		}
	}
	return encoded
}

// ── Contract ──

func TestSettingsAiProviderCapabilityContract(t *testing.T) {
	if settingsConfigureAiProviderCapabilityID != "settings.configureAiProvider" {
		t.Errorf("configure capability id = %q", settingsConfigureAiProviderCapabilityID)
	}
	if settingsRestoreAiProviderCapabilityID != "settings.restoreAiProvider" {
		t.Errorf("restore capability id = %q", settingsRestoreAiProviderCapabilityID)
	}
	specs := settingsCapabilitySpecEntries()
	for capabilityID, wantInverse := range map[string]string{
		settingsConfigureAiProviderCapabilityID: settingsRestoreAiProviderCapabilityID,
		settingsRestoreAiProviderCapabilityID:   settingsConfigureAiProviderCapabilityID,
	} {
		spec, present := specs[capabilityID]
		if !present {
			t.Fatalf("%s is missing from the settings capability specs", capabilityID)
		}
		if spec.module != "settings" || spec.permission != "iam.admin" || spec.risk != "secret" {
			t.Errorf("%s spec=%+v, want settings module, iam.admin permission, secret risk", capabilityID, spec)
		}
		if spec.moneyThresholdMinor != 0 {
			t.Errorf("%s moneyThresholdMinor = %d, want 0", capabilityID, spec.moneyThresholdMinor)
		}
		if spec.inverseCapabilityID != wantInverse {
			t.Errorf("%s inverse = %q, want %q", capabilityID, spec.inverseCapabilityID, wantInverse)
		}
		entry := readMigrationManifest(t, capabilityID)
		if entry["module"] != spec.module || entry["permission"] != spec.permission || entry["risk"] != spec.risk {
			t.Errorf("%s spec=%+v disagrees with the migration manifest entry %v", capabilityID, spec, entry)
		}
		if entry["inverseCapabilityId"] != spec.inverseCapabilityID {
			t.Errorf("%s inverse=%q, manifest says %v", capabilityID, spec.inverseCapabilityID, entry["inverseCapabilityId"])
		}
	}
	if _, err := parseSettingsInput("settings.unknown", json.RawMessage(`{}`)); err == nil {
		t.Error("parseSettingsInput accepted an unknown settings capability")
	}
}

// ── Input parser parity with the TypeScript Zod schemas ──

func TestSettingsConfigureAiProviderInputParserParity(t *testing.T) {
	valid := settingsCanaryConfig("opaque-credential")
	models := `"models":{"primary":"a","fast":"b","reasoning":"c","embeddings":"d"}`
	accepted := map[string]json.RawMessage{
		"config object":       json.RawMessage(`{"config":` + valid + `}`),
		"unknown sibling key": json.RawMessage(`{"config":` + valid + `,"force":true}`),
		"empty key hint":      json.RawMessage(`{"config":{"provider":"custom","baseUrl":"https://models.example/v1",` + models + `,"encryptedApiKey":null,"keyHint":"","updatedAt":"2026-01-01T00:00:00Z"}}`),
		"opaque credential":   json.RawMessage(`{"config":{"provider":"openai","baseUrl":"https://api.openai.com/v1",` + models + `,"encryptedApiKey":"not-an-aes-ciphertext","keyHint":null,"updatedAt":"2026-01-01T00:00:00.123456Z"}}`),
		"non-http url scheme": json.RawMessage(`{"config":{"provider":"custom","baseUrl":"ftp://models.example/v1",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00Z"}}`),
		"leap day timestamp":  json.RawMessage(`{"config":{"provider":"groq","baseUrl":"https://api.groq.com/openai/v1",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2024-02-29T23:59:59.999Z"}}`),
	}
	for name, raw := range accepted {
		parsed, err := ParseSettingsConfigureAiProviderInput(raw)
		if err != nil {
			t.Errorf("parse %s: %v", name, err)
			continue
		}
		if _, err := ParseSettingsRestoreAiProviderInput(raw); err != nil {
			t.Errorf("restore parser rejected %s: %v", name, err)
		}
		if parsed.Config == nil {
			t.Errorf("parse %s returned no config", name)
		}
	}
	// A null config is the clear-the-credential path, not a missing field.
	cleared, err := ParseSettingsConfigureAiProviderInput(json.RawMessage(`{"config":null}`))
	if err != nil {
		t.Errorf("parse null config: %v", err)
	}
	if cleared.Config != nil {
		t.Errorf("null config parsed as %+v, want nil", cleared.Config)
	}
	trimmed, err := ParseSettingsConfigureAiProviderInput(json.RawMessage(`{"config":{"provider":"zai","baseUrl":"https://api.z.ai/api/paas/v4",` +
		`"models":{"primary":"  spaced  ","fast":"\tb\t","reasoning":"c","embeddings":"d","surprise":1},` +
		`"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00.000Z","surprise":1}}`))
	if err != nil {
		t.Fatalf("parse the model-trimming fixture: %v", err)
	}
	if trimmed.Config == nil {
		t.Fatal("expected a trimmed config")
	}
	if trimmed.Config.Models.Primary != "spaced" || trimmed.Config.Models.Fast != "b" {
		t.Errorf("models = %+v, want JS-trimmed values and no unknown keys", trimmed.Config.Models)
	}

	rejected := map[string]json.RawMessage{
		"missing config":        json.RawMessage(`{}`),
		"array input":           json.RawMessage(`[]`),
		"scalar input":          json.RawMessage(`7`),
		"malformed json":        json.RawMessage(`{"config":`),
		"trailing data":         json.RawMessage(`{"config":null} {"config":null}`),
		"config not an object":  json.RawMessage(`{"config":"nvidia"}`),
		"config not nullable":   json.RawMessage(`{"config":7}`),
		"unknown provider":      json.RawMessage(`{"config":{"provider":"anthropic","baseUrl":"https://api.anthropic.com/v1",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"provider wrong type":   json.RawMessage(`{"config":{"provider":1,"baseUrl":"https://a.example","models":{"primary":"a","fast":"b","reasoning":"c","embeddings":"d"},"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"missing provider":      json.RawMessage(`{"config":{"baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"empty base url":        json.RawMessage(`{"config":{"provider":"custom","baseUrl":"",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"relative base url":     json.RawMessage(`{"config":{"provider":"custom","baseUrl":"/v1",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"schemeless base url":   json.RawMessage(`{"config":{"provider":"custom","baseUrl":"models.example",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"hostless base url":     json.RawMessage(`{"config":{"provider":"custom","baseUrl":"http://",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"oversized base url":    json.RawMessage(`{"config":{"provider":"custom","baseUrl":"https://a.example/` + strings.Repeat("p", 490) + `",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"missing models":        json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"models not an object":  json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","models":[],"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"missing model role":    json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","models":{"primary":"a","fast":"b","reasoning":"c"},"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"blank model role":      json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","models":{"primary":"   ","fast":"b","reasoning":"c","embeddings":"d"},"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"oversized model role":  json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","models":{"primary":"` + strings.Repeat("m", 201) + `","fast":"b","reasoning":"c","embeddings":"d"},"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"model role not string": json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","models":{"primary":1,"fast":"b","reasoning":"c","embeddings":"d"},"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"missing credential":    json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"empty credential":      json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":"","keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"oversized credential":  json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","models":{"primary":"a","fast":"b","reasoning":"c","embeddings":"d"},"encryptedApiKey":"` + strings.Repeat("k", 2001) + `","keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"missing key hint":      json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"oversized key hint":    json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"keyHint":"1234567890123","updatedAt":"2026-01-01T00:00:00Z"}}`),
		"missing updated at":    json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"keyHint":null}}`),
		"offset timestamp":      json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00+02:00"}}`),
		"lowercase z timestamp": json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00z"}}`),
		"date only timestamp":   json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01"}}`),
		"impossible date":       json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-02-30T00:00:00Z"}}`),
		"non leap february":     json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2023-02-29T00:00:00Z"}}`),
		"hour out of range":     json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T24:00:00Z"}}`),
		"empty fraction":        json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example",` + models + `,"encryptedApiKey":null,"keyHint":null,"updatedAt":"2026-01-01T00:00:00.Z"}}`),
	}
	for name, raw := range rejected {
		if _, err := ParseSettingsConfigureAiProviderInput(raw); err == nil {
			t.Errorf("configure parser accepted %s: %s", name, raw)
		}
		if _, err := ParseSettingsRestoreAiProviderInput(raw); err == nil {
			t.Errorf("restore parser accepted %s: %s", name, raw)
		}
	}
}

// ── Output shape ──

func TestSettingsAIProviderOutputMatchesManifest(t *testing.T) {
	config, err := settingsParseStoredConfig(json.RawMessage(settingsCanaryConfig("v1:aaaa:bbbb:cccc")))
	if err != nil {
		t.Fatal(err)
	}
	for _, capabilityID := range []string{settingsConfigureAiProviderCapabilityID, settingsRestoreAiProviderCapabilityID} {
		encoded := assertManifestOutput(t, capabilityID, SettingsAIProviderOutput{Previous: config, Current: config})
		var decoded struct {
			Previous *SettingsAIProviderConfig `json:"previous"`
			Current  *SettingsAIProviderConfig `json:"current"`
		}
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.Previous == nil || decoded.Current == nil {
			t.Fatalf("%s output lost a config: %s", capabilityID, encoded)
		}
	}
	cleared := assertManifestOutput(t, settingsConfigureAiProviderCapabilityID, SettingsAIProviderOutput{})
	if !bytes.Contains(cleared, []byte(`"previous":null`)) || !bytes.Contains(cleared, []byte(`"current":null`)) {
		t.Errorf("cleared output %s must keep both keys present and null", cleared)
	}
	stored := assertManifestOutput(t, settingsConfigureAiProviderCapabilityID, SettingsAIProviderOutput{Current: config})
	if !bytes.Contains(stored, []byte(`"previous":null`)) {
		t.Errorf("output %s must keep a null previous key", stored)
	}
}

// ── No secret leakage ──

func TestSettingsAiProviderNeverExposesThePlaintextCredential(t *testing.T) {
	ciphertext := settingsCanaryCiphertext(t)
	if !strings.Contains(settingsDecryptCanary(t, ciphertext), settingsPlaintextCanary) {
		t.Fatal("test setup: the canary is not actually sealed in the ciphertext")
	}
	config, err := settingsParseStoredConfig(json.RawMessage(settingsCanaryConfig(ciphertext)))
	if err != nil {
		t.Fatal(err)
	}
	if config.EncryptedAPIKey == nil || *config.EncryptedAPIKey != ciphertext {
		t.Fatalf("parsed credential = %v, want the opaque ciphertext", config.EncryptedAPIKey)
	}

	// The executor writes {"input": <parsed input>} into the audit ledger and
	// into approvals.payload, so the input encoding is the audit payload shape.
	input, err := ParseSettingsConfigureAiProviderInput(json.RawMessage(`{"config":` + settingsCanaryConfig(ciphertext) + `}`))
	if err != nil {
		t.Fatal(err)
	}
	auditPayload, err := marshalJS(struct {
		Input any `json:"input"`
	}{Input: input})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(auditPayload, []byte(settingsPlaintextCanary)) {
		t.Errorf("audit payload leaks the plaintext credential: %s", auditPayload)
	}
	if !bytes.Contains(auditPayload, []byte(ciphertext)) {
		t.Errorf("audit payload should carry the contract ciphertext: %s", auditPayload)
	}

	for _, capabilityID := range []string{settingsConfigureAiProviderCapabilityID, settingsRestoreAiProviderCapabilityID} {
		output := assertManifestOutput(t, capabilityID, SettingsAIProviderOutput{Previous: config, Current: config})
		if bytes.Contains(output, []byte(settingsPlaintextCanary)) {
			t.Errorf("%s output leaks the plaintext credential: %s", capabilityID, output)
		}
		for _, forbidden := range []string{"apiKey", "plaintext", "secretValue", "NVIDIA_API_KEY"} {
			if bytes.Contains(bytes.ToLower(output), []byte(strings.ToLower(jsonString(forbidden)))) {
				t.Errorf("%s output exposes a raw credential field: %s", capabilityID, output)
			}
		}
	}

	// No rejection path may echo credential material back to the caller.
	leaky := map[string]json.RawMessage{
		"bad provider":     json.RawMessage(`{"config":{"provider":"nope","baseUrl":"https://a.example","models":{"primary":"a","fast":"b","reasoning":"c","embeddings":"d"},"encryptedApiKey":` + jsonString(ciphertext) + `,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"bad base url":     json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"not a url","models":{"primary":"a","fast":"b","reasoning":"c","embeddings":"d"},"encryptedApiKey":` + jsonString(ciphertext) + `,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"bad models":       json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","models":{"primary":"` + settingsPlaintextCanary + `"},"encryptedApiKey":` + jsonString(ciphertext) + `,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
		"oversized hint":   json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","models":{"primary":"a","fast":"b","reasoning":"c","embeddings":"d"},"encryptedApiKey":` + jsonString(ciphertext) + `,"keyHint":"` + settingsPlaintextCanary + `","updatedAt":"2026-01-01T00:00:00Z"}}`),
		"bad timestamp":    json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","models":{"primary":"a","fast":"b","reasoning":"c","embeddings":"d"},"encryptedApiKey":` + jsonString(ciphertext) + `,"keyHint":null,"updatedAt":"` + settingsPlaintextCanary + `"}}`),
		"credential value": json.RawMessage(`{"config":{"provider":"nvidia","baseUrl":"https://a.example","models":{"primary":"a","fast":"b","reasoning":"c","embeddings":"d"},"encryptedApiKey":123,"keyHint":null,"updatedAt":"2026-01-01T00:00:00Z"}}`),
	}
	for name, raw := range leaky {
		_, err := ParseSettingsConfigureAiProviderInput(raw)
		if err == nil {
			t.Errorf("expected %s to be rejected", name)
			continue
		}
		if strings.Contains(err.Error(), settingsPlaintextCanary) || strings.Contains(err.Error(), ciphertext) {
			t.Errorf("%s error echoes credential material: %v", name, err)
		}
	}
}

// settingsDecryptCanary mirrors internal/jobs.decryptProviderKey so the test
// can prove the canary really is recoverable from the ciphertext it inspects.
func settingsDecryptCanary(t *testing.T, ciphertext string) string {
	t.Helper()
	parts := strings.Split(ciphertext, ":")
	if len(parts) != 4 {
		t.Fatalf("ciphertext has %d parts", len(parts))
	}
	iv, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		t.Fatal(err)
	}
	key := sha256.Sum256([]byte(os.Getenv("AI_CONFIG_ENCRYPTION_KEY")))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := gcm.Open(nil, iv, append(sealed, tag...), nil)
	if err != nil {
		t.Fatal(err)
	}
	return string(plain)
}

// ── Persistence, org scoping and stored-row validation ──

func TestGoSettingsConfigureAndRestoreRoundTrip(t *testing.T) {
	fx := newExecutorFixture(t)
	ciphertext := settingsCanaryCiphertext(t)
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET settings='{}'::jsonb WHERE id = ANY($1::uuid[])`, []string{fx.orgID, fx.otherOrgID}); err != nil {
			t.Errorf("reset settings fixture rows: %v", err)
		}
	})
	// A sibling setting must survive the read-modify-write.
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET settings='{"branding":{"layout":"modern"}}'::jsonb WHERE id=$1::uuid`, fx.orgID); err != nil {
		t.Fatal(err)
	}
	parsedInput, err := ParseSettingsConfigureAiProviderInput(json.RawMessage(`{"config":` + settingsCanaryConfig(ciphertext) + `}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SettingsAIProviderOutput, error) {
		return settingsConfigureAiProvider(fx.ctx, tx, fx.orgID, parsedInput)
	})
	if err != nil {
		t.Fatalf("configure: %v", err)
	}
	var stored, sibling string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT settings->'ai'->>'encryptedApiKey', settings->'branding'->>'layout' FROM organizations WHERE id=$1::uuid`, fx.orgID).Scan(&stored, &sibling); err != nil {
		t.Fatal(err)
	}
	if stored != ciphertext {
		t.Errorf("stored credential = %q, want the ciphertext", stored)
	}
	if sibling != "modern" {
		t.Errorf("sibling setting = %q, want it preserved", sibling)
	}

	restoreInput := SettingsRestoreAiProviderInput{}
	restored, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SettingsAIProviderOutput, error) {
		return settingsRestoreAiProvider(fx.ctx, tx, fx.orgID, restoreInput)
	})
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.Previous == nil || restored.Previous.EncryptedAPIKey == nil || *restored.Previous.EncryptedAPIKey != ciphertext {
		t.Errorf("restore previous = %+v, want the configured snapshot", restored.Previous)
	}
	if restored.Current != nil {
		t.Errorf("restore current = %+v, want nil", restored.Current)
	}
	if bytes.Contains([]byte(mustMarshal(t, restored)), []byte(settingsPlaintextCanary)) {
		t.Error("restore output leaks the plaintext credential")
	}
	var cleared bool
	if err := fx.owner.QueryRow(fx.ctx, `SELECT settings->>'ai' IS NULL FROM organizations WHERE id=$1::uuid`, fx.orgID).Scan(&cleared); err != nil {
		t.Fatal(err)
	}
	if !cleared {
		t.Error("restore to null left settings->ai in place")
	}

	// Cross-tenant: the other org's snapshot is invisible from this org.
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET settings=$2::jsonb WHERE id=$1::uuid`, fx.otherOrgID, `{"ai":`+settingsCanaryConfig("other-org-ciphertext")+`}`); err != nil {
		t.Fatal(err)
	}
	seen, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (*SettingsAIProviderConfig, error) {
		return settingsStoredConfig(fx.ctx, tx, fx.orgID)
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen != nil {
		t.Errorf("org %s read another org's credential: %+v", fx.orgID, seen)
	}
}

func TestGoSettingsRefusesMalformedStoredConfiguration(t *testing.T) {
	fx := newExecutorFixture(t)
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET settings='{}'::jsonb WHERE id=$1::uuid`, fx.orgID); err != nil {
			t.Errorf("reset settings fixture row: %v", err)
		}
	})
	// A stored credential that is not the shape the schema requires must block
	// the write instead of being silently overwritten.
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE organizations SET settings=$2::jsonb WHERE id=$1::uuid`, fx.orgID, `{"ai":{"provider":"nvidia"}}`); err != nil {
		t.Fatal(err)
	}
	parsedInput, err := ParseSettingsConfigureAiProviderInput(json.RawMessage(`{"config":` + settingsCanaryConfig("opaque") + `}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SettingsAIProviderOutput, error) {
		return settingsConfigureAiProvider(fx.ctx, tx, fx.orgID, parsedInput)
	})
	if err == nil {
		t.Fatal("expected the malformed stored configuration to block the write")
	}
	if strings.Contains(err.Error(), "opaque") {
		t.Errorf("error echoes stored credential material: %v", err)
	}
	var provider string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT settings->'ai'->>'provider' FROM organizations WHERE id=$1::uuid`, fx.orgID).Scan(&provider); err != nil {
		t.Fatal(err)
	}
	if provider != "nvidia" {
		t.Errorf("stored provider = %q, want the malformed row left untouched", provider)
	}
}

func mustMarshal(t *testing.T, value any) string {
	t.Helper()
	encoded, err := marshalJS(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
