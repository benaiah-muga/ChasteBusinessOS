package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/mail"
	"strings"
	"time"
)

const notificationEmailPayloadLimit = 64 * 1024

var ErrInvalidNotificationEmail = errors.New("invalid approval notification email payload")

// NotificationEmailClaim is the metadata required to deliver the Go
// capability executor's approval email outbox rows. Database claiming and
// acknowledgement remain behind the separately provisioned worker boundary.
type NotificationEmailClaim struct {
	ID                  string
	OrgID               string
	Kind                string
	DedupeKey           string
	ProviderOperationID string
	Attempts            int
	MaxAttempts         int
	FencingToken        int
	LeaseOwner          string
	LeaseExpiresAt      time.Time
}

type notificationEmailPayload struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Text    string `json:"text"`
}

type NotificationEmailSender func(context.Context, MarketingEmailConfig, ClaimedMessage, marketingEmailPayload) (json.RawMessage, error)

type NotificationEmailDispatcher struct {
	config MarketingEmailConfig
	send   NotificationEmailSender
}

func NewNotificationEmailDispatcher(config MarketingEmailConfig, send NotificationEmailSender) *NotificationEmailDispatcher {
	if config.Port == 0 {
		config.Port = 587
	}
	if config.From == "" {
		config.From = "chaste@localhost"
	}
	if send == nil {
		send = sendMarketingEmailSMTP
	}
	return &NotificationEmailDispatcher{config: config, send: send}
}

// Deliver handles a claimed approval-email row after the database layer has
// established its lease and organization scope. A failed SMTP call is
// uncertain because the provider may have accepted DATA before disconnecting.
func (d *NotificationEmailDispatcher) Deliver(ctx context.Context, claim NotificationEmailClaim, raw json.RawMessage) DeliveryResult {
	if !validUUID(claim.ID) || !validUUID(claim.OrgID) || claim.Kind != "email" ||
		!validNotificationEmailDedupeKey(claim.DedupeKey) || !validUUID(claim.ProviderOperationID) {
		return DeliveryResult{Status: "failed", LastError: notificationEmailError("invalid approval notification email claim")}
	}
	payload, err := parseNotificationEmailPayload(raw)
	if err != nil {
		return DeliveryResult{Status: "failed", LastError: notificationEmailError(err.Error())}
	}
	if d.config.Host == "" {
		return DeliveryResult{Status: "failed", LastError: notificationEmailError("SMTP is not configured")}
	}
	message := ClaimedMessage{ID: claim.ID, OrgID: claim.OrgID, Kind: claim.Kind, ProviderOperationID: claim.ProviderOperationID}
	receipt, err := d.send(ctx, d.config, message, marketingEmailPayload{To: payload.To, Subject: payload.Subject, Text: payload.Text})
	if err != nil {
		return DeliveryResult{Status: "unknown", LastError: notificationEmailError(unknownOutcome + ": " + err.Error())}
	}
	return DeliveryResult{Status: "sent", ProviderReceipt: receipt}
}

func parseNotificationEmailPayload(raw json.RawMessage) (notificationEmailPayload, error) {
	var payload notificationEmailPayload
	if len(raw) == 0 || len(raw) > notificationEmailPayloadLimit {
		return payload, fmt.Errorf("%w: payload size", ErrInvalidNotificationEmail)
	}
	decoder := json.NewDecoder(io.LimitReader(strings.NewReader(string(raw)), notificationEmailPayloadLimit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, fmt.Errorf("%w: decode fields", ErrInvalidNotificationEmail)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return payload, fmt.Errorf("%w: trailing data", ErrInvalidNotificationEmail)
	}
	if !validNotificationEmailPayload(payload) {
		return payload, ErrInvalidNotificationEmail
	}
	return payload, nil
}

func validNotificationEmailPayload(payload notificationEmailPayload) bool {
	if len(payload.To) == 0 || len(payload.To) > 254 || strings.TrimSpace(payload.To) != payload.To || strings.ContainsAny(payload.To, "\r\n\x00") {
		return false
	}
	parsed, err := mail.ParseAddress(payload.To)
	if err != nil || parsed.Address != payload.To || strings.Count(payload.To, "@") != 1 || !strings.Contains(strings.SplitN(payload.To, "@", 2)[1], ".") {
		return false
	}
	if len(payload.Subject) == 0 || len(payload.Subject) > 998 || strings.ContainsAny(payload.Subject, "\r\n\x00") || len(payload.Text) > 60*1024 {
		return false
	}
	return true
}

func validNotificationEmailDedupeKey(key string) bool {
	const prefix = "notification:approval.email:"
	if !strings.HasPrefix(key, prefix) || len(key) != len(prefix)+64 {
		return false
	}
	for _, r := range key[len(prefix):] {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

func validUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, r := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if r != '-' {
				return false
			}
			continue
		}
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

func notificationEmailError(value string) *string { return &value }
