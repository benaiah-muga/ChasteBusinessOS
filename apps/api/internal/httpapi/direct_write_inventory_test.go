package httpapi

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// directWriteExceptions is the reviewed list of HTTP-layer files that still
// write to PostgreSQL outside the capability executor. Each entry names why
// the write is infrastructure, identity lifecycle, public intake, or an
// ephemeral workspace, rather than a business action the agent should hold a
// capability for. A new file with a direct write fails this test until it is
// either routed through the executor or added here with a reason.
var directWriteExceptions = map[string]string{
	"ai_connections.go":              "coding-agent connection setup is a human platform configuration surface; credentials and local process control never enter a model turn",
	"ai_tools_mcp.go":                "MCP session and trajectory storage around governed capability calls",
	"chat_session.go":                "agent session and trajectory storage for the chat infrastructure",
	"documents_editor_workspace.go":  "ephemeral draft autosave, presence, and soft locks, not published business documents",
	"documents_ingest_collection.go": "queues a parse job and marks the document queued around the governed ingest capability",
	"evaluations_store.go":           "internal quality-evaluation run storage, not business state",
	"invitations.go":                 "invitation claim and identity lifecycle, governed by ADR 0053",
	"messaging_agent_session.go":     "agent session and token accounting for messaging replies around governed message capabilities",
	"my_work_summary.go":             "coding-agent usage counters after a governed my-work summary call",
	"notification_preferences.go":    "per-user notification preference, authenticated and self-scoped",
	"onboarding.go":                  "onboarding checklist state and setup notifications around the governed bootstrap capability",
	"portal_invoice.go":              "tokenized public invoice view and view tracking",
	"support_auto_reply_budget.go":   "rate-limit and auto-reply budget counters",
	"support_public.go":              "public support widget intake and visitor binding, governed by ADR 0025 containment",
}

var directWritePattern = regexp.MustCompile(`(?m)(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM)`)

func TestDirectHTTPWritesAreReviewedExceptions(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		source, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if !directWritePattern.Match(source) {
			continue
		}
		found[name] = true
		if directWriteExceptions[name] == "" {
			t.Errorf("%s writes to PostgreSQL outside the capability executor without a reviewed reason; route it through the executor or document the exception", name)
		}
	}
	for name := range directWriteExceptions {
		if !found[name] {
			t.Errorf("reviewed direct-write exception %s no longer contains a direct write; remove the stale exception", name)
		}
	}
	if len(found) == 0 {
		t.Fatal("no direct writes found; the inventory pattern is stale")
	}
	names := make([]string, 0, len(found))
	for name := range found {
		names = append(names, name)
	}
	sort.Strings(names)
	t.Logf("reviewed direct-write exceptions: %s", strings.Join(names, ", "))
}
