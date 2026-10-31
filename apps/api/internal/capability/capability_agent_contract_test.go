package capability

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
)

// reviewedHumanOnly is the complete set of capabilities that need an
// authenticated human session, with the reason a reviewer accepted. Adding a
// fourth entry without a reason fails this test.
var reviewedHumanOnly = map[string]string{
	"crm.listCustomerCollection": "the CRM page's rich 500-row profile collection; agents use crm.listCustomers and crm.customerTimeline instead",
	"creator.reviewProposal":     "a terminal human decision; an inverse would erase the decision it records",
	"harness.listCompositions":   "the human approval queue for composed runtime profiles",
}

// reviewedAgentHidden is the complete set of capabilities deliberately kept
// out of model discovery while remaining callable by a human or by an internal
// system actor. Each entry names the governance reason.
var reviewedAgentHidden = map[string]string{
	"iam.scimProvisionUser":          "external SCIM provisioning is authenticated by an Identity Provider assertion, not an agent turn",
	"iam.createSCIMToken":            "returns a one-time bearer credential that must not enter a model transcript",
	"iam.revokeSCIMToken":            "requires a token id that is only listed in the human IAM admin console",
	"iam.createSSOConnection":        "accepts SSO client secrets, so identity-provider setup stays in the human admin console",
	"iam.disableSSOConnection":       "can lock every member out of the organization, so it requires an authenticated human session",
	"iam.restoreSSOConnection":       "changes organization-wide sign-in, so it requires an authenticated human session",
	"support.updateChannelSettings":  "changes the public widget embed token, so credential handling stays in the human support console",
	"support.restoreChannelSettings": "restores the public widget embed token, so credential handling stays in the human support console",
	"sales.restoreDraftOrder":        "internal inverse checkpoint used by the session revert path; callers edit through sales.updateDraftOrder",
	"iam.restoreAgentSoul":           "internal inverse checkpoint used by the session revert path; people edit through iam.setAgentSoul",
}

// TestEveryCapabilityIsDiscoverableOrReviewedHidden is the ratchet that closes
// the projects.list class of gap. A new capability is visible to the agent as
// soon as it is registered, unless its author records a reviewed reason to
// keep it hidden. There is no third state where an executable business
// capability silently has no agent entry point.
func TestEveryCapabilityIsDiscoverableOrReviewedHidden(t *testing.T) {
	ensureCapabilityCatalog()
	for id, spec := range capabilitySpecs {
		if !supportedCapability(id) {
			continue
		}
		if spec.humanOnly && spec.agentHidden != "" {
			t.Errorf("%s is both humanOnly and agentHidden", id)
		}
		if spec.humanOnly {
			if reviewedHumanOnly[id] == "" {
				t.Errorf("%s is humanOnly without a reviewed reason", id)
			}
			continue
		}
		if spec.agentHidden != "" {
			if reviewedAgentHidden[id] == "" {
				t.Errorf("%s is agentHidden without a reviewed reason: %s", id, spec.agentHidden)
			}
			continue
		}
		if reviewedHumanOnly[id] != "" || reviewedAgentHidden[id] != "" {
			t.Errorf("%s is listed as hidden but its spec is visible", id)
		}
		capability, ok := AgentCapabilityByID(map[string]bool{"*": true}, id)
		if !ok {
			t.Errorf("%s is supported and not hidden but is absent from agent discovery", id)
			continue
		}
		if len(capability.Intent) < 40 {
			t.Errorf("%s intent is too short to retrieve on: %q", id, capability.Intent)
		}
		assertClosedAgentSchema(t, id, capability.InputSchema)
	}
	for id := range reviewedHumanOnly {
		if !supportedCapability(id) {
			t.Errorf("reviewed human-only capability %s is no longer supported", id)
		}
	}
	for id := range reviewedAgentHidden {
		if !supportedCapability(id) {
			t.Errorf("reviewed agent-hidden capability %s is no longer supported", id)
		}
	}
}

// TestEveryVisibleCapabilityHasAnAuthoredContract forbids the silent fallback.
// The fallback catalog entry keeps a forgotten capability discoverable during
// development, but release requires a reviewed intent and input schema from
// either the migration manifest or the hand-written agent tool catalog.
func TestEveryVisibleCapabilityHasAnAuthoredContract(t *testing.T) {
	ensureCapabilityCatalog()
	authored := authoredAgentContractIDs()
	visible := 0
	for id, spec := range capabilitySpecs {
		if !supportedCapability(id) || spec.humanOnly || spec.agentHidden != "" {
			continue
		}
		visible++
		if !authored[id] {
			t.Errorf("%s has no authored agent contract; add it to agent_tool_contracts.json or the capability manifest", id)
			continue
		}
		if schema := json.RawMessage(spec.inputSchema); len(schema) > 0 {
			assertClosedAgentSchema(t, id, schema)
		}
	}
	if visible == 0 {
		t.Fatal("no visible capabilities were checked")
	}
	if len(authored) < visible {
		t.Fatalf("authored contracts=%d, visible capabilities=%d", len(authored), visible)
	}
}

func authoredAgentContractIDs() map[string]bool {
	ids := make(map[string]bool, len(agentToolDefinitions))
	for id := range agentToolDefinitions {
		ids[id] = true
	}
	// A capability can also carry its contract in the spec itself. This is the
	// path a new Go capability should take when it has no migration manifest
	// entry yet.
	for id, spec := range capabilitySpecs {
		if len(spec.inputSchema) > 0 && len(strings.TrimSpace(spec.intent)) >= 40 {
			ids[id] = true
		}
	}
	var document struct {
		Capabilities []struct {
			ID string `json:"id"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(capabilityCatalogJSON, &document); err == nil {
		for _, entry := range document.Capabilities {
			if entry.ID != "" {
				ids[entry.ID] = true
			}
		}
	}
	return ids
}

// assertClosedAgentSchema accepts either a closed object schema or a oneOf /
// anyOf of closed object branches, matching how the executor parses inputs.
func assertClosedAgentSchema(t *testing.T, id string, raw json.RawMessage) {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Errorf("%s has invalid input schema: %v", id, err)
		return
	}
	if branches, ok := schemaBranches(document); ok {
		if len(branches) == 0 {
			t.Errorf("%s has an empty schema union", id)
		}
		for _, branch := range branches {
			if !closedObject(branch) {
				t.Errorf("%s has an open schema union branch: %s", id, branch)
			}
		}
		return
	}
	if !closedObject(document) {
		t.Errorf("%s must advertise a closed object schema: %s", id, raw)
	}
}

func schemaBranches(document map[string]any) ([]map[string]any, bool) {
	for _, key := range []string{"oneOf", "anyOf"} {
		value, exists := document[key]
		if !exists {
			continue
		}
		list, ok := value.([]any)
		if !ok {
			return nil, true
		}
		branches := make([]map[string]any, 0, len(list))
		for _, item := range list {
			branch, ok := item.(map[string]any)
			if !ok {
				return nil, true
			}
			branches = append(branches, branch)
		}
		return branches, true
	}
	return nil, false
}

func closedObject(document map[string]any) bool {
	if document["type"] != "object" {
		return false
	}
	additional, exists := document["additionalProperties"]
	if !exists {
		return false
	}
	closed, ok := additional.(bool)
	return ok && !closed
}

func TestProjectsListIsDiscoverableAndGoverned(t *testing.T) {
	results := SearchAgentCapabilities(map[string]bool{"projects.read": true}, "active projects", 10)
	found := false
	for _, result := range results {
		if result.ID != ProjectCollectionReadCapabilityID {
			continue
		}
		found = true
		if result.Risk != "read" || result.Permission != "projects.read" || len(result.InputSchema) == 0 {
			t.Fatalf("projects.list contract=%+v, want a projects.read read with a schema", result)
		}
		assertClosedAgentSchema(t, result.ID, result.InputSchema)
	}
	if !found {
		t.Fatalf("projects.list was not discoverable for a project reader: %+v", results)
	}
	if _, ok := AgentCapabilityByID(map[string]bool{"projects.write": true}, ProjectCollectionReadCapabilityID); ok {
		t.Fatal("projects.list must require projects.read")
	}
	if _, ok := AgentCapabilityByID(map[string]bool{"projects.read": true}, ProjectCollectionReadCapabilityID); !ok {
		t.Fatal("projects.list must be invokable with projects.read")
	}
	direct := false
	for _, tool := range AgentTools(map[string]bool{"projects.read": true}) {
		if tool.ID != ProjectCollectionReadCapabilityID {
			continue
		}
		direct = true
		if tool.Permission != "projects.read" || tool.Risk != "read" {
			t.Fatalf("projects.list direct tool=%+v, want projects.read read", tool)
		}
		assertClosedAgentSchema(t, tool.ID, tool.InputSchema)
	}
	if !direct {
		t.Fatal("projects.list must be on the direct agent tool list for a project reader")
	}
}

func TestAgentHiddenCapabilitiesDoNotLeakIntoDiscovery(t *testing.T) {
	ids := make([]string, 0, len(reviewedAgentHidden))
	for id := range reviewedAgentHidden {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if _, ok := AgentCapabilityByID(map[string]bool{"*": true}, id); ok {
			t.Errorf("agent-hidden capability leaked into discovery: %s", id)
		}
		for _, tool := range AgentTools(map[string]bool{"*": true}) {
			if tool.ID == id {
				t.Errorf("agent-hidden capability leaked into tool list: %s", id)
			}
		}
	}
}
