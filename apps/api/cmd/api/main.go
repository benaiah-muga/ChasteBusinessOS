package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
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

func goAuthRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goMyWorkRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goAnalyticsRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goSessionsRouteEnabledFromEnv(value string) bool {
	return value != "0"
}

func goDurableRunsRouteEnabledFromEnv(value string) bool {
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
	// trusting an assertion minted by the legacy app. It stays unmounted until
	// GO_ORG_ROUTE=1, so the legacy app keeps serving /api/org until the parity
	// gate has proven the two agree.
	var orgRoute http.Handler
	if os.Getenv("GO_ORG_ROUTE") == "1" {
		resolver, err := getSessionResolver()
		if err != nil {
			return err
		}
		orgRoute = httpapi.NewOrgHandler(httpapi.NewPgOrgRepository(pool), resolver, os.Getenv("BETTER_AUTH_SECRET"), logger)
		logger.Info("Go organization route mounted", "path", "/api/org")
	}
	var portalInvoiceRoute http.Handler
	if os.Getenv("GO_PORTAL_INVOICE_ROUTE") == "1" {
		portalInvoiceRoute, err = httpapi.NewPortalInvoiceHandler(pool, trustedProxyCIDRs, logger)
		if err != nil {
			return err
		}
		logger.Info("Go portal invoice route mounted", "path", "/api/portal/invoice/{token}")
	}
	var salesInvoiceRoute http.Handler
	if os.Getenv("GO_SALES_INVOICE_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		salesInvoiceRoute = httpapi.NewSalesInvoiceHandler(pool, resolver, logger)
		logger.Info("Go sales invoice route mounted", "path", "/api/sales/{orderId}")
	}
	var supportChannelsRoute http.Handler
	if os.Getenv("GO_SUPPORT_CHANNELS_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		supportChannelsRoute, err = httpapi.NewSupportChannelsHandler(pool, resolver, trustedProxyCIDRs, logger)
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
		if os.Getenv("GO_MANUFACTURING_DEFINE_BOM_SLICE") != "1" {
			disabledCapabilities["manufacturing.defineBom"] = struct{}{}
		}
		for capabilityID := range httpapi.InventoryCycleCountDisabledCapabilities(os.Getenv("GO_INVENTORY_CYCLE_COUNT_WRITES") == "1") {
			disabledCapabilities[capabilityID] = struct{}{}
		}
		sessionCapabilityRoute = httpapi.NewSessionCapabilityHandlerWithDisabledCapabilities(resolver, capabilityExecutor, logger, disabledCapabilities, trustedProxyCIDRs)
		logger.Info("Go session capability route mounted", "path", "/api/capabilities/execute")
	}
	var modulesRoute http.Handler
	if os.Getenv("GO_MODULES_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		modulesRoute = httpapi.NewModulesHandler(resolver)
		logger.Info("Go module switchboard route mounted", "path", "/api/modules")
	}
	var modulesWriteRoute http.Handler
	if os.Getenv("GO_MODULES_WRITE_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		modulesWriteRoute = httpapi.NewModulesWriteHandler(resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go module switchboard write route mounted", "path", "/api/modules")
	}
	var projectsRoute http.Handler
	if os.Getenv("GO_PROJECTS_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		projectsRoute = httpapi.NewProjectsSessionHandler(resolver, capabilityExecutor, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go projects route mounted", "path", "/api/projects")
	}
	var routinesRoute http.Handler
	if os.Getenv("GO_ROUTINES_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		routinesRoute = httpapi.NewRoutinesSessionHandler(pool, resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go routines route mounted", "paths", []string{"GET /api/routines", "POST /api/routines"})
	}
	var teamReadRoute http.Handler
	if os.Getenv("GO_TEAM_READ_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		teamReadRoute = httpapi.NewGoTeamHandler(pool, resolver, capability.PermissionCatalog(), logger)
		logger.Info("Go team read route mounted", "path", "/api/team")
	}
	var teamWriteRoute http.Handler
	if os.Getenv("GO_TEAM_WRITE_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		teamWriteRoute = httpapi.NewTeamWriteHandler(resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go team write route mounted", "path", "/api/team")
	}
	var brandingRoute http.Handler
	if os.Getenv("GO_BRANDING_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		brandingRoute = httpapi.NewBrandingSessionHandler(resolver, capabilityExecutor, httpapi.NewPGXBrandingReader(pool), logger, trustedProxyCIDRs)
		logger.Info("Go branding route mounted", "path", "/api/branding")
	}
	var analyticsRoute http.Handler
	if goAnalyticsRouteEnabledFromEnv(os.Getenv("GO_ANALYTICS_ROUTE")) {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		analyticsRoute = httpapi.NewAnalyticsSessionHandler(resolver, capabilityExecutor, logger)
		logger.Info("Go analytics route mounted", "path", "/api/analytics")
	}
	var inventoryReadRoute http.Handler
	if os.Getenv("GO_INVENTORY_READ_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		inventoryReadRoute = httpapi.NewInventoryReadSessionHandler(resolver, capabilityExecutor, logger)
		logger.Info("Go inventory read route mounted", "path", "GET /api/inventory")
	}
	var dashboardRoute http.Handler
	if os.Getenv("GO_DASHBOARD_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		dashboardRoute = httpapi.NewDashboardSessionHandler(resolver, dashboard.NewPostgresReader(pool), capabilityExecutor, logger)
		logger.Info("Go dashboard route mounted", "path", "/api/dashboard")
	}
	var setupRoute http.Handler
	if os.Getenv("GO_SETUP_ROUTE") == "1" {
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
	if os.Getenv("GO_MY_WORK_SUMMARY_ROUTE") == "1" {
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
	if os.Getenv("GO_NOTIFICATIONS_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		notificationsRoute = httpapi.NewNotificationsSessionHandler(pool, resolver, logger)
		logger.Info("Go notifications route mounted", "path", "GET /api/notifications")
	}
	var notificationReadRoute http.Handler
	if os.Getenv("GO_NOTIFICATIONS_WRITE_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		notificationReadRoute = httpapi.NewNotificationReadHandler(resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go notification read receipt route mounted", "path", "POST /api/notifications")
	}
	var ledgerRoute http.Handler
	if os.Getenv("GO_LEDGER_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		ledgerRoute = httpapi.NewLedgerSessionHandler(resolver, ledger.NewPostgresReader(pool), logger)
		logger.Info("Go ledger route mounted", "path", "/api/ledger")
	}
	var directMetricsRoute http.Handler
	if os.Getenv("GO_METRICS_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		directMetricsRoute = httpapi.NewMetricsSessionHandler(resolver, metrics.NewPostgresReader(pool), logger)
		logger.Info("Go metrics route mounted", "path", "/api/metrics")
	}
	var signalsRoute http.Handler
	if os.Getenv("GO_SIGNALS_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		signalsRoute = httpapi.NewSignalsSessionHandler(resolver, capabilityExecutor, logger)
		logger.Info("Go signals route mounted", "path", "/api/signals")
	}
	var authRoute http.Handler
	var authOutbox *authn.Service
	if (os.Getenv("GO_OIDC_ENABLED") == "1" || os.Getenv("GO_SAML_ENABLED") == "1") && !goAuthRouteEnabledFromEnv(os.Getenv("GO_AUTH_ROUTE")) {
		return errors.New("GO_OIDC_ENABLED=1 and GO_SAML_ENABLED=1 require GO_AUTH_ROUTE=1")
	}
	if goAuthRouteEnabledFromEnv(os.Getenv("GO_AUTH_ROUTE")) {
		authSecret := os.Getenv("BETTER_AUTH_SECRET")
		if authSecret == "" {
			return errors.New("GO_AUTH_ROUTE=1 requires BETTER_AUTH_SECRET")
		}
		runtimeConfig, err := authn.ResolveAuthRouteRuntime(
			os.Getenv("GO_AUTH_MODE"),
			os.Getenv("GO_AUTH_PUBLIC_ORIGIN"),
			os.Getenv("GO_AUTH_SECURE_COOKIE"),
			os.Getenv("NEXT_PUBLIC_APP_URL"),
		)
		if err != nil {
			return err
		}
		trustedProxyCIDRs, err := httpapi.ParseTrustedProxyCIDRs(os.Getenv("GO_AUTH_TRUSTED_PROXY_CIDRS"))
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
			oidcRoutes, err = httpapi.NewOIDCSignInHandler(context.Background(), authService, authSecret, runtimeConfig.SecureCookie, logger, trustedProxyCIDRs, httpapi.OIDCConfig{
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
		authRoute, err = httpapi.NewAuthHandlerWithFederatedRoutes(authService, authSecret, runtimeConfig.SecureCookie, logger, trustedProxyCIDRs, oidcRoutes, samlRoutes)
		if err != nil {
			return err
		}
		logger.Info("Go authentication routes mounted", "path", "/api/auth")
	}
	var supportPublicRoute http.Handler
	if os.Getenv("GO_SUPPORT_PUBLIC_ROUTE") == "1" {
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
	var scimReadRoute, scimWriteRoute http.Handler
	scimRateLimiter := httpapi.NewSCIMRateLimiter()
	if os.Getenv("GO_SCIM_READ_ROUTE") == "1" {
		scimReadRoute, err = httpapi.NewSCIMReadHandlerWithLimiter(pool, trustedProxyCIDRs, logger, scimRateLimiter)
		if err != nil {
			return err
		}
		logger.Info("Go SCIM read route mounted", "path", "/api/scim/v2/Users")
	}
	if os.Getenv("GO_SCIM_WRITE_ROUTE") == "1" {
		scimWriteRoute, err = httpapi.NewSCIMWriteHandlerWithLimiter(pool, capabilityExecutor, trustedProxyCIDRs, logger, scimRateLimiter)
		if err != nil {
			return err
		}
		logger.Info("Go SCIM provisioning routes mounted", "paths", []string{"POST /api/scim/v2/Users", "DELETE /api/scim/v2/Users/{id}"})
	}
	var scimTokenManagementRoute http.Handler
	if os.Getenv("GO_SCIM_TOKENS_ROUTE") == "1" {
		resolver, resolverErr := getSessionResolver()
		if resolverErr != nil {
			return resolverErr
		}
		scimTokenManagementRoute = httpapi.NewSCIMTokenSessionHandler(pool, resolver, capabilityExecutor, logger, trustedProxyCIDRs)
		logger.Info("Go SCIM token management route mounted", "path", "/api/scim/tokens")
	}

	server := &http.Server{
		Addr: addr,
		Handler: httpapi.MountGoInventoryReadRoute(httpapi.MountGoRoutinesRoute(httpapi.MountGoNotificationReadRoute(httpapi.MountGoSessionReadRoutes(httpapi.MountGoSCIMTokenManagementRoute(httpapi.MountSignalsRoute(httpapi.MountGoSCIMRoutes(httpapi.MountGoBusinessRoutes(httpapi.MountMyWorkSummaryRoute(httpapi.MountMyWorkRoute(httpapi.MountSetupRoute(httpapi.MountSupportPublicRoute(httpapi.NewRouterWithAuthAndOrgRoute(
			pool,
			logger,
			os.Getenv("GO_INTERNAL_AUTH_SECRET"),
			policy.NewPostgresReader(pool),
			ledger.NewPostgresReader(pool),
			orgswitch.NewPostgresMembershipChecker(pool),
			capabilityExecutor,
			metrics.NewPostgresReader(pool),
			httpapi.NewPostgresApprovalInboxReader(pool),
			orgRoute,
			authRoute,
			approvalDecider,
		), supportPublicRoute), setupRoute), myWorkRoute), myWorkSummaryRoute), portalInvoiceRoute, salesInvoiceRoute, supportChannelsRoute, sessionCapabilityRoute, modulesRoute, modulesWriteRoute, projectsRoute, teamReadRoute, teamWriteRoute, brandingRoute, analyticsRoute, dashboardRoute, ledgerRoute, directMetricsRoute), scimReadRoute, scimWriteRoute), signalsRoute), scimTokenManagementRoute), sessionsListRoute, sessionsDetailRoute, durableRunsRoute, notificationsRoute), notificationReadRoute), routinesRoute), inventoryReadRoute),
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
