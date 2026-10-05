package httpapi

import (
	"log/slog"
	"net/http"
)

func NewRouter(pinger Pinger, logger *slog.Logger, bridgeSecret string, policyReader PolicyReader, ledgerReader LedgerReader, orgMembershipChecker OrgMembershipChecker, capabilityExecutor CapabilityExecutor, approvalDeciders ...ApprovalDecisionDecider) http.Handler {
	return newRouter(pinger, logger, bridgeSecret, policyReader, ledgerReader, orgMembershipChecker, capabilityExecutor, nil, approvalDeciders...)
}

func NewRouterWithMetrics(pinger Pinger, logger *slog.Logger, bridgeSecret string, policyReader PolicyReader, ledgerReader LedgerReader, orgMembershipChecker OrgMembershipChecker, capabilityExecutor CapabilityExecutor, metricsReader MetricsReader, approvalDeciders ...ApprovalDecisionDecider) http.Handler {
	return newRouter(pinger, logger, bridgeSecret, policyReader, ledgerReader, orgMembershipChecker, capabilityExecutor, metricsReader, approvalDeciders...)
}

func newRouter(pinger Pinger, logger *slog.Logger, bridgeSecret string, policyReader PolicyReader, ledgerReader LedgerReader, orgMembershipChecker OrgMembershipChecker, capabilityExecutor CapabilityExecutor, metricsReader MetricsReader, approvalDeciders ...ApprovalDecisionDecider) http.Handler {
	return newRouterWithApprovalInbox(pinger, logger, bridgeSecret, policyReader, ledgerReader, orgMembershipChecker, capabilityExecutor, metricsReader, nil, nil, approvalDeciders...)
}

// NewRouterWithOrgRoute mounts the organization route in addition to the bridge
// endpoints. It is separate from NewRouterWithApprovalInbox so existing callers
// keep compiling unchanged while the route is still being proven.
func NewRouterWithOrgRoute(pinger Pinger, logger *slog.Logger, bridgeSecret string, policyReader PolicyReader, ledgerReader LedgerReader, orgMembershipChecker OrgMembershipChecker, capabilityExecutor CapabilityExecutor, metricsReader MetricsReader, approvalInboxReader ApprovalInboxReader, orgRoute http.Handler, approvalDeciders ...ApprovalDecisionDecider) http.Handler {
	return newRouterWithApprovalInbox(pinger, logger, bridgeSecret, policyReader, ledgerReader, orgMembershipChecker, capabilityExecutor, metricsReader, approvalInboxReader, orgRoute, approvalDeciders...)
}

// NewRouterWithAuthAndOrgRoute mounts auth routes only when an auth handler is
// explicitly supplied. Production route ownership remains with the legacy app
// until GO_AUTH_ROUTE is enabled after compatibility review.
func NewRouterWithAuthAndOrgRoute(pinger Pinger, logger *slog.Logger, bridgeSecret string, policyReader PolicyReader, ledgerReader LedgerReader, orgMembershipChecker OrgMembershipChecker, capabilityExecutor CapabilityExecutor, metricsReader MetricsReader, approvalInboxReader ApprovalInboxReader, orgRoute, authRoute http.Handler, approvalDeciders ...ApprovalDecisionDecider) http.Handler {
	base := NewRouterWithOrgRoute(pinger, logger, bridgeSecret, policyReader, ledgerReader, orgMembershipChecker, capabilityExecutor, metricsReader, approvalInboxReader, orgRoute, approvalDeciders...)
	if authRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("/api/auth/", http.StripPrefix("/api/auth", authRoute))
	mux.Handle("/", base)
	return mux
}

// MountSupportPublicRoute mounts the unauthenticated website widget API only
// when explicitly supplied by the server configuration.
func MountSupportPublicRoute(base, supportRoute http.Handler) http.Handler {
	if supportRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("/api/support/public", supportRoute)
	mux.Handle("/", base)
	return mux
}

// MountSetupRoute mounts the Go-owned dashboard setup checklist when enabled.
func MountSetupRoute(base, setupRoute http.Handler) http.Handler {
	if setupRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/setup", setupRoute)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountMyWorkRoute mounts the Go-owned work queue when enabled.
func MountMyWorkRoute(base, myWorkRoute http.Handler) http.Handler {
	if myWorkRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/my-work", myWorkRoute)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountSignalsRoute mounts the Go-owned signals feed only when explicitly
// supplied by server configuration.
func MountSignalsRoute(base, signalsRoute http.Handler) http.Handler {
	if signalsRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/signals", signalsRoute)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountMyWorkSummaryRoute mounts the Go work brief only when enabled.
func MountMyWorkSummaryRoute(base, summaryRoute http.Handler) http.Handler {
	if summaryRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/my-work/summarize", summaryRoute)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoSCIMReadRoute mounts only the Go SCIM user reads when explicitly
// supplied.
func MountGoSCIMReadRoute(base, scimRoute http.Handler) http.Handler {
	return MountGoSCIMRoutes(base, scimRoute, nil)
}

// MountGoSCIMRoutes keeps SCIM reads and writes independently opt-in.
func MountGoSCIMRoutes(base, scimReadRoute, scimWriteRoute http.Handler) http.Handler {
	if scimReadRoute == nil && scimWriteRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	if scimReadRoute != nil {
		mux.Handle("GET /api/scim/v2/Users", scimReadRoute)
		mux.Handle("GET /api/scim/v2/Users/{id}", scimReadRoute)
		fallback := base
		if fallback == nil {
			fallback = http.NotFoundHandler()
		}
		mux.Handle("HEAD /api/scim/v2/Users", fallback)
		mux.Handle("HEAD /api/scim/v2/Users/{id}", fallback)
	}
	if scimWriteRoute != nil {
		mux.Handle("POST /api/scim/v2/Users", scimWriteRoute)
		mux.Handle("DELETE /api/scim/v2/Users/{id}", scimWriteRoute)
	}
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoSCIMTokenManagementRoute mounts browser or API session management for
// SCIM bearer tokens when explicitly supplied.
func MountGoSCIMTokenManagementRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("/api/scim/tokens", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoRoutinesRoute mounts only the routine collection paths supported by
// the Go handler; other methods and subpaths continue to the legacy route.
func MountGoRoutinesRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/routines", route)
	mux.Handle("POST /api/routines", route)
	if base != nil {
		mux.Handle("HEAD /api/routines", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoInventoryReadRoute mounts only the read-only inventory collection
// endpoint. Writes and nested inventory paths continue to the existing owner.
func MountGoInventoryReadRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/inventory", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoBusinessRoutes mounts API handlers only when their Go route is opted in.
// Unprovided handlers continue to fall through to the existing API owner.
func MountGoBusinessRoutes(base, portalInvoiceRoute, salesInvoiceRoute, supportChannelsRoute, sessionCapabilityRoute, modulesRoute, modulesWriteRoute, projectsRoute, teamReadRoute, teamWriteRoute, brandingRoute, analyticsRoute, dashboardRoute, ledgerRoute, directMetricsRoute http.Handler) http.Handler {
	mux := http.NewServeMux()
	if portalInvoiceRoute != nil {
		mux.Handle("GET /api/portal/invoice/{token}", portalInvoiceRoute)
	}
	if salesInvoiceRoute != nil {
		mux.Handle("GET /api/sales/{orderId}", salesInvoiceRoute)
	}
	if supportChannelsRoute != nil {
		mux.Handle("/api/support/channels", supportChannelsRoute)
	}
	if sessionCapabilityRoute != nil {
		mux.Handle("/api/capabilities/execute", sessionCapabilityRoute)
	}
	if modulesRoute != nil {
		mux.Handle("GET /api/modules", modulesRoute)
	}
	if modulesWriteRoute != nil {
		mux.Handle("POST /api/modules", modulesWriteRoute)
	}
	if projectsRoute != nil {
		mux.Handle("GET /api/projects", projectsRoute)
		mux.Handle("POST /api/projects", projectsRoute)
	}
	if teamReadRoute != nil {
		mux.Handle("GET /api/team", teamReadRoute)
	}
	if teamWriteRoute != nil {
		mux.Handle("POST /api/team", teamWriteRoute)
	}
	if brandingRoute != nil {
		mux.Handle("GET /api/branding", brandingRoute)
		mux.Handle("POST /api/branding", brandingRoute)
	}
	if analyticsRoute != nil {
		mux.Handle("GET /api/analytics", analyticsRoute)
		mux.Handle("POST /api/analytics", analyticsRoute)
	}
	if dashboardRoute != nil {
		mux.Handle("GET /api/dashboard", dashboardRoute)
	}
	if ledgerRoute != nil {
		mux.Handle("GET /api/ledger", ledgerRoute)
	}
	if directMetricsRoute != nil {
		mux.Handle("GET /api/metrics", directMetricsRoute)
	}
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoSessionReadRoutes mounts session and durable-run reads only when
// their handlers are explicitly enabled by the API process configuration.
func MountGoSessionReadRoutes(base, sessionsListRoute, sessionsDetailRoute, durableRunsRoute, notificationsRoute http.Handler) http.Handler {
	mux := http.NewServeMux()
	if sessionsListRoute != nil {
		mux.Handle("GET /api/sessions", sessionsListRoute)
	}
	if sessionsDetailRoute != nil {
		mux.Handle("GET /api/sessions/{id}", sessionsDetailRoute)
		mux.Handle("GET /api/sessions/{id}/replay", sessionsDetailRoute)
	}
	if durableRunsRoute != nil {
		mux.Handle("GET /api/durable-runs", durableRunsRoute)
		mux.Handle("GET /api/durable-runs/{id}", durableRunsRoute)
	}
	if notificationsRoute != nil {
		mux.Handle("GET /api/notifications", notificationsRoute)
	}
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

func MountGoNotificationReadRoute(base, notificationReadRoute http.Handler) http.Handler {
	if notificationReadRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/notifications", notificationReadRoute)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

func NewRouterWithApprovalInbox(pinger Pinger, logger *slog.Logger, bridgeSecret string, policyReader PolicyReader, ledgerReader LedgerReader, orgMembershipChecker OrgMembershipChecker, capabilityExecutor CapabilityExecutor, metricsReader MetricsReader, approvalInboxReader ApprovalInboxReader, approvalDeciders ...ApprovalDecisionDecider) http.Handler {
	return newRouterWithApprovalInbox(pinger, logger, bridgeSecret, policyReader, ledgerReader, orgMembershipChecker, capabilityExecutor, metricsReader, approvalInboxReader, nil, approvalDeciders...)
}

func newRouterWithApprovalInbox(pinger Pinger, logger *slog.Logger, bridgeSecret string, policyReader PolicyReader, ledgerReader LedgerReader, orgMembershipChecker OrgMembershipChecker, capabilityExecutor CapabilityExecutor, metricsReader MetricsReader, approvalInboxReader ApprovalInboxReader, orgRoute http.Handler, approvalDeciders ...ApprovalDecisionDecider) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/health", NewHealthHandler(pinger, logger))
	mux.Handle("GET /__go/metrics", NewGoMetricsHandler(bridgeSecret, metricsReader, logger))
	mux.Handle("GET /__go/policy", NewGoPolicyHandler(bridgeSecret, policyReader, logger))
	mux.Handle("GET /__go/ledger", NewGoLedgerHandler(bridgeSecret, ledgerReader, logger))
	mux.Handle("GET /__go/crm", NewGoCRMReadHandler(bridgeSecret, capabilityExecutor, logger))
	mux.Handle("GET /__go/projects", NewGoProjectsReadHandler(bridgeSecret, capabilityExecutor, logger))
	mux.Handle("POST /__go/org/switch", NewGoOrgSwitchHandler(bridgeSecret, orgMembershipChecker, logger))
	mux.Handle("POST /__go/capability/execute", NewGoCapabilityHandler(bridgeSecret, capabilityExecutor, logger))
	var approvalDecider ApprovalDecisionDecider
	if len(approvalDeciders) > 0 {
		approvalDecider = approvalDeciders[0]
	}
	mux.Handle("POST /__go/approval/decide", NewGoApprovalDecisionHandler(bridgeSecret, approvalDecider, logger))
	mux.Handle("POST /__go/approvals/inbox", NewGoApprovalInboxHandler(bridgeSecret, approvalInboxReader, logger))
	// The organization route is registered only when the caller supplies it. It
	// resolves the browser session itself rather than trusting an assertion, so
	// it is opt-in: until the deployment provides a session resolver the route
	// stays unmounted and the legacy app keeps serving it.
	if orgRoute != nil {
		mux.Handle("/api/org", orgRoute)
	}
	return mux
}
