package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	submitExpenseClaimCapabilityID  = "accounting.submitExpenseClaim"
	decideExpenseClaimCapabilityID  = "accounting.decideExpenseClaim"
	payExpenseClaimCapabilityID     = "accounting.payExpenseClaim"
	listExpenseClaimsCapabilityID   = "accounting.listExpenseClaims"
	listExpensePoliciesCapabilityID = "accounting.listExpensePolicies"
	setExpensePolicyCapabilityID    = "accounting.setExpensePolicy"
)

var expenseClaimStatusValues = []string{"submitted", "approved", "rejected", "paid"}

type SubmitExpenseClaimInput struct {
	AmountMinor int64   `json:"amountMinor"`
	Memo        string  `json:"memo"`
	AccountCode *string `json:"accountCode,omitempty"`
	Category    *string `json:"category,omitempty"`
	DocumentID  *string `json:"documentId,omitempty"`
}

type SubmitExpenseClaimOutput struct {
	ClaimID          string `json:"claimId"`
	Status           string `json:"status"`
	Category         string `json:"category"`
	OverPolicyLimit  bool   `json:"overPolicyLimit"`
	PolicyLimitMinor *int64 `json:"policyLimitMinor"`
}

type DecideExpenseClaimInput struct {
	ClaimID  string  `json:"claimId"`
	Decision string  `json:"decision"`
	Reason   *string `json:"reason,omitempty"`
}

type DecideExpenseClaimOutput struct {
	ClaimID string `json:"claimId"`
	Status  string `json:"status"`
}

type PayExpenseClaimInput struct {
	ClaimID     string `json:"claimId"`
	AmountMinor int64  `json:"amountMinor"`
}

type PayExpenseClaimOutput struct {
	ClaimID   string `json:"claimId"`
	EntryID   string `json:"entryId"`
	PaidMinor int64  `json:"paidMinor"`
}

type ListExpenseClaimsInput struct {
	Status *string `json:"status,omitempty"`
}

type ListExpenseClaimSummary struct {
	ID             string `json:"id"`
	ClaimantUserID string `json:"claimantUserId"`
	AmountMinor    int64  `json:"amountMinor"`
	Status         string `json:"status"`
	Memo           string `json:"memo"`
}

type ListExpenseClaimsOutput struct {
	Claims []ListExpenseClaimSummary `json:"claims"`
}

type ListExpensePoliciesInput struct{}

type ExpensePolicySummary struct {
	Category   string `json:"category"`
	LimitMinor int64  `json:"limitMinor"`
}

type ListExpensePoliciesOutput struct {
	Policies []ExpensePolicySummary `json:"policies"`
}

type SetExpensePolicyInput struct {
	Category   string `json:"category"`
	LimitMinor int64  `json:"limitMinor"`
}

type SetExpensePolicyOutput struct {
	Set        bool   `json:"set"`
	Category   string `json:"category"`
	LimitMinor int64  `json:"limitMinor"`
}

func parseAccountingExpenseInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case submitExpenseClaimCapabilityID:
		return ParseSubmitExpenseClaimInput(raw)
	case decideExpenseClaimCapabilityID:
		return ParseDecideExpenseClaimInput(raw)
	case payExpenseClaimCapabilityID:
		return ParsePayExpenseClaimInput(raw)
	case listExpenseClaimsCapabilityID:
		return ParseListExpenseClaimsInput(raw)
	case listExpensePoliciesCapabilityID:
		return ParseListExpensePoliciesInput(raw)
	case setExpensePolicyCapabilityID:
		return ParseSetExpensePolicyInput(raw)
	default:
		return nil, errors.New("unsupported accounting expense capability")
	}
}

func ParseListExpensePoliciesInput(raw json.RawMessage) (ListExpensePoliciesInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return ListExpensePoliciesInput{}, err
	}
	return ListExpensePoliciesInput{}, nil
}

func ParseSetExpensePolicyInput(raw json.RawMessage) (SetExpensePolicyInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SetExpensePolicyInput{}, err
	}
	var input SetExpensePolicyInput
	if input.Category, err = requiredString(fields, "category"); err != nil {
		return SetExpensePolicyInput{}, err
	}
	if utf16Length(input.Category) < 2 || utf16Length(input.Category) > 40 {
		return SetExpensePolicyInput{}, errors.New("category must contain between 2 and 40 characters")
	}
	input.LimitMinor, err = requiredSafeInteger(fields, "limitMinor")
	if err != nil || input.LimitMinor < 0 {
		return SetExpensePolicyInput{}, errors.New("limitMinor must be a nonnegative integer")
	}
	return input, nil
}

func ParseSubmitExpenseClaimInput(raw json.RawMessage) (SubmitExpenseClaimInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SubmitExpenseClaimInput{}, err
	}
	var input SubmitExpenseClaimInput
	input.AmountMinor, err = requiredSafeInteger(fields, "amountMinor")
	if err != nil || input.AmountMinor <= 0 {
		return SubmitExpenseClaimInput{}, errors.New("amountMinor must be a positive integer")
	}
	if input.Memo, err = requiredString(fields, "memo"); err != nil {
		return SubmitExpenseClaimInput{}, err
	}
	if length := utf16Length(input.Memo); length < 3 || length > 500 {
		return SubmitExpenseClaimInput{}, errors.New("memo must contain between 3 and 500 characters")
	}
	if input.AccountCode, err = optionalString(fields, "accountCode"); err != nil {
		return SubmitExpenseClaimInput{}, err
	}
	if input.Category, err = optionalString(fields, "category"); err != nil {
		return SubmitExpenseClaimInput{}, err
	} else if input.Category != nil && utf16Length(*input.Category) > 40 {
		return SubmitExpenseClaimInput{}, errors.New("category must contain at most 40 characters")
	}
	if input.DocumentID, err = crmTaskOptionalUUID(fields, "documentId"); err != nil {
		return SubmitExpenseClaimInput{}, err
	}
	return input, nil
}

func ParseDecideExpenseClaimInput(raw json.RawMessage) (DecideExpenseClaimInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DecideExpenseClaimInput{}, err
	}
	var input DecideExpenseClaimInput
	if input.ClaimID, err = requiredString(fields, "claimId"); err != nil {
		return DecideExpenseClaimInput{}, err
	}
	if !isZodUUID(input.ClaimID) {
		return DecideExpenseClaimInput{}, errors.New("claimId must be a UUID")
	}
	if input.Decision, err = projectRequiredEnum(fields, "decision", []string{"approved", "rejected"}); err != nil {
		return DecideExpenseClaimInput{}, err
	}
	if input.Reason, err = optionalString(fields, "reason"); err != nil {
		return DecideExpenseClaimInput{}, err
	} else if input.Reason != nil && utf16Length(*input.Reason) > 500 {
		return DecideExpenseClaimInput{}, errors.New("reason must contain at most 500 characters")
	}
	return input, nil
}

func ParsePayExpenseClaimInput(raw json.RawMessage) (PayExpenseClaimInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return PayExpenseClaimInput{}, err
	}
	var input PayExpenseClaimInput
	if input.ClaimID, err = requiredString(fields, "claimId"); err != nil {
		return PayExpenseClaimInput{}, err
	}
	if !isZodUUID(input.ClaimID) {
		return PayExpenseClaimInput{}, errors.New("claimId must be a UUID")
	}
	input.AmountMinor, err = requiredSafeInteger(fields, "amountMinor")
	if err != nil || input.AmountMinor <= 0 {
		return PayExpenseClaimInput{}, errors.New("amountMinor must be a positive integer")
	}
	return input, nil
}

func ParseListExpenseClaimsInput(raw json.RawMessage) (ListExpenseClaimsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return ListExpenseClaimsInput{}, err
	}
	status, err := projectOptionalEnum(fields, "status", expenseClaimStatusValues)
	if err != nil {
		return ListExpenseClaimsInput{}, err
	}
	return ListExpenseClaimsInput{Status: status}, nil
}

var expenseCategoryKeywords = []struct {
	category string
	keywords []string
}{
	{"travel", []string{"taxi", "flight", "airline", "hotel", "train", "mileage", "uber", "parking"}},
	{"meals", []string{"restaurant", "lunch", "dinner", "breakfast", "coffee", "catering"}},
	{"software", []string{"saas", "subscription", "license", "licence", "hosting", "domain"}},
	{"supplies", []string{"office", "stationery", "printer", "paper", "ink", "furniture"}},
}

// suggestExpenseCategory mirrors erp-core suggestExpenseCategory: rules-first,
// deterministic keyword match against the memo, "other" as the fallback.
func suggestExpenseCategory(memo string) string {
	text := strings.ToLower(memo)
	for _, group := range expenseCategoryKeywords {
		for _, keyword := range group.keywords {
			if strings.Contains(text, keyword) {
				return group.category
			}
		}
	}
	return "other"
}

type expensePolicyRow struct {
	category   string
	limitMinor int64
}

type expensePolicyVerdict struct {
	overLimit  bool
	limitMinor *int64
}

// evaluateExpensePolicy mirrors erp-core evaluateExpensePolicy: a category
// without a policy row is never over limit and reports a null ceiling.
func evaluateExpensePolicy(category string, amountMinor int64, policies []expensePolicyRow) expensePolicyVerdict {
	for _, policy := range policies {
		if policy.category != category {
			continue
		}
		limit := policy.limitMinor
		return expensePolicyVerdict{overLimit: amountMinor > limit, limitMinor: &limit}
	}
	return expensePolicyVerdict{}
}

func submitExpenseClaim(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SubmitExpenseClaimInput) (SubmitExpenseClaimOutput, error) {
	orgID := claims.OrganizationID
	var base string
	err := tx.QueryRow(ctx, `SELECT base_currency FROM organizations WHERE id = $1::uuid`, orgID).Scan(&base)
	if errors.Is(err, pgx.ErrNoRows) {
		base = "USD"
	} else if err != nil {
		return SubmitExpenseClaimOutput{}, err
	}
	category := suggestExpenseCategory(input.Memo)
	if input.Category != nil {
		category = *input.Category
	}
	rows, err := tx.Query(ctx, `SELECT category, limit_minor FROM expense_policies WHERE org_id = $1::uuid`, orgID)
	if err != nil {
		return SubmitExpenseClaimOutput{}, err
	}
	policies := make([]expensePolicyRow, 0, 4)
	for rows.Next() {
		var policy expensePolicyRow
		if err := rows.Scan(&policy.category, &policy.limitMinor); err != nil {
			rows.Close()
			return SubmitExpenseClaimOutput{}, err
		}
		policies = append(policies, policy)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SubmitExpenseClaimOutput{}, err
	}
	rows.Close()
	verdict := evaluateExpensePolicy(category, input.AmountMinor, policies)
	var claimID string
	err = tx.QueryRow(ctx, `
		INSERT INTO expense_claims (org_id, claimant_user_id, amount_minor, currency, memo, account_code, category, document_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid)
		RETURNING id::text`, orgID, claims.ActorID, input.AmountMinor, base, input.Memo, input.AccountCode, category, input.DocumentID).Scan(&claimID)
	if err != nil {
		return SubmitExpenseClaimOutput{}, err
	}
	return SubmitExpenseClaimOutput{
		ClaimID: claimID, Status: "submitted", Category: category,
		OverPolicyLimit: verdict.overLimit, PolicyLimitMinor: verdict.limitMinor,
	}, nil
}

func decideExpenseClaim(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DecideExpenseClaimInput) (DecideExpenseClaimOutput, error) {
	var claimID string
	err := tx.QueryRow(ctx, `
		UPDATE expense_claims
		SET status = $3, decided_by_actor_type = $4, decided_by_actor_id = $5::uuid, decision_reason = $6
		WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'submitted'
		RETURNING id::text`, input.ClaimID, claims.OrganizationID, input.Decision, claims.ActorType, claims.ActorID, input.Reason).Scan(&claimID)
	if errors.Is(err, pgx.ErrNoRows) {
		return DecideExpenseClaimOutput{}, errors.New("claim not found or already decided")
	}
	if err != nil {
		return DecideExpenseClaimOutput{}, err
	}
	return DecideExpenseClaimOutput{ClaimID: claimID, Status: input.Decision}, nil
}

func payExpenseClaim(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input PayExpenseClaimInput, now time.Time) (PayExpenseClaimOutput, error) {
	var status, currency, memo string
	var amountMinor int64
	var accountCode *string
	err := tx.QueryRow(ctx, `
		SELECT status, amount_minor, currency, memo, account_code
		FROM expense_claims
		WHERE id = $1::uuid AND org_id = $2::uuid
		LIMIT 1
		FOR UPDATE`, input.ClaimID, claims.OrganizationID).Scan(&status, &amountMinor, &currency, &memo, &accountCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return PayExpenseClaimOutput{}, errors.New("claim not found")
	}
	if err != nil {
		return PayExpenseClaimOutput{}, err
	}
	if status != "approved" {
		return PayExpenseClaimOutput{}, fmt.Errorf("claim is %s, not approved", status)
	}
	if amountMinor != input.AmountMinor {
		return PayExpenseClaimOutput{}, fmt.Errorf("amount mismatch: approved %d", amountMinor)
	}
	expenseCode := "6900"
	if accountCode != nil {
		expenseCode = *accountCode
	}
	entryID, err := postJournalEntry(ctx, tx, PostJournalEntryInput{
		OrgID:      claims.OrganizationID,
		Memo:       fmt.Sprintf("Expense reimbursement: %s", sliceUTF16CodeUnits(memo, 80)),
		SourceType: "expense_claim",
		SourceID:   &input.ClaimID,
		Currency:   currency,
		PostedAt:   now,
		ActorType:  claims.ActorType,
		ActorID:    claims.ActorID,
		Lines: []JournalEntryLineInput{
			{AccountCode: expenseCode, DebitMinor: amountMinor},
			{AccountCode: "1000", CreditMinor: amountMinor},
		},
	})
	if err != nil {
		return PayExpenseClaimOutput{}, err
	}
	if tag, err := tx.Exec(ctx, `
		UPDATE expense_claims SET status = 'paid', payment_entry_id = $2::uuid
		WHERE id = $1::uuid AND org_id = $3::uuid AND status = 'approved'`, input.ClaimID, entryID, claims.OrganizationID); err != nil {
		return PayExpenseClaimOutput{}, err
	} else if tag.RowsAffected() != 1 {
		return PayExpenseClaimOutput{}, errors.New("claim is no longer approved")
	}
	return PayExpenseClaimOutput{ClaimID: input.ClaimID, EntryID: entryID, PaidMinor: amountMinor}, nil
}

func sliceUTF16CodeUnits(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if len(units) > limit {
		units = units[:limit]
	}
	return string(utf16.Decode(units))
}

func listExpenseClaims(ctx context.Context, tx pgx.Tx, orgID string, input ListExpenseClaimsInput) (ListExpenseClaimsOutput, error) {
	query := `
		SELECT id::text, claimant_user_id::text, amount_minor, status, memo
		FROM expense_claims
		WHERE org_id = $1::uuid`
	args := []any{orgID}
	if input.Status != nil {
		query += ` AND status = $2`
		args = append(args, *input.Status)
	}
	query += ` ORDER BY created_at DESC LIMIT 100`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return ListExpenseClaimsOutput{}, err
	}
	defer rows.Close()
	claims := make([]ListExpenseClaimSummary, 0)
	for rows.Next() {
		var claim ListExpenseClaimSummary
		if err := rows.Scan(&claim.ID, &claim.ClaimantUserID, &claim.AmountMinor, &claim.Status, &claim.Memo); err != nil {
			return ListExpenseClaimsOutput{}, err
		}
		claims = append(claims, claim)
	}
	if err := rows.Err(); err != nil {
		return ListExpenseClaimsOutput{}, err
	}
	return ListExpenseClaimsOutput{Claims: claims}, nil
}

func listExpensePolicies(ctx context.Context, tx pgx.Tx, orgID string) (ListExpensePoliciesOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT category, limit_minor
		FROM expense_policies
		WHERE org_id = $1::uuid
		ORDER BY limit_minor DESC`, orgID)
	if err != nil {
		return ListExpensePoliciesOutput{}, err
	}
	defer rows.Close()
	policies := make([]ExpensePolicySummary, 0)
	for rows.Next() {
		var policy ExpensePolicySummary
		if err := rows.Scan(&policy.Category, &policy.LimitMinor); err != nil {
			return ListExpensePoliciesOutput{}, err
		}
		policies = append(policies, policy)
	}
	if err := rows.Err(); err != nil {
		return ListExpensePoliciesOutput{}, err
	}
	return ListExpensePoliciesOutput{Policies: policies}, nil
}

func setExpensePolicy(ctx context.Context, tx pgx.Tx, orgID string, input SetExpensePolicyInput) (SetExpensePolicyOutput, error) {
	_, err := tx.Exec(ctx, `
		INSERT INTO expense_policies (org_id, category, limit_minor)
		VALUES ($1::uuid, $2, $3)
		ON CONFLICT (org_id, category) DO UPDATE SET limit_minor = EXCLUDED.limit_minor`,
		orgID, input.Category, input.LimitMinor)
	if err != nil {
		return SetExpensePolicyOutput{}, err
	}
	return SetExpensePolicyOutput{Set: true, Category: input.Category, LimitMinor: input.LimitMinor}, nil
}
