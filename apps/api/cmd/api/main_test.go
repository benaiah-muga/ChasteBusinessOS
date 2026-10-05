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

func TestGoMyWorkRouteEnabledFromEnvMatchesViteProxyDefault(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goMyWorkRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goMyWorkRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoAnalyticsRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goAnalyticsRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goAnalyticsRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoSessionsRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goSessionsRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goSessionsRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoDurableRunsRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goDurableRunsRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goDurableRunsRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}
