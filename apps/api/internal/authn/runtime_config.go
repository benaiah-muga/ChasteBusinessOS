package authn

import (
	"errors"
	"net/url"
	"strings"
)

type AuthRouteRuntime struct {
	BaseURL        string
	TrustedOrigins []string
	SecureCookie   bool
}

// ResolveAuthRouteRuntime rejects an implicit or insecure production browser
// origin. Local development may retain the legacy app URL fallback.
func ResolveAuthRouteRuntime(mode, publicOrigin, secureCookiePolicy, appURL string) (AuthRouteRuntime, error) {
	var result AuthRouteRuntime
	switch mode {
	case "development":
	case "production":
		if publicOrigin == "" || secureCookiePolicy != "true" {
			return result, errors.New("production auth requires GO_AUTH_PUBLIC_ORIGIN and GO_AUTH_SECURE_COOKIE=true")
		}
		parsed, err := parseOrigin(publicOrigin)
		if err != nil || parsed.Scheme != "https" {
			return result, errors.New("production auth public origin must be an HTTPS origin")
		}
		result.BaseURL = originOf(parsed) + "/api/auth"
		result.TrustedOrigins = []string{originOf(parsed)}
		result.SecureCookie = true
		return result, nil
	default:
		return result, errors.New("GO_AUTH_MODE must be explicitly set to development or production when GO_AUTH_ROUTE=1")
	}

	if publicOrigin != "" {
		parsed, err := parseOrigin(publicOrigin)
		if err != nil {
			return result, errors.New("auth public origin must be an HTTP(S) origin")
		}
		appURL = originOf(parsed)
	}
	if appURL == "" {
		appURL = "http://localhost:3000"
	}
	parsed, err := url.Parse(appURL)
	if err != nil || parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return result, errors.New("auth app URL must be an absolute HTTP(S) URL")
	}
	if secureCookiePolicy != "" && secureCookiePolicy != "true" && secureCookiePolicy != "false" {
		return result, errors.New("GO_AUTH_SECURE_COOKIE must be true or false")
	}
	result.BaseURL = strings.TrimRight(appURL, "/") + "/api/auth"
	result.TrustedOrigins = []string{originOf(parsed)}
	if mode == "development" {
		result.TrustedOrigins = append(result.TrustedOrigins, "http://localhost:3001")
	}
	result.SecureCookie = secureCookiePolicy == "true"
	return result, nil
}

func parseOrigin(value string) (*url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil || parsed.User != nil || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("invalid origin")
	}
	return parsed, nil
}
