package dashboard

import (
	"context"
	"os"
	"os/exec"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

type SetupItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Why   string `json:"why"`
	Href  string `json:"href"`
	Done  bool   `json:"done"`
}

type SetupPayload struct {
	Items     []SetupItem `json:"items"`
	Remaining int64       `json:"remaining"`
}

type SetupPostgresReader struct {
	pool dbx.Beginner
}

func NewSetupPostgresReader(pool dbx.Beginner) *SetupPostgresReader {
	return &SetupPostgresReader{pool: pool}
}

func (r *SetupPostgresReader) ForOrg(ctx context.Context, orgID string) (SetupPayload, error) {
	var counts setupCounts
	_, err := dbx.WithOrgTx(ctx, r.pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		err := tx.QueryRow(ctx, `
			SELECT
				(SELECT count(*) FROM vendors WHERE org_id = $1::uuid),
				(SELECT count(*) FROM items WHERE org_id = $1::uuid),
				(SELECT count(*) FROM customers WHERE org_id = $1::uuid),
				(SELECT count(*) FROM memberships WHERE org_id = $1::uuid),
				(SELECT count(*) FROM invitations WHERE org_id = $1::uuid),
				EXISTS (SELECT 1 FROM support_settings WHERE org_id = $1::uuid AND embed_token <> '')`, orgID,
		).Scan(&counts.vendors, &counts.items, &counts.customers, &counts.members, &counts.invites, &counts.widget)
		return struct{}{}, err
	})
	if err != nil {
		return SetupPayload{}, err
	}
	return setupPayload(counts, os.Getenv("SMTP_HOST") != "", codingAgentAvailable()), nil
}

type setupCounts struct {
	vendors, items, customers, members, invites int64
	widget                                      bool
}

func setupPayload(counts setupCounts, emailConfigured, codingAgentInstalled bool) SetupPayload {
	items := []SetupItem{
		{ID: "products", Title: "Add what you sell", Why: "Orders, invoices, and stock all reference products; without them nothing can be priced.", Href: "/products", Done: counts.items > 0},
		{ID: "customers", Title: "Add your first customer", Why: "Sales, invoicing, and customer care hang off customer records.", Href: "/crm", Done: counts.customers > 0},
		{ID: "vendors", Title: "Add a vendor", Why: "Purchase requests, RFQs, and bills name the vendor you buy from.", Href: "/purchasing", Done: counts.vendors > 0},
		{ID: "team", Title: "Invite your team", Why: "Approvals need a second pair of eyes; money-gated actions wait for them.", Href: "/team", Done: counts.members > 1 || counts.invites > 0},
		{ID: "email", Title: "Connect outgoing email", Why: "Invoices, approvals, and notifications reach people by email once SMTP is set.", Href: "/settings", Done: emailConfigured},
		{ID: "widget", Title: "Put chat on your website", Why: "Customer questions land in your care inbox instead of a shared mailbox.", Href: "/support", Done: counts.widget},
		{ID: "creator-agent", Title: "Connect a coding agent for Creator mode", Why: "With an agent installed, improvements are proposed as reviewed diffs instead of wishful thinking.", Href: "/proposals", Done: codingAgentInstalled},
	}
	var remaining int64
	for _, item := range items {
		if !item.Done {
			remaining++
		}
	}
	return SetupPayload{Items: items, Remaining: remaining}
}

func codingAgentAvailable() bool {
	for _, binary := range []string{"opencode", "claude", "codex", "kilo", "kilocode", "aider", "gemini"} {
		if _, err := exec.LookPath(binary); err == nil {
			return true
		}
	}
	return false
}
