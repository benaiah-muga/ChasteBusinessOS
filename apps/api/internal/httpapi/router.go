package httpapi

import (
	"log/slog"
	"net/http"
	"strings"
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

// NewRouterWithAuthAndOrgRoute mounts the full auth namespace only when an auth
// handler is explicitly supplied. Unsupported auth paths remain owned by Go
// and fail closed instead of reaching the base handler.
func NewRouterWithAuthAndOrgRoute(pinger Pinger, logger *slog.Logger, bridgeSecret string, policyReader PolicyReader, ledgerReader LedgerReader, orgMembershipChecker OrgMembershipChecker, capabilityExecutor CapabilityExecutor, metricsReader MetricsReader, approvalInboxReader ApprovalInboxReader, orgRoute, authRoute http.Handler, approvalDeciders ...ApprovalDecisionDecider) http.Handler {
	base := NewRouterWithOrgRoute(pinger, logger, bridgeSecret, policyReader, ledgerReader, orgMembershipChecker, capabilityExecutor, metricsReader, approvalInboxReader, orgRoute, approvalDeciders...)
	if authRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("/api/auth", http.NotFoundHandler())
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
	mux.Handle("/api/setup", setupRoute)
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
// the Go handler; other methods and subpaths fall through to the base handler.
func MountGoRoutinesRoute(base, route http.Handler, webhookRoute ...http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/routines", route)
	mux.Handle("POST /api/routines", route)
	if len(webhookRoute) > 0 && webhookRoute[0] != nil {
		mux.Handle("POST /api/routines/webhook/{token}", webhookRoute[0])
	}
	if base != nil {
		mux.Handle("HEAD /api/routines", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoMemoryRoute mounts only Settings memory collection GET and POST;
// unsupported methods and nested paths continue to the base handler.
func MountGoMemoryRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/memory", route)
	mux.Handle("POST /api/memory", route)
	if base != nil {
		mux.Handle("HEAD /api/memory", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoModuleSettingsRoute mounts only the Vite Settings module defaults
// collection. Other methods and nested paths continue to the base handler.
func MountGoModuleSettingsRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/module-settings", route)
	mux.Handle("POST /api/module-settings", route)
	if base != nil {
		mux.Handle("HEAD /api/module-settings", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoAIConfigRoute owns the authenticated AI provider configuration API.
func MountGoAIConfigRoute(base, route http.Handler) http.Handler {
	if route == nil {
		route = http.NotFoundHandler()
	}
	mux := http.NewServeMux()
	mux.Handle("/api/ai-config", route)
	mux.Handle("/api/ai-config/", http.NotFoundHandler())
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoBankingRoute owns the legacy Banking REST contract for authenticated
// clients while dispatching its operations through the capability executor.
func MountGoBankingRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("/api/banking", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoAccountingBudgetsRoute owns the authenticated budget scenario REST API.
func MountGoAccountingBudgetsRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/accounting/budgets", route)
	mux.Handle("POST /api/accounting/budgets", route)
	if base != nil {
		mux.Handle("HEAD /api/accounting/budgets", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoExpensesRoute owns the authenticated expense claims REST API.
func MountGoExpensesRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/expenses", route)
	mux.Handle("POST /api/expenses", route)
	if base != nil {
		mux.Handle("HEAD /api/expenses", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoAccountingRoute owns the authenticated Accounting overview and action API.
func MountGoAccountingRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/accounting", route)
	mux.Handle("POST /api/accounting", route)
	if base != nil {
		mux.Handle("HEAD /api/accounting", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoHRRoute owns the authenticated HR people and payroll API.
func MountGoHRRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/hr", route)
	mux.Handle("POST /api/hr", route)
	if base != nil {
		mux.Handle("HEAD /api/hr", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoMarketingRoute owns the authenticated Marketing overview and action API.
func MountGoMarketingRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/marketing", route)
	mux.Handle("POST /api/marketing", route)
	if base != nil {
		mux.Handle("HEAD /api/marketing", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoPOSWriteRoute owns authenticated POS actions; collection reads remain
// mounted separately so the two methods can migrate independently.
func MountGoPOSWriteRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/pos", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoAccountingTaxRoute owns the authenticated Accounting tax API.
func MountGoAccountingTaxRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/accounting/tax", route)
	mux.Handle("POST /api/accounting/tax", route)
	if base != nil {
		mux.Handle("HEAD /api/accounting/tax", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoAccountingPeriodCloseRoute owns the authenticated period-close API.
func MountGoAccountingPeriodCloseRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/accounting/close", route)
	mux.Handle("POST /api/accounting/close", route)
	if base != nil {
		mux.Handle("HEAD /api/accounting/close", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoTimeRoute owns authenticated HR time reporting and entry actions.
func MountGoTimeRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/time", route)
	mux.Handle("POST /api/time", route)
	if base != nil {
		mux.Handle("HEAD /api/time", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoDocumentsEditorWorkspaceRoute owns the authored-document draft,
// presence, and editing-lock endpoint when supplied by server configuration.
func MountGoDocumentsEditorWorkspaceRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/docs/{id}/workspace", route)
	mux.Handle("DELETE /api/docs/{id}/workspace", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoDocumentsAssistRoute owns authenticated document-writing assistance.
func MountGoDocumentsAssistRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/docs/assist", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoMessagingPresenceRoute owns the exact Vite conversation presence path.
func MountGoMessagingPresenceRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		mux.Handle(method+" /api/conversations/{id}/presence", route)
	}
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

func MountGoMessagingAgentRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/conversations/{id}/agent-reply", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoPolicySessionRoute mounts only the Vite Settings policy collection.
// Other methods and nested paths continue to the base handler.
func MountGoPolicySessionRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/policy", route)
	mux.Handle("POST /api/policy", route)
	if base != nil {
		mux.Handle("HEAD /api/policy", base)
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

// MountGoCRMReadRoute mounts only the CRM collection GET. CRM writes and other
// CRM endpoints continue to their current owner.
func MountGoCRMReadRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/crm", route)
	mux.Handle("GET /api/customers", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoCRMFollowUpDraftRoute owns the authenticated Vite follow-up draft.
func MountGoCRMFollowUpDraftRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/crm/follow-up-draft", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoApprovalsReadRoute mounts only the approvals inbox GET. Decisions
// remain with their current owner until they pass their own migration gate.
func MountGoApprovalsReadRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/approvals", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			route.ServeHTTP(w, r)
			return
		}
		if base != nil {
			base.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoApprovalsDecisionRoute mounts only approval decision POSTs. Inbox reads
// and every other method or path retain their existing owner.
func MountGoApprovalsDecisionRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/approvals", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			route.ServeHTTP(w, r)
			return
		}
		if base != nil {
			base.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoMessageAttachmentDownloadRoute mounts the session-authenticated Go
// binary download handler for one message attachment.
func MountGoMessageAttachmentDownloadRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/message-attachments/{id}", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoDocumentContentDownloadRoute owns uploaded document binary reads.
func MountGoDocumentContentDownloadRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/go/documents/{id}/content", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoPOSReadRoute mounts only the POS collection GET. Actions remain with
// the existing owner until their write routes pass their own migration gate.
func MountGoPOSReadRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pos", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			route.ServeHTTP(w, r)
			return
		}
		if base != nil {
			base.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoPOSCustomersRoute sends only the POS customer lookup GET to Go.
func MountGoPOSCustomersRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pos/customers", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			route.ServeHTTP(w, r)
			return
		}
		if base != nil {
			base.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoSupportCustomersRoute mounts only the Support customer-picker GET.
// CRM writes and the broader CRM customer directory remain with their owner.
func MountGoSupportCustomersRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/support/customers", route)
	if base != nil {
		mux.Handle("HEAD /api/support/customers", base)
		mux.Handle("/", base)
	}
	return mux
}

// MountGoSupportReplyDraftRoute owns authenticated Vite support reply drafts.
func MountGoSupportReplyDraftRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/support/draft", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoPOSShiftSummaryRoute sends only the POS shift summary POST to Go.
func MountGoPOSShiftSummaryRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pos/shift-summary", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			route.ServeHTTP(w, r)
			return
		}
		if base != nil {
			base.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoSalesOrdersRoute sends only the orders collection GET to Go. The
// invoice detail route and all other sales methods remain with the base owner.
func MountGoSalesOrdersRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/sales", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			route.ServeHTTP(w, r)
			return
		}
		if base != nil {
			base.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoSalesCustomersRoute sends only the Sales customer picker GET to Go.
func MountGoSalesCustomersRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/sales/customers", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			route.ServeHTTP(w, r)
			return
		}
		if base != nil {
			base.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoBusinessRoutes mounts the supplied API handlers. Unprovided handlers
// continue to fall through to the existing API owner.
func MountGoBusinessRoutes(base, portalInvoiceRoute, salesInvoiceRoute, supportChannelsRoute, sessionCapabilityRoute, modulesRoute, modulesWriteRoute, projectsRoute, teamReadRoute, teamWriteRoute, brandingRoute, analyticsRoute, dashboardRoute, ledgerRoute, directMetricsRoute http.Handler, analyticsReportRoute ...http.Handler) http.Handler {
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
	if modulesRoute != nil || modulesWriteRoute != nil {
		mux.HandleFunc("/api/modules", func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				if modulesRoute != nil {
					modulesRoute.ServeHTTP(w, r)
					return
				}
			case http.MethodPost:
				if modulesWriteRoute != nil {
					modulesWriteRoute.ServeHTTP(w, r)
					return
				}
			}
			if base != nil {
				base.ServeHTTP(w, r)
				return
			}
			http.NotFound(w, r)
		})
	}
	if projectsRoute != nil {
		mux.HandleFunc("/api/projects", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet || r.Method == http.MethodPost {
				projectsRoute.ServeHTTP(w, r)
				return
			}
			if base != nil {
				base.ServeHTTP(w, r)
				return
			}
			http.NotFound(w, r)
		})
	}
	if teamReadRoute != nil || teamWriteRoute != nil {
		mux.HandleFunc("/api/team", func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				if teamReadRoute != nil {
					teamReadRoute.ServeHTTP(w, r)
					return
				}
			case http.MethodPost:
				if teamWriteRoute != nil {
					teamWriteRoute.ServeHTTP(w, r)
					return
				}
			}
			if base != nil {
				base.ServeHTTP(w, r)
				return
			}
			http.NotFound(w, r)
		})
	}
	if brandingRoute != nil {
		mux.Handle("GET /api/branding", brandingRoute)
		mux.Handle("POST /api/branding", brandingRoute)
	}
	if analyticsRoute != nil {
		mux.Handle("GET /api/analytics", analyticsRoute)
	}
	if len(analyticsReportRoute) > 0 && analyticsReportRoute[0] != nil {
		mux.Handle("POST /api/analytics", analyticsReportRoute[0])
	}
	if dashboardRoute != nil {
		mux.Handle("GET /api/dashboard", dashboardRoute)
	}
	if ledgerRoute != nil {
		mux.Handle("GET /api/ledger", ledgerRoute)
	}
	if directMetricsRoute != nil {
		mux.HandleFunc("/api/metrics", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet {
				directMetricsRoute.ServeHTTP(w, r)
				return
			}
			if base != nil {
				base.ServeHTTP(w, r)
				return
			}
			http.NotFound(w, r)
		})
	}
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoTeamSSORoute gives the Go API sole ownership of SSO connection
// management, including unsupported methods, so they cannot fall through to
// the compatibility app.
func MountGoTeamSSORoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("/api/team/sso", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoSessionReadRoutes mounts session reads and durable-run reads and
// creates only when their handlers are explicitly enabled by API configuration.
func MountGoSessionReadRoutes(base, sessionsListRoute, sessionsDetailRoute, durableRunsRoute http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/durable-runs" && durableRunsRoute != nil {
			durableRunsRoute.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodGet {
			switch {
			case r.URL.Path == "/api/sessions" && sessionsListRoute != nil:
				sessionsListRoute.ServeHTTP(w, r)
				return
			case sessionsDetailRoute != nil && sessionDetailRoutePath(r.URL.Path):
				sessionsDetailRoute.ServeHTTP(w, r)
				return
			case r.URL.Path == "/api/durable-runs" && durableRunsRoute != nil:
				durableRunsRoute.ServeHTTP(w, r)
				return
			case durableRunsRoute != nil && durableRunDetailRoutePath(r.URL.Path):
				durableRunsRoute.ServeHTTP(w, r)
				return
			}
		}
		if base != nil {
			base.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
}

func sessionDetailRoutePath(path string) bool {
	if !strings.HasPrefix(path, "/api/sessions/") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(path, "/api/sessions/"), "/")
	if len(parts) == 1 {
		return isUUID(parts[0])
	}
	return len(parts) == 2 && isUUID(parts[0]) && parts[1] == "replay"
}

func durableRunDetailRoutePath(path string) bool {
	if !strings.HasPrefix(path, "/api/durable-runs/") {
		return false
	}
	return isUUID(strings.TrimPrefix(path, "/api/durable-runs/"))
}

func MountGoNotificationsRoute(base, notificationsRoute, notificationReadRoute http.Handler) http.Handler {
	if notificationsRoute == nil && notificationReadRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	methods := make([]string, 0, 2)
	if notificationsRoute != nil {
		methods = append(methods, http.MethodGet)
	}
	if notificationReadRoute != nil {
		methods = append(methods, http.MethodPost)
	}
	mux.HandleFunc("/api/notifications", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			if notificationsRoute != nil {
				notificationsRoute.ServeHTTP(w, r)
				return
			}
		case http.MethodPost:
			if notificationReadRoute != nil {
				notificationReadRoute.ServeHTTP(w, r)
				return
			}
		default:
			w.Header().Set("Allow", strings.Join(methods, ", "))
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Pragma", "no-cache")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		if base != nil {
			base.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoTeamRoute gives the active Go team methods exact-path ownership while
// leaving disabled GET/POST methods available to the existing compatibility route.
func MountGoTeamRoute(base, teamReadRoute, teamWriteRoute http.Handler) http.Handler {
	if teamReadRoute == nil && teamWriteRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	methods := make([]string, 0, 2)
	if teamReadRoute != nil {
		methods = append(methods, http.MethodGet)
	}
	if teamWriteRoute != nil {
		methods = append(methods, http.MethodPost)
	}
	mux.HandleFunc("/api/team", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/team" {
			if base != nil {
				base.ServeHTTP(w, r)
				return
			}
			http.NotFound(w, r)
			return
		}
		switch r.Method {
		case http.MethodGet:
			if teamReadRoute != nil {
				teamReadRoute.ServeHTTP(w, r)
				return
			}
		case http.MethodPost:
			if teamWriteRoute != nil {
				teamWriteRoute.ServeHTTP(w, r)
				return
			}
		default:
			w.Header().Set("Allow", strings.Join(methods, ", "))
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Pragma", "no-cache")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		if base != nil {
			base.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
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
	// The organization route is registered when the caller supplies it. The API
	// server mounts it by default with a direct session resolver; a disabled or
	// unavailable route does not fall back to the legacy app.
	if orgRoute != nil {
		mux.Handle("/api/org", orgRoute)
	}
	return mux
}
