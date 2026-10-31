package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

func main() {
	cookie := os.Getenv("PROBE_COOKIE")
	activeOrg := os.Getenv("PROBE_ACTIVE_ORG")
	if cookie == "" {
		fmt.Println("no PROBE_COOKIE")
		os.Exit(2)
	}
	pool, err := pgxpool.New(context.Background(), os.Getenv("DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer pool.Close()
	resolver, err := session.NewResolver(pool, os.Getenv("BETTER_AUTH_SECRET"))
	if err != nil {
		panic(err)
	}
	// Build a real request so the probe exercises the same cookie-reading path
	// production uses, including the percent-decoding that browser cookies need.
	req := &http.Request{Header: http.Header{}}
	req.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: cookie})
	if activeOrg != "" {
		req.AddCookie(&http.Cookie{Name: session.ActiveOrgCookieName, Value: activeOrg})
	}
	resolved, err := resolver.Resolve(
		context.Background(),
		session.CookieFromRequest(req, session.SessionCookieName),
		session.CookieFromRequest(req, session.ActiveOrgCookieName),
	)
	if err != nil {
		out, _ := json.Marshal(map[string]string{"error": err.Error()})
		fmt.Println(string(out))
		os.Exit(3)
	}
	var orgID *string
	if resolved.OrgID != nil {
		orgID = resolved.OrgID
	}
	permissions := make([]string, 0, len(resolved.Permissions))
	for key := range resolved.Permissions {
		permissions = append(permissions, key)
	}
	// Sort for a stable diff against the TypeScript oracle.
	sortStrings(permissions)
	var modules []string
	if resolved.ModulesRestricted {
		modules = resolved.EnabledModules
	}
	var currency *string
	currency = resolved.BaseCurrency
	// Optional: report how the middleware's permission guard would decide, so the
	// parity harness can compare it against what the legacy app actually allows.
	decisions := map[string]bool{}
	if requested := os.Getenv("PROBE_PERMISSIONS"); requested != "" {
		for _, permission := range strings.Split(requested, ",") {
			permission = strings.TrimSpace(permission)
			if permission == "" {
				continue
			}
			decisions[permission] = session.RequirePermission(permission)(resolved) == nil
		}
	}

	out, _ := json.MarshalIndent(map[string]any{
		"permissionDecisions": decisions,
		"userId":              resolved.UserID,
		"email":               resolved.Email,
		"emailVerified":       resolved.EmailVerified,
		"orgId":               orgID,
		"permissions":         permissions,
		"allOrgIds":           resolved.AllOrgIDs,
		"enabledModules":      modules,
		"baseCurrency":        currency,
	}, "", "  ")
	fmt.Println(string(out))
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
