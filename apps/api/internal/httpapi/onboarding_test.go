package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"testing"
)

func TestOnboardingStateFailureSeparatesInputAndInfrastructureErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{name: "missing workspace", err: errOnboardingOrgNotFound, want: http.StatusConflict},
		{name: "invalid update", err: errInvalidOnboardingUpdate, want: http.StatusBadRequest},
		{name: "database failure", err: errors.New("database unavailable"), want: http.StatusInternalServerError},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, body := onboardingStateFailure(test.err)
			if status != test.want || body["code"] == "" {
				t.Fatalf("onboardingStateFailure(%v) = %d, %#v, want status %d with an error code", test.err, status, body, test.want)
			}
		})
	}
}

func TestOnboardingChecklistOnlyReturnsUnfinishedKnownSteps(t *testing.T) {
	state := &onboardingState{
		Steps: map[string]string{
			"business_profile": "done",
			"import_customers": "skipped",
			"import_products":  "pending",
			"unknown_step":     "pending",
		},
	}
	want := []onboardingChecklistStep{
		{Key: "import_customers", Status: "skipped"},
		{Key: "import_products", Status: "pending"},
	}
	if got := onboardingChecklist(state); !reflect.DeepEqual(got, want) {
		t.Fatalf("onboardingChecklist() = %#v, want %#v", got, want)
	}
	if got := onboardingChecklist(nil); len(got) != 0 {
		t.Fatalf("onboardingChecklist(nil) = %#v, want empty", got)
	}
	state.FinishedAt = "2026-01-01T00:00:00Z"
	if got := onboardingChecklist(state); len(got) != 0 {
		t.Fatalf("finished onboardingChecklist() = %#v, want empty", got)
	}
}

func TestParseOnboardingStateKeepsWireContractAndFiltersInvalidFields(t *testing.T) {
	state := parseOnboardingState([]byte(`{"onboarding":{"path":"connect","steps":{"invite_team":"pending","invalid":"done","import_products":"unknown"},"startedAt":"2026-01-01T00:00:00Z","finishedAt":"2026-01-02T00:00:00Z"}}`))
	if state.Path != "connect" || state.StartedAt != "2026-01-01T00:00:00Z" || state.FinishedAt != "2026-01-02T00:00:00Z" {
		t.Fatalf("parsed state = %+v, expected stored path and timestamps", state)
	}
	if !reflect.DeepEqual(state.Steps, map[string]string{"invite_team": "pending"}) {
		t.Fatalf("parsed steps = %#v, expected only known statuses", state.Steps)
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"path", "steps", "startedAt", "finishedAt"} {
		if _, ok := wire[field]; !ok {
			t.Errorf("wire state is missing %q: %s", field, encoded)
		}
	}
}
