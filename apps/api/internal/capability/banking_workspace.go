package capability

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

type ListBankingWorkspaceInput struct{}

type BankingWorkspaceAccount struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	CurrencyCode string  `json:"currencyCode"`
	Last4        *string `json:"last4"`
	BalanceMinor int64   `json:"balanceMinor"`
}

type BankingWorkspaceTransaction struct {
	ID             string    `json:"id"`
	BankAccountID  string    `json:"bankAccountId"`
	CurrencyCode   string    `json:"currencyCode"`
	PostedAt       time.Time `json:"postedAt"`
	AmountMinor    int64     `json:"amountMinor"`
	RemainingMinor int64     `json:"remainingMinor"`
	Description    string    `json:"description"`
}

type BankingWorkspacePayment struct {
	ID             string    `json:"id"`
	InvoiceNumber  *int64    `json:"invoiceNumber"`
	CurrencyCode   string    `json:"currencyCode"`
	CustomerName   string    `json:"customerName"`
	AmountMinor    int64     `json:"amountMinor"`
	RemainingMinor int64     `json:"remainingMinor"`
	ReceivedAt     time.Time `json:"receivedAt"`
}

type BankingWorkspaceEntry struct {
	ID             string    `json:"id"`
	Memo           string    `json:"memo"`
	CurrencyCode   string    `json:"currencyCode"`
	PostedAt       time.Time `json:"postedAt"`
	RemainingMinor int64     `json:"remainingMinor"`
}

type ListBankingWorkspaceOutput struct {
	Accounts  []BankingWorkspaceAccount     `json:"accounts"`
	Unmatched []BankingWorkspaceTransaction `json:"unmatched"`
	Matched   []BankingWorkspaceTransaction `json:"matched"`
	Excluded  []BankingWorkspaceTransaction `json:"excluded"`
	Payments  []BankingWorkspacePayment     `json:"payments"`
	Entries   []BankingWorkspaceEntry       `json:"entries"`
	Summary   BankSummaryOutput             `json:"summary"`
}

func listBankingWorkspace(ctx context.Context, tx pgx.Tx, orgID string) (ListBankingWorkspaceOutput, error) {
	output := ListBankingWorkspaceOutput{
		Accounts:  make([]BankingWorkspaceAccount, 0),
		Unmatched: make([]BankingWorkspaceTransaction, 0),
		Matched:   make([]BankingWorkspaceTransaction, 0),
		Excluded:  make([]BankingWorkspaceTransaction, 0),
		Payments:  make([]BankingWorkspacePayment, 0),
		Entries:   make([]BankingWorkspaceEntry, 0),
	}

	accountRows, err := tx.Query(ctx, `
		SELECT id::text, name, currency_code, last4, balance_minor
		FROM bank_accounts
		WHERE org_id = $1::uuid
		ORDER BY created_at DESC`, orgID)
	if err != nil {
		return ListBankingWorkspaceOutput{}, err
	}
	for accountRows.Next() {
		var account BankingWorkspaceAccount
		if err := accountRows.Scan(&account.ID, &account.Name, &account.CurrencyCode, &account.Last4, &account.BalanceMinor); err != nil {
			accountRows.Close()
			return ListBankingWorkspaceOutput{}, err
		}
		output.Accounts = append(output.Accounts, account)
	}
	if err := accountRows.Err(); err != nil {
		accountRows.Close()
		return ListBankingWorkspaceOutput{}, err
	}
	accountRows.Close()

	for _, projection := range []struct {
		status string
		limit  int
		target *[]BankingWorkspaceTransaction
	}{
		{status: "unmatched", limit: 200, target: &output.Unmatched},
		{status: "matched", limit: 100, target: &output.Matched},
		{status: "excluded", limit: 100, target: &output.Excluded},
	} {
		rows, err := tx.Query(ctx, `
			SELECT t.id::text, t.bank_account_id::text, a.currency_code, t.posted_at, t.amount_minor,
				t.amount_minor - coalesce((
					SELECT sum(ba.amount_minor) FROM bank_allocations ba
					WHERE ba.org_id = t.org_id AND ba.transaction_id = t.id
				), 0)::bigint AS remaining_minor, t.description
			FROM bank_transactions t
			JOIN bank_accounts a ON a.id = t.bank_account_id AND a.org_id = t.org_id
			WHERE t.org_id = $1::uuid AND t.status = $2
			ORDER BY t.posted_at DESC
			LIMIT $3`, orgID, projection.status, projection.limit)
		if err != nil {
			return ListBankingWorkspaceOutput{}, err
		}
		for rows.Next() {
			var row BankingWorkspaceTransaction
			if err := rows.Scan(&row.ID, &row.BankAccountID, &row.CurrencyCode, &row.PostedAt, &row.AmountMinor, &row.RemainingMinor, &row.Description); err != nil {
				rows.Close()
				return ListBankingWorkspaceOutput{}, err
			}
			*projection.target = append(*projection.target, row)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return ListBankingWorkspaceOutput{}, err
		}
		rows.Close()
	}

	paymentRows, err := tx.Query(ctx, `
		SELECT p.id::text, i.number, i.currency, c.name, p.amount_minor,
			p.amount_minor - coalesce(allocated.allocated_minor, 0)::bigint AS remaining_minor, p.received_at
		FROM payments p
		JOIN invoices i ON i.id = p.invoice_id
		JOIN customers c ON c.id = i.customer_id
		LEFT JOIN LATERAL (
			SELECT sum(ba.amount_minor) AS allocated_minor
			FROM bank_allocations ba
			WHERE ba.org_id = p.org_id AND ba.payment_id = p.id
		) allocated ON true
		WHERE p.org_id = $1::uuid
			AND p.amount_minor - coalesce(allocated.allocated_minor, 0)::bigint > 0
		ORDER BY p.received_at DESC
		LIMIT 50`, orgID)
	if err != nil {
		return ListBankingWorkspaceOutput{}, err
	}
	for paymentRows.Next() {
		var row BankingWorkspacePayment
		if err := paymentRows.Scan(&row.ID, &row.InvoiceNumber, &row.CurrencyCode, &row.CustomerName, &row.AmountMinor, &row.RemainingMinor, &row.ReceivedAt); err != nil {
			paymentRows.Close()
			return ListBankingWorkspaceOutput{}, err
		}
		output.Payments = append(output.Payments, row)
	}
	if err := paymentRows.Err(); err != nil {
		paymentRows.Close()
		return ListBankingWorkspaceOutput{}, err
	}
	paymentRows.Close()

	entryRows, err := tx.Query(ctx, `
		WITH cash_effects AS (
			SELECT je.id, je.memo, je.currency, je.posted_at,
				coalesce(sum(jl.debit_minor - jl.credit_minor), 0)::bigint AS cash_minor
			FROM journal_entries je
			JOIN journal_lines jl ON jl.entry_id = je.id
			JOIN accounts a ON a.id = jl.account_id AND a.org_id = je.org_id
			WHERE je.org_id = $1::uuid AND a.code = $2
			GROUP BY je.id
		), allocated AS (
			SELECT entry_id, sum(amount_minor)::bigint AS allocated_minor, count(*) AS allocation_count
			FROM bank_allocations
			WHERE org_id = $1::uuid AND entry_id IS NOT NULL
			GROUP BY entry_id
		)
		SELECT cash.id::text, cash.memo, cash.currency, cash.posted_at,
			cash.cash_minor - coalesce(allocated.allocated_minor, 0) AS remaining_minor
		FROM cash_effects cash
		LEFT JOIN allocated ON allocated.entry_id = cash.id
		WHERE cash.cash_minor <> 0
			AND coalesce(allocated.allocation_count, 0) = 0
			AND cash.cash_minor - coalesce(allocated.allocated_minor, 0) <> 0
		ORDER BY cash.posted_at DESC, cash.id DESC
		LIMIT 50`, orgID, cashAccountCode)
	if err != nil {
		return ListBankingWorkspaceOutput{}, err
	}
	for entryRows.Next() {
		var row BankingWorkspaceEntry
		if err := entryRows.Scan(&row.ID, &row.Memo, &row.CurrencyCode, &row.PostedAt, &row.RemainingMinor); err != nil {
			entryRows.Close()
			return ListBankingWorkspaceOutput{}, err
		}
		output.Entries = append(output.Entries, row)
	}
	if err := entryRows.Err(); err != nil {
		entryRows.Close()
		return ListBankingWorkspaceOutput{}, err
	}
	entryRows.Close()

	output.Summary, err = bankSummary(ctx, tx, orgID)
	if err != nil {
		return ListBankingWorkspaceOutput{}, err
	}
	return output, nil
}
