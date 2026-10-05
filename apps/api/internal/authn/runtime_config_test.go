package authn

import "testing"

func TestProductionAuthRouteRequiresExplicitHTTPSOriginAndSecureCookie(t *testing.T) {
	for _, tc := range []struct {
		name, origin, secure string
		wantErr              bool
	}{
		{name: "missing origin", secure: "true", wantErr: true},
		{name: "localhost fallback", origin: "", secure: "true", wantErr: true},
		{name: "http origin", origin: "http://auth.example.test", secure: "true", wantErr: true},
		{name: "path is not an origin", origin: "https://auth.example.test/path", secure: "true", wantErr: true},
		{name: "implicit cookie policy", origin: "https://auth.example.test", secure: "", wantErr: true},
		{name: "insecure cookie policy", origin: "https://auth.example.test", secure: "false", wantErr: true},
		{name: "explicit secure policy", origin: "https://auth.example.test", secure: "true"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config, err := ResolveAuthRouteRuntime("production", tc.origin, tc.secure, "http://localhost:3000")
			if (err != nil) != tc.wantErr {
				t.Fatalf("config=%+v err=%v", config, err)
			}
			if err == nil && (config.BaseURL != "https://auth.example.test/api/auth" || !config.SecureCookie) {
				t.Fatalf("production config=%+v", config)
			}
		})
	}
}

func TestDevelopmentAuthRouteCanUseLocalOriginButSecurePolicyIsParsed(t *testing.T) {
	config, err := ResolveAuthRouteRuntime("development", "", "true", "http://localhost:3000")
	if err != nil {
		t.Fatal(err)
	}
	if config.BaseURL != "http://localhost:3000/api/auth" || !config.SecureCookie || len(config.TrustedOrigins) != 2 {
		t.Fatalf("development auth config=%+v", config)
	}
	if _, err := ResolveAuthRouteRuntime("development", "", "sometimes", "http://localhost:3000"); err == nil {
		t.Fatal("invalid secure-cookie policy was accepted")
	}
}

func TestAuthModeIsRequiredAndProductionIgnoresNodeEnv(t *testing.T) {
	for _, mode := range []string{"", "staging", "Production"} {
		if _, err := ResolveAuthRouteRuntime(mode, "", "", "http://localhost:3000"); err == nil {
			t.Fatalf("mode %q was accepted", mode)
		}
	}
	for _, tc := range []struct {
		name, origin, secure string
	}{
		{name: "missing origin", secure: "true"},
		{name: "missing secure policy", origin: "https://app.example.test"},
		{name: "http origin", origin: "http://app.example.test", secure: "true"},
		{name: "false secure policy", origin: "https://app.example.test", secure: "false"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ResolveAuthRouteRuntime("production", tc.origin, tc.secure, "http://localhost:3000"); err == nil {
				t.Fatal("production auth accepted implicit or insecure settings")
			}
		})
	}
	config, err := ResolveAuthRouteRuntime("production", "https://app.example.test", "true", "http://localhost:3000")
	if err != nil || !config.SecureCookie || config.BaseURL != "https://app.example.test/api/auth" {
		t.Fatalf("production config=%+v err=%v", config, err)
	}
}
