package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
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

func TestDecodeOnboardingRequestRejectsUnknownAndUnsupportedDeferredSteps(t *testing.T) {
	valid := `{"orgName":"Glow Works","businessDescription":"We design and sell handmade lighting fixtures online.","baseCurrency":"USD","path":"import","deferredSteps":["import_customers"],"intentId":"intent-123456"}`
	tests := []struct {
		name string
		body string
	}{
		{name: "unknown field", body: strings.TrimSuffix(valid, "}") + `,"admin":true}`},
		{name: "unsupported setup step", body: strings.Replace(valid, `"import_customers"`, `"delete_workspace"`, 1)},
		{name: "duplicate setup step", body: strings.Replace(valid, `"import_customers"]`, `"import_customers","import_customers"]`, 1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/onboarding", strings.NewReader(test.body))
			response := httptest.NewRecorder()
			_, field, _, err := decodeOnboardingRequest(response, request)
			if err == nil || field == "" {
				t.Fatalf("decodeOnboardingRequest() accepted invalid body, field=%q err=%v", field, err)
			}
		})
	}

	request := httptest.NewRequest(http.MethodPost, "/api/onboarding", strings.NewReader(valid))
	response := httptest.NewRecorder()
	decoded, field, _, err := decodeOnboardingRequest(response, request)
	if err != nil || field != "" || !reflect.DeepEqual(decoded.deferredSteps, []string{"import_customers"}) {
		t.Fatalf("decodeOnboardingRequest(valid) = %+v, field=%q, err=%v", decoded, field, err)
	}
}
