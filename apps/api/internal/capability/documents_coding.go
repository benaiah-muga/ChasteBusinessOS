package capability

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	documentsCodingFallbackExpenseCode = "6000"
	documentsCodingMaxLines            = 50
	documentsCodingDefaultQuantity     = 1000
)

type DocumentCodingSuggestion struct {
	Description          string `json:"description"`
	QuantityThousandths  int64  `json:"quantityThousandths"`
	UnitPriceMinor       int64  `json:"unitPriceMinor"`
	SuggestedAccountCode string `json:"suggestedAccountCode"`
	MatchScore           int64  `json:"matchScore"`
}

type SuggestDocumentCodingOutput struct {
	Suggestions []DocumentCodingSuggestion `json:"suggestions"`
}

// CoderAccount is one chart-of-accounts row the matcher can score against.
type CoderAccount struct {
	Code string
	Name string
	Type string
}

// CodingMatch is one scored expense account plus the description tokens that
// earned the match. MatchedOn is stored but never returned to the caller.
type CodingMatch struct {
	Code      string
	Score     int64
	MatchedOn []string
}

// documentsCodingSynonyms steers a line toward the account whose name carries
// the paired token, however the vendor words the line. Order is the canonical
// term followed by its synonyms, matching the TypeScript map.
var documentsCodingSynonyms = []struct {
	Canonical string
	Terms     []string
}{
	{"rent", []string{"rent", "lease", "premises"}},
	{"utilities", []string{"electricity", "water", "power", "utilities"}},
	{"internet", []string{"internet", "broadband", "wifi"}},
	{"telephone", []string{"phone", "telephone", "airtime", "data bundle"}},
	{"insurance", []string{"insurance", "premium"}},
	{"salaries", []string{"salary", "salaries", "wages", "payroll", "staff cost"}},
	{"marketing", []string{"marketing", "advertis", "promo"}},
	{"professional", []string{"legal", "audit", "consult", "professional fee", "accounting fee"}},
	{"repair", []string{"repair", "maintenance", "servicing"}},
	{"transport", []string{"transport", "freight", "delivery", "courier", "shipping"}},
	{"fuel", []string{"fuel", "diesel", "petrol", "gasoline"}},
	{"licenses", []string{"license", "licence", "permit", "subscription", "saas"}},
	{"bank", []string{"bank charge", "transaction fee", "processing fee"}},
	{"goods", []string{"cogs", "coffee", "beans", "merchandise", "resale", "stock purchase"}},
	{"expenses", []string{"office", "supplies", "stationery", "consumables", "general"}},
}

// documentsCodingTokenize mirrors the domain tokenizer: lowercase, split on
// runs of non-alphanumerics, keep tokens longer than two characters.
func documentsCodingTokenize(text string) []string {
	lowered := strings.ToLower(text)
	tokens := make([]string, 0, 8)
	current := strings.Builder{}
	flush := func() {
		if current.Len() > 2 {
			tokens = append(tokens, current.String())
		}
		current.Reset()
	}
	for index := 0; index < len(lowered); index++ {
		char := lowered[index]
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			current.WriteByte(char)
			continue
		}
		flush()
	}
	flush()
	return tokens
}

// documentsCodingExpandTokens adds each canonical term whose own name or any
// synonym is contained in one of the description tokens. The original tokens
// come first and duplicates are possible, matching the TypeScript spread.
func documentsCodingExpandTokens(tokens []string) []string {
	expanded := make([]string, 0, len(tokens)+8)
	expanded = append(expanded, tokens...)
	for _, entry := range documentsCodingSynonyms {
		terms := append([]string{entry.Canonical}, entry.Terms...)
		for _, term := range terms {
			for _, token := range tokens {
				if token == term || strings.Contains(token, term) {
					expanded = append(expanded, entry.Canonical)
					break
				}
			}
		}
	}
	return expanded
}

// SuggestExpenseAccount is the pure domain rule: score every expense account
// by the description tokens it shares with the account name, and break ties on
// the ascending account code so the result is stable regardless of row order.
// It never fails; an org with no expense account falls back to 6000.
func SuggestExpenseAccount(description string, accounts []CoderAccount) CodingMatch {
	expenses := make([]CoderAccount, 0, len(accounts))
	for _, account := range accounts {
		if account.Type == "expense" {
			expenses = append(expenses, account)
		}
	}
	fallback := CoderAccount{Code: documentsCodingFallbackExpenseCode}
	if len(expenses) > 0 {
		fallback = expenses[0]
		for _, account := range expenses {
			if account.Code == documentsCodingFallbackExpenseCode {
				fallback = account
				break
			}
		}
	}

	seen := make(map[string]bool, 16)
	descriptionTokens := make([]string, 0, 16)
	for _, token := range documentsCodingExpandTokens(documentsCodingTokenize(description)) {
		if seen[token] {
			continue
		}
		seen[token] = true
		descriptionTokens = append(descriptionTokens, token)
	}

	best := CodingMatch{Code: fallback.Code, Score: 0, MatchedOn: []string{}}
	for _, account := range expenses {
		nameTokens := documentsCodingTokenize(account.Name)
		matched := make([]string, 0, 4)
		for _, token := range descriptionTokens {
			for _, nameToken := range nameTokens {
				if nameToken == token || strings.Contains(nameToken, token) || strings.Contains(token, nameToken) {
					matched = append(matched, token)
					break
				}
			}
		}
		score := int64(len(matched))
		if score > best.Score || (score == best.Score && score > 0 && account.Code < best.Code) {
			best = CodingMatch{Code: account.Code, Score: score, MatchedOn: matched}
		}
	}
	return best
}

func parseSuggestCodingInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	documentID, err := documentsRequiredPlainString(fields, "documentId")
	if err != nil {
		return DocumentsInput{}, err
	}
	rawLines, ok := fields["lines"]
	if !ok {
		return DocumentsInput{DocumentID: &documentID}, nil
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(rawLines, &entries); err != nil || entries == nil {
		return DocumentsInput{}, errors.New("lines must be an array of line objects")
	}
	if len(entries) < 1 || len(entries) > documentsCodingMaxLines {
		return DocumentsInput{}, errors.New("lines must contain between 1 and 50 line items")
	}
	lines := make([]DocumentsCodingLine, 0, len(entries))
	for _, entry := range entries {
		description, err := documentsRequiredString(entry, "description", 1, documentsUnbounded)
		if err != nil {
			return DocumentsInput{}, err
		}
		quantity := int64(documentsCodingDefaultQuantity)
		if _, present := entry["quantityThousandths"]; present {
			value, err := documentsBoundedInteger(entry, "quantityThousandths", 1, maxSafeInteger)
			if err != nil {
				return DocumentsInput{}, err
			}
			quantity = value
		}
		price, err := documentsBoundedInteger(entry, "unitPriceMinor", 0, maxSafeInteger)
		if err != nil {
			return DocumentsInput{}, err
		}
		lines = append(lines, DocumentsCodingLine{
			Description: description, QuantityThousandths: quantity, UnitPriceMinor: price,
		})
	}
	return DocumentsInput{DocumentID: &documentID, Lines: lines}, nil
}

// suggestDocumentCoding replaces any previous suggestion set for the document
// with a fresh one, so the stored state always reflects the latest run.
func suggestDocumentCoding(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (SuggestDocumentCodingOutput, error) {
	var (
		parsedMarkdown *string
		rawText        *string
	)
	err := tx.QueryRow(ctx, `
		SELECT parsed_markdown, raw_text FROM documents
		WHERE org_id = $1::uuid AND id = $2::uuid
		LIMIT 1`, claims.OrganizationID, *input.DocumentID).Scan(&parsedMarkdown, &rawText)
	if errors.Is(err, pgx.ErrNoRows) {
		return SuggestDocumentCodingOutput{}, rejectDocuments("no document %s", *input.DocumentID)
	}
	if err != nil {
		return SuggestDocumentCodingOutput{}, err
	}

	lines := input.Lines
	if lines == nil {
		// The module extracts lines from the parsed text with a model when the
		// caller omits them. No Go provider is wired, so the omission is a
		// refusal rather than a guessed line set: silently coding nothing would
		// replace real suggestions with none.
		text := documentsCoalesceString(parsedMarkdown, rawText)
		if strings.TrimSpace(text) == "" {
			return SuggestDocumentCodingOutput{}, rejectDocuments("document has no parsed text yet, parse it first")
		}
		return SuggestDocumentCodingOutput{}, rejectDocuments(
			"extracting bill lines from document text needs a model provider, which the Go runtime does not have; pass lines explicitly")
	}
	if len(lines) == 0 {
		return SuggestDocumentCodingOutput{}, rejectDocuments("no bill lines could be extracted from this document")
	}

	rows, err := tx.Query(ctx, `
		SELECT code, name, type FROM accounts WHERE org_id = $1::uuid`, claims.OrganizationID)
	if err != nil {
		return SuggestDocumentCodingOutput{}, err
	}
	accounts := make([]CoderAccount, 0)
	for rows.Next() {
		var account CoderAccount
		if err := rows.Scan(&account.Code, &account.Name, &account.Type); err != nil {
			rows.Close()
			return SuggestDocumentCodingOutput{}, err
		}
		accounts = append(accounts, account)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SuggestDocumentCodingOutput{}, err
	}
	rows.Close()

	suggestions := make([]DocumentCodingSuggestion, 0, len(lines))
	for _, line := range lines {
		match := SuggestExpenseAccount(line.Description, accounts)
		suggestions = append(suggestions, DocumentCodingSuggestion{
			Description:          line.Description,
			QuantityThousandths:  line.QuantityThousandths,
			UnitPriceMinor:       line.UnitPriceMinor,
			SuggestedAccountCode: match.Code,
			MatchScore:           match.Score,
		})
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM document_suggestions
		WHERE org_id = $1::uuid AND document_id = $2::uuid`, claims.OrganizationID, *input.DocumentID); err != nil {
		return SuggestDocumentCodingOutput{}, err
	}
	for _, suggestion := range suggestions {
		if suggestion.QuantityThousandths > maxDatabaseInteger || suggestion.UnitPriceMinor > maxDatabaseInteger {
			return SuggestDocumentCodingOutput{}, rejectDocuments("a line amount exceeds what the ledger stores")
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO document_suggestions (
				org_id, document_id, description, quantity_thousandths, unit_price_minor,
				suggested_account_code, match_score, matched_on)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, '[]'::jsonb)`,
			claims.OrganizationID, *input.DocumentID, suggestion.Description,
			suggestion.QuantityThousandths, suggestion.UnitPriceMinor,
			suggestion.SuggestedAccountCode, suggestion.MatchScore); err != nil {
			return SuggestDocumentCodingOutput{}, err
		}
	}
	return SuggestDocumentCodingOutput{Suggestions: suggestions}, nil
}

func documentsCoalesceString(primary, secondary *string) string {
	if primary != nil && *primary != "" {
		return *primary
	}
	if secondary != nil {
		return *secondary
	}
	return ""
}
