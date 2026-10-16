package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authn"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dashboard"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/httpapi"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/metrics"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/orgswitch"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/policy"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("api server stopped", "error", err)
		os.Exit(1)
	}
}

func goMessageAttachmentDownloadRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goMyWorkRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goAnalyticsRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goAnalyticsReportRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goMetricsRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goSetupRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goDashboardRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goTeamReadRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goTeamWriteRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goProjectsRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goRoutinesRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goMemoryRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goModuleSettingsRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goDocumentsEditorWorkspaceEnabledFromEnv(value string) bool {
	return value != "0"
}

func goDocumentsAssistRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goDocumentsCapabilityReadsEnabledFromEnv(value string) bool {
	return value != "0"
}

func goMessagingPresenceRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goPolicyRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goSalesOrdersRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goModulesReadRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goSessionsRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goDurableRunsRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goPosReadRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goPosShiftSummaryRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goPosCustomersRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goSupportCustomersRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goApprovalsReadRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goApprovalsDecisionRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goOnboardingRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goOrgRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goPortalInvoiceRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goSalesInvoiceRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goInventoryReadRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goCRMFollowUpDraftRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goSupportChannelsRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func run(logger *slog.Logger) error {
	databaseURL := os.Getenv("GO_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("GO_DATABASE_URL is required")
	}

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		return errors.New("could not configure PostgreSQL pool")
	}
	defer pool.Close()
	if err := dbx.VerifyAppRuntimeRole(context.Background(), pool); err != nil {
		return errors.New("GO_DATABASE_URL must use the chaste_app role without superuser or BYPASSRLS privileges")
	}

	addr := os.Getenv("GO_API_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}

	capabilityExecutor := capability.NewExecutor(pool, os.Getenv("NOTIFICATION_WEBHOOK_URL"), os.Getenv("SMTP_HOST"), os.Getenv("SMTP_TO"))
	approvalDecider := capability.NewApprovalDecider(pool, capabilityExecutor)
	approvalInboxReader := httpapi.NewPostgresApprovalInboxReader(pool)
	var sessionResolver *session.Resolver
	getSessionResolver := func() (*session.Resolver, error) {
		if sessionResolver != nil {
			return sessionResolver, nil
		}
		secret := os.Getenv("BETTER_AUTH_SECRET")
		if secret == "" {
			return nil, errors.New("Go session routes require BETTER_AUTH_SECRET")
		}
		resolver, err := session.NewResolver(pool, secret)
		if err != nil {
			return nil, errors.New("BETTER_AUTH_SECRET is unusable for session resolution: " + err.Error())
		}
		sessionResolver = resolver
		return resolver, nil
	}
	trustedProxyCIDRs, err := httpapi.ParseTrustedProxyCIDRs(os.Getenv("GO_API_TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return err
	}

	// The organization route resolves the browser session itself instead of
	// trusting an assertion minted by the legacy app. It is mounted by default;
	// GO_ORG_ROUTE=0 disables the Go handler.
	var orgRoute http.Handler
	if goOrgRouteEnabledFromEnv(os.Getenv("GO_ORG_ROUTE")) {
		resolver, err := getSessionResolver()
		if err != nil {
			return err
		}
		orgRoute = httpapi.NewOrgHandler(httpapi.NewPgOrgRepository(pool), resolver, os.Getenv("BETTER_AUTH_SECRET"), logger, trustedProxyCIDRs)
		logger.Info("Go organization route mounted", "path", "/api/org")
	}
	var aiConfigRoute http.Handler
	aiConfigResolver, aiConfigResolverErr := getSessionResolver()
	if aiConfigResolverErr != nil {
		return aiConfigResolverErr
	}
	aiConfigRoute = httpapi.NewAIConfigSessionHandler(pool, aiConfigResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go AI config route mounted", "path", "/api/ai-config")
	var documentsEditorWorkspaceRoute http.Handler
	if goDocumentsEditorWorkspaceEnabledFromEnv(os.Getenv("GO_DOCUMENTS_EDITOR_WORKSPACE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		documentsEditorWorkspaceRoute = httpapi.NewDocumentsEditorWorkspaceHandler(pool, resolver, logger, trustedProxyCIDRs)
		logger.Info("Go authored document workspace route mounted", "path", "/api/docs/{id}/workspace")
	}
	var documentsAssistRoute http.Handler
	if goDocumentsAssistRouteEnabledFromEnv(os.Getenv("GO_DOCUMENTS_ASSIST_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		documentsAssistRoute = httpapi.NewDocumentsAssistSessionHandler(pool, resolver, logger, trustedProxyCIDRs)
		logger.Info("Go document assistant route mounted", "path", "/api/docs/assist")
	}
	var messagingPresenceRoute http.Handler
	var messagingAgentRoute http.Handler
	if goMessagingPresenceRouteEnabledFromEnv(os.Getenv("GO_MESSAGING_PRESENCE_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		messagingPresenceRoute = httpapi.NewMessagingPresenceHandler(pool, resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go messaging presence route mounted", "path", "/api/conversations/{id}/presence")
		messagingAgentRoute = httpapi.NewMessagingAgentHandler(pool, resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go messaging agent route mounted", "path", "/api/conversations/{id}/agent-reply")
	}
	var portalInvoiceRoute http.Handler
	if goPortalInvoiceRouteEnabledFromEnv(os.Getenv("GO_PORTAL_INVOICE_ROUTE")) {
		portalInvoiceRoute, err = httpapi.NewPortalInvoiceHandler(pool, trustedProxyCIDRs, logger)
		if err != nil {
			return err
		}
		logger.Info("Go portal invoice route mounted", "path", "/api/portal/invoice/{token}")
	}
	var salesInvoiceRoute http.Handler
	if goSalesInvoiceRouteEnabledFromEnv(os.Getenv("GO_SALES_INVOICE_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		salesInvoiceRoute = httpapi.NewSalesInvoiceHandler(pool, resolver, logger)
		logger.Info("Go sales invoice route mounted", "path", "/api/sales/{orderId}")
	}
	var salesOrdersRoute http.Handler
	if goSalesOrdersRouteEnabledFromEnv(os.Getenv("GO_SALES_ORDERS_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		salesOrdersRoute = httpapi.NewSalesOrdersSessionHandler(resolver, capabilityExecutor, logger)
		logger.Info("Go sales order list route mounted", "path", "GET /api/sales")
	}
	resolver, resolverErr := getSessionResolver()
	if resolverErr != nil {
		return resolverErr
	}
	salesCustomersRoute := httpapi.NewSalesCustomersSessionHandler(pool, resolver, logger)
	logger.Info("Go sales customer lookup route mounted", "path", "GET /api/sales/customers")
	var messageAttachmentDownloadRoute http.Handler
	if goMessageAttachmentDownloadRouteEnabledFromEnv(os.Getenv("GO_MESSAGE_ATTACHMENT_DOWNLOAD_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		messageAttachmentDownloadRoute = httpapi.NewMessageAttachmentDownloadHandler(pool, resolver, logger)
		logger.Info("Go message attachment download route mounted", "path", "GET /api/message-attachments/{id}")
	}
	documentContentDownloadResolver, documentContentDownloadResolverErr := getSessionResolver()
	if documentContentDownloadResolverErr != nil {
		return documentContentDownloadResolverErr
	}
	documentContentDownloadRoute := httpapi.NewDocumentContentDownloadHandler(pool, documentContentDownloadResolver, logger)
	logger.Info("Go document content download route mounted", "path", "GET /api/go/documents/{id}/content")
	var supportChannelsRoute http.Handler
	if goSupportChannelsRouteEnabledFromEnv(os.Getenv("GO_SUPPORT_CHANNELS_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		supportChannelsRoute, err = httpapi.NewSupportChannelsHandler(pool, resolver, capabilityExecutor, trustedProxyCIDRs, logger)
		if err != nil {
			return err
		}
		logger.Info("Go support channels route mounted", "path", "/api/support/channels")
	}
	var sessionCapabilityRoute http.Handler
	if os.Getenv("GO_SESSION_CAPABILITY_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		disabledCapabilities := map[string]struct{}{}
		for capabilityID := range goManufacturingBomWriteDisabledCapabilities(os.Getenv("GO_MANUFACTURING_DEFINE_BOM_SLICE") == "1") {
			disabledCapabilities[capabilityID] = struct{}{}
		}
		for capabilityID := range httpapi.InventoryCycleCountDisabledCapabilities(os.Getenv("GO_INVENTORY_CYCLE_COUNT_WRITES") == "1") {
			disabledCapabilities[capabilityID] = struct{}{}
		}
		for capabilityID := range httpapi.PurchasingAPAgingDisabledCapabilities(os.Getenv("GO_PURCHASING_AP_AGING_READS") == "1") {
			disabledCapabilities[capabilityID] = struct{}{}
		}
		for capabilityID := range httpapi.PurchasingWorkflowDisabledCapabilities(os.Getenv("GO_PURCHASING_WORKFLOW_READS") == "1") {
			disabledCapabilities[capabilityID] = struct{}{}
		}
		for capabilityID := range httpapi.DocumentsIngestedDisabledCapabilities(goDocumentsCapabilityReadsEnabledFromEnv(os.Getenv("GO_DOCUMENT_INGESTED_READS"))) {
			disabledCapabilities[capabilityID] = struct{}{}
		}
		for capabilityID := range httpapi.DocumentsVersionDisabledCapabilities(goDocumentsCapabilityReadsEnabledFromEnv(os.Getenv("GO_DOCUMENTS_VERSION_READS"))) {
			disabledCapabilities[capabilityID] = struct{}{}
		}
		for capabilityID := range httpapi.DocumentsEditorDisabledCapabilities(goDocumentsCapabilityReadsEnabledFromEnv(os.Getenv("GO_DOCUMENTS_EDITOR_READS"))) {
			disabledCapabilities[capabilityID] = struct{}{}
		}
		for capabilityID := range httpapi.MessagingPeopleDisabledCapabilities(os.Getenv("GO_MESSAGING_PEOPLE_READS") != "0") {
			disabledCapabilities[capabilityID] = struct{}{}
		}
		sessionCapabilityRoute = httpapi.NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, capabilityExecutor, logger, disabledCapabilities, trustedProxyCIDRs)
		logger.Info("Go session capability route mounted", "path", "/api/capabilities/execute")
	}
	var modulesRoute http.Handler
	if goModulesReadRouteEnabledFromEnv(os.Getenv("GO_MODULES_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		modulesRoute = httpapi.NewModulesHandler(resolver)
		logger.Info("Go module switchboard route mounted", "path", "/api/modules")
	}
	var modulesWriteRoute http.Handler
	if os.Getenv("GO_MODULES_WRITE_ROUTE") != "0" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		modulesWriteRoute = httpapi.NewModulesWriteHandler(resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go module switchboard write route mounted", "path", "/api/modules")
	}
	var projectsRoute http.Handler
	if goProjectsRouteEnabledFromEnv(os.Getenv("GO_PROJECTS_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		projectsRoute = httpapi.NewProjectsSessionHandler(resolver, capabilityExecutor, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go projects route mounted", "path", "/api/projects")
	}
	var routinesRoute http.Handler
	var routinesWebhookRoute http.Handler
	if goRoutinesRouteEnabledFromEnv(os.Getenv("GO_ROUTINES_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		routinesRoute = httpapi.NewRoutinesSessionHandler(pool, resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		routinesWebhookRoute = httpapi.NewRoutinesWebhookHandler(pool, trustedProxyCIDRs, logger)
		logger.Info("Go routines route mounted", "paths", []string{"GET /api/routines", "POST /api/routines", "POST /api/routines/webhook/{token}"})
	}
	var memoryRoute http.Handler
	if goMemoryRouteEnabledFromEnv(os.Getenv("GO_MEMORY_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		memoryRoute = httpapi.NewMemorySessionHandler(pool, resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go organization memory route mounted", "paths", []string{"GET /api/memory", "POST /api/memory"})
	}
	var moduleSettingsRoute http.Handler
	if goModuleSettingsRouteEnabledFromEnv(os.Getenv("GO_MODULE_SETTINGS_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		moduleSettingsRoute = httpapi.NewModuleSettingsSessionHandler(pool, resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go module settings route mounted", "paths", []string{"GET /api/module-settings", "POST /api/module-settings"})
	}
	var policyRoute http.Handler
	if goPolicyRouteEnabledFromEnv(os.Getenv("GO_POLICY_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		policyRoute = httpapi.NewPolicySessionHandler(resolver, policy.NewPostgresReader(pool), capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go session policy route mounted", "paths", []string{"GET /api/policy", "POST /api/policy"})
	}
	var teamReadRoute http.Handler
	if goTeamReadRouteEnabledFromEnv(os.Getenv("GO_TEAM_READ_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		teamReadRoute = httpapi.NewGoTeamHandler(pool, resolver, capability.PermissionCatalog(), logger)
		logger.Info("Go team read route mounted", "path", "/api/team")
	}
	var teamWriteRoute http.Handler
	if goTeamWriteRouteEnabledFromEnv(os.Getenv("GO_TEAM_WRITE_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		teamWriteRoute = httpapi.NewTeamWriteHandler(resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go team write route mounted", "path", "/api/team")
	}
	ssoResolver, ssoResolverErr := getSessionResolver()
	if ssoResolverErr != nil {
		return ssoResolverErr
	}
	teamSSORoute := httpapi.NewGoTeamSSOHandler(pool, ssoResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go team SSO route mounted", "paths", []string{"GET /api/team/sso", "POST /api/team/sso", "DELETE /api/team/sso"})
	var brandingRoute http.Handler
	if os.Getenv("GO_BRANDING_ROUTE") != "0" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		brandingRoute = httpapi.NewBrandingSessionHandler(resolver, capabilityExecutor, httpapi.NewPGXBrandingReader(pool), logger, trustedProxyCIDRs)
		logger.Info("Go branding route mounted", "path", "/api/branding")
	}
	var analyticsRoute, analyticsReportRoute http.Handler
	analyticsReadEnabled := goAnalyticsRouteEnabledFromEnv(os.Getenv("GO_ANALYTICS_ROUTE"))
	analyticsReportEnabled := goAnalyticsReportRouteEnabledFromEnv(os.Getenv("GO_ANALYTICS_REPORT_ROUTE"))
	if analyticsReadEnabled || analyticsReportEnabled {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		analyticsHandler := httpapi.NewAnalyticsSessionHandler(resolver, capabilityExecutor, logger)
		if analyticsReadEnabled {
			analyticsRoute = analyticsHandler
			logger.Info("Go analytics read route mounted", "path", "/api/analytics")
		}
		if analyticsReportEnabled {
			analyticsReportRoute = analyticsHandler
			logger.Info("Go analytics report route mounted", "method", http.MethodPost, "path", "/api/analytics")
		}
	}
	var inventoryReadRoute http.Handler
	if goInventoryReadRouteEnabledFromEnv(os.Getenv("GO_INVENTORY_READ_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		inventoryReadRoute = httpapi.NewInventoryReadSessionHandler(resolver, capabilityExecutor, logger)
		logger.Info("Go inventory read route mounted", "path", "GET /api/inventory")
	}
	var crmReadRoute http.Handler
	if os.Getenv("GO_CRM_READ_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		crmReadRoute = httpapi.NewCRMReadSessionHandlerWithPOSCustomers(resolver, capabilityExecutor, pool, logger)
		logger.Info("Go CRM session read routes mounted", "paths", []string{"GET /api/crm", "GET /api/customers"})
	}
	var crmFollowUpDraftRoute http.Handler
	if goCRMFollowUpDraftRouteEnabledFromEnv(os.Getenv("GO_CRM_FOLLOW_UP_DRAFT_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		crmFollowUpDraftRoute = httpapi.NewCRMFollowUpDraftSessionHandler(
			resolver, capabilityExecutor, pool, httpapi.NewMyWorkSummaryPostgresReader(pool), nil, logger, trustedProxyCIDRs,
		)
		logger.Info("Go CRM follow-up draft route mounted", "path", "POST /api/crm/follow-up-draft")
	}
	var posReadRoute http.Handler
	if goPosReadRouteEnabledFromEnv(os.Getenv("GO_POS_READ_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		posReadRoute = httpapi.NewPosReadSessionHandler(pool, resolver, logger)
		logger.Info("Go POS read route mounted", "path", "GET /api/pos")
	}
	var posCustomersRoute http.Handler
	if goPosCustomersRouteEnabledFromEnv(os.Getenv("GO_POS_CUSTOMERS_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		posCustomersRoute = httpapi.NewPosCustomersSessionHandler(pool, resolver, logger)
		logger.Info("Go POS customer lookup route mounted", "path", "GET /api/pos/customers")
	}
	var supportCustomersRoute http.Handler
	if goSupportCustomersRouteEnabledFromEnv(os.Getenv("GO_SUPPORT_CUSTOMERS_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		supportCustomersRoute = httpapi.NewSupportCustomersSessionHandler(pool, resolver, logger)
		logger.Info("Go Support customer picker route mounted", "path", "GET /api/support/customers")
	}
	var supportReplyDraftRoute http.Handler
	if os.Getenv("GO_SUPPORT_REPLY_DRAFT_ROUTE") != "0" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		supportReplyDraftRoute = httpapi.NewSupportReplyDraftSessionHandler(pool, resolver, logger, trustedProxyCIDRs)
		logger.Info("Go Support reply draft route mounted", "path", "POST /api/support/draft")
	}
	var posShiftSummaryRoute http.Handler
	if goPosShiftSummaryRouteEnabledFromEnv(os.Getenv("GO_POS_SHIFT_SUMMARY_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		posShiftSummaryRoute = httpapi.NewPosShiftSummarySessionHandler(resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go POS shift summary route mounted", "path", "POST /api/pos/shift-summary")
	}
	var approvalsReadRoute http.Handler
	if goApprovalsReadRouteEnabledFromEnv(os.Getenv("GO_APPROVALS_READ_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		approvalsReadRoute = httpapi.NewApprovalInboxSessionHandler(resolver, approvalInboxReader, logger)
		logger.Info("Go approvals read route mounted", "path", "GET /api/approvals")
	}
	var approvalsDecisionRoute http.Handler
	if goApprovalsDecisionRouteEnabledFromEnv(os.Getenv("GO_APPROVALS_DECISION_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		approvalsDecisionRoute = httpapi.NewApprovalDecisionSessionHandler(resolver, approvalDecider, logger, trustedProxyCIDRs)
		logger.Info("Go approvals decision route mounted", "path", "POST /api/approvals")
	}
	var dashboardRoute http.Handler
	if goDashboardRouteEnabledFromEnv(os.Getenv("GO_DASHBOARD_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		dashboardRoute = httpapi.NewDashboardSessionHandler(resolver, dashboard.NewPostgresReader(pool), capabilityExecutor, logger)
		logger.Info("Go dashboard route mounted", "path", "/api/dashboard")
	}
	var setupRoute http.Handler
	if goSetupRouteEnabledFromEnv(os.Getenv("GO_SETUP_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		setupRoute = httpapi.NewSetupSessionHandler(resolver, dashboard.NewSetupPostgresReader(pool), logger)
		logger.Info("Go dashboard setup route mounted", "path", "/api/setup")
	}
	var myWorkRoute http.Handler
	if goMyWorkRouteEnabledFromEnv(os.Getenv("GO_MY_WORK_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		myWorkRoute = httpapi.NewMyWorkSessionHandler(resolver, dashboard.NewMyWorkPostgresReader(pool), capabilityExecutor, logger)
		logger.Info("Go my work route mounted", "path", "/api/my-work")
	}
	var myWorkSummaryRoute http.Handler
	if os.Getenv("GO_MY_WORK_SUMMARY_ROUTE") != "0" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		myWorkSummaryRoute = httpapi.NewMyWorkSummarySessionHandler(resolver, httpapi.NewMyWorkSummaryPostgresReader(pool), nil, logger)
		logger.Info("Go my work summary route mounted", "path", "POST /api/my-work/summarize")
	}
	var sessionsListRoute, sessionsDetailRoute http.Handler
	if goSessionsRouteEnabledFromEnv(os.Getenv("GO_SESSIONS_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		sessionsListRoute = httpapi.NewSessionsListHandler(pool, resolver, logger)
		sessionsDetailRoute = httpapi.NewSessionsDetailHandler(resolver, pool, logger)
		logger.Info("Go sessions routes mounted", "paths", []string{"GET /api/sessions", "GET /api/sessions/{id}", "GET /api/sessions/{id}/replay"})
	}
	var durableRunsRoute http.Handler
	if goDurableRunsRouteEnabledFromEnv(os.Getenv("GO_DURABLE_RUNS_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		durableRunsRoute = httpapi.NewDurableRunsSessionHandler(pool, resolver, logger)
		logger.Info("Go durable runs routes mounted", "paths", []string{"GET /api/durable-runs", "GET /api/durable-runs/{id}"})
	}
	var notificationsRoute http.Handler
	if os.Getenv("GO_NOTIFICATIONS_ROUTE") != "0" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		notificationsRoute = httpapi.NewNotificationsSessionHandler(pool, resolver, logger)
		logger.Info("Go notifications route mounted", "path", "GET /api/notifications")
	}
	var notificationReadRoute http.Handler
	if os.Getenv("GO_NOTIFICATIONS_WRITE_ROUTE") != "0" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		notificationReadRoute = httpapi.NewNotificationReadHandler(resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go notification read receipt route mounted", "path", "POST /api/notifications")
	}
	var ledgerRoute http.Handler
	if os.Getenv("GO_LEDGER_ROUTE") != "0" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		ledgerRoute = httpapi.NewLedgerSessionHandler(resolver, ledger.NewPostgresReader(pool), logger)
		logger.Info("Go ledger route mounted", "path", "/api/ledger")
	}
	var directMetricsRoute http.Handler
	if goMetricsRouteEnabledFromEnv(os.Getenv("GO_METRICS_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		directMetricsRoute = httpapi.NewMetricsSessionHandler(resolver, metrics.NewPostgresReader(pool), logger)
		logger.Info("Go metrics route mounted", "path", "/api/metrics")
	}
	var signalsRoute http.Handler
	if os.Getenv("GO_SIGNALS_ROUTE") != "0" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		signalsRoute = httpapi.NewSignalsSessionHandler(resolver, capabilityExecutor, logger)
		logger.Info("Go signals route mounted", "path", "/api/signals")
	}
	var authRoute http.Handler
	var authOutbox *authn.Service
	authSecret := os.Getenv("BETTER_AUTH_SECRET")
	if authSecret == "" {
		return errors.New("BETTER_AUTH_SECRET is required because Go owns the authentication routes")
	}
	runtimeConfig, err := authn.ResolveAuthRouteRuntime(
		os.Getenv("GO_AUTH_MODE"),
		os.Getenv("GO_AUTH_PUBLIC_ORIGIN"),
		os.Getenv("GO_AUTH_SECURE_COOKIE"),
		os.Getenv("BETTER_AUTH_URL"),
	)
	if err != nil {
		return err
	}
	authTrustedProxyCIDRs, err := httpapi.ParseTrustedProxyCIDRs(os.Getenv("GO_AUTH_TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return err
	}
	authService, err := authn.NewService(pool, authSecret, authn.Options{
		BaseURL:                runtimeConfig.BaseURL,
		TrustedOrigins:         runtimeConfig.TrustedOrigins,
		Logger:                 logger,
		RecoveryLinkSender:     authn.SMTPRecoveryLinkSenderFromEnv(),
		VerificationLinkSender: authn.SMTPVerificationLinkSenderFromEnv(),
	})
	if err != nil {
		return errors.New("BETTER_AUTH_SECRET or auth URL is unusable: " + err.Error())
	}
	authOutbox = authService
	var oidcRoutes, samlRoutes http.Handler
	if os.Getenv("GO_OIDC_ENABLED") == "1" {
		oidcRoutes, err = httpapi.NewOIDCSignInHandler(context.Background(), authService, authSecret, runtimeConfig.SecureCookie, logger, authTrustedProxyCIDRs, httpapi.OIDCConfig{
			Issuer: os.Getenv("GO_OIDC_ISSUER"), ClientID: os.Getenv("GO_OIDC_CLIENT_ID"),
			ClientSecret: os.Getenv("GO_OIDC_CLIENT_SECRET"), RedirectURI: os.Getenv("GO_OIDC_REDIRECT_URI"),
			NativeRedirectURI:    os.Getenv("GO_OIDC_NATIVE_REDIRECT_URI"),
			TrustVerifiedEmail:   os.Getenv("GO_OIDC_TRUST_VERIFIED_EMAIL") == "true",
			AllowedEndpointHosts: os.Getenv("GO_OIDC_ALLOWED_ENDPOINT_HOSTS"),
		})
		if err != nil {
			return err
		}
		logger.Info("Go OIDC sign-in routes mounted", "path", "/api/auth/sign-in/oidc")
	}
	if os.Getenv("GO_SAML_ENABLED") == "1" {
		samlRoutes, err = httpapi.NewSAMLSignInHandler(authService, authSecret, runtimeConfig.SecureCookie, logger, httpapi.SAMLConfig{
			IDPIssuer: os.Getenv("GO_SAML_IDP_ISSUER"), IDPSSOURL: os.Getenv("GO_SAML_IDP_SSO_URL"),
			IDPSigningCertPEM: os.Getenv("GO_SAML_IDP_SIGNING_CERT_PEM"), SPEntityID: os.Getenv("GO_SAML_SP_ENTITY_ID"),
			ACSURL: os.Getenv("GO_SAML_ACS_URL"), SuccessURL: os.Getenv("GO_SAML_SUCCESS_URL"),
			TrustVerifiedEmail: os.Getenv("GO_SAML_TRUST_VERIFIED_EMAIL") == "true",
			EmailAttribute:     os.Getenv("GO_SAML_EMAIL_ATTRIBUTE"), NameAttribute: os.Getenv("GO_SAML_NAME_ATTRIBUTE"),
		})
		if err != nil {
			return err
		}
		logger.Info("Go SAML sign-in routes mounted", "paths", []string{"/api/auth/sign-in/saml", "/api/auth/callback/saml"})
	}
	authRoute, err = httpapi.NewAuthHandlerWithFederatedRoutes(authService, authSecret, runtimeConfig.SecureCookie, logger, authTrustedProxyCIDRs, oidcRoutes, samlRoutes)
	if err != nil {
		return err
	}
	invitationResolver, err := getSessionResolver()
	if err != nil {
		return err
	}
	invitationRoute, err := httpapi.NewGoInvitationHandler(pool, invitationResolver, authTrustedProxyCIDRs, logger)
	if err != nil {
		return err
	}
	authRoute = httpapi.MountGoInvitationRoutes(authRoute, invitationRoute)
	logger.Info("Go invitation routes mounted", "paths", []string{"GET /api/auth/invitations/{token}", "POST /api/auth/invitations/{token}"})
	logger.Info("Go authentication routes mounted", "path", "/api/auth")
	var supportPublicRoute http.Handler
	if os.Getenv("GO_SUPPORT_PUBLIC_ROUTE") != "0" {
		trustedProxyCIDRs, err := httpapi.ParseTrustedProxyCIDRs(os.Getenv("GO_SUPPORT_TRUSTED_PROXY_CIDRS"))
		if err != nil {
			return err
		}
		model, err := capability.SupportEmbeddingModelFromEnv()
		if err != nil {
			return err
		}
		embedder, err := capability.SupportEmbeddingClientFromEnv()
		if err != nil {
			return err
		}
		supportPublicRoute, err = httpapi.NewSupportPublicHandlerWithEmbedding(pool, trustedProxyCIDRs, logger, model, embedder)
		if err != nil {
			return err
		}
		logger.Info("Go public support route mounted", "path", "/api/support/public")
	}
	var onboardingRoute http.Handler
	if goOnboardingRouteEnabledFromEnv(os.Getenv("GO_ONBOARDING_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		var embeddingModel string
		var embedder capability.SupportKnowledgeEmbedder
		if os.Getenv("NVIDIA_API_KEY") != "" {
			configuredModel := strings.TrimSpace(os.Getenv("MODEL_EMBEDDINGS"))
			if configuredModel == "" {
				configuredModel, err = capability.SupportEmbeddingModelFromEnv()
			}
			if err != nil {
				logger.Warn("Go onboarding embedding upgrade disabled", "error", err)
			} else {
				for _, prefix := range []string{"openrouter/", "groq/", "mistral/", "zai/", "openai/"} {
					configuredModel = strings.TrimPrefix(configuredModel, prefix)
				}
				configuredEmbedder, embedderErr := capability.SupportEmbeddingClientFromEnv()
				if embedderErr != nil {
					logger.Warn("Go onboarding embedding upgrade disabled", "error", embedderErr)
				} else {
					embeddingModel, embedder = configuredModel, configuredEmbedder
				}
			}
		}
		onboardingRoute, err = httpapi.NewGoOnboardingHandler(pool, capabilityExecutor, resolver, os.Getenv("BETTER_AUTH_SECRET"), embeddingModel, embedder, logger, trustedProxyCIDRs)
		if err != nil {
			return err
		}
		logger.Info("Go onboarding route mounted", "path", "POST /api/onboarding")
	}
	var scimReadRoute, scimWriteRoute http.Handler
	scimRateLimiter := httpapi.NewSCIMRateLimiter()
	if os.Getenv("GO_SCIM_READ_ROUTE") != "0" {
		scimReadRoute, err = httpapi.NewSCIMReadHandlerWithLimiter(pool, trustedProxyCIDRs, logger, scimRateLimiter)
		if err != nil {
			return err
		}
		logger.Info("Go SCIM read route mounted", "path", "/api/scim/v2/Users")
	}
	if os.Getenv("GO_SCIM_WRITE_ROUTE") != "0" {
		scimWriteRoute, err = httpapi.NewSCIMWriteHandlerWithLimiter(pool, capabilityExecutor, trustedProxyCIDRs, logger, scimRateLimiter)
		if err != nil {
			return err
		}
		logger.Info("Go SCIM provisioning routes mounted", "paths", []string{"POST /api/scim/v2/Users", "DELETE /api/scim/v2/Users/{id}"})
	}
	var scimTokenManagementRoute http.Handler
	if os.Getenv("GO_SCIM_TOKENS_ROUTE") != "0" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		scimTokenManagementRoute = httpapi.NewSCIMTokenSessionHandler(pool, resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go SCIM token management route mounted", "path", "/api/scim/tokens")
	}
	emailResolver, emailResolverErr := getSessionResolver()
	if emailResolverErr != nil {
		logger.Warn("Go email route authentication is unavailable", "error", emailResolverErr)
	}
	smtpPort, smtpPortErr := strconv.Atoi(strings.TrimSpace(os.Getenv("SMTP_PORT")))
	if smtpPortErr != nil || smtpPort < 1 || smtpPort > 65535 {
		smtpPort = 587
	}
	emailRoute := httpapi.NewEmailHandler(
		pool, emailResolver, capabilityExecutor, os.Getenv("SMTP_HOST"), smtpPort,
		strings.EqualFold(os.Getenv("SMTP_SECURE"), "true"), os.Getenv("SMTP_USER"), os.Getenv("SMTP_PASS"),
		os.Getenv("SMTP_FROM"), os.Getenv("GO_PUBLIC_APP_URL"), logger, trustedProxyCIDRs,
	)
	logger.Info("Go email route mounted", "path", "/api/email")
	bankingRoute := httpapi.NewBankingSessionHandler(emailResolver, capabilityExecutor, httpapi.NewPGXBankingPaymentReader(pool), logger, trustedProxyCIDRs)
	logger.Info("Go Banking REST route mounted", "path", "/api/banking")
	accountingBudgetsRoute := httpapi.NewAccountingBudgetsSessionHandler(pool, emailResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go accounting budgets route mounted", "path", "/api/accounting/budgets")
	timeRoute := httpapi.NewTimeSessionHandler(emailResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go HR time route mounted", "path", "/api/time")
	expensesRoute := httpapi.NewExpensesSessionHandler(emailResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go expenses route mounted", "path", "/api/expenses")
	accountingRoute := httpapi.NewAccountingSessionHandler(emailResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go accounting route mounted", "path", "/api/accounting")
	hrRoute := httpapi.NewHRSessionHandler(emailResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go HR route mounted", "path", "/api/hr")
	marketingRoute := httpapi.NewMarketingSessionHandler(emailResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go marketing route mounted", "path", "/api/marketing")
	posWriteRoute := httpapi.NewPosSessionHandler(emailResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go POS actions route mounted", "path", "/api/pos")
	accountingTaxRoute := httpapi.NewAccountingTaxSessionHandler(pool, emailResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go accounting tax route mounted", "path", "/api/accounting/tax")
	accountingPeriodCloseRoute := httpapi.NewAccountingPeriodCloseSessionHandler(emailResolver, capabilityExecutor, logger, trustedProxyCIDRs)
	logger.Info("Go accounting period close route mounted", "path", "/api/accounting/close")

	apiHandler := httpapi.MountGoMessageAttachmentDownloadRoute(httpapi.MountGoOnboardingRoute(httpapi.MountGoPOSShiftSummaryRoute(httpapi.MountGoPOSCustomersRoute(httpapi.MountGoPOSReadRoute(httpapi.MountGoCRMReadRoute(httpapi.MountGoInventoryReadRoute(httpapi.MountGoRoutinesRoute(httpapi.MountGoNotificationsRoute(httpapi.MountGoSessionReadRoutes(httpapi.MountGoSCIMTokenManagementRoute(httpapi.MountSignalsRoute(httpapi.MountGoSCIMRoutes(httpapi.MountGoSalesOrdersRoute(httpapi.MountGoBusinessRoutes(httpapi.MountMyWorkSummaryRoute(httpapi.MountMyWorkRoute(httpapi.MountSetupRoute(httpapi.MountSupportPublicRoute(httpapi.NewRouterWithAuthAndOrgRoute(
		pool,
		logger,
		os.Getenv("GO_INTERNAL_AUTH_SECRET"),
		policy.NewPostgresReader(pool),
		ledger.NewPostgresReader(pool),
		orgswitch.NewPostgresMembershipChecker(pool),
		capabilityExecutor,
		metrics.NewPostgresReader(pool),
		approvalInboxReader,
		orgRoute,
		authRoute,
		approvalDecider,
	), supportPublicRoute), setupRoute), myWorkRoute), myWorkSummaryRoute), portalInvoiceRoute, salesInvoiceRoute, supportChannelsRoute, sessionCapabilityRoute, modulesRoute, modulesWriteRoute, projectsRoute, teamReadRoute, teamWriteRoute, brandingRoute, analyticsRoute, dashboardRoute, ledgerRoute, directMetricsRoute, analyticsReportRoute), salesOrdersRoute), scimReadRoute, scimWriteRoute), signalsRoute), scimTokenManagementRoute), sessionsListRoute, sessionsDetailRoute, durableRunsRoute), notificationsRoute, notificationReadRoute), routinesRoute, routinesWebhookRoute), inventoryReadRoute), crmReadRoute), posReadRoute), posCustomersRoute), posShiftSummaryRoute), onboardingRoute), messageAttachmentDownloadRoute)
	apiHandler = httpapi.MountGoBankingRoute(apiHandler, bankingRoute)
	apiHandler = httpapi.MountGoAccountingBudgetsRoute(apiHandler, accountingBudgetsRoute)
	apiHandler = httpapi.MountGoTimeRoute(apiHandler, timeRoute)
	apiHandler = httpapi.MountGoExpensesRoute(apiHandler, expensesRoute)
	apiHandler = httpapi.MountGoAccountingTaxRoute(apiHandler, accountingTaxRoute)
	apiHandler = httpapi.MountGoAccountingPeriodCloseRoute(apiHandler, accountingPeriodCloseRoute)
	apiHandler = httpapi.MountGoAccountingRoute(apiHandler, accountingRoute)
	apiHandler = httpapi.MountGoHRRoute(apiHandler, hrRoute)
	apiHandler = httpapi.MountGoMarketingRoute(apiHandler, marketingRoute)
	apiHandler = httpapi.MountGoPOSWriteRoute(apiHandler, posWriteRoute)
	apiHandler = httpapi.MountGoApprovalsReadRoute(apiHandler, approvalsReadRoute)
	apiHandler = httpapi.MountGoSalesCustomersRoute(apiHandler, salesCustomersRoute)
	apiHandler = httpapi.MountGoApprovalsDecisionRoute(apiHandler, approvalsDecisionRoute)
	apiHandler = httpapi.MountGoMemoryRoute(apiHandler, memoryRoute)
	apiHandler = httpapi.MountGoModuleSettingsRoute(apiHandler, moduleSettingsRoute)
	apiHandler = httpapi.MountGoPolicySessionRoute(apiHandler, policyRoute)
	apiHandler = httpapi.MountGoSupportCustomersRoute(apiHandler, supportCustomersRoute)
	apiHandler = httpapi.MountGoSupportReplyDraftRoute(apiHandler, supportReplyDraftRoute)
	apiHandler = httpapi.MountGoCRMFollowUpDraftRoute(apiHandler, crmFollowUpDraftRoute)
	apiHandler = httpapi.MountGoAIConfigRoute(apiHandler, aiConfigRoute)
	apiHandler = httpapi.MountGoDocumentsEditorWorkspaceRoute(apiHandler, documentsEditorWorkspaceRoute)
	apiHandler = httpapi.MountGoDocumentsAssistRoute(apiHandler, documentsAssistRoute)
	apiHandler = httpapi.MountGoDocumentContentDownloadRoute(apiHandler, documentContentDownloadRoute)
	apiHandler = httpapi.MountGoMessagingPresenceRoute(apiHandler, messagingPresenceRoute)
	apiHandler = httpapi.MountGoMessagingAgentRoute(apiHandler, messagingAgentRoute)
	apiMux := http.NewServeMux()
	apiMux.Handle("/api/email", emailRoute)
	apiMux.Handle("/", apiHandler)
	apiHandler = httpapi.MountGoTeamSSORoute(apiMux, teamSSORoute)
	apiHandler = httpapi.MountGoTeamRoute(apiHandler, teamReadRoute, teamWriteRoute)
	server := &http.Server{
		Addr:              addr,
		Handler:           apiHandler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if authOutbox != nil {
		go func() {
			if err := authOutbox.RunEmailOutbox(ctx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Error("authentication email outbox stopped", "error", err)
				stop()
			}
		}()
	}

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("Go API listening", "addr", addr)
		serverErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}

func goManufacturingBomWriteDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{
		"manufacturing.defineBom":  {},
		"manufacturing.deleteBom":  {},
		"manufacturing.restoreBom": {},
	}
}
