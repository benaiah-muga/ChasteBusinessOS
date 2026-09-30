package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	supportStartConversationCapabilityID    = "support.startConversation"
	supportPostMessageCapabilityID          = "support.postMessage"
	supportListConversationsCapabilityID    = "support.listConversations"
	supportListLibraryCapabilityID          = "support.listLibrary"
	supportReadConversationCapabilityID     = "support.readConversation"
	supportLookupOrderStatusCapabilityID    = "support.lookupOrderStatus"
	supportSearchKnowledgeCapabilityID      = "support.searchKnowledge"
	supportEscalateConversationCapabilityID = "support.escalateConversation"
	supportResolveConversationCapabilityID  = "support.resolveConversation"
	supportReopenConversationCapabilityID   = "support.reopenConversation"
	supportCreateTicketCapabilityID         = "support.createTicket"
	supportUpdateTicketCapabilityID         = "support.updateTicket"
	supportSuggestCategoryCapabilityID      = "support.suggestCategory"
	supportCreateCannedResponseCapabilityID = "support.createCannedResponse"
	supportCreateKbArticleCapabilityID      = "support.createKbArticle"

	supportSubjectMax            = 200
	supportMessageBodyMax        = 4000
	supportTranscriptMaxMessages = 20
)

type SupportBoundConversation struct {
	ID             string
	Status         string
	CustomerID     *string
	Subject        string
	CustomerName   string
	CustomerEmail  *string
	Priority       string
	Category       *string
	AssignedUserID *string
	SLADueAt       *string
}

func supportLoadBoundConversation(ctx context.Context, tx pgx.Tx, orgID, conversationID string) (*SupportBoundConversation, error) {
	var conv SupportBoundConversation
	var customerName, visitorEmail *string
	var customerEmail *string
	var slaDueAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT c.id::text, c.status, c.customer_id::text, c.subject, cu.name, cu.email, c.visitor_email,
			c.priority, c.category, c.assigned_user_id::text, c.sla_due_at
		FROM support_conversations c
		LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.org_id=$1::uuid
		WHERE c.id=$2::uuid AND c.org_id=$1::uuid LIMIT 1`, orgID, conversationID).Scan(
		&conv.ID, &conv.Status, &conv.CustomerID, &conv.Subject, &customerName, &customerEmail, &visitorEmail,
		&conv.Priority, &conv.Category, &conv.AssignedUserID, &slaDueAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if customerName != nil {
		conv.CustomerName = *customerName
	} else if visitorEmail != nil {
		conv.CustomerName = "Website visitor"
	} else {
		conv.CustomerName = "Unbound"
	}
	if customerEmail != nil {
		conv.CustomerEmail = customerEmail
	} else if visitorEmail != nil {
		conv.CustomerEmail = visitorEmail
	}
	if slaDueAt != nil {
		formatted := slaDueAt.UTC().Format("2006-01-02T15:04:05.000Z07:00")
		conv.SLADueAt = &formatted
	}
	return &conv, nil
}

type SupportStartConversationInput struct {
	CustomerID string `json:"customerId"`
	Subject    string `json:"subject"`
}

type SupportStartConversationOutput struct {
	ConversationID string `json:"conversationId"`
}

type SupportPostMessageInput struct {
	ConversationID string `json:"conversationId"`
	Body           string `json:"body"`
	From           string `json:"from"`
}

type SupportPostMessageOutput struct {
	MessageID  string `json:"messageId"`
	SenderType string `json:"senderType"`
}

type SupportListConversationsInput struct {
	Status            *string `json:"status"`
	Limit             int64   `json:"limit"`
	CustomerBoundOnly bool    `json:"customerBoundOnly"`
}

type SupportConversationListItem struct {
	ID                 string `json:"id"`
	CustomerID         string `json:"customerId"`
	CustomerName       string `json:"customerName"`
	Subject            string `json:"subject"`
	Status             string `json:"status"`
	LastMessageAt      string `json:"lastMessageAt"`
	LastMessagePreview string `json:"lastMessagePreview"`
}

type SupportListConversationsOutput struct {
	Conversations []SupportConversationListItem `json:"conversations"`
}

type SupportLibraryInput struct{}

type SupportCannedResponse struct {
	ID       string `json:"id"`
	Shortcut string `json:"shortcut"`
	Title    string `json:"title"`
	Body     string `json:"body"`
}

type SupportKnowledgeArticle struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Body     string  `json:"body"`
	Category *string `json:"category"`
}

type SupportLibraryOutput struct {
	Canned   []SupportCannedResponse   `json:"canned"`
	Articles []SupportKnowledgeArticle `json:"articles"`
}

type SupportReadConversationInput struct {
	ConversationID string `json:"conversationId"`
	Limit          int64  `json:"limit"`
	FullDetail     bool   `json:"-"`
}

type SupportTranscriptMessage struct {
	ID             string  `json:"id"`
	OrgID          string  `json:"orgId"`
	ConversationID string  `json:"conversationId"`
	SenderType     string  `json:"senderType"`
	SenderUserID   *string `json:"senderUserId"`
	Body           string  `json:"body"`
	CreatedAt      string  `json:"createdAt"`
}

type SupportReadConversationOutput struct {
	Conversation SupportConversationHeader  `json:"conversation"`
	Messages     []SupportTranscriptMessage `json:"messages"`
	FullDetail   bool                       `json:"-"`
}

func (output SupportReadConversationOutput) MarshalJSON() ([]byte, error) {
	if !output.FullDetail {
		return json.Marshal(legacyReadConversationOutput(output))
	}
	type fullOutput SupportReadConversationOutput
	return json.Marshal(fullOutput(output))
}

type SupportConversationHeader struct {
	ID             string  `json:"id"`
	CustomerID     *string `json:"customerId"`
	CustomerName   string  `json:"customerName"`
	Subject        string  `json:"subject"`
	Status         string  `json:"status"`
	Priority       string  `json:"priority"`
	Category       *string `json:"category"`
	AssignedUserID *string `json:"assignedUserId"`
	SLADueAt       *string `json:"slaDueAt"`
	CustomerEmail  *string `json:"customerEmail"`
}

type SupportLookupOrderStatusInput struct {
	ConversationID string `json:"conversationId"`
}

type SupportInvoiceStatus struct {
	Number           int64   `json:"number"`
	Status           string  `json:"status"`
	TotalMinor       int64   `json:"totalMinor"`
	PaidMinor        int64   `json:"paidMinor"`
	OutstandingMinor int64   `json:"outstandingMinor"`
	IssuedAt         *string `json:"issuedAt"`
}

type SupportLookupOrderStatusOutput struct {
	CustomerName          string                 `json:"customerName"`
	Invoices              []SupportInvoiceStatus `json:"invoices"`
	TotalOutstandingMinor int64                  `json:"totalOutstandingMinor"`
}

type SupportSearchKnowledgeInput struct {
	Query string `json:"query"`
}

type SupportKnowledgeResult struct {
	Kind    string  `json:"kind"`
	Source  *string `json:"source"`
	Content string  `json:"content"`
}

type SupportSearchKnowledgeOutput struct {
	Mode    string                   `json:"mode"`
	Results []SupportKnowledgeResult `json:"results"`
}

type SupportEscalateConversationInput struct {
	ConversationID string `json:"conversationId"`
	Reason         string `json:"reason"`
}

type SupportStatusOutput struct {
	Status string `json:"status"`
}

type SupportCreateTicketInput struct {
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Origin      string  `json:"origin"`
	SessionID   *string `json:"sessionId,omitempty"`
}

type SupportCreateTicketOutput struct {
	TicketID string `json:"ticketId"`
}

type SupportUpdateTicketInput struct {
	ConversationID string  `json:"conversationId"`
	Priority       *string `json:"priority,omitempty"`
	Category       *string `json:"category,omitempty"`
	AssigneeUserID *string `json:"assigneeUserId,omitempty"`
	SlaDueAt       *string `json:"slaDueAt,omitempty"`
}

type SupportUpdateTicketOutput struct {
	Updated bool `json:"updated"`
}

type SupportSuggestCategoryInput struct {
	Text string `json:"text"`
}

type SupportSuggestCategoryOutput struct {
	Category string `json:"category"`
	Draft    bool   `json:"draft"`
}

type SupportCreateCannedResponseInput struct {
	Shortcut string `json:"shortcut"`
	Title    string `json:"title"`
	Body     string `json:"body"`
}

type SupportCreateCannedResponseOutput struct {
	CannedResponseID string `json:"cannedResponseId"`
}

type SupportCreateKbArticleInput struct {
	Title    string  `json:"title"`
	Body     string  `json:"body"`
	Category *string `json:"category,omitempty"`
}

type SupportCreateKbArticleOutput struct {
	ArticleID string `json:"articleId"`
}

func supportSuggestTicketCategory(memo string) string {
	text := strings.ToLower(memo)
	patterns := []struct {
		pattern  *regexp.Regexp
		category string
	}{
		{regexp.MustCompile(`(refund|return|damaged)`), "billing"},
		{regexp.MustCompile(`(bug|error|crash|not working|broken)`), "technical"},
		{regexp.MustCompile(`(how do|how to|question|help)`), "how-to"},
		{regexp.MustCompile(`(ship|deliver|tracking|late)`), "shipping"},
	}
	for _, entry := range patterns {
		if entry.pattern.MatchString(text) {
			return entry.category
		}
	}
	return "general"
}

func ParseSupportStartConversationInput(raw json.RawMessage) (SupportStartConversationInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportStartConversationInput{}, err
	}
	var input SupportStartConversationInput
	if input.CustomerID, err = projectRequiredUUID(fields, "customerId"); err != nil {
		return SupportStartConversationInput{}, err
	}
	if input.Subject, err = requiredCRMDealString(fields, "subject", 1, supportSubjectMax); err != nil {
		return SupportStartConversationInput{}, err
	}
	return input, nil
}

func ParseSupportPostMessageInput(raw json.RawMessage) (SupportPostMessageInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportPostMessageInput{}, err
	}
	var input SupportPostMessageInput
	if input.ConversationID, err = projectRequiredUUID(fields, "conversationId"); err != nil {
		return SupportPostMessageInput{}, err
	}
	if input.Body, err = requiredCRMDealString(fields, "body", 1, supportMessageBodyMax); err != nil {
		return SupportPostMessageInput{}, err
	}
	if rawFrom, ok := fields["from"]; ok && string(rawFrom) != "null" {
		if err := json.Unmarshal(rawFrom, &input.From); err != nil {
			return SupportPostMessageInput{}, errors.New("from must be a string")
		}
		if input.From != "customer" && input.From != "staff" {
			return SupportPostMessageInput{}, errors.New("from must be customer or staff")
		}
	} else {
		input.From = "staff"
	}
	return input, nil
}

func ParseSupportListConversationsInput(raw json.RawMessage) (SupportListConversationsInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportListConversationsInput{}, err
	}
	input := SupportListConversationsInput{Limit: 50}
	if rawStatus, ok := fields["status"]; ok && string(rawStatus) != "null" {
		var status string
		if err := json.Unmarshal(rawStatus, &status); err != nil {
			return SupportListConversationsInput{}, errors.New("status must be a string")
		}
		switch status {
		case "open", "escalated", "resolved":
		default:
			return SupportListConversationsInput{}, errors.New("status must be open, escalated or resolved")
		}
		input.Status = &status
	}
	if _, ok := fields["limit"]; ok {
		if input.Limit, err = requiredSafeInteger(fields, "limit"); err != nil {
			return SupportListConversationsInput{}, err
		}
		if input.Limit < 1 || input.Limit > 100 {
			return SupportListConversationsInput{}, errors.New("limit must be between 1 and 100")
		}
	}
	if rawCustomerBoundOnly, ok := fields["customerBoundOnly"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawCustomerBoundOnly), []byte("null")) || json.Unmarshal(rawCustomerBoundOnly, &input.CustomerBoundOnly) != nil {
			return SupportListConversationsInput{}, errors.New("customerBoundOnly must be a boolean")
		}
	}
	return input, nil
}

func ParseSupportLibraryInput(raw json.RawMessage) (SupportLibraryInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportLibraryInput{}, err
	}
	if len(fields) != 0 {
		return SupportLibraryInput{}, errors.New("input must be an empty object")
	}
	return SupportLibraryInput{}, nil
}

func ParseSupportConversationIDInput(raw json.RawMessage) (SupportReadConversationInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportReadConversationInput{}, err
	}
	var input SupportReadConversationInput
	if input.ConversationID, err = projectRequiredUUID(fields, "conversationId"); err != nil {
		return SupportReadConversationInput{}, err
	}
	input.Limit = supportTranscriptMaxMessages
	if _, ok := fields["limit"]; ok {
		input.FullDetail = true
		if input.Limit, err = requiredSafeInteger(fields, "limit"); err != nil {
			return SupportReadConversationInput{}, err
		}
		if input.Limit < 1 || input.Limit > 200 {
			return SupportReadConversationInput{}, errors.New("limit must be between 1 and 200")
		}
	}
	return input, nil
}

type supportLegacyTranscriptMessage struct {
	SenderType string `json:"senderType"`
	Body       string `json:"body"`
	CreatedAt  string `json:"createdAt"`
}

type supportLegacyConversationHeader struct {
	ID            string  `json:"id"`
	Status        string  `json:"status"`
	CustomerName  string  `json:"customerName"`
	CustomerEmail *string `json:"customerEmail"`
	Subject       string  `json:"subject"`
}

type supportLegacyReadConversationOutput struct {
	Conversation supportLegacyConversationHeader  `json:"conversation"`
	Messages     []supportLegacyTranscriptMessage `json:"messages"`
}

func legacyReadConversationOutput(output SupportReadConversationOutput) supportLegacyReadConversationOutput {
	legacy := supportLegacyReadConversationOutput{
		Conversation: supportLegacyConversationHeader{
			ID: output.Conversation.ID, Status: output.Conversation.Status,
			CustomerName: output.Conversation.CustomerName, CustomerEmail: output.Conversation.CustomerEmail,
			Subject: output.Conversation.Subject,
		},
		Messages: make([]supportLegacyTranscriptMessage, 0, len(output.Messages)),
	}
	for _, message := range output.Messages {
		legacy.Messages = append(legacy.Messages, supportLegacyTranscriptMessage{
			SenderType: message.SenderType, Body: message.Body, CreatedAt: message.CreatedAt,
		})
	}
	return legacy
}

func ParseSupportSearchKnowledgeInput(raw json.RawMessage) (SupportSearchKnowledgeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportSearchKnowledgeInput{}, err
	}
	var input SupportSearchKnowledgeInput
	if input.Query, err = requiredCRMDealString(fields, "query", 2, 500); err != nil {
		return SupportSearchKnowledgeInput{}, err
	}
	return input, nil
}

func ParseSupportEscalateConversationInput(raw json.RawMessage) (SupportEscalateConversationInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportEscalateConversationInput{}, err
	}
	var input SupportEscalateConversationInput
	if input.ConversationID, err = projectRequiredUUID(fields, "conversationId"); err != nil {
		return SupportEscalateConversationInput{}, err
	}
	if input.Reason, err = requiredCRMDealString(fields, "reason", 3, supportMessageBodyMax); err != nil {
		return SupportEscalateConversationInput{}, err
	}
	return input, nil
}

func ParseSupportCreateTicketInput(raw json.RawMessage) (SupportCreateTicketInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportCreateTicketInput{}, err
	}
	var input SupportCreateTicketInput
	if input.Title, err = requiredCRMDealString(fields, "title", 1, 200); err != nil {
		return SupportCreateTicketInput{}, err
	}
	if input.Description, err = requiredCRMDealString(fields, "description", 1, 8000); err != nil {
		return SupportCreateTicketInput{}, err
	}
	if rawOrigin, ok := fields["origin"]; ok && string(rawOrigin) != "null" {
		if err := json.Unmarshal(rawOrigin, &input.Origin); err != nil {
			return SupportCreateTicketInput{}, errors.New("origin must be a string")
		}
		switch input.Origin {
		case "capability_gap", "bug", "request":
		default:
			return SupportCreateTicketInput{}, errors.New("origin must be capability_gap, bug or request")
		}
	} else {
		input.Origin = "request"
	}
	if rawSession, ok := fields["sessionId"]; ok && string(rawSession) != "null" {
		sessionID, err := projectRequiredUUID(fields, "sessionId")
		if err != nil {
			return SupportCreateTicketInput{}, err
		}
		input.SessionID = &sessionID
	}
	return input, nil
}

func ParseSupportUpdateTicketInput(raw json.RawMessage) (SupportUpdateTicketInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportUpdateTicketInput{}, err
	}
	var input SupportUpdateTicketInput
	if input.ConversationID, err = projectRequiredUUID(fields, "conversationId"); err != nil {
		return SupportUpdateTicketInput{}, err
	}
	if rawPriority, ok := fields["priority"]; ok && string(rawPriority) != "null" {
		var priority string
		if err := json.Unmarshal(rawPriority, &priority); err != nil {
			return SupportUpdateTicketInput{}, errors.New("priority must be a string")
		}
		switch priority {
		case "low", "normal", "high", "urgent":
		default:
			return SupportUpdateTicketInput{}, errors.New("priority must be low, normal, high or urgent")
		}
		input.Priority = &priority
	}
	if rawCategory, ok := fields["category"]; ok && string(rawCategory) != "null" {
		var category string
		if err := json.Unmarshal(rawCategory, &category); err != nil {
			return SupportUpdateTicketInput{}, errors.New("category must be a string")
		}
		if len(category) > 40 {
			return SupportUpdateTicketInput{}, errors.New("category must be at most 40 characters")
		}
		input.Category = &category
	}
	if rawAssignee, ok := fields["assigneeUserId"]; ok && string(rawAssignee) != "null" {
		assignee, err := projectRequiredUUID(fields, "assigneeUserId")
		if err != nil {
			return SupportUpdateTicketInput{}, err
		}
		input.AssigneeUserID = &assignee
	}
	if rawSla, ok := fields["slaDueAt"]; ok && string(rawSla) != "null" {
		var sla string
		if err := json.Unmarshal(rawSla, &sla); err != nil {
			return SupportUpdateTicketInput{}, errors.New("slaDueAt must be a string")
		}
		if _, err := time.Parse(time.RFC3339, sla); err != nil {
			return SupportUpdateTicketInput{}, errors.New("slaDueAt must be an ISO datetime")
		}
		input.SlaDueAt = &sla
	}
	return input, nil
}

func ParseSupportSuggestCategoryInput(raw json.RawMessage) (SupportSuggestCategoryInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportSuggestCategoryInput{}, err
	}
	var input SupportSuggestCategoryInput
	if input.Text, err = requiredCRMDealString(fields, "text", 1, 2000); err != nil {
		return SupportSuggestCategoryInput{}, err
	}
	return input, nil
}

func ParseSupportCreateCannedResponseInput(raw json.RawMessage) (SupportCreateCannedResponseInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportCreateCannedResponseInput{}, err
	}
	var input SupportCreateCannedResponseInput
	if input.Shortcut, err = requiredCRMDealString(fields, "shortcut", 1, 40); err != nil {
		return SupportCreateCannedResponseInput{}, err
	}
	if input.Title, err = requiredCRMDealString(fields, "title", 1, 120); err != nil {
		return SupportCreateCannedResponseInput{}, err
	}
	if input.Body, err = requiredCRMDealString(fields, "body", 1, 4000); err != nil {
		return SupportCreateCannedResponseInput{}, err
	}
	return input, nil
}

func ParseSupportCreateKbArticleInput(raw json.RawMessage) (SupportCreateKbArticleInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return SupportCreateKbArticleInput{}, err
	}
	var input SupportCreateKbArticleInput
	if input.Title, err = requiredCRMDealString(fields, "title", 1, 200); err != nil {
		return SupportCreateKbArticleInput{}, err
	}
	if input.Body, err = requiredCRMDealString(fields, "body", 1, 20000); err != nil {
		return SupportCreateKbArticleInput{}, err
	}
	if rawCategory, ok := fields["category"]; ok && string(rawCategory) != "null" {
		var category string
		if err := json.Unmarshal(rawCategory, &category); err != nil {
			return SupportCreateKbArticleInput{}, errors.New("category must be a string")
		}
		if len(category) > 40 {
			return SupportCreateKbArticleInput{}, errors.New("category must be at most 40 characters")
		}
		input.Category = &category
	}
	return input, nil
}

func parseSupportInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case supportStartConversationCapabilityID:
		return ParseSupportStartConversationInput(raw)
	case supportPostMessageCapabilityID:
		return ParseSupportPostMessageInput(raw)
	case supportListConversationsCapabilityID:
		return ParseSupportListConversationsInput(raw)
	case supportListLibraryCapabilityID:
		return ParseSupportLibraryInput(raw)
	case supportReadConversationCapabilityID, supportLookupOrderStatusCapabilityID:
		return ParseSupportConversationIDInput(raw)
	case supportResolveConversationCapabilityID, supportReopenConversationCapabilityID:
		fields, err := decodeJSONObject(raw)
		if err != nil {
			return nil, err
		}
		var input SupportStatusInput
		if input.ConversationID, err = projectRequiredUUID(fields, "conversationId"); err != nil {
			return nil, err
		}
		return input, nil
	case supportSearchKnowledgeCapabilityID:
		return ParseSupportSearchKnowledgeInput(raw)
	case supportEscalateConversationCapabilityID:
		return ParseSupportEscalateConversationInput(raw)
	case supportCreateTicketCapabilityID:
		return ParseSupportCreateTicketInput(raw)
	case supportUpdateTicketCapabilityID:
		return ParseSupportUpdateTicketInput(raw)
	case supportSuggestCategoryCapabilityID:
		return ParseSupportSuggestCategoryInput(raw)
	case supportCreateCannedResponseCapabilityID:
		return ParseSupportCreateCannedResponseInput(raw)
	case supportCreateKbArticleCapabilityID:
		return ParseSupportCreateKbArticleInput(raw)
	default:
		return nil, errors.New("unsupported support capability")
	}
}

func supportNextTicketNumber(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var number int64
	err := tx.QueryRow(ctx, `
		INSERT INTO doc_counters (org_id, kind, "next") VALUES ($1::uuid, 'support_ticket', 1)
		ON CONFLICT (org_id, kind) DO UPDATE SET "next" = doc_counters."next" + 1
		RETURNING "next"`, orgID).Scan(&number)
	return number, err
}

func supportStartConversation(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SupportStartConversationInput) (SupportStartConversationOutput, error) {
	var customerID string
	err := tx.QueryRow(ctx, `SELECT id::text FROM customers WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`,
		input.CustomerID, claims.OrganizationID).Scan(&customerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return SupportStartConversationOutput{}, errors.New("customer not found in this organization")
	}
	if err != nil {
		return SupportStartConversationOutput{}, err
	}
	ticketNumber, err := supportNextTicketNumber(ctx, tx, claims.OrganizationID)
	if err != nil {
		return SupportStartConversationOutput{}, err
	}
	var conversationID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO support_conversations (org_id, customer_id, subject, status, created_by_actor_type, created_by_actor_id, ticket_number)
		VALUES ($1::uuid, $2::uuid, $3, 'open', $4, $5, $6)
		RETURNING id::text`,
		claims.OrganizationID, input.CustomerID, input.Subject, claims.ActorType, claims.ActorID, ticketNumber).Scan(&conversationID); err != nil {
		return SupportStartConversationOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO support_messages (org_id, conversation_id, sender_type, body)
		VALUES ($1::uuid, $2::uuid, 'system', $3)`,
		claims.OrganizationID, conversationID, fmt.Sprintf("Conversation opened about %s.", input.Subject)); err != nil {
		return SupportStartConversationOutput{}, err
	}
	return SupportStartConversationOutput{ConversationID: conversationID}, nil
}

func supportPostMessage(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SupportPostMessageInput) (SupportPostMessageOutput, error) {
	conv, err := supportLoadBoundConversation(ctx, tx, claims.OrganizationID, input.ConversationID)
	if err != nil {
		return SupportPostMessageOutput{}, err
	}
	if conv == nil {
		return SupportPostMessageOutput{}, errors.New("conversation not found")
	}
	if conv.Status == "resolved" {
		return SupportPostMessageOutput{}, errors.New("conversation is resolved; reopen it first")
	}
	senderType := input.From
	var senderUserID *string
	if claims.ActorType == "human" && claims.ActorID != nil {
		senderUserID = claims.ActorID
	} else if claims.ActorType == "agent" {
		senderType = "agent"
	}
	var messageID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO support_messages (org_id, conversation_id, sender_type, sender_user_id, body)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)
		RETURNING id::text`,
		claims.OrganizationID, conv.ID, senderType, senderUserID, input.Body).Scan(&messageID); err != nil {
		return SupportPostMessageOutput{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE support_conversations SET updated_at=$2 WHERE id=$1::uuid`, conv.ID, time.Now()); err != nil {
		return SupportPostMessageOutput{}, err
	}
	return SupportPostMessageOutput{MessageID: messageID, SenderType: senderType}, nil
}

func supportListConversations(ctx context.Context, tx pgx.Tx, orgID string, input SupportListConversationsInput) (SupportListConversationsOutput, error) {
	customerJoin := "LEFT JOIN"
	if input.CustomerBoundOnly {
		customerJoin = "JOIN"
	}
	query := fmt.Sprintf(`
		SELECT c.id::text, coalesce(c.customer_id::text, ''), coalesce(cu.name, c.visitor_email, 'Website visitor'),
		       c.subject, c.status, COALESCE(m.created_at, c.created_at), coalesce(left(m.body, 140), '')
		FROM support_conversations c
		%s customers cu ON cu.id = c.customer_id AND cu.org_id=$1::uuid
		LEFT JOIN LATERAL (
			SELECT body, created_at FROM support_messages sm
			WHERE sm.conversation_id = c.id ORDER BY created_at DESC LIMIT 1
		) m ON true
		WHERE c.org_id=$1::uuid`, customerJoin)
	args := []any{orgID}
	if input.Status != nil {
		args = append(args, *input.Status)
		query += fmt.Sprintf(" AND c.status=$%d", len(args))
	}
	query += fmt.Sprintf(" ORDER BY COALESCE(m.created_at, c.created_at) DESC LIMIT %d", input.Limit)
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return SupportListConversationsOutput{}, err
	}
	defer rows.Close()
	out := SupportListConversationsOutput{Conversations: []SupportConversationListItem{}}
	for rows.Next() {
		var item SupportConversationListItem
		var lastMessageAt time.Time
		if err := rows.Scan(&item.ID, &item.CustomerID, &item.CustomerName, &item.Subject, &item.Status, &lastMessageAt, &item.LastMessagePreview); err != nil {
			return SupportListConversationsOutput{}, err
		}
		item.LastMessageAt = lastMessageAt.UTC().Format("2006-01-02T15:04:05.000Z07:00")
		out.Conversations = append(out.Conversations, item)
	}
	return out, rows.Err()
}

func supportListLibrary(ctx context.Context, tx pgx.Tx, orgID string) (SupportLibraryOutput, error) {
	cannedRows, err := tx.Query(ctx, `
		SELECT id::text, shortcut, title, body
		FROM support_canned_responses
		WHERE org_id=$1::uuid
		ORDER BY shortcut
		LIMIT 100`, orgID)
	if err != nil {
		return SupportLibraryOutput{}, err
	}
	canned := make([]SupportCannedResponse, 0)
	for cannedRows.Next() {
		var row SupportCannedResponse
		if err := cannedRows.Scan(&row.ID, &row.Shortcut, &row.Title, &row.Body); err != nil {
			cannedRows.Close()
			return SupportLibraryOutput{}, err
		}
		canned = append(canned, row)
	}
	if err := cannedRows.Err(); err != nil {
		cannedRows.Close()
		return SupportLibraryOutput{}, err
	}
	cannedRows.Close()

	articleRows, err := tx.Query(ctx, `
		SELECT id::text, title, body, category
		FROM support_kb_articles
		WHERE org_id=$1::uuid
		ORDER BY title
		LIMIT 100`, orgID)
	if err != nil {
		return SupportLibraryOutput{}, err
	}
	articles := make([]SupportKnowledgeArticle, 0)
	for articleRows.Next() {
		var row SupportKnowledgeArticle
		if err := articleRows.Scan(&row.ID, &row.Title, &row.Body, &row.Category); err != nil {
			articleRows.Close()
			return SupportLibraryOutput{}, err
		}
		articles = append(articles, row)
	}
	if err := articleRows.Err(); err != nil {
		articleRows.Close()
		return SupportLibraryOutput{}, err
	}
	articleRows.Close()
	return SupportLibraryOutput{Canned: canned, Articles: articles}, nil
}

func supportReadConversation(ctx context.Context, tx pgx.Tx, orgID string, input SupportReadConversationInput) (SupportReadConversationOutput, error) {
	conv, err := supportLoadBoundConversation(ctx, tx, orgID, input.ConversationID)
	if err != nil {
		return SupportReadConversationOutput{}, err
	}
	if conv == nil {
		return SupportReadConversationOutput{}, errors.New("conversation not found")
	}
	limit := input.Limit
	if limit == 0 {
		limit = supportTranscriptMaxMessages
	}
	query := `
		SELECT id::text, org_id::text, conversation_id::text, sender_type, sender_user_id::text, body, created_at
		FROM support_messages
		WHERE org_id=$1::uuid AND conversation_id=$2::uuid ORDER BY created_at DESC LIMIT $3`
	if input.FullDetail {
		query = `
		SELECT id::text, org_id::text, conversation_id::text, sender_type, sender_user_id::text, body, created_at
		FROM support_messages
		WHERE org_id=$1::uuid AND conversation_id=$2::uuid ORDER BY created_at ASC LIMIT $3`
	}
	msgRows, err := tx.Query(ctx, query, orgID, conv.ID, limit)
	if err != nil {
		return SupportReadConversationOutput{}, err
	}
	messages := make([]SupportTranscriptMessage, 0)
	for msgRows.Next() {
		var message SupportTranscriptMessage
		var createdAt time.Time
		if err := msgRows.Scan(&message.ID, &message.OrgID, &message.ConversationID, &message.SenderType, &message.SenderUserID, &message.Body, &createdAt); err != nil {
			msgRows.Close()
			return SupportReadConversationOutput{}, err
		}
		message.CreatedAt = createdAt.UTC().Format("2006-01-02T15:04:05.000Z07:00")
		messages = append(messages, message)
	}
	if err := msgRows.Err(); err != nil {
		msgRows.Close()
		return SupportReadConversationOutput{}, err
	}
	msgRows.Close()
	if !input.FullDetail {
		for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
			messages[i], messages[j] = messages[j], messages[i]
		}
	}
	return SupportReadConversationOutput{
		Conversation: SupportConversationHeader{
			ID: conv.ID, CustomerID: conv.CustomerID, CustomerName: conv.CustomerName, Subject: conv.Subject,
			Status: conv.Status, Priority: conv.Priority, Category: conv.Category, AssignedUserID: conv.AssignedUserID,
			SLADueAt: conv.SLADueAt, CustomerEmail: conv.CustomerEmail,
		},
		Messages: messages, FullDetail: input.FullDetail,
	}, nil
}

func supportLookupOrderStatus(ctx context.Context, tx pgx.Tx, orgID string, input SupportLookupOrderStatusInput) (SupportLookupOrderStatusOutput, error) {
	conv, err := supportLoadBoundConversation(ctx, tx, orgID, input.ConversationID)
	if err != nil {
		return SupportLookupOrderStatusOutput{}, err
	}
	if conv == nil {
		return SupportLookupOrderStatusOutput{}, errors.New("conversation not found")
	}
	if conv.CustomerID == nil {
		return SupportLookupOrderStatusOutput{CustomerName: conv.CustomerName, Invoices: []SupportInvoiceStatus{}}, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT number, status, total_minor, paid_minor, credited_minor, issued_at
		FROM invoices WHERE org_id=$1::uuid AND customer_id=$2::uuid
		ORDER BY issued_at DESC LIMIT 10`, orgID, *conv.CustomerID)
	if err != nil {
		return SupportLookupOrderStatusOutput{}, err
	}
	defer rows.Close()
	out := SupportLookupOrderStatusOutput{CustomerName: conv.CustomerName, Invoices: []SupportInvoiceStatus{}}
	for rows.Next() {
		var invoice SupportInvoiceStatus
		var credited int64
		var issuedAt *time.Time
		if err := rows.Scan(&invoice.Number, &invoice.Status, &invoice.TotalMinor, &invoice.PaidMinor, &credited, &issuedAt); err != nil {
			return SupportLookupOrderStatusOutput{}, err
		}
		invoice.OutstandingMinor, _ = reportDocumentOutstandingMinor(invoice.TotalMinor, invoice.PaidMinor, credited)
		if issuedAt != nil {
			formatted := issuedAt.UTC().Format("2006-01-02T15:04:05.000Z07:00")
			invoice.IssuedAt = &formatted
		}
		out.TotalOutstandingMinor += invoice.OutstandingMinor
		out.Invoices = append(out.Invoices, invoice)
	}
	return out, rows.Err()
}

func supportSearchKnowledge(ctx context.Context, tx pgx.Tx, orgID string, input SupportSearchKnowledgeInput) (SupportSearchKnowledgeOutput, error) {
	// The Go embed pipeline is not wired yet, so retrieval always runs the
	// deterministic text path; the semantic branch stays a TS-side capability.
	needle := "%" + strings.NewReplacer("%", "", "_", "").Replace(strings.TrimSpace(input.Query)) + "%"
	rows, err := tx.Query(ctx, `
		SELECT kind, source, content FROM memories
		WHERE org_id=$1::uuid AND content ILIKE $2 LIMIT 5`, orgID, needle)
	if err != nil {
		return SupportSearchKnowledgeOutput{}, err
	}
	defer rows.Close()
	out := SupportSearchKnowledgeOutput{Mode: "text", Results: []SupportKnowledgeResult{}}
	for rows.Next() {
		var result SupportKnowledgeResult
		if err := rows.Scan(&result.Kind, &result.Source, &result.Content); err != nil {
			return SupportSearchKnowledgeOutput{}, err
		}
		out.Results = append(out.Results, result)
	}
	return out, rows.Err()
}

func supportEscalateConversation(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SupportEscalateConversationInput) (SupportStatusOutput, error) {
	conv, err := supportLoadBoundConversation(ctx, tx, claims.OrganizationID, input.ConversationID)
	if err != nil {
		return SupportStatusOutput{}, err
	}
	if conv == nil {
		return SupportStatusOutput{}, errors.New("conversation not found")
	}
	if conv.Status != "open" {
		return SupportStatusOutput{}, fmt.Errorf("cannot escalate a %s conversation", conv.Status)
	}
	if _, err := tx.Exec(ctx, `UPDATE support_conversations SET status='escalated', updated_at=$2 WHERE id=$1::uuid`, conv.ID, time.Now()); err != nil {
		return SupportStatusOutput{}, err
	}
	reason := input.Reason
	if len(reason) > 300 {
		reason = reason[:300]
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO support_messages (org_id, conversation_id, sender_type, body)
		VALUES ($1::uuid, $2::uuid, 'system', $3)`,
		claims.OrganizationID, conv.ID, fmt.Sprintf("Escalated by %s: %s", claims.ActorType, reason)); err != nil {
		return SupportStatusOutput{}, err
	}
	return SupportStatusOutput{Status: "escalated"}, nil
}

func supportResolveConversation(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SupportReadConversationInput) (SupportStatusOutput, error) {
	conv, err := supportLoadBoundConversation(ctx, tx, claims.OrganizationID, input.ConversationID)
	if err != nil {
		return SupportStatusOutput{}, err
	}
	if conv == nil {
		return SupportStatusOutput{}, errors.New("conversation not found")
	}
	if conv.Status == "resolved" {
		return SupportStatusOutput{}, errors.New("conversation already resolved")
	}
	if _, err := tx.Exec(ctx, `UPDATE support_conversations SET status='resolved', updated_at=$2 WHERE id=$1::uuid`, conv.ID, time.Now()); err != nil {
		return SupportStatusOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO support_messages (org_id, conversation_id, sender_type, body)
		VALUES ($1::uuid, $2::uuid, 'system', $3)`,
		claims.OrganizationID, conv.ID, fmt.Sprintf("Resolved by %s.", claims.ActorType)); err != nil {
		return SupportStatusOutput{}, err
	}
	return SupportStatusOutput{Status: "resolved"}, nil
}

func supportReopenConversation(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SupportReadConversationInput) (SupportStatusOutput, error) {
	conv, err := supportLoadBoundConversation(ctx, tx, claims.OrganizationID, input.ConversationID)
	if err != nil {
		return SupportStatusOutput{}, err
	}
	if conv == nil {
		return SupportStatusOutput{}, errors.New("conversation not found")
	}
	if conv.Status == "open" {
		return SupportStatusOutput{}, errors.New("conversation is already open")
	}
	if _, err := tx.Exec(ctx, `UPDATE support_conversations SET status='open', updated_at=$2 WHERE id=$1::uuid`, conv.ID, time.Now()); err != nil {
		return SupportStatusOutput{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO support_messages (org_id, conversation_id, sender_type, body)
		VALUES ($1::uuid, $2::uuid, 'system', $3)`,
		claims.OrganizationID, conv.ID, fmt.Sprintf("Reopened by %s.", claims.ActorType)); err != nil {
		return SupportStatusOutput{}, err
	}
	return SupportStatusOutput{Status: "open"}, nil
}

func supportCreateTicket(ctx context.Context, tx pgx.Tx, orgID string, input SupportCreateTicketInput) (SupportCreateTicketOutput, error) {
	var ticketID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO tickets (org_id, session_id, title, description, origin)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		RETURNING id::text`, orgID, input.SessionID, input.Title, input.Description, input.Origin).Scan(&ticketID); err != nil {
		return SupportCreateTicketOutput{}, err
	}
	return SupportCreateTicketOutput{TicketID: ticketID}, nil
}

func supportUpdateTicket(ctx context.Context, tx pgx.Tx, orgID string, input SupportUpdateTicketInput, now time.Time) (SupportUpdateTicketOutput, error) {
	var conversationID string
	err := tx.QueryRow(ctx, `SELECT id::text FROM support_conversations WHERE id=$1::uuid AND org_id=$2::uuid LIMIT 1`,
		input.ConversationID, orgID).Scan(&conversationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return SupportUpdateTicketOutput{}, errors.New("ticket not found")
	}
	if err != nil {
		return SupportUpdateTicketOutput{}, err
	}
	sets := []string{"updated_at=" + "$2"}
	args := []any{conversationID, now}
	arg := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if input.Priority != nil {
		sets = append(sets, "priority="+arg(*input.Priority))
	}
	if input.Category != nil {
		sets = append(sets, "category="+arg(*input.Category))
	}
	if input.AssigneeUserID != nil {
		sets = append(sets, "assigned_user_id="+arg(*input.AssigneeUserID))
	}
	if input.SlaDueAt != nil {
		sla, _ := time.Parse(time.RFC3339, *input.SlaDueAt)
		sets = append(sets, "sla_due_at="+arg(sla))
	}
	query := "UPDATE support_conversations SET "
	for i, set := range sets {
		if i > 0 {
			query += ", "
		}
		query += set
	}
	query += " WHERE id=$1::uuid"
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		return SupportUpdateTicketOutput{}, err
	}
	return SupportUpdateTicketOutput{Updated: true}, nil
}

func supportSuggestCategory(ctx context.Context, input SupportSuggestCategoryInput) (SupportSuggestCategoryOutput, error) {
	return SupportSuggestCategoryOutput{Category: supportSuggestTicketCategory(input.Text), Draft: true}, nil
}

func supportCreateCannedResponse(ctx context.Context, tx pgx.Tx, orgID string, input SupportCreateCannedResponseInput) (SupportCreateCannedResponseOutput, error) {
	var cannedResponseID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO support_canned_responses (org_id, shortcut, title, body)
		VALUES ($1::uuid, $2, $3, $4)
		ON CONFLICT (org_id, shortcut) DO UPDATE SET title=$3, body=$4
		RETURNING id::text`, orgID, input.Shortcut, input.Title, input.Body).Scan(&cannedResponseID); err != nil {
		return SupportCreateCannedResponseOutput{}, err
	}
	return SupportCreateCannedResponseOutput{CannedResponseID: cannedResponseID}, nil
}

func supportCreateKbArticle(ctx context.Context, tx pgx.Tx, orgID string, input SupportCreateKbArticleInput) (SupportCreateKbArticleOutput, error) {
	var articleID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO support_kb_articles (org_id, title, body, category)
		VALUES ($1::uuid, $2, $3, $4)
		RETURNING id::text`, orgID, input.Title, input.Body, input.Category).Scan(&articleID); err != nil {
		return SupportCreateKbArticleOutput{}, err
	}
	return SupportCreateKbArticleOutput{ArticleID: articleID}, nil
}

type SupportStatusInput struct {
	ConversationID string `json:"conversationId"`
}

func supportResolveOrReopen(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input SupportStatusInput, capabilityID string) (SupportStatusOutput, error) {
	if capabilityID == supportReopenConversationCapabilityID {
		return supportReopenConversation(ctx, tx, claims, SupportReadConversationInput{ConversationID: input.ConversationID})
	}
	return supportResolveConversation(ctx, tx, claims, SupportReadConversationInput{ConversationID: input.ConversationID})
}
