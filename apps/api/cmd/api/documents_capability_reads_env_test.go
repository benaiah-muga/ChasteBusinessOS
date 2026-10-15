package main

import "testing"

func TestGoDocumentsCapabilityReadsEnabledFromEnvDefaultsOnAndSupportsOptOut(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{{"", true}, {"1", true}, {"0", false}} {
		if got := goDocumentsCapabilityReadsEnabledFromEnv(test.value); got != test.want {
			t.Errorf("value %q enabled=%v want=%v", test.value, got, test.want)
		}
	}
}
