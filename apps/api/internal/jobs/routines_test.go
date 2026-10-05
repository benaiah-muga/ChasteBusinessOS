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

func TestRoutineListToolIsAvailableAndValidatesItsFilter(t *testing.T) {
	tools, byName, err := routineToolSet()
	if err != nil {
		t.Fatal(err)
	}
	var found *routineTool
	for index := range tools {
		if tools[index].Capability == "routines.list" {
			found = &tools[index]
			break
		}
	}
	if found == nil || found.Name != "routines_list" || found.Permission != "routines.read" || byName["routines_list"] != "routines.list" {
		t.Fatalf("routine list tool=%+v dispatch=%q, want routines_list with routines.read", found, byName["routines_list"])
	}
	properties, ok := found.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("routine list schema has no properties: %#v", found.Schema)
	}
	limit, ok := properties["limit"].(map[string]any)
	if !ok || limit["type"] != "integer" || limit["minimum"] != 1 || limit["maximum"] != 100 || limit["default"] != 50 {
		t.Fatalf("routine list limit schema=%#v, want integer 1..100 default 50", properties["limit"])
	}

	for _, test := range []struct {
		input string
		valid bool
	}{
		{input: `{}`, valid: true},
		{input: `{"limit":1}`, valid: true},
		{input: `{"limit":100}`, valid: true},
		{input: `{"limit":0}`},
		{input: `{"limit":101}`},
		{input: `{"limit":1.5}`},
		{input: `{"limit":"10"}`},
		{input: `{"unexpected":true}`},
		{input: `null`},
		{input: `{} {}`},
	} {
		t.Run(test.input, func(t *testing.T) {
			err := validateRoutineListToolInput(json.RawMessage(test.input))
			if (err == nil) != test.valid {
				t.Fatalf("validateRoutineListToolInput(%s) error=%v, want valid=%v", test.input, err, test.valid)
			}
		})
	}
}

func TestRoutineToolSchemasDescribeRequiredInputs(t *testing.T) {
	tools, byName, err := routineToolSet()
	if err != nil {
		t.Fatal(err)
	}
	for _, capabilityID := range []string{"support.readConversation", "support.searchKnowledge", "documents.listDocVersions", "purchasing.supplierStatement", "inventory.itemHistory", "accounting.customerStatement", "hr.leaveBalance", "purchasing.listReceipts"} {
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
	var supplierStatement *routineTool
	for index := range tools {
		if tools[index].Capability == "purchasing.supplierStatement" {
			supplierStatement = &tools[index]
			break
		}
	}
	if supplierStatement == nil || supplierStatement.Name != "purchasing_supplierStatement" || supplierStatement.Permission != "purchasing.read" {
		t.Fatalf("supplier statement tool=%+v, want purchasing_supplierStatement with purchasing.read", supplierStatement)
	}
	statementProperties, ok := supplierStatement.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("supplier statement schema has no properties: %#v", supplierStatement.Schema)
	}
	vendorID, ok := statementProperties["vendorId"].(map[string]any)
	if !ok || vendorID["type"] != "string" || vendorID["format"] != "uuid" {
		t.Fatalf("supplier statement vendorId schema=%#v, want UUID string", statementProperties["vendorId"])
	}
	if got := byName[supplierStatement.Name]; got != "purchasing.supplierStatement" {
		t.Fatalf("supplier statement routine dispatch maps to %q", got)
	}
	var cashFlow *routineTool
	for index := range tools {
		if tools[index].Capability == "accounting.cashFlow" {
			cashFlow = &tools[index]
			break
		}
	}
	if cashFlow == nil || cashFlow.Name != "accounting_cashFlow" || cashFlow.Permission != "accounting.read" {
		t.Fatalf("cash flow tool=%+v, want accounting_cashFlow with accounting.read", cashFlow)
	}
	cashFlowProperties, ok := cashFlow.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("cash flow schema has no properties: %#v", cashFlow.Schema)
	}
	cashCodes, ok := cashFlowProperties["cashAccountCodes"].(map[string]any)
	if !ok || cashCodes["type"] != "array" {
		t.Fatalf("cash flow cashAccountCodes schema=%#v, want optional string array", cashFlowProperties["cashAccountCodes"])
	}
	if _, required := cashFlow.Schema["required"]; required {
		t.Fatalf("cash flow schema should keep its defaulted cashAccountCodes optional: %#v", cashFlow.Schema["required"])
	}
	items, ok := cashCodes["items"].(map[string]any)
	if !ok || items["type"] != "string" {
		t.Fatalf("cash flow cashAccountCodes items=%#v, want strings", cashCodes["items"])
	}
	if got := byName[cashFlow.Name]; got != "accounting.cashFlow" {
		t.Fatalf("cash flow routine dispatch maps to %q", got)
	}
	var customerStatement *routineTool
	for index := range tools {
		if tools[index].Capability == "accounting.customerStatement" {
			customerStatement = &tools[index]
			break
		}
	}
	if customerStatement == nil || customerStatement.Name != "accounting_customerStatement" || customerStatement.Permission != "accounting.read" {
		t.Fatalf("customer statement tool=%+v, want accounting_customerStatement with accounting.read", customerStatement)
	}
	customerStatementProperties, ok := customerStatement.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("customer statement schema has no properties: %#v", customerStatement.Schema)
	}
	customerID, ok := customerStatementProperties["customerId"].(map[string]any)
	if !ok || customerID["type"] != "string" || customerID["format"] != "uuid" || byName[customerStatement.Name] != "accounting.customerStatement" {
		t.Fatalf("customer statement customerId schema=%#v dispatch=%q, want UUID and governed dispatch", customerStatementProperties["customerId"], byName[customerStatement.Name])
	}
	if capabilityID := byName["accounting_arAging"]; capabilityID != "accounting.arAging" {
		t.Fatalf("accounts receivable aging routine dispatch maps to %q", capabilityID)
	}
	if capabilityID := byName["purchasing_apAging"]; capabilityID != "purchasing.apAging" {
		t.Fatalf("accounts payable aging routine dispatch maps to %q", capabilityID)
	}
	for toolName, capabilityID := range map[string]string{
		"crm_listCustomerViews":          "crm.listCustomerViews",
		"hr_listEmployees":               "hr.listEmployees",
		"hr_leaveBalance":                "hr.leaveBalance",
		"accounting_listBudgetScenarios": "accounting.listBudgetScenarios",
		"inventory_listLots":             "inventory.listLots",
		"inventory_listReservations":     "inventory.listReservations",
		"purchasing_listReceipts":        "purchasing.listReceipts",
	} {
		if got := byName[toolName]; got != capabilityID {
			t.Fatalf("routine dispatch for %s maps to %q, want %q", toolName, got, capabilityID)
		}
	}
	for _, optional := range []string{"accounting_listBudgetScenarios", "inventory_listReservations"} {
		for index := range tools {
			if tools[index].Name != optional {
				continue
			}
			if _, required := tools[index].Schema["required"]; required {
				t.Fatalf("routine tool %s should keep its optional filter optional: %#v", optional, tools[index].Schema["required"])
			}
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
	var itemHistory *routineTool
	for index := range tools {
		if tools[index].Capability == "inventory.itemHistory" {
			itemHistory = &tools[index]
			break
		}
	}
	if itemHistory == nil || itemHistory.Name != "inventory_itemHistory" || itemHistory.Permission != "inventory.read" {
		t.Fatalf("inventory item history tool=%+v, want inventory_itemHistory with inventory.read", itemHistory)
	}
	historyProperties, ok := itemHistory.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("inventory item history schema has no properties: %#v", itemHistory.Schema)
	}
	historyLimit, ok := historyProperties["limit"].(map[string]any)
	if !ok || historyLimit["type"] != "integer" || historyLimit["minimum"] != 1 || historyLimit["maximum"] != 200 {
		t.Fatalf("inventory item history limit schema=%#v, want optional integer from 1 to 200", historyProperties["limit"])
	}
	if got := byName[itemHistory.Name]; got != "inventory.itemHistory" {
		t.Fatalf("inventory item history routine dispatch maps to %q", got)
	}
	var trialBalance *routineTool
	for index := range tools {
		if tools[index].Capability == "accounting.trialBalance" {
			trialBalance = &tools[index]
			break
		}
	}
	if trialBalance == nil || trialBalance.Name != "accounting_trialBalance" || trialBalance.Permission != "accounting.read" {
		t.Fatalf("accounting trial balance tool=%+v, want accounting_trialBalance with accounting.read", trialBalance)
	}
	if trialBalance.Schema["type"] != "object" || trialBalance.Schema["additionalProperties"] != false {
		t.Fatalf("accounting trial balance schema must be an input-free object: %#v", trialBalance.Schema)
	}
	if properties, ok := trialBalance.Schema["properties"].(map[string]any); !ok || len(properties) != 0 {
		t.Fatalf("accounting trial balance schema must not accept inputs: %#v", trialBalance.Schema["properties"])
	}
	if got := byName[trialBalance.Name]; got != "accounting.trialBalance" {
		t.Fatalf("accounting trial balance routine dispatch maps to %q", got)
	}
	var incomeStatement *routineTool
	for index := range tools {
		if tools[index].Capability == "accounting.incomeStatement" {
			incomeStatement = &tools[index]
			break
		}
	}
	if incomeStatement == nil || incomeStatement.Name != "accounting_incomeStatement" || incomeStatement.Permission != "accounting.read" {
		t.Fatalf("accounting income statement tool=%+v, want accounting_incomeStatement with accounting.read", incomeStatement)
	}
	if incomeStatement.Schema["type"] != "object" || incomeStatement.Schema["additionalProperties"] != false {
		t.Fatalf("accounting income statement schema must be an input-free object: %#v", incomeStatement.Schema)
	}
	if properties, ok := incomeStatement.Schema["properties"].(map[string]any); !ok || len(properties) != 0 {
		t.Fatalf("accounting income statement schema must not accept inputs: %#v", incomeStatement.Schema["properties"])
	}
	if got := byName[incomeStatement.Name]; got != "accounting.incomeStatement" {
		t.Fatalf("accounting income statement routine dispatch maps to %q", got)
	}
	var balanceSheet *routineTool
	for index := range tools {
		if tools[index].Capability == "accounting.balanceSheet" {
			balanceSheet = &tools[index]
			break
		}
	}
	if balanceSheet == nil || balanceSheet.Name != "accounting_balanceSheet" || balanceSheet.Permission != "accounting.read" {
		t.Fatalf("accounting balance sheet tool=%+v, want accounting_balanceSheet with accounting.read", balanceSheet)
	}
	if balanceSheet.Schema["type"] != "object" || balanceSheet.Schema["additionalProperties"] != false {
		t.Fatalf("accounting balance sheet schema must be an input-free object: %#v", balanceSheet.Schema)
	}
	if properties, ok := balanceSheet.Schema["properties"].(map[string]any); !ok || len(properties) != 0 {
		t.Fatalf("accounting balance sheet schema must not accept inputs: %#v", balanceSheet.Schema["properties"])
	}
	if got := byName[balanceSheet.Name]; got != "accounting.balanceSheet" {
		t.Fatalf("accounting balance sheet routine dispatch maps to %q", got)
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
	var quotes *routineTool
	for index := range tools {
		if tools[index].Capability == "accounting.listQuotes" {
			quotes = &tools[index]
			break
		}
	}
	if quotes == nil || quotes.Name != "accounting_listQuotes" || quotes.Permission != "accounting.read" {
		t.Fatalf("accounting quote list tool=%+v, want accounting_listQuotes with accounting.read", quotes)
	}
	quoteProperties, ok := quotes.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("accounting quote list schema has no properties: %#v", quotes.Schema)
	}
	quoteStatus, ok := quoteProperties["status"].(map[string]any)
	if !ok || quoteStatus["type"] != "string" {
		t.Fatalf("accounting quote status filter schema=%#v", quoteProperties["status"])
	}
	if _, required := quotes.Schema["required"]; required {
		t.Fatalf("accounting quote status filter should remain optional: %#v", quotes.Schema)
	}
	quoteStatuses, ok := quoteStatus["enum"].([]string)
	if !ok || len(quoteStatuses) != 5 || quoteStatuses[0] != "draft" || quoteStatuses[1] != "sent" || quoteStatuses[2] != "accepted" || quoteStatuses[3] != "declined" || quoteStatuses[4] != "expired" {
		t.Fatalf("accounting quote status values=%#v, want the legacy status set", quoteStatus["enum"])
	}
	var timeline *routineTool
	for index := range tools {
		if tools[index].Capability == "crm.customerTimeline" {
			timeline = &tools[index]
			break
		}
	}
	if timeline == nil || timeline.Name != "crm_customerTimeline" || timeline.Permission != "crm.read" {
		t.Fatalf("CRM customer timeline tool=%+v, want crm_customerTimeline with crm.read", timeline)
	}
	timelineProperties, ok := timeline.Schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("CRM customer timeline schema has no properties: %#v", timeline.Schema)
	}
	timelineLimit, ok := timelineProperties["limit"].(map[string]any)
	if !ok || timelineLimit["type"] != "integer" || timelineLimit["minimum"] != 1 || timelineLimit["maximum"] != 200 {
		t.Fatalf("CRM customer timeline limit schema=%#v, want optional integer from 1 to 200", timelineProperties["limit"])
	}
	timelineRequired, ok := timeline.Schema["required"].([]string)
	if !ok || len(timelineRequired) != 1 || timelineRequired[0] != "customerId" {
		t.Fatalf("CRM customer timeline required fields=%#v, want customerId only", timeline.Schema["required"])
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
