package capability

import (
	"strings"
	"testing"
)

func TestRoutinesParseScheduleTextNormalizesLegacyNaturalLanguageExamples(t *testing.T) {
	for _, tc := range []struct {
		text    string
		kind    string
		minutes int64
		atTime  string
	}{
		{text: "twice a day", kind: "interval", minutes: 720},
		{text: "each morning at 8", kind: "daily", atTime: "08:00"},
	} {
		t.Run(tc.text, func(t *testing.T) {
			schedule, ok := routinesParseScheduleText(tc.text)
			if !ok || schedule.Kind != tc.kind {
				t.Fatalf("parse(%q) = %+v, %t", tc.text, schedule, ok)
			}
			if tc.kind == "interval" && (schedule.EveryMinutes == nil || *schedule.EveryMinutes != tc.minutes) {
				t.Fatalf("parse(%q) interval = %+v, want %d minutes", tc.text, schedule, tc.minutes)
			}
			if tc.kind == "daily" && (schedule.AtTime == nil || *schedule.AtTime != tc.atTime) {
				t.Fatalf("parse(%q) time = %+v, want %q", tc.text, schedule, tc.atTime)
			}
		})
	}
}

func TestRoutinesParseScheduleTextRejectsAmbiguousNaturalLanguageWithActionableError(t *testing.T) {
	for _, text := range []string{"a few times a day", "each morning whenever possible", "every 2 hours with reminders"} {
		if _, ok := routinesParseScheduleText(text); ok {
			t.Errorf("parse(%q) accepted an unsupported schedule", text)
		}
	}
	bad := "a few times a day"
	_, _, err := routinesResolveSchedule(&bad, nil)
	if err == nil || !strings.Contains(err.Error(), "twice a day") || !strings.Contains(err.Error(), "each morning at 8") {
		t.Fatalf("validation error = %v, want supported examples", err)
	}
}
