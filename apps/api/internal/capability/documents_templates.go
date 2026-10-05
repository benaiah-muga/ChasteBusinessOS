package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

type DocumentTemplateRow struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Description  *string         `json:"description"`
	Placeholders []string        `json:"placeholders"`
	IsSystem     *string         `json:"isSystem"`
	Content      json.RawMessage `json:"content"`
}

type ListDocumentTemplatesOutput struct {
	Templates []DocumentTemplateRow `json:"templates"`
}

type DocumentTemplateDetail struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Content      json.RawMessage `json:"content"`
	Placeholders []string        `json:"placeholders"`
}

type GetDocumentTemplateOutput struct {
	Template DocumentTemplateDetail `json:"template"`
}

type CreateDocumentTemplateOutput struct {
	TemplateID   string   `json:"templateId"`
	Placeholders []string `json:"placeholders"`
}

type DeleteDocumentTemplateOutput struct {
	Deleted bool `json:"deleted"`
}

func parseDocumentTemplateIDInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	templateID, err := documentsRequiredUUID(fields, "templateId")
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{TemplateID: &templateID}, nil
}

func parseCreateDocumentTemplateInput(raw json.RawMessage) (DocumentsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return DocumentsInput{}, err
	}
	name, err := documentsRequiredString(fields, "name", 1, 120)
	if err != nil {
		return DocumentsInput{}, err
	}
	description, err := documentsOptionalString(fields, "description", 0, 300)
	if err != nil {
		return DocumentsInput{}, err
	}
	content, err := documentsRequiredContentObject(fields, "content")
	if err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{Name: &name, Description: description, Content: content}, nil
}

func listDocumentTemplates(ctx context.Context, tx pgx.Tx, orgID string) (ListDocumentTemplatesOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, description, placeholders, is_system, content_json
		FROM doc_templates
		WHERE org_id = $1::uuid
		ORDER BY is_system DESC, name`, orgID)
	if err != nil {
		return ListDocumentTemplatesOutput{}, err
	}
	defer rows.Close()
	templates := make([]DocumentTemplateRow, 0)
	for rows.Next() {
		var (
			template     DocumentTemplateRow
			placeholders []byte
		)
		if err := rows.Scan(&template.ID, &template.Name, &template.Description, &placeholders,
			&template.IsSystem, &template.Content); err != nil {
			return ListDocumentTemplatesOutput{}, err
		}
		resolved, err := documentsTemplatePlaceholders(placeholders)
		if err != nil {
			return ListDocumentTemplatesOutput{}, err
		}
		template.Placeholders = resolved
		if len(bytes.TrimSpace(template.Content)) == 0 {
			template.Content = json.RawMessage("{}")
		}
		templates = append(templates, template)
	}
	if err := rows.Err(); err != nil {
		return ListDocumentTemplatesOutput{}, err
	}
	return ListDocumentTemplatesOutput{Templates: templates}, nil
}

func getDocumentTemplate(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (GetDocumentTemplateOutput, error) {
	var (
		template     DocumentTemplateDetail
		placeholders []byte
	)
	err := tx.QueryRow(ctx, `
		SELECT id::text, name, content_json, placeholders
		FROM doc_templates
		WHERE org_id = $1::uuid AND id = $2::uuid
		LIMIT 1`, claims.OrganizationID, *input.TemplateID).
		Scan(&template.ID, &template.Name, &template.Content, &placeholders)
	if errors.Is(err, pgx.ErrNoRows) {
		return GetDocumentTemplateOutput{}, rejectDocuments("template not found")
	}
	if err != nil {
		return GetDocumentTemplateOutput{}, err
	}
	resolved, err := documentsTemplatePlaceholders(placeholders)
	if err != nil {
		return GetDocumentTemplateOutput{}, err
	}
	template.Placeholders = resolved
	return GetDocumentTemplateOutput{Template: template}, nil
}

func createDocumentTemplate(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (CreateDocumentTemplateOutput, error) {
	placeholders, err := ExtractDocumentPlaceholders(input.Content)
	if err != nil {
		return CreateDocumentTemplateOutput{}, err
	}
	var templateID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO doc_templates (org_id, name, description, content_json, placeholders)
		VALUES ($1::uuid, $2, $3, $4, $5)
		RETURNING id::text`,
		claims.OrganizationID, *input.Name, input.Description, []byte(input.Content), documentsPlaceholdersJSON(placeholders)).Scan(&templateID); err != nil {
		return CreateDocumentTemplateOutput{}, err
	}
	return CreateDocumentTemplateOutput{TemplateID: templateID, Placeholders: placeholders}, nil
}

func deleteDocumentTemplate(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input DocumentsInput) (DeleteDocumentTemplateOutput, error) {
	var isSystem *string
	if err := tx.QueryRow(ctx, `
		SELECT is_system FROM doc_templates
		WHERE org_id = $1::uuid AND id = $2::uuid
		LIMIT 1`, claims.OrganizationID, *input.TemplateID).Scan(&isSystem); errors.Is(err, pgx.ErrNoRows) {
		return DeleteDocumentTemplateOutput{}, rejectDocuments("template not found")
	} else if err != nil {
		return DeleteDocumentTemplateOutput{}, err
	}
	if isSystem != nil && *isSystem == "system" {
		return DeleteDocumentTemplateOutput{}, rejectDocuments("built-in templates cannot be deleted")
	}
	command, err := tx.Exec(ctx, `
		DELETE FROM doc_templates WHERE org_id = $1::uuid AND id = $2::uuid`, claims.OrganizationID, *input.TemplateID)
	if err != nil {
		return DeleteDocumentTemplateOutput{}, err
	}
	return DeleteDocumentTemplateOutput{Deleted: command.RowsAffected() > 0}, nil
}

func documentsTemplatePlaceholders(raw []byte) ([]string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return []string{}, nil
	}
	var placeholders []string
	if err := json.Unmarshal(trimmed, &placeholders); err != nil {
		return nil, errors.New("template placeholders are invalid")
	}
	if placeholders == nil {
		return []string{}, nil
	}
	return placeholders, nil
}

func documentsPlaceholdersJSON(placeholders []string) []byte {
	if placeholders == nil {
		placeholders = []string{}
	}
	encoded, err := json.Marshal(placeholders)
	if err != nil {
		return []byte("[]")
	}
	return encoded
}

// documentsWhitespaceClass is JavaScript's \s for a regular expression:
// ASCII whitespace plus the Unicode space separators JSON.stringify can emit.
const documentsWhitespaceClass = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// documentsPlaceholderPattern is the module's extractPlaceholders regex:
// {{ optional-whitespace, then a dotted token of 1 to 61 word characters }}.
var documentsPlaceholderPattern = regexp.MustCompile(
	`\{\{` + documentsWhitespaceClass + `*([a-zA-Z][\w.]{0,60})` + documentsWhitespaceClass + `*\}\}`)

// ExtractDocumentPlaceholders finds the unique {{dotted.path}} tokens in a
// template's content. Order matters because the array is returned to the
// caller, so the content is serialized with JSON.stringify semantics rather
// than Go's key-sorted encoder.
func ExtractDocumentPlaceholders(content json.RawMessage) ([]string, error) {
	serialized, err := documentsStringifyJSON(content)
	if err != nil {
		return nil, err
	}
	found := make([]string, 0)
	seen := make(map[string]bool)
	for _, match := range documentsPlaceholderPattern.FindAllStringSubmatch(serialized, -1) {
		token := match[1]
		if seen[token] {
			continue
		}
		seen[token] = true
		found = append(found, token)
	}
	return found, nil
}

// documentsStringifyJSON renders raw JSON the way JSON.stringify does:
// compact, no HTML escaping, keys in JavaScript property order (array indices
// ascending first, then the remaining keys in insertion order).
func documentsStringifyJSON(raw json.RawMessage) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var builder strings.Builder
	if err := documentsWriteJSONValue(&builder, decoder); err != nil {
		return "", err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return "", errors.New("content contains trailing JSON data")
	}
	return builder.String(), nil
}

func documentsWriteJSONValue(builder *strings.Builder, decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	return documentsWriteJSONToken(builder, decoder, token)
}

func documentsWriteJSONToken(builder *strings.Builder, decoder *json.Decoder, token json.Token) error {
	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			return documentsWriteJSONObject(builder, decoder)
		case '[':
			return documentsWriteJSONArray(builder, decoder)
		default:
			return errors.New("content is not valid JSON")
		}
	case string:
		documentsWriteJSONString(builder, value)
		return nil
	case json.Number:
		builder.WriteString(value.String())
		return nil
	case bool:
		builder.WriteString(strconv.FormatBool(value))
		return nil
	case nil:
		builder.WriteString("null")
		return nil
	default:
		return errors.New("content is not valid JSON")
	}
}

func documentsWriteJSONObject(builder *strings.Builder, decoder *json.Decoder) error {
	type member struct {
		key   string
		value json.RawMessage
	}
	members := make([]member, 0)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := keyToken.(string)
		if !ok {
			return errors.New("content is not a JSON object")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		members = append(members, member{key: key, value: value})
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	// JavaScript hoists canonical array-index keys ahead of the rest.
	indexed := make([]int, 0, len(members))
	rest := make([]int, 0, len(members))
	positions := make(map[int]int, len(members))
	for position, entry := range members {
		positions[position] = position
		if documentsArrayIndexKey(entry.key) {
			indexed = append(indexed, position)
		} else {
			rest = append(rest, position)
		}
	}
	sort.Slice(indexed, func(left, right int) bool {
		return documentsArrayIndexValue(members[indexed[left]].key) < documentsArrayIndexValue(members[indexed[right]].key)
	})
	order := append(append([]int{}, indexed...), rest...)

	builder.WriteByte('{')
	for position, memberPosition := range order {
		if position > 0 {
			builder.WriteByte(',')
		}
		documentsWriteJSONString(builder, members[memberPosition].key)
		builder.WriteByte(':')
		nested := json.NewDecoder(bytes.NewReader(members[memberPosition].value))
		nested.UseNumber()
		if err := documentsWriteJSONValue(builder, nested); err != nil {
			return err
		}
	}
	builder.WriteByte('}')
	return nil
}

func documentsWriteJSONArray(builder *strings.Builder, decoder *json.Decoder) error {
	builder.WriteByte('[')
	for position := 0; decoder.More(); position++ {
		if position > 0 {
			builder.WriteByte(',')
		}
		if err := documentsWriteJSONValue(builder, decoder); err != nil {
			return err
		}
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	builder.WriteByte(']')
	return nil
}

// documentsArrayIndexKey reports whether a key is a canonical array index, the
// only kind JavaScript orders ahead of insertion order.
func documentsArrayIndexKey(key string) bool {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return false
	}
	for index := 0; index < len(key); index++ {
		if key[index] < '0' || key[index] > '9' {
			return false
		}
	}
	return len(key) <= 10 && documentsArrayIndexValue(key) < 4294967295
}

func documentsArrayIndexValue(key string) uint64 {
	value, err := strconv.ParseUint(key, 10, 64)
	if err != nil {
		return 0
	}
	return value
}

// documentsWriteJSONString escapes a string the way JSON.stringify does:
// only the mandatory escapes, with every other code point emitted literally
// (no HTML escaping, no lone-surrogate escaping).
func documentsWriteJSONString(builder *strings.Builder, value string) {
	builder.WriteByte('"')
	for _, char := range value {
		switch char {
		case '"':
			builder.WriteString(`\"`)
		case '\\':
			builder.WriteString(`\\`)
		case '\b':
			builder.WriteString(`\b`)
		case '\f':
			builder.WriteString(`\f`)
		case '\n':
			builder.WriteString(`\n`)
		case '\r':
			builder.WriteString(`\r`)
		case '\t':
			builder.WriteString(`\t`)
		default:
			if char < 0x20 {
				builder.WriteString(fmt.Sprintf(`\u%04x`, char))
				continue
			}
			if char == utf8.RuneError {
				builder.WriteString(string(utf8.RuneError))
				continue
			}
			builder.WriteRune(char)
		}
	}
	builder.WriteByte('"')
}
