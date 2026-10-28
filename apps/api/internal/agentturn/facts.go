// Package agentturn holds the deterministic half of one Workmate turn: the
// facts code reads before the model is asked anything, and the obligations
// code enforces after the model answers. Instructions in a prompt are only text
// the model may ignore, so anything a business needs guaranteed lives here.
package agentturn

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	// MaxApprovalFacts bounds what one turn adds to the prompt. The count is
	// always exact; only the listed rows are capped.
	MaxApprovalFacts  = 4
	rationaleMaxRunes = 110
)

// Approval is one pending decision the signed user can act on.
type Approval struct {
	ID           string
	CapabilityID string
	RiskClass    string
	Rationale    string
	RaisedBy     string
	CreatedAt    time.Time
}

// Notification is the newest unread workspace event.
type Notification struct {
	Title     string
	CreatedAt time.Time
}

// Facts is the code-computed context for one turn. A read that failed is
// recorded as unknown, never as zero: claiming nothing is waiting when the
// inbox could not be read is the failure this type exists to prevent.
type Facts struct {
	Now time.Time

	ApprovalsKnown       bool
	PendingApprovalCount int
	Approvals            []Approval
	ApprovalsUnknown     string

	NotificationsKnown   bool
	UnreadNotifications  int
	Notifications        []Notification
	NotificationsUnknown string
}

// FactInput carries the tool payloads the handler already read. Passing the
// payloads keeps facts and the approvals_inbox answer derived from one read.
type FactInput struct {
	Now                  time.Time
	ApprovalsPayload     string
	ApprovalsErr         string
	NotificationsPayload string
	NotificationsErr     string
}

type approvalPayload struct {
	Count     int `json:"count"`
	Approvals []struct {
		ID           string    `json:"id"`
		CapabilityID string    `json:"capabilityId"`
		RiskClass    string    `json:"riskClass"`
		Rationale    *string   `json:"rationale"`
		CreatedAt    time.Time `json:"createdAt"`
		RaisedBy     struct {
			Kind string `json:"kind"`
			Name string `json:"name"`
		} `json:"raisedBy"`
	} `json:"approvals"`
}

type notificationPayload struct {
	UnreadCount   int `json:"unreadCount"`
	Notifications []struct {
		Title     string    `json:"title"`
		CreatedAt time.Time `json:"createdAt"`
	} `json:"notifications"`
}

// CompileFacts turns already-read tool payloads into the turn facts. It never
// returns an error: a failed or malformed read becomes an unknown fact so the
// model is told the truth instead of a fabricated zero.
func CompileFacts(in FactInput) Facts {
	facts := Facts{Now: in.Now.UTC()}
	if facts.Now.IsZero() {
		facts.Now = time.Now().UTC()
	}

	switch {
	case strings.TrimSpace(in.ApprovalsErr) != "" || strings.TrimSpace(in.ApprovalsPayload) == "":
		facts.ApprovalsUnknown = reasonOf(in.ApprovalsErr, "the approval inbox was not read")
	default:
		var payload approvalPayload
		if err := json.Unmarshal([]byte(in.ApprovalsPayload), &payload); err != nil {
			facts.ApprovalsUnknown = "the approval inbox result could not be read"
			break
		}
		facts.ApprovalsKnown = true
		facts.PendingApprovalCount = payload.Count
		if facts.PendingApprovalCount < len(payload.Approvals) {
			facts.PendingApprovalCount = len(payload.Approvals)
		}
		for index, row := range payload.Approvals {
			if index >= MaxApprovalFacts {
				break
			}
			facts.Approvals = append(facts.Approvals, Approval{
				ID:           row.ID,
				CapabilityID: row.CapabilityID,
				RiskClass:    row.RiskClass,
				Rationale:    oneLine(deref(row.Rationale), rationaleMaxRunes),
				RaisedBy:     oneLine(row.RaisedBy.Name, 60),
				CreatedAt:    row.CreatedAt,
			})
		}
	}

	switch {
	case strings.TrimSpace(in.NotificationsErr) != "" || strings.TrimSpace(in.NotificationsPayload) == "":
		facts.NotificationsUnknown = reasonOf(in.NotificationsErr, "notifications were not read")
	default:
		var payload notificationPayload
		if err := json.Unmarshal([]byte(in.NotificationsPayload), &payload); err != nil {
			facts.NotificationsUnknown = "the notification inbox result could not be read"
			break
		}
		facts.NotificationsKnown = true
		facts.UnreadNotifications = payload.UnreadCount
		for index, row := range payload.Notifications {
			if index >= 1 {
				break
			}
			facts.Notifications = append(facts.Notifications, Notification{
				Title:     oneLine(row.Title, 80),
				CreatedAt: row.CreatedAt,
			})
		}
	}
	return facts
}

// RenderFacts is the exact block appended to the system prompt. It is facts,
// not instructions, so the model does not have to remember to fetch them.
func RenderFacts(facts Facts) string {
	var builder strings.Builder
	builder.WriteString("<turn_facts>\n")
	builder.WriteString("readAt: " + facts.Now.Format(time.RFC3339) + "\n")

	if facts.ApprovalsKnown {
		fmt.Fprintf(&builder, "pendingApprovals: %d\n", facts.PendingApprovalCount)
		if facts.PendingApprovalCount == 0 {
			builder.WriteString("  nothing is waiting for a decision\n")
		}
		for _, approval := range facts.Approvals {
			builder.WriteString("  - " + approvalLine(facts.Now, approval) + "\n")
		}
		if extra := facts.PendingApprovalCount - len(facts.Approvals); extra > 0 {
			fmt.Fprintf(&builder, "  - %d more in Approvals\n", extra)
		}
	} else {
		builder.WriteString("pendingApprovals: unknown (" + facts.ApprovalsUnknown + ")\n")
	}

	if facts.NotificationsKnown {
		fmt.Fprintf(&builder, "unreadNotifications: %d", facts.UnreadNotifications)
		if len(facts.Notifications) > 0 && facts.UnreadNotifications > 0 {
			latest := facts.Notifications[0]
			builder.WriteString(" (latest: " + quote(latest.Title) + ", " + ageOf(facts.Now, latest.CreatedAt) + ")")
		}
		builder.WriteString("\n")
	} else {
		builder.WriteString("unreadNotifications: unknown (" + facts.NotificationsUnknown + ")\n")
	}
	builder.WriteString("</turn_facts>")
	return builder.String()
}

// Summary is the compact, durable record of what the model was told. The full
// rendered block is derivable and too verbose for the session trajectory.
func (facts Facts) Summary() map[string]any {
	summary := map[string]any{"readAt": facts.Now.Format(time.RFC3339)}
	if facts.ApprovalsKnown {
		summary["pendingApprovals"] = facts.PendingApprovalCount
		ids := make([]string, 0, len(facts.Approvals))
		for _, approval := range facts.Approvals {
			if approval.ID != "" {
				ids = append(ids, approval.ID)
			}
		}
		if len(ids) > 0 {
			summary["pendingApprovalIds"] = ids
		}
	} else {
		summary["pendingApprovalsUnknown"] = facts.ApprovalsUnknown
	}
	if facts.NotificationsKnown {
		summary["unreadNotifications"] = facts.UnreadNotifications
	} else {
		summary["unreadNotificationsUnknown"] = facts.NotificationsUnknown
	}
	return summary
}

func approvalLine(now time.Time, approval Approval) string {
	parts := make([]string, 0, 4)
	label := approval.CapabilityID
	if label == "" {
		label = "an action"
	}
	if approval.RiskClass != "" {
		label += " (" + approval.RiskClass + ")"
	}
	parts = append(parts, label)
	if approval.Rationale != "" {
		parts = append(parts, quote(approval.Rationale))
	}
	if approval.RaisedBy != "" {
		parts = append(parts, "raised by "+approval.RaisedBy)
	}
	parts = append(parts, ageOf(now, approval.CreatedAt))
	if approval.ID != "" {
		parts = append(parts, "approval "+approval.ID)
	}
	return strings.Join(parts, ", ")
}

func ageOf(now, then time.Time) string {
	if then.IsZero() {
		return "at an unknown time"
	}
	delta := now.Sub(then)
	switch {
	case delta < 0:
		return "just now"
	case delta < time.Minute:
		return "less than a minute ago"
	case delta < time.Hour:
		return fmt.Sprintf("%d minutes ago", int(delta.Minutes()))
	case delta < 24*time.Hour:
		return fmt.Sprintf("%d hours ago", int(delta.Hours()))
	default:
		return fmt.Sprintf("%d days ago", int(delta.Hours()/24))
	}
}

func oneLine(value string, limit int) string {
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		return ""
	}
	runes := []rune(value)
	if len(runes) > limit {
		value = strings.TrimSpace(string(runes[:limit])) + "..."
	}
	return value
}

func quote(value string) string {
	value = strings.ReplaceAll(value, `"`, "'")
	return `"` + value + `"`
}

func reasonOf(value, fallback string) string {
	if trimmed := oneLine(value, 120); trimmed != "" {
		return trimmed
	}
	return fallback
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
