package main

import "testing"

func TestGoAuthRouteEnabledFromEnvMatchesViteProxyDefault(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goAuthRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goAuthRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}
