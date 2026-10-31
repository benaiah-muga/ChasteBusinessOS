package signals

import (
	"context"
	"fmt"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	overdueSignalDays            = 30
	overdueRedDays               = 60
	duplicatePaymentRowCap       = 500
	duplicateClaimRowCap         = 300
	expenseAnomalyWindowDays     = 180
	expenseAnomalyMinimumHistory = 3
	expenseAnomalyMultiple       = 3
)

type invoiceRow struct {
	id            string
	number        int64
	issuedAt      *time.Time
	dueAt         *time.Time
	totalMinor    int64
	paidMinor     int64
	creditedMinor int64
}

type quoteRow struct {
	id        string
	number    int64
	expiresAt time.Time
}

type expenseClaimRow struct {
	id             string
	claimantUserID string
	amountMinor    int64
	category       string
	createdAt      time.Time
}

type recordPaymentDraft struct {
	InvoiceID string `json:"invoiceId"`
}

type declineQuoteDraft struct {
	QuoteID string `json:"quoteId"`
}

// NewAccountingProducer ports modules/accounting/src/signals.ts: overdue
// receivables, expired quotes, suspected duplicate payments, duplicate expense
// claims, and expense policy overruns.
func NewAccountingProducer(pool *pgxpool.Pool) capability.SignalProducer {
	return func(ctx context.Context, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
		return dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) ([]capability.BusinessSignal, error) {
			return accountingSignals(ctx, tx, orgID, now)
		})
	}
}

func accountingSignals(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]capability.BusinessSignal, error) {
	var signals []capability.BusinessSignal

	invoices, err := accountingInvoices(ctx, tx, orgID)
	if err != nil {
		return nil, err
	}
	for _, invoice := range invoices {
		balance := documentOutstandingMinor(invoice.totalMinor, invoice.paidMinor, invoice.creditedMinor)
		if balance <= 0 || invoice.issuedAt == nil {
			continue
		}
		ref := *invoice.issuedAt
		if invoice.dueAt != nil {
			ref = *invoice.dueAt
		}
		days := ageDays(now.Sub(ref))
		if days < overdueSignalDays {
			continue
		}
		severity := "orange"
		if days >= overdueRedDays {
			severity = "red"
		}
		signals = append(signals, capability.BusinessSignal{
			ID:       fmt.Sprintf("accounting.overdue:%s", invoice.id),
			Severity: severity,
			Module:   "accounting",
			Subject:  fmt.Sprintf("Invoice #%d is %d days past due", invoice.number, days),
			Detail:   fmt.Sprintf("%s minor-major units outstanding of %s - due %d days ago.", formatMinor(balance), formatMinor(invoice.totalMinor), days),
			Evidence: evidence("invoice", invoice.id),
			SuggestedAction: suggestedAction("accounting.recordPayment", recordPaymentDraft{
				InvoiceID: invoice.id,
			}),
		})
	}

	lapsedQuotes, err := accountingLapsedQuotes(ctx, tx, orgID, now)
	if err != nil {
		return nil, err
	}
	for _, quote := range lapsedQuotes {
		signals = append(signals, capability.BusinessSignal{
			ID:       fmt.Sprintf("accounting.quoteExpired:%s", quote.id),
			Severity: "red",
			Module:   "accounting",
			Subject:  fmt.Sprintf("Quote #%d expired without a decision", quote.number),
			Detail:   fmt.Sprintf("Validity lapsed %s. Decline it to keep the pipeline truthful, or issue a fresh quote if the customer is still warm.", quote.expiresAt.UTC().Format("2006-01-02")),
			Evidence: evidence("quote", quote.id),
			SuggestedAction: suggestedAction("accounting.declineQuote", declineQuoteDraft{
				QuoteID: quote.id,
			}),
		})
	}

	payments, err := accountingPayments(ctx, tx, orgID)
	if err != nil {
		return nil, err
	}
	for _, duplicate := range findDuplicatePayments(payments) {
		signals = append(signals, capability.BusinessSignal{
			ID:       fmt.Sprintf("accounting.duplicatePayment:%s:%s", duplicate.paymentIDA, duplicate.paymentIDB),
			Severity: "orange",
			Module:   "accounting",
			Subject:  fmt.Sprintf("Suspected duplicate payment on invoice (%s, %d %s apart)", formatMinor(duplicate.amountMinor), duplicate.daysApart, dayWord(duplicate.daysApart)),
			Detail:   fmt.Sprintf("Payments %s and %s hit the same invoice for the same amount %d %s apart. Could be a double click or an installment that matches by coincidence - verify and refund or reconcile.", shortID(duplicate.paymentIDA), shortID(duplicate.paymentIDB), duplicate.daysApart, dayWord(duplicate.daysApart)),
			Evidence: evidence("invoice", duplicate.invoiceID),
		})
	}

	claims, err := accountingPendingClaims(ctx, tx, orgID)
	if err != nil {
		return nil, err
	}
	claimRecords := make([]expenseClaimRecord, 0, len(claims))
	for _, claim := range claims {
		claimRecords = append(claimRecords, expenseClaimRecord{
			id:             claim.id,
			claimantUserID: claim.claimantUserID,
			amountMinor:    claim.amountMinor,
			category:       claim.category,
			submittedAt:    claim.createdAt,
		})
	}
	for _, duplicate := range findDuplicateExpenseClaims(claimRecords) {
		signals = append(signals, capability.BusinessSignal{
			ID:       fmt.Sprintf("accounting.duplicateClaim:%s:%s", duplicate.claimIDA, duplicate.claimIDB),
			Severity: "orange",
			Module:   "accounting",
			Subject:  fmt.Sprintf("Suspected duplicate expense claim (%s, %d %s apart)", formatMinor(duplicate.amountMinor), duplicate.daysApart, dayWord(duplicate.daysApart)),
			Detail:   fmt.Sprintf("Claims %s and %s are by the same person for the same amount %d %s apart. Reject one with a reason.", shortID(duplicate.claimIDA), shortID(duplicate.claimIDB), duplicate.daysApart, dayWord(duplicate.daysApart)),
			Evidence: evidence("expense_claim", duplicate.claimIDA),
		})
	}

	policies, err := accountingExpensePolicies(ctx, tx, orgID)
	if err != nil {
		return nil, err
	}
	for _, claim := range claims {
		overLimit, limitMinor, found := evaluateExpensePolicy(claim.category, claim.amountMinor, policies)
		if !found || !overLimit {
			continue
		}
		signals = append(signals, capability.BusinessSignal{
			ID:       fmt.Sprintf("accounting.policyOverrun:%s", claim.id),
			Severity: "orange",
			Module:   "accounting",
			Subject:  fmt.Sprintf("Expense claim over policy: %s in %s (limit %s)", formatMinor(claim.amountMinor), claim.category, formatMinor(limitMinor)),
			Detail:   fmt.Sprintf("The category ceiling is %s; this pending claim exceeds it. Approve deliberately or send back with a reason.", formatMinor(limitMinor)),
			Evidence: evidence("expense_claim", claim.id),
		})
	}

	history, err := accountingExpenseHistory(ctx, tx, orgID, now)
	if err != nil {
		return nil, err
	}
	for _, anomaly := range findUnusualExpenseClaims(claimRecords, history, expenseAnomalyMinimumHistory, expenseAnomalyMultiple) {
		signals = append(signals, capability.BusinessSignal{
			ID:       fmt.Sprintf("accounting.unusualClaim:%s", anomaly.claimID),
			Severity: "orange",
			Module:   "accounting",
			Subject:  fmt.Sprintf("Unusual expense claim: %s in %s", formatMinor(anomaly.amountMinor), anomaly.category),
			Detail:   fmt.Sprintf("The claim is %s against a %s median across %d approved claims in this category over the last %d days. Approve deliberately or ask for the receipt before it reaches the books.", formatMinor(anomaly.amountMinor), formatMinor(anomaly.medianMinor), anomaly.sampleSize, expenseAnomalyWindowDays),
			Evidence: evidence("expense_claim", anomaly.claimID),
		})
	}

	return signals, nil
}

func accountingInvoices(ctx context.Context, tx pgx.Tx, orgID string) ([]invoiceRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, number, issued_at, due_at, total_minor, paid_minor, credited_minor
		FROM invoices
		WHERE org_id = $1::uuid AND status = 'sent' AND voided_at IS NULL
		ORDER BY id ASC
		LIMIT 200`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var invoices []invoiceRow
	for rows.Next() {
		var invoice invoiceRow
		if err := rows.Scan(&invoice.id, &invoice.number, &invoice.issuedAt, &invoice.dueAt,
			&invoice.totalMinor, &invoice.paidMinor, &invoice.creditedMinor); err != nil {
			return nil, err
		}
		invoices = append(invoices, invoice)
	}
	return invoices, rows.Err()
}

func accountingLapsedQuotes(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]quoteRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, number, expires_at
		FROM quotes
		WHERE org_id = $1::uuid AND status = 'sent' AND expires_at < $2
		ORDER BY id ASC
		LIMIT 100`, orgID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var quotes []quoteRow
	for rows.Next() {
		var quote quoteRow
		if err := rows.Scan(&quote.id, &quote.number, &quote.expiresAt); err != nil {
			return nil, err
		}
		quotes = append(quotes, quote)
	}
	return quotes, rows.Err()
}

func accountingPayments(ctx context.Context, tx pgx.Tx, orgID string) ([]paymentRecord, error) {
	rows, err := tx.Query(ctx, `
		SELECT p.id::text, p.invoice_id::text, p.amount_minor, p.received_at
		FROM payments p
		JOIN invoices i ON i.id = p.invoice_id AND i.org_id = $1::uuid
		WHERE p.org_id = $1::uuid
		ORDER BY p.invoice_id ASC, p.id ASC
		LIMIT $2`, orgID, duplicatePaymentRowCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var payments []paymentRecord
	for rows.Next() {
		var payment paymentRecord
		if err := rows.Scan(&payment.id, &payment.invoiceID, &payment.amountMinor, &payment.receivedAt); err != nil {
			return nil, err
		}
		payments = append(payments, payment)
	}
	return payments, rows.Err()
}

func accountingPendingClaims(ctx context.Context, tx pgx.Tx, orgID string) ([]expenseClaimRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, claimant_user_id::text, amount_minor, category, created_at
		FROM expense_claims
		WHERE org_id = $1::uuid AND status = 'submitted'
		ORDER BY id ASC
		LIMIT $2`, orgID, duplicateClaimRowCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var claims []expenseClaimRow
	for rows.Next() {
		var claim expenseClaimRow
		if err := rows.Scan(&claim.id, &claim.claimantUserID, &claim.amountMinor, &claim.category, &claim.createdAt); err != nil {
			return nil, err
		}
		claims = append(claims, claim)
	}
	return claims, rows.Err()
}

func accountingExpensePolicies(ctx context.Context, tx pgx.Tx, orgID string) ([]expensePolicy, error) {
	rows, err := tx.Query(ctx, `
		SELECT category, limit_minor
		FROM expense_policies
		WHERE org_id = $1::uuid
		ORDER BY id ASC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var policies []expensePolicy
	for rows.Next() {
		var policy expensePolicy
		if err := rows.Scan(&policy.category, &policy.limitMinor); err != nil {
			return nil, err
		}
		policies = append(policies, policy)
	}
	return policies, rows.Err()
}

func accountingExpenseHistory(ctx context.Context, tx pgx.Tx, orgID string, now time.Time) ([]expenseClaimRecord, error) {
	cutoff := now.Add(-time.Duration(expenseAnomalyWindowDays) * 24 * time.Hour)
	rows, err := tx.Query(ctx, `
		SELECT id::text, claimant_user_id::text, amount_minor, category, created_at
		FROM expense_claims
		WHERE org_id = $1::uuid AND status IN ('approved', 'paid') AND created_at >= $2
		ORDER BY id ASC
		LIMIT 2000`, orgID, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	history := make([]expenseClaimRecord, 0)
	for rows.Next() {
		var claim expenseClaimRecord
		if err := rows.Scan(&claim.id, &claim.claimantUserID, &claim.amountMinor, &claim.category, &claim.submittedAt); err != nil {
			return nil, err
		}
		history = append(history, claim)
	}
	return history, rows.Err()
}
