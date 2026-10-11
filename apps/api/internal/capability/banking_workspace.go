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
	ID            string    `json:"id"`
	BankAccountID string    `json:"bankAccountId"`
	CurrencyCode  string    `json:"currencyCode"`
	PostedAt      time.Time `json:"postedAt"`
	AmountMinor   int64     `json:"amountMinor"`
	Description   string    `json:"description"`
}

type BankingWorkspacePayment struct {
	ID            string    `json:"id"`
	InvoiceNumber *int64    `json:"invoiceNumber"`
	CurrencyCode  string    `json:"currencyCode"`
	CustomerName  string    `json:"customerName"`
	AmountMinor   int64     `json:"amountMinor"`
	ReceivedAt    time.Time `json:"receivedAt"`
}

type ListBankingWorkspaceOutput struct {
	Accounts  []BankingWorkspaceAccount     `json:"accounts"`
	Unmatched []BankingWorkspaceTransaction `json:"unmatched"`
	Matched   []BankingWorkspaceTransaction `json:"matched"`
	Excluded  []BankingWorkspaceTransaction `json:"excluded"`
	Payments  []BankingWorkspacePayment     `json:"payments"`
	Summary   BankSummaryOutput             `json:"summary"`
}

func listBankingWorkspace(ctx context.Context, tx pgx.Tx, orgID string) (ListBankingWorkspaceOutput, error) {
	output := ListBankingWorkspaceOutput{
		Accounts:  make([]BankingWorkspaceAccount, 0),
		Unmatched: make([]BankingWorkspaceTransaction, 0),
		Matched:   make([]BankingWorkspaceTransaction, 0),
		Excluded:  make([]BankingWorkspaceTransaction, 0),
		Payments:  make([]BankingWorkspacePayment, 0),
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
			SELECT t.id::text, t.bank_account_id::text, a.currency_code, t.posted_at, t.amount_minor, t.description
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
			if err := rows.Scan(&row.ID, &row.BankAccountID, &row.CurrencyCode, &row.PostedAt, &row.AmountMinor, &row.Description); err != nil {
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
		SELECT p.id::text, i.number, i.currency, c.name, p.amount_minor, p.received_at
		FROM payments p
		JOIN invoices i ON i.id = p.invoice_id
		JOIN customers c ON c.id = i.customer_id
		WHERE p.org_id = $1::uuid
		ORDER BY p.received_at DESC
		LIMIT 50`, orgID)
	if err != nil {
		return ListBankingWorkspaceOutput{}, err
	}
	for paymentRows.Next() {
		var row BankingWorkspacePayment
		if err := paymentRows.Scan(&row.ID, &row.InvoiceNumber, &row.CurrencyCode, &row.CustomerName, &row.AmountMinor, &row.ReceivedAt); err != nil {
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

	output.Summary, err = bankSummary(ctx, tx, orgID)
	if err != nil {
		return ListBankingWorkspaceOutput{}, err
	}
	return output, nil
}
