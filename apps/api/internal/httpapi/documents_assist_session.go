package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const documentsAssistBodyLimit = 80 << 10

type documentsAssistInput struct {
	Kind       string  `json:"kind"`
	Action     string  `json:"action,omitempty"`
	Text       string  `json:"text,omitempty"`
	Language   *string `json:"language,omitempty"`
	Before     string  `json:"before,omitempty"`
	After      *string `json:"after,omitempty"`
	TemplateID string  `json:"templateId,omitempty"`
	DocumentID string  `json:"documentId,omitempty"`
	Question   string  `json:"question,omitempty"`
}

type documentsAssistTemplate struct {
	Name         string
	Placeholders []string
}

type documentsAssistDocument struct {
	Title   string
	Content json.RawMessage
}

type documentsAssistRepository interface {
	LoadTemplate(context.Context, string, string) (documentsAssistTemplate, bool, error)
	LoadProfileFacts(context.Context, string) ([]string, error)
	LoadDocument(context.Context, string, string) (documentsAssistDocument, bool, error)
}

type documentsAssistModel interface {
	Complete(context.Context, myWorkSummaryConfig, string, string, string, float64, int) (string, error)
	CodingAgentBrief(context.Context, supportCodingAgentConnection, string, string) (string, int64, int64, error)
}

type documentsAssistSessionHandler struct {
	resolver DirectCapabilitySessionResolver
	store    documentsAssistRepository
	config   myWorkSummaryConfigReader
	model    documentsAssistModel
	logger   *slog.Logger
	trusted  []*net.IPNet
}

func NewDocumentsAssistSessionHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return newDocumentsAssistSessionHandler(resolver, postgresDocumentsAssistRepository{pool: pool}, NewMyWorkSummaryPostgresReader(pool), &openAIWorkSummaryModel{}, logger, trusted)
}

func newDocumentsAssistSessionHandler(resolver DirectCapabilitySessionResolver, store documentsAssistRepository, config myWorkSummaryConfigReader, model documentsAssistModel, logger *slog.Logger, trusted []*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &documentsAssistSessionHandler{resolver: resolver, store: store, config: config, model: model, logger: logger, trusted: trusted}
}

func (h *documentsAssistSessionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.store == nil || h.config == nil || h.model == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "document assistant unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	resolved, err := resolveDirectCapabilitySession(r, h.resolver, selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) {
		h.unauthorized(w)
		return
	}
	if !matchesRequestedOrganization(r, resolved) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "organization access denied"})
		return
	}
	if !sameOriginCapabilityRequest(r, h.trusted) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "documents") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: Documents module is disabled"})
		return
	}
	input, ok := decodeDocumentsAssistInput(w, r)
	if !ok {
		return
	}
	permission := "documents.read"
	if input.Kind == "selection" || input.Kind == "continue" {
		permission = "documents.write"
	}
	if !resolved.HasPermission(permission) && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing " + permission})
		return
	}
	h.handle(w, r, resolved, input)
}

func decodeDocumentsAssistInput(w http.ResponseWriter, r *http.Request) (documentsAssistInput, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, documentsAssistBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input documentsAssistInput
	if decoder.Decode(&input) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return input, false
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return input, false
	}
	if !validDocumentsAssistInput(input) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return input, false
	}
	return input, true
}

func validDocumentsAssistInput(input documentsAssistInput) bool {
	if !utf8.ValidString(input.Text) || !utf8.ValidString(input.Before) || !utf8.ValidString(input.Question) {
		return false
	}
	switch input.Kind {
	case "selection":
		if !map[string]bool{"improve": true, "grammar": true, "tone": true, "shorten": true, "expand": true, "translate": true}[input.Action] || utf16Length(input.Text) == 0 || utf16Length(input.Text) > 12_000 {
			return false
		}
		return input.Language == nil || (utf8.ValidString(*input.Language) && utf16Length(*input.Language) <= 40)
	case "continue":
		return utf16Length(input.Before) <= 12_000 && (input.After == nil || (utf8.ValidString(*input.After) && utf16Length(*input.After) <= 4_000))
	case "prefill":
		return isUUID(input.TemplateID)
	case "chat":
		return isUUID(input.DocumentID) && utf16Length(input.Question) > 0 && utf16Length(input.Question) <= 2_000
	default:
		return false
	}
}

func (h *documentsAssistSessionHandler) handle(w http.ResponseWriter, r *http.Request, user *session.ResolvedUser, input documentsAssistInput) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	orgID := *user.OrgID
	switch input.Kind {
	case "selection":
		instruction := map[string]string{
			"improve": "Improve the writing: clearer, tighter, better flow. Keep the meaning and the language.",
			"grammar": "Fix grammar, spelling and punctuation only. Do not change style or meaning.",
			"tone":    "Rewrite in a professional, warm and confident business tone. Keep the meaning.",
			"shorten": "Say the same thing in fewer words. Keep every essential fact.",
			"expand":  "Expand this with useful detail and specificity, without inventing facts, numbers or commitments.",
		}[input.Action]
		if input.Action == "translate" {
			language := "English"
			if input.Language != nil && strings.TrimSpace(*input.Language) != "" {
				language = *input.Language
			}
			instruction = "Translate the text into " + language + ". Reply with only the translation."
		}
		text, err := h.generate(ctx, orgID, user.UserID,
			"You are a precise writing assistant inside a business document editor. Reply with ONLY the rewritten text, no preamble, no quotes around it.",
			instruction+"\n\n---\n"+input.Text)
		h.writeText(w, orgID, "selection", text, err)
	case "continue":
		prompt := input.Before
		if input.After != nil && *input.After != "" {
			prompt += "\n[...]\n" + *input.After
		}
		text, err := h.generate(ctx, orgID, user.UserID,
			"You continue the user's business document. Continue naturally from where the text stops, matching its tone and formatting. Reply with ONLY the continuation, 1-3 sentences unless more is obviously needed.", prompt)
		h.writeText(w, orgID, "continue", text, err)
	case "prefill":
		template, found, err := h.store.LoadTemplate(ctx, orgID, input.TemplateID)
		if err != nil {
			h.fail(w, "read document template", orgID, err)
			return
		}
		if !found {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "template not found"})
			return
		}
		if len(template.Placeholders) == 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "values": map[string]string{}})
			return
		}
		facts, err := h.store.LoadProfileFacts(ctx, orgID)
		if err != nil {
			h.fail(w, "read document prefill facts", orgID, err)
			return
		}
		known := strings.Join(facts, "\n")
		if known == "" {
			known = "(none recorded)"
		}
		prompt := "Business facts:\n" + known + "\n\nTemplate: " + template.Name + "\nPlaceholders: " + strings.Join(template.Placeholders, ", ")
		raw, err := h.generate(ctx, orgID, user.UserID,
			"You fill in document template placeholders for a business. Use ONLY the facts provided; if a value is unknown, use an empty string. Reply with ONLY a JSON object mapping placeholder path to string value.", prompt)
		if err != nil {
			h.fail(w, "generate document prefill", orgID, err)
			return
		}
		values := parseDocumentsAssistValues(raw, template.Placeholders)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "values": values})
	case "chat":
		document, found, err := h.store.LoadDocument(ctx, orgID, input.DocumentID)
		if err != nil {
			h.fail(w, "read document for assistant", orgID, err)
			return
		}
		if !found {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "document not found"})
			return
		}
		docText := documentsAssistPlainText(document.Content)
		if docText == "" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "the document is empty"})
			return
		}
		docText = truncateDocumentsAssistText(docText, 12_000)
		prompt := "Document \"" + document.Title + "\":\n" + docText + "\n\nQuestion: " + input.Question
		text, err := h.generate(ctx, orgID, user.UserID,
			"Answer questions about the document the user is writing. Ground every answer in the document; say honestly when it does not contain the answer. Be concise.", prompt)
		h.writeText(w, orgID, "chat", text, err)
	}
}

func (h *documentsAssistSessionHandler) generate(ctx context.Context, orgID, userID, system, prompt string) (string, error) {
	config, err := h.config.LoadForOrg(ctx, orgID, userID)
	if err != nil {
		return "", err
	}
	if config.codingAgent == nil {
		if strings.TrimSpace(config.apiKey) == "" || strings.TrimSpace(config.baseURL) == "" || strings.TrimSpace(config.fastModel) == "" {
			return "", errors.New("workspace AI provider is incomplete")
		}
		return h.model.Complete(ctx, config, config.fastModel, system, prompt, 0.4, 2_000)
	}
	text, inputTokens, outputTokens, err := h.model.CodingAgentBrief(ctx, *config.codingAgent, system, prompt)
	if err != nil {
		return "", err
	}
	if inputTokens > 0 || outputTokens > 0 {
		if err := h.config.RecordCodingAgentUsage(ctx, orgID, userID, config.codingAgent.connectionID, inputTokens, outputTokens); err != nil {
			return "", err
		}
	}
	return text, nil
}

func (h *documentsAssistSessionHandler) writeText(w http.ResponseWriter, orgID, kind, text string, err error) {
	if err != nil {
		h.fail(w, "generate document assistant "+kind, orgID, err)
		return
	}
	if strings.TrimSpace(text) == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "the model returned nothing, try again"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "text": text})
}

func (h *documentsAssistSessionHandler) unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

func (h *documentsAssistSessionHandler) fail(w http.ResponseWriter, action, orgID string, err error) {
	if h.logger != nil {
		h.logger.Error("document assistant request failed", "action", action, "organizationId", orgID, "error", err)
	}
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": "the assistant could not help with that, try again"})
}

type postgresDocumentsAssistRepository struct{ pool *pgxpool.Pool }

func (repository postgresDocumentsAssistRepository) LoadTemplate(ctx context.Context, orgID, templateID string) (documentsAssistTemplate, bool, error) {
	var template documentsAssistTemplate
	found := false
	err := documentsAssistOrgTx(ctx, repository.pool, orgID, func(tx pgx.Tx) error {
		var placeholders []byte
		err := tx.QueryRow(ctx, `SELECT name, placeholders FROM doc_templates WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`, templateID, orgID).Scan(&template.Name, &placeholders)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		if err := json.Unmarshal(placeholders, &template.Placeholders); err != nil {
			return errors.New("document template placeholders are invalid")
		}
		return nil
	})
	return template, found, err
}

func (repository postgresDocumentsAssistRepository) LoadProfileFacts(ctx context.Context, orgID string) ([]string, error) {
	facts := make([]string, 0, 6)
	err := documentsAssistOrgTx(ctx, repository.pool, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT content FROM memories WHERE org_id=$1::uuid AND kind LIKE '%profile%' LIMIT 6`, orgID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var fact string
			if err := rows.Scan(&fact); err != nil {
				return err
			}
			facts = append(facts, fact)
		}
		return rows.Err()
	})
	return facts, err
}

func (repository postgresDocumentsAssistRepository) LoadDocument(ctx context.Context, orgID, documentID string) (documentsAssistDocument, bool, error) {
	var document documentsAssistDocument
	found := false
	err := documentsAssistOrgTx(ctx, repository.pool, orgID, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT title, content_json FROM authored_docs WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`, documentID, orgID).Scan(&document.Title, &document.Content)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err == nil {
			found = true
		}
		return err
	})
	return document, found, err
}

func documentsAssistOrgTx(ctx context.Context, pool *pgxpool.Pool, orgID string, callback func(pgx.Tx) error) error {
	if pool == nil || !isUUID(orgID) {
		return errors.New("document assistant database is unavailable")
	}
	_, err := dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (struct{}, error) {
		return struct{}{}, callback(tx)
	})
	return err
}

func parseDocumentsAssistValues(raw string, allowed []string) map[string]string {
	values := make(map[string]string)
	start, end := strings.Index(raw, "{"), strings.LastIndex(raw, "}")
	if start < 0 || end < start {
		return values
	}
	var candidate map[string]json.RawMessage
	if json.Unmarshal([]byte(raw[start:end+1]), &candidate) != nil {
		return values
	}
	for _, key := range allowed {
		var value string
		if encoded, exists := candidate[key]; exists && json.Unmarshal(encoded, &value) == nil {
			values[key] = value
		}
	}
	return values
}

func documentsAssistPlainText(content json.RawMessage) string {
	var root any
	if json.Unmarshal(content, &root) != nil {
		return ""
	}
	var output strings.Builder
	var walk func(any)
	walk = func(value any) {
		node, ok := value.(map[string]any)
		if !ok {
			return
		}
		kind, _ := node["type"].(string)
		if kind == "text" {
			if text, ok := node["text"].(string); ok {
				output.WriteString(text)
				output.WriteByte(' ')
			}
		} else if kind == "paragraph" || kind == "heading" {
			output.WriteByte('\n')
		}
		if children, ok := node["content"].([]any); ok {
			for _, child := range children {
				walk(child)
			}
		}
	}
	walk(root)
	lines := strings.Split(output.String(), "\n")
	for index, line := range lines {
		lines[index] = strings.Join(strings.Fields(line), " ")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func truncateDocumentsAssistText(value string, maxUnits int) string {
	var output strings.Builder
	units := 0
	for _, character := range value {
		width := 1
		if character > 0xffff {
			width = 2
		}
		if units+width > maxUnits {
			break
		}
		output.WriteRune(character)
		units += width
	}
	return output.String()
}
