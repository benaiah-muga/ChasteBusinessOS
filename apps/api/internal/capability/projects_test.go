package capability

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestProjectsCapabilityContractsAndDispatchIDs(t *testing.T) {
	cases := []struct {
		id   string
		raw  string
		want any
	}{
		{createProjectCapabilityID, `{"name":"Launch","dueAt":"2030-01-02T03:04:05.123456Z","unknown":true}`, CreateProjectInput{Name: "Launch", DueAt: projectStringPointer("2030-01-02T03:04:05.123456Z")}},
		{ProjectBoardReadCapabilityID, `{"projectId":"11111111-1111-4111-8111-111111111111","unknown":true}`, ProjectBoardInput{ProjectID: "11111111-1111-4111-8111-111111111111"}},
		{archiveProjectCapabilityID, `{"projectId":"11111111-1111-4111-8111-111111111111"}`, ArchiveProjectInput{ProjectID: "11111111-1111-4111-8111-111111111111"}},
		{createProjectTaskCapabilityID, `{"projectId":"11111111-1111-4111-8111-111111111111","title":"Inspect","unknown":true}`, CreateProjectTaskInput{ProjectID: "11111111-1111-4111-8111-111111111111", Title: "Inspect"}},
		{moveProjectTaskCapabilityID, `{"taskId":"22222222-2222-4222-8222-222222222222","status":"done","position":0}`, MoveProjectTaskInput{TaskID: "22222222-2222-4222-8222-222222222222", Status: "done", Position: floatPointer(0)}},
		{assignProjectTaskCapabilityID, `{"taskId":"22222222-2222-4222-8222-222222222222"}`, AssignProjectTaskInput{TaskID: "22222222-2222-4222-8222-222222222222"}},
	}
	for _, test := range cases {
		t.Run(test.id, func(t *testing.T) {
			spec, exists := capabilitySpecs[test.id]
			permission, risk := "projects.write", "write"
			if test.id == ProjectBoardReadCapabilityID {
				permission, risk = "projects.read", "read"
			}
			if !supportedCapability(test.id) || !exists || spec.module != "projects" || spec.permission != permission || spec.risk != risk {
				t.Fatalf("capability %q has spec %+v, supported=%t", test.id, spec, supportedCapability(test.id))
			}
			got, err := parseProjectsInput(test.id, json.RawMessage(test.raw))
			if err != nil {
				t.Fatal(err)
			}
			gotJSON, err := marshalJS(got)
			if err != nil {
				t.Fatal(err)
			}
			wantJSON, err := marshalJS(test.want)
			if err != nil {
				t.Fatal(err)
			}
			if string(gotJSON) != string(wantJSON) {
				t.Fatalf("parsed input = %s, want %s", gotJSON, wantJSON)
			}
			hash, err := canonicalInputHash(got)
			if err != nil || hash == "" {
				t.Fatalf("canonicalInputHash() = %q, %v", hash, err)
			}
		})
	}
}

func TestProjectsCapabilityParsersRejectLegacySchemaViolations(t *testing.T) {
	validProject := `11111111-1111-4111-8111-111111111111`
	validTask := `22222222-2222-4222-8222-222222222222`
	tests := []struct {
		name string
		id   string
		raw  string
	}{
		{"project requires a non-empty name", createProjectCapabilityID, `{}`},
		{"project name maximum", createProjectCapabilityID, `{"name":"` + repeated("a", 121) + `"}`},
		{"project date must use UTC Z", createProjectCapabilityID, `{"name":"Launch","dueAt":"2030-01-02T03:04:05+00:00"}`},
		{"archive requires UUID", archiveProjectCapabilityID, `{"projectId":"not-a-uuid"}`},
		{"board requires UUID", ProjectBoardReadCapabilityID, `{"projectId":"11111111-1111-0111-8111-111111111111"}`},
		{"archive rejects UUID version zero", archiveProjectCapabilityID, `{"projectId":"11111111-1111-0111-8111-111111111111"}`},
		{"archive rejects a non-RFC UUID variant", archiveProjectCapabilityID, `{"projectId":"11111111-1111-4111-7111-111111111111"}`},
		{"task title maximum", createProjectTaskCapabilityID, `{"projectId":"` + validProject + `","title":"` + repeated("a", 201) + `"}`},
		{"parent UUID", createProjectTaskCapabilityID, `{"projectId":"` + validProject + `","title":"Inspect","parentTaskId":null}`},
		{"assignee UUID", createProjectTaskCapabilityID, `{"projectId":"` + validProject + `","title":"Inspect","assigneeUserId":"bad"}`},
		{"due date null", createProjectTaskCapabilityID, `{"projectId":"` + validProject + `","title":"Inspect","dueAt":null}`},
		{"priority enum", createProjectTaskCapabilityID, `{"projectId":"` + validProject + `","title":"Inspect","priority":"urgent"}`},
		{"move status enum", moveProjectTaskCapabilityID, `{"taskId":"` + validTask + `","status":"blocked"}`},
		{"move position negative", moveProjectTaskCapabilityID, `{"taskId":"` + validTask + `","status":"done","position":-1}`},
		{"move position fractional", moveProjectTaskCapabilityID, `{"taskId":"` + validTask + `","status":"done","position":1.5}`},
		{"move position null", moveProjectTaskCapabilityID, `{"taskId":"` + validTask + `","status":"done","position":null}`},
		{"assign null", assignProjectTaskCapabilityID, `{"taskId":"` + validTask + `","assigneeUserId":null}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseProjectsInput(test.id, json.RawMessage(test.raw)); err == nil {
				t.Fatalf("parseProjectsInput(%s) accepted %s", test.id, test.raw)
			}
		})
	}
	if _, err := projectDateTimeValue(projectStringPointer("2030-01-02T03:04:05.123456789Z")); err != nil {
		t.Fatalf("valid UTC timestamp was rejected: %v", err)
	}
}

func TestProjectsCapabilityUUIDSentinelsAndMinuteDateMatchZod(t *testing.T) {
	for _, projectID := range []string{
		"00000000-0000-0000-0000-000000000000",
		"ffffffff-ffff-ffff-ffff-ffffffffffff",
	} {
		if _, err := ParseArchiveProjectInput(json.RawMessage(`{"projectId":"` + projectID + `"}`)); err != nil {
			t.Errorf("Zod-valid sentinel UUID %q was rejected: %v", projectID, err)
		}
		if _, err := ParseProjectBoardInput(json.RawMessage(`{"projectId":"` + projectID + `"}`)); err != nil {
			t.Errorf("Zod-valid board UUID %q was rejected: %v", projectID, err)
		}
	}
	input, err := ParseCreateProjectInput(json.RawMessage(`{"name":"Minute date","dueAt":"2030-01-02T03:04Z"}`))
	if err != nil || input.DueAt == nil || *input.DueAt != "2030-01-02T03:04Z" {
		t.Fatalf("Zod-valid hour-minute datetime input=%+v err=%v", input, err)
	}
	value, err := projectDateTimeValue(input.DueAt)
	if err != nil {
		t.Fatal(err)
	}
	parsed, ok := value.(time.Time)
	if !ok || !parsed.Equal(time.Date(2030, time.January, 2, 3, 4, 0, 0, time.UTC)) {
		t.Fatalf("minute datetime database value=%#v, want 2030-01-02T03:04:00Z", value)
	}
}

func TestProjectsCapabilityDateWriteUsesJavaScriptMillisecondPrecision(t *testing.T) {
	value, err := projectDateTimeValue(projectStringPointer("2030-01-02T03:04:05.123456789Z"))
	if err != nil {
		t.Fatal(err)
	}
	parsed, ok := value.(time.Time)
	if !ok || parsed.Nanosecond() != 123_000_000 {
		t.Fatalf("projectDateTimeValue() = %#v, want timestamp truncated to 123 milliseconds", value)
	}
}

func TestProjectsMoveNormalizesNegativeZeroLikeJavaScriptJSON(t *testing.T) {
	input, err := ParseMoveProjectTaskInput(json.RawMessage(`{"taskId":"22222222-2222-4222-8222-222222222222","status":"todo","position":-0}`))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := marshalJS(input)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"taskId":"22222222-2222-4222-8222-222222222222","status":"todo","position":0}` {
		t.Fatalf("negative zero parsed JSON=%s, want JavaScript's normalized zero", encoded)
	}
}

func parseProjectsInput(id string, raw json.RawMessage) (any, error) {
	switch id {
	case createProjectCapabilityID:
		return ParseCreateProjectInput(raw)
	case ProjectBoardReadCapabilityID:
		return ParseProjectBoardInput(raw)
	case archiveProjectCapabilityID:
		return ParseArchiveProjectInput(raw)
	case createProjectTaskCapabilityID:
		return ParseCreateProjectTaskInput(raw)
	case moveProjectTaskCapabilityID:
		return ParseMoveProjectTaskInput(raw)
	case assignProjectTaskCapabilityID:
		return ParseAssignProjectTaskInput(raw)
	default:
		return nil, errors.New("unknown projects capability")
	}
}

func TestProjectCollectionReadIsNotAnAuditedCapability(t *testing.T) {
	if supportedCapability(ProjectCollectionReadOperationID) {
		t.Fatalf("collection operation %q must stay outside the capability registry", ProjectCollectionReadOperationID)
	}
	if _, exists := capabilitySpecs[ProjectCollectionReadOperationID]; exists {
		t.Fatalf("collection operation %q must not have an audited capability spec", ProjectCollectionReadOperationID)
	}
}

func projectStringPointer(value string) *string { return &value }

func floatPointer(value float64) *float64 { return &value }

func repeated(value string, count int) string {
	result := make([]byte, 0, len(value)*count)
	for range count {
		result = append(result, value...)
	}
	return string(result)
}
