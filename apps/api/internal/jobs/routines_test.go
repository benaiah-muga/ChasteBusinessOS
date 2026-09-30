package jobs

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRoutineToolsMatchLegacyReadOnlyPermissionBundle(t *testing.T) {
	tools, _, err := routineToolSet()
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) == 0 {
		t.Fatal("routine tool registry is empty")
	}
	for _, tool := range tools {
		switch tool.Permission {
		case "accounting.read", "analytics.report", "crm.read", "documents.read", "hr.read", "inventory.read", "manufacturing.read", "messaging.read", "messaging.write", "purchasing.read", "routines.read", "support.read":
		default:
			t.Errorf("routine tool %s exposes permission %q outside the legacy routine bundle", tool.Capability, tool.Permission)
		}
	}
	for _, denied := range []string{"crm.createCustomer", "iam.setModules", "accounting.recordPayment", "routines.runNow"} {
		for _, tool := range tools {
			if tool.Capability == denied {
				t.Errorf("routine tool set contains write capability %s", denied)
			}
		}
	}
}

func TestRoutineToolSchemasDescribeRequiredInputs(t *testing.T) {
	tools, _, err := routineToolSet()
	if err != nil {
		t.Fatal(err)
	}
	for _, capabilityID := range []string{"support.readConversation", "support.searchKnowledge", "documents.listDocVersions"} {
		var found *routineTool
		for index := range tools {
			if tools[index].Capability == capabilityID {
				found = &tools[index]
				break
			}
		}
		if found == nil {
			t.Fatalf("missing routine tool %s", capabilityID)
		}
		required, ok := found.Schema["required"].([]string)
		if !ok || len(required) != 1 {
			t.Fatalf("schema for %s has no required parameter list: %#v", capabilityID, found.Schema)
		}
		properties, ok := found.Schema["properties"].(map[string]any)
		if !ok || properties[required[0]] == nil {
			t.Fatalf("schema for %s omits required field %q: %#v", capabilityID, required[0], found.Schema)
		}
	}
	var customers *routineTool
	for index := range tools {
		if tools[index].Capability == "crm.listCustomers" {
			customers = &tools[index]
		}
	}
	if customers == nil {
		t.Fatal("customer search capability is missing")
	}
	properties := customers.Schema["properties"].(map[string]any)
	query := properties["query"].(map[string]any)
	if query["type"] != "string" {
		t.Fatalf("customer query schema=%#v", query)
	}
	var tasks *routineTool
	for index := range tools {
		if tools[index].Capability == "crm.listTasks" {
			tasks = &tools[index]
		}
	}
	if tasks == nil || tasks.Name != "crm_listTasks" || tasks.Permission != "crm.read" {
		t.Fatalf("CRM task list tool=%+v, want crm_listTasks with crm.read", tasks)
	}
	taskProperties, ok := tasks.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("CRM task list schema has no properties: %#v", tasks.Schema)
	}
	openOnly, ok := taskProperties["openOnly"].(map[string]any)
	if !ok || openOnly["type"] != "boolean" {
		t.Fatalf("CRM task list openOnly schema=%#v", taskProperties["openOnly"])
	}
	if _, required := tasks.Schema["required"]; required {
		t.Fatalf("CRM task list openOnly filter should remain optional: %#v", tasks.Schema)
	}
	var stockReport *routineTool
	for index := range tools {
		if tools[index].Capability == "inventory.stockReport" {
			stockReport = &tools[index]
		}
	}
	if stockReport == nil || stockReport.Permission != "inventory.read" {
		t.Fatalf("inventory stock report tool=%+v, want inventory.read", stockReport)
	}
	stockProperties, ok := stockReport.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("inventory stock report schema has no properties: %#v", stockReport.Schema)
	}
	belowReorder, ok := stockProperties["belowReorderOnly"].(map[string]any)
	if !ok || belowReorder["type"] != "boolean" {
		t.Fatalf("inventory stock report filter schema=%#v", stockProperties["belowReorderOnly"])
	}
	if _, required := stockReport.Schema["required"]; required {
		t.Fatalf("inventory stock report filter should remain optional: %#v", stockReport.Schema)
	}
	var locations *routineTool
	for index := range tools {
		if tools[index].Capability == "inventory.listLocations" {
			locations = &tools[index]
			break
		}
	}
	if locations == nil || locations.Name != "inventory_listLocations" || locations.Permission != "inventory.read" {
		t.Fatalf("inventory location list tool=%+v, want inventory_listLocations with inventory.read", locations)
	}
	if locations.Schema["type"] != "object" || locations.Schema["additionalProperties"] != false {
		t.Fatalf("inventory location list schema must be an input-free object: %#v", locations.Schema)
	}
	if properties, ok := locations.Schema["properties"].(map[string]any); !ok || len(properties) != 0 {
		t.Fatalf("inventory location list schema should have no properties: %#v", locations.Schema)
	}
	if _, required := locations.Schema["required"]; required {
		t.Fatalf("inventory location list schema should not require input fields: %#v", locations.Schema)
	}
	var documents *routineTool
	for index := range tools {
		if tools[index].Capability == "documents.listDocs" {
			documents = &tools[index]
			break
		}
	}
	if documents == nil || documents.Name != "documents_listDocs" || documents.Permission != "documents.read" {
		t.Fatalf("document list tool=%+v, want documents_listDocs with documents.read", documents)
	}
	if documents.Schema["type"] != "object" || documents.Schema["additionalProperties"] != false {
		t.Fatalf("document list schema must be an input-free object: %#v", documents.Schema)
	}
	if properties, ok := documents.Schema["properties"].(map[string]any); !ok || len(properties) != 0 {
		t.Fatalf("document list schema should have no properties: %#v", documents.Schema)
	}
	if _, required := documents.Schema["required"]; required {
		t.Fatalf("document list schema should not require input fields: %#v", documents.Schema)
	}
	var documentVersions *routineTool
	for index := range tools {
		if tools[index].Capability == "documents.listDocVersions" {
			documentVersions = &tools[index]
			break
		}
	}
	if documentVersions == nil || documentVersions.Name != "documents_listDocVersions" || documentVersions.Permission != "documents.read" {
		t.Fatalf("document version list tool=%+v, want documents_listDocVersions with documents.read", documentVersions)
	}
	versionProperties, ok := documentVersions.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("document version list schema has no properties: %#v", documentVersions.Schema)
	}
	documentID, ok := versionProperties["documentId"].(map[string]any)
	if !ok || documentID["type"] != "string" || documentID["format"] != "uuid" {
		t.Fatalf("document version list documentId schema=%#v", versionProperties["documentId"])
	}
	versionRequired, ok := documentVersions.Schema["required"].([]string)
	if !ok || len(versionRequired) != 1 || versionRequired[0] != "documentId" {
		t.Fatalf("document version list required fields=%#v, want documentId", documentVersions.Schema["required"])
	}
	var documentVersion *routineTool
	for index := range tools {
		if tools[index].Capability == "documents.getDocVersion" {
			documentVersion = &tools[index]
			break
		}
	}
	if documentVersion == nil || documentVersion.Name != "documents_getDocVersion" || documentVersion.Permission != "documents.read" {
		t.Fatalf("document version detail tool=%+v, want documents_getDocVersion with documents.read", documentVersion)
	}
	detailProperties, ok := documentVersion.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("document version detail schema has no properties: %#v", documentVersion.Schema)
	}
	detailDocumentID, ok := detailProperties["documentId"].(map[string]any)
	if !ok || detailDocumentID["type"] != "string" || detailDocumentID["format"] != "uuid" {
		t.Fatalf("document version detail documentId schema=%#v", detailProperties["documentId"])
	}
	detailVersion, ok := detailProperties["version"].(map[string]any)
	if !ok || detailVersion["type"] != "integer" || detailVersion["minimum"] != 1 {
		t.Fatalf("document version detail version schema=%#v", detailProperties["version"])
	}
	detailRequired, ok := documentVersion.Schema["required"].([]string)
	if !ok || len(detailRequired) != 2 || detailRequired[0] != "documentId" || detailRequired[1] != "version" {
		t.Fatalf("document version detail required fields=%#v, want documentId and version", documentVersion.Schema["required"])
	}
}

func TestRoutineIntentIsDeterministicUUID(t *testing.T) {
	first := routineIntent("00000000-0000-4000-8000-000000000001", 2, 1, "call-1")
	if first != routineIntent("00000000-0000-4000-8000-000000000001", 2, 1, "call-1") || !routineUUID(first) {
		t.Fatalf("routine intent is not stable UUID: %q", first)
	}
	if first == routineIntent("00000000-0000-4000-8000-000000000001", 2, 2, "call-1") {
		t.Fatal("different routine tool calls shared one capability intent")
	}
}

func TestDecryptProviderKeyMatchesTypeScriptEnvelope(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "routine-test-secret")
	plain := "provider-key-value"
	key := sha256.Sum256([]byte("routine-test-secret"))
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
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	value := "v1:" + base64.RawURLEncoding.EncodeToString(iv) + ":" + base64.RawURLEncoding.EncodeToString(sealed[len(sealed)-gcm.Overhead():]) + ":" + base64.RawURLEncoding.EncodeToString(sealed[:len(sealed)-gcm.Overhead()])
	got, err := decryptProviderKey(value)
	if err != nil || got != plain {
		t.Fatalf("decrypted key=%q err=%v", got, err)
	}
	if _, err := decryptProviderKey(value + ":tampered"); err == nil {
		t.Fatal("accepted malformed credential envelope")
	}
}

func TestStoredProviderConfigDoesNotFallBackToGlobalCredential(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "global-provider-key")
	config := routineConfig{Provider: "openai"}
	if err := decryptStoredProviderKey(&config); err != nil {
		t.Fatal(err)
	}
	if config.APIKey != nil {
		t.Fatalf("cleared organization key fell back to global credential %q", *config.APIKey)
	}
	emptyConfig := routineConfig{Provider: "openai", APIKey: stringPointer("")}
	if err := decryptStoredProviderKey(&emptyConfig); err != nil {
		t.Fatal(err)
	}
	if emptyConfig.APIKey != nil {
		t.Fatalf("empty organization credential was not treated as cleared: %#v", emptyConfig.APIKey)
	}
}

func TestRoutineProviderUsesOpenAICompatibleChatCompletions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			t.Errorf("request=%s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-provider-key" {
			t.Errorf("authorization=%q", got)
		}
		var body struct {
			Model string            `json:"model"`
			Tools []json.RawMessage `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Model != "test-model" || len(body.Tools) != 1 {
			t.Errorf("provider request model=%q tools=%d", body.Model, len(body.Tools))
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"routine finished"}}],"usage":{"prompt_tokens":12,"completion_tokens":4}}`))
	}))
	defer server.Close()
	agent := newRoutineAgent(nil, nil)
	agent.client = server.Client()
	config := routineConfig{BaseURL: server.URL + "/v1", APIKey: stringPointer("test-provider-key")}
	config.Models.Primary = "test-model"
	result, err := agent.complete(context.Background(), config, []routineMessage{{Role: "user", Content: json.RawMessage(`"run"`)}}, []map[string]any{{"type": "function"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Choices) != 1 || string(result.Choices[0].Message.Content) != `"routine finished"` || result.Usage.Input != 12 || result.Usage.Output != 4 {
		t.Fatalf("provider response=%+v", result)
	}
}

func stringPointer(value string) *string { return &value }

func TestRoutineProviderErrorDoesNotExposeBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("secret provider response"))
	}))
	defer server.Close()
	agent := newRoutineAgent(nil, nil)
	agent.client = server.Client()
	config := routineConfig{BaseURL: server.URL, APIKey: stringPointer("key")}
	config.Models.Primary = "model"
	_, err := agent.complete(context.Background(), config, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") || strings.Contains(err.Error(), "secret provider response") {
		t.Fatalf("provider error=%v", err)
	}
}
