package capability

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
	"sync"
)

// capabilityCatalogJSON is a compact, reviewed index of the capability
// manifest. It lets the chat workmate discover a governed capability that was
// not on the turn's shortlist, then invoke it through the same executor as a
// visible tool. Legacy schemas come from the manifest; newer capabilities can
// carry their contract in the spec or the agent tool catalog.
//
//go:embed capability_catalog.json
var capabilityCatalogJSON []byte

type AgentCapability struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Intent      string          `json:"intent"`
	Module      string          `json:"module"`
	Permission  string          `json:"permission"`
	Risk        string          `json:"risk"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

type catalogCapability struct {
	ID     string          `json:"id"`
	Title  string          `json:"title"`
	Intent string          `json:"intent"`
	Module string          `json:"module"`
	Risk   string          `json:"risk"`
	Schema json.RawMessage `json:"schema"`
}

var capabilityCatalog = loadCapabilityCatalog()

// capabilityCatalogOnce builds the discovery index after every domain has
// registered its specs. Package-level specs are ready before init functions,
// but documents, messaging, notifications, SSO, and harness add theirs during
// init, so the merge cannot run at variable-initialization time.
var capabilityCatalogOnce sync.Once

// ensureCapabilityCatalog makes every supported, agent-visible capability
// discoverable from its own registration. A capability no longer has to be
// copied into a generated manifest or a hand-written tool map to become
// visible; it only has to exist in capabilitySpecs and carry a usable
// contract. Conformance tests require that contract.
func ensureCapabilityCatalog() {
	capabilityCatalogOnce.Do(func() {
		mergeAgentDefinitionsIntoCatalog()
		mergeCapabilitySpecsIntoCatalog()
	})
}

func loadCapabilityCatalog() map[string]catalogCapability {
	var document struct {
		Capabilities []catalogCapability `json:"capabilities"`
	}
	if err := json.Unmarshal(capabilityCatalogJSON, &document); err != nil {
		panic("capability catalog is not valid JSON: " + err.Error())
	}
	catalog := make(map[string]catalogCapability, len(document.Capabilities))
	for _, entry := range document.Capabilities {
		if entry.ID == "" {
			continue
		}
		catalog[entry.ID] = entry
	}
	return catalog
}

func capabilityAllowed(permissions map[string]bool, id string) bool {
	ensureCapabilityCatalog()
	spec, exists := capabilitySpecs[id]
	if !exists || !supportedCapability(id) || spec.humanOnly || spec.agentHidden != "" {
		return false
	}
	return permissions["*"] || permissions[spec.permission]
}

// AgentCapabilityByID resolves one governed capability for a signed user.
// Human-only and unsupported capabilities are deliberately absent.
func AgentCapabilityByID(permissions map[string]bool, id string) (AgentCapability, bool) {
	id = strings.TrimSpace(id)
	if !capabilityAllowed(permissions, id) {
		return AgentCapability{}, false
	}
	entry, exists := capabilityCatalog[id]
	if !exists {
		return AgentCapability{}, false
	}
	spec := capabilitySpecs[id]
	return AgentCapability{
		ID: id, Title: entry.Title, Intent: entry.Intent, Module: spec.module,
		Permission: spec.permission, Risk: spec.risk, InputSchema: entry.Schema,
	}, true
}

// SearchAgentCapabilities is the model-facing discovery surface. It ranks by
// literal term matches and returns only capabilities the caller may invoke.
func SearchAgentCapabilities(permissions map[string]bool, query string, limit int) []AgentCapability {
	ensureCapabilityCatalog()
	if limit < 1 {
		limit = 8
	}
	if limit > 20 {
		limit = 20
	}
	terms := strings.Fields(strings.ToLower(strings.TrimSpace(query)))
	if len(terms) == 0 {
		return nil
	}
	type hit struct {
		capability AgentCapability
		score      int
	}
	hits := make([]hit, 0, 16)
	for id, entry := range capabilityCatalog {
		if !capabilityAllowed(permissions, id) {
			continue
		}
		haystack := strings.ToLower(id + " " + entry.Title + " " + entry.Intent + " " + entry.Module)
		score := 0
		for _, term := range terms {
			if strings.Contains(haystack, term) {
				score++
			}
		}
		if score == 0 {
			continue
		}
		spec := capabilitySpecs[id]
		hits = append(hits, hit{capability: AgentCapability{
			ID: id, Title: entry.Title, Intent: entry.Intent, Module: spec.module,
			Permission: spec.permission, Risk: spec.risk, InputSchema: entry.Schema,
		}, score: score})
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].capability.ID < hits[j].capability.ID
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]AgentCapability, 0, len(hits))
	for _, h := range hits {
		out = append(out, h.capability)
	}
	return out
}

// CapabilityModules reports how many supported capabilities each module
// registers. It is a coverage signal for the module switchboard, not an
// authorization check.
func CapabilityModules() map[string]int {
	ensureCapabilityCatalog()
	modules := map[string]int{}
	for id, spec := range capabilitySpecs {
		if !supportedCapability(id) {
			continue
		}
		modules[spec.module]++
	}
	return modules
}

// CapabilityVisibleModules reports how many supported, agent-visible
// capabilities each module registers. A module with only human-only or hidden
// capabilities is installed without giving the agent a way to work in it.
func CapabilityVisibleModules() map[string]int {
	ensureCapabilityCatalog()
	modules := map[string]int{}
	for id, spec := range capabilitySpecs {
		if !supportedCapability(id) || spec.humanOnly || spec.agentHidden != "" {
			continue
		}
		modules[spec.module]++
	}
	return modules
}

// CapabilityRisk exposes the risk class for audit-only filtering. It does not
// grant permission and must never be used as an authorization check.
func CapabilityRisk(id string) (string, bool) {
	spec, exists := capabilitySpecs[id]
	if !exists {
		return "", false
	}
	return spec.risk, true
}

// mergeAgentDefinitionsIntoCatalog makes hand-written governed tools that are
// newer than the migration manifest discoverable too. Manifest entries win
// because they carry the reviewed, generated schema.
func mergeAgentDefinitionsIntoCatalog() {
	for id, definition := range agentToolDefinitions {
		if _, exists := capabilityCatalog[id]; exists {
			continue
		}
		spec, exists := capabilitySpecs[id]
		if !exists || !supportedCapability(id) || spec.humanOnly || spec.agentHidden != "" {
			continue
		}
		capabilityCatalog[id] = catalogCapability{
			ID: id, Title: firstNonEmpty(spec.title, definition.description), Intent: firstNonEmpty(spec.intent, definition.description),
			Module: spec.module, Risk: spec.risk, Schema: json.RawMessage(definition.schema),
		}
	}
}

// mergeCapabilitySpecsIntoCatalog closes the class of gap where a capability
// was executable but absent from the generated manifest, so an agent could not
// find it. The fallback entry keeps it visible; conformance requires an
// authored contract before release, so the fallback never silently ships an
// unusable tool.
func mergeCapabilitySpecsIntoCatalog() {
	for id, spec := range capabilitySpecs {
		if _, exists := capabilityCatalog[id]; exists {
			continue
		}
		if !supportedCapability(id) || spec.humanOnly || spec.agentHidden != "" {
			continue
		}
		schema := json.RawMessage(spec.inputSchema)
		if len(schema) == 0 {
			schema = json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)
		}
		intent := strings.TrimSpace(spec.intent)
		if len(intent) < 20 {
			intent = "Governed " + spec.module + " capability " + id + "."
		}
		capabilityCatalog[id] = catalogCapability{
			ID: id, Title: firstNonEmpty(spec.title, humanizeCapabilityID(id)), Intent: intent,
			Module: spec.module, Risk: spec.risk, Schema: schema,
		}
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func humanizeCapabilityID(id string) string {
	parts := strings.FieldsFunc(id, func(r rune) bool { return r == '.' || r == '-' || r == '_' })
	for index, part := range parts {
		if part == "" {
			continue
		}
		parts[index] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}
