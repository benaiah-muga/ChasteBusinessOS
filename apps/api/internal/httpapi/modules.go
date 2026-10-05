package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

type modulesSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type moduleInfo struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	Description string  `json:"description"`
	Href        *string `json:"href"`
	Protected   bool    `json:"protected,omitempty"`
}

var moduleCatalog = []moduleInfo{
	{ID: "accounting", Label: "Accounting", Description: "Ledger, invoicing, bills, payments, reports", Href: modulePath("/accounting")},
	{ID: "analytics", Label: "Analytics", Description: "Governed datasets, charts, downloadable reports", Href: modulePath("/analytics")},
	{ID: "marketing", Label: "Marketing", Description: "Segments, campaigns, honest send log", Href: modulePath("/marketing")},
	{ID: "projects", Label: "Projects", Description: "Project boards & tasks", Href: modulePath("/projects")},
	{ID: "pos", Label: "Point of sale", Description: "Register sessions and instant sales", Href: modulePath("/pos")},
	{ID: "inventory", Label: "Inventory", Description: "Stock ledger, valuation, counting, reorder alerts", Href: modulePath("/inventory")},
	{ID: "manufacturing", Label: "Manufacturing", Description: "BOMs, work orders, production runs, traceability", Href: modulePath("/manufacturing")},
	{ID: "purchasing", Label: "Purchasing (Procurement)", Description: "Vendors, purchase orders, receipts, bills, AP aging", Href: modulePath("/purchasing")},
	{ID: "crm", Label: "CRM", Description: "Customers and deal pipeline", Href: modulePath("/crm")},
	{ID: "sales", Label: "Sales", Description: "Quotes that convert to invoices, deal pipeline", Href: modulePath("/sales")},
	{ID: "documents", Label: "Documents", Description: "Ingestion, OCR, coding suggestions, org memory", Href: modulePath("/documents")},
	{ID: "hr", Label: "HR & Payroll", Description: "Employees, leave, payroll runs", Href: modulePath("/hr")},
	{ID: "messaging", Label: "Messages", Description: "Internal channels and DMs with agent participation", Href: modulePath("/messages")},
	{ID: "support", Label: "Customer care", Description: "Support desk with AI-drafted replies", Href: modulePath("/support")},
	{ID: "skills", Label: "Skills", Description: "Advisory playbooks the workmate can consult", Href: nil},
	{ID: "creator", Label: "Creator & marketplace", Description: "Capability proposals and signed plugins", Href: modulePath("/proposals")},
	{ID: "iam", Label: "Identity & access", Description: "Roles, permissions, module switchboard", Href: modulePath("/team"), Protected: true},
	{ID: "routines", Label: "Routines", Description: "Scheduled agent runs on a fixed least-privilege bundle", Href: nil, Protected: true},
	{ID: "signals", Label: "Signals", Description: "Needs-attention registry feeding home and the workmate", Href: nil, Protected: true},
}

var protectedModuleIDs = []string{"iam", "routines", "signals"}

type modulesHandler struct {
	resolver modulesSessionResolver
}

// NewModulesHandler serves the authenticated module switchboard catalog for the
// organization resolved by the Go session resolver.
func NewModulesHandler(resolver modulesSessionResolver) http.Handler {
	return &modulesHandler{resolver: resolver}
}

func (h *modulesHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setModulesHeaders(w)
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeModulesError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if h == nil || h.resolver == nil {
		writeModulesError(w, http.StatusServiceUnavailable, "module service unavailable")
		return
	}

	selector, ok := modulesOrganizationSelector(r)
	if !ok {
		writeModulesError(w, http.StatusBadRequest, "invalid organization selector")
		return
	}

	var resolved *session.ResolvedUser
	var err error
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			writeModulesError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		resolved, err = h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	} else {
		resolved, err = h.resolver.Resolve(
			r.Context(),
			session.CookieFromRequest(r, session.SessionCookieName),
			selector,
		)
	}
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || strings.TrimSpace(*resolved.OrgID) == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeModulesError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if selector != "" && !strings.EqualFold(selector, *resolved.OrgID) {
		writeModulesError(w, http.StatusForbidden, "organization access denied")
		return
	}

	enabled := effectiveModuleIDs(resolved)
	writeModulesJSON(w, http.StatusOK, map[string]any{
		"catalog":        moduleCatalog,
		"enabledModules": enabled,
		"usingDefaults":  !resolved.ModulesRestricted,
	})
}

func modulesOrganizationSelector(r *http.Request) (string, bool) {
	values := r.Header.Values("X-Organization-ID")
	if len(values) > 1 {
		return "", false
	}
	selector := ""
	if len(values) == 1 {
		selector = strings.ToLower(strings.TrimSpace(values[0]))
	} else {
		selector = strings.TrimSpace(session.CookieFromRequest(r, session.ActiveOrgCookieName))
	}
	if selector != "" && !isUUID(selector) {
		return "", false
	}
	return selector, true
}

func effectiveModuleIDs(resolved *session.ResolvedUser) []string {
	if !resolved.ModulesRestricted {
		ids := make([]string, 0, len(moduleCatalog))
		for _, module := range moduleCatalog {
			ids = append(ids, module.ID)
		}
		return ids
	}

	seen := make(map[string]struct{}, len(protectedModuleIDs)+len(resolved.EnabledModules))
	ids := make([]string, 0, len(protectedModuleIDs)+len(resolved.EnabledModules))
	for _, id := range append(append([]string(nil), protectedModuleIDs...), resolved.EnabledModules...) {
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids
}

func modulePath(value string) *string { return &value }

func setModulesHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
}

func writeModulesError(w http.ResponseWriter, status int, message string) {
	writeModulesJSON(w, status, map[string]string{"error": message})
}

func writeModulesJSON(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}
