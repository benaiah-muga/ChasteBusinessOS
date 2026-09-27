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
	return mux
}
