package main

import "testing"

func TestGoCRMFollowUpDraftRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	if !goCRMFollowUpDraftRouteEnabledFromEnv("") || !goCRMFollowUpDraftRouteEnabledFromEnv("1") || goCRMFollowUpDraftRouteEnabledFromEnv("0") {
		t.Fatal("CRM follow-up draft route should default on and allow explicit disable")
	}
}

func TestGoManufacturingBomWriteSelectorDisablesAllCapabilities(t *testing.T) {
	for _, test := range []struct {
		name    string
		enabled bool
		want    []string
	}{
		{name: "rollback", enabled: false, want: []string{"manufacturing.defineBom", "manufacturing.deleteBom", "manufacturing.restoreBom"}},
		{name: "enabled", enabled: true, want: []string{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := goManufacturingBomWriteDisabledCapabilities(test.enabled)
			if len(got) != len(test.want) {
				t.Fatalf("disabled capability count=%d, want %d", len(got), len(test.want))
			}
			for _, capabilityID := range test.want {
				if _, ok := got[capabilityID]; !ok {
					t.Errorf("%s is not disabled", capabilityID)
				}
			}
		})
	}
}

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

func TestGoOnboardingRouteEnabledFromEnvDefaultsOff(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: false},
		{value: "0", want: false},
		{value: "1", want: true},
		{value: "true", want: false},
	} {
		if got := goOnboardingRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goOnboardingRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoOrgRouteEnabledFromEnvDefaultsOnAndAllowsDisable(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goOrgRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goOrgRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoRoutinesRouteEnabledFromEnvDefaultsOnAndAllowsDisable(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goRoutinesRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goRoutinesRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoMemoryRouteEnabledFromEnvDefaultsOnAndAllowsDisable(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goMemoryRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goMemoryRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoModuleSettingsRouteEnabledFromEnvDefaultsOnAndAllowsDisable(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goModuleSettingsRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goModuleSettingsRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoPolicyRouteEnabledFromEnvDefaultsOnAndAllowsDisable(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goPolicyRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goPolicyRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoPortalInvoiceRouteEnabledFromEnvDefaultsOnAndAllowsDisable(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goPortalInvoiceRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goPortalInvoiceRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoSalesInvoiceRouteEnabledFromEnvDefaultsOnAndAllowsDisable(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goSalesInvoiceRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goSalesInvoiceRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoInventoryReadRouteEnabledFromEnvDefaultsOnAndAllowsDisable(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goInventoryReadRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goInventoryReadRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoSupportChannelsRouteEnabledFromEnvDefaultsOnAndAllowsDisable(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goSupportChannelsRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goSupportChannelsRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
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

func TestGoAnalyticsReportRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "0", want: false},
		{value: "1", want: true},
		{value: "true", want: true},
	} {
		if got := goAnalyticsReportRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goAnalyticsReportRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoMetricsRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goMetricsRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goMetricsRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoSetupRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goSetupRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goSetupRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoDashboardRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goDashboardRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goDashboardRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoTeamRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		name    string
		enabled func(string) bool
	}{
		{name: "read", enabled: goTeamReadRouteEnabledFromEnv},
		{name: "write", enabled: goTeamWriteRouteEnabledFromEnv},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, value := range []struct {
				value string
				want  bool
			}{
				{value: "", want: true},
				{value: "1", want: true},
				{value: "0", want: false},
			} {
				if got := test.enabled(value.value); got != value.want {
					t.Errorf("routeEnabled(%q) = %t, want %t", value.value, got, value.want)
				}
			}
		})
	}
}

func TestGoProjectsAndModulesReadRoutesDefaultOnAndAllowRollback(t *testing.T) {
	for _, test := range []struct {
		name    string
		enabled func(string) bool
	}{
		{name: "projects", enabled: goProjectsRouteEnabledFromEnv},
		{name: "modules read", enabled: goModulesReadRouteEnabledFromEnv},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, value := range []struct {
				value string
				want  bool
			}{
				{value: "", want: true},
				{value: "1", want: true},
				{value: "0", want: false},
			} {
				if got := test.enabled(value.value); got != value.want {
					t.Errorf("routeEnabled(%q) = %t, want %t", value.value, got, value.want)
				}
			}
		})
	}
}

func TestGoSalesOrdersRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goSalesOrdersRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goSalesOrdersRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoPosReadRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goPosReadRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goPosReadRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoPosShiftSummaryRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goPosShiftSummaryRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goPosShiftSummaryRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoPosCustomersRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goPosCustomersRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goPosCustomersRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoSupportCustomersRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goSupportCustomersRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goSupportCustomersRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoApprovalsReadRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goApprovalsReadRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goApprovalsReadRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestGoApprovalsDecisionRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goApprovalsDecisionRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goApprovalsDecisionRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
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

func TestGoAIConfigRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goAIConfigRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goAIConfigRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
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

func TestGoMessagingPresenceRouteEnabledFromEnvDefaultsOnAndAllowsRollback(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: true},
		{value: "1", want: true},
		{value: "0", want: false},
	} {
		if got := goMessagingPresenceRouteEnabledFromEnv(test.value); got != test.want {
			t.Errorf("goMessagingPresenceRouteEnabledFromEnv(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}
