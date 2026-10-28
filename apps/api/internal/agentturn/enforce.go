package agentturn

import (
	"strings"
	"unicode"
)

const (
	ViolationDash            = "dash"
	ViolationPendingApproval = "pending_approval"
	ViolationFailedAction    = "failed_action"

	failureDetailMaxRunes = 180
)

// Effect is one executed capability in the turn, as the loop observed it. It
// carries the executor's verdict, not the model's description of it.
type Effect struct {
	CapabilityID    string
	Risk            string
	OK              bool
	PendingApproval bool
	ApprovalID      string
	Error           string
}

// Violation records an obligation the model did not meet and that code had to
// fix. It is the evidence trail for a corrected answer.
type Violation struct {
	Kind         string
	CapabilityID string
	Detail       string
}

// Enforced is the authoritative final text plus what had to be corrected.
type Enforced struct {
	Text       string
	Violations []Violation
}

// Enforce applies the after-reasoning obligations: the writing rule holds, a
// pending approval is never reported as done, and a failed material action is
// never reported as complete. It is idempotent so a retried turn cannot stack
// duplicate notices.
func Enforce(reply string, effects []Effect) Enforced {
	text := Sanitize(reply)
	result := Enforced{Text: text}
	if text != reply {
		result.Violations = append(result.Violations, Violation{
			Kind:   ViolationDash,
			Detail: "removed a dash character the writing rule forbids",
		})
	}

	if notice := pendingApprovalNotice(effects); notice != "" && !mentionsApproval(text) && !strings.Contains(text, notice) {
		text = appendParagraph(text, notice)
		result.Violations = append(result.Violations, Violation{
			Kind:   ViolationPendingApproval,
			Detail: notice,
		})
	}

	if notice := failedActionNotice(effects); notice != "" && !acknowledgesFailure(text) && !strings.Contains(text, notice) {
		text = appendParagraph(text, notice)
		result.Violations = append(result.Violations, Violation{
			Kind:   ViolationFailedAction,
			Detail: notice,
		})
	}

	result.Text = text
	return result
}

// Sanitize rewrites dash characters into punctuation the writing rule allows.
// It runs on every streamed delta and on the final reply, so the streamed text
// and the stored transcript agree.
func Sanitize(text string) string {
	if !strings.ContainsAny(text, "\u2014\u2013") {
		return text
	}
	runes := []rune(text)
	var builder strings.Builder
	builder.Grow(len(text))
	for index, char := range runes {
		switch char {
		case '\u2014':
			// A comma reads correctly for both a parenthetical and an
			// appositive dash, and unlike " - " it never doubles a space.
			builder.WriteByte(',')
			if index+1 < len(runes) && !unicode.IsSpace(runes[index+1]) {
				builder.WriteByte(' ')
			}
		case '\u2013':
			builder.WriteByte('-')
		default:
			builder.WriteRune(char)
		}
	}
	out := builder.String()
	out = strings.ReplaceAll(out, ", ,", ",")
	out = strings.ReplaceAll(out, ", .", ".")
	out = strings.ReplaceAll(out, "\n, ", "\n")
	out = strings.ReplaceAll(out, " ,", ",")
	return strings.TrimPrefix(out, ", ")
}

// Material reports whether an effect can change business state. Reads are
// excluded because a missing read usually surfaces in the answer itself and a
// notice on every failed lookup would be noise.
func Material(risk string) bool {
	return risk != "read"
}

func pendingApprovalNotice(effects []Effect) string {
	seen := map[string]bool{}
	type pending struct {
		capabilityID string
		approvalID   string
	}
	rows := make([]pending, 0, len(effects))
	for _, effect := range effects {
		if !effect.PendingApproval {
			continue
		}
		key := effect.ApprovalID
		if key == "" {
			key = effect.CapabilityID
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		rows = append(rows, pending{capabilityID: labelOf(effect.CapabilityID), approvalID: effect.ApprovalID})
	}
	if len(rows) == 0 {
		return ""
	}
	if len(rows) == 1 {
		return "Not done yet: " + rows[0].capabilityID + " is waiting for your approval" + approvalRef(rows[0].approvalID) + ". Nothing has changed until you approve or reject it."
	}
	var builder strings.Builder
	builder.WriteString("Not done yet, these are waiting for your approval:")
	for _, row := range rows {
		builder.WriteString("\n- " + row.capabilityID + approvalRef(row.approvalID))
	}
	builder.WriteString("\nNothing has changed until you approve or reject them.")
	return builder.String()
}

func failedActionNotice(effects []Effect) string {
	type failure struct {
		capabilityID string
		detail       string
	}
	rows := make([]failure, 0, len(effects))
	for _, effect := range effects {
		if effect.OK || effect.PendingApproval || !Material(effect.Risk) {
			continue
		}
		detail := oneLine(effect.Error, failureDetailMaxRunes)
		if detail == "" {
			detail = "no reason was returned"
		}
		rows = append(rows, failure{capabilityID: labelOf(effect.CapabilityID), detail: detail})
	}
	if len(rows) == 0 {
		return ""
	}
	if len(rows) == 1 {
		return "The " + rows[0].capabilityID + " step did not complete: " + rows[0].detail + ". I have not confirmed any change from it."
	}
	var builder strings.Builder
	builder.WriteString("These steps did not complete:")
	for _, row := range rows {
		builder.WriteString("\n- " + row.capabilityID + ": " + row.detail)
	}
	builder.WriteString("\nI have not confirmed any change from them.")
	return builder.String()
}

func approvalRef(approvalID string) string {
	if approvalID == "" {
		return " (the approval id was not recorded)"
	}
	return " (approval id " + approvalID + ")"
}

func labelOf(capabilityID string) string {
	if strings.TrimSpace(capabilityID) == "" {
		return "the requested action"
	}
	return capabilityID
}

func mentionsApproval(text string) bool {
	return strings.Contains(strings.ToLower(text), "approv")
}

var failureAcknowledgements = []string{
	"could not", "cannot", "can't", "can\u2019t", "unable", "failed", "failure",
	"did not", "didn't", "didn\u2019t", "not complete", "was not", "wasn't", "wasn\u2019t",
	"refused", "blocked", "declined", "error", "no change", "not confirmed",
}

func acknowledgesFailure(text string) bool {
	lower := strings.ToLower(text)
	for _, token := range failureAcknowledgements {
		if strings.Contains(lower, token) {
			return true
		}
	}
	return false
}

func appendParagraph(text, paragraph string) string {
	if strings.TrimSpace(text) == "" {
		return paragraph
	}
	return strings.TrimRight(text, " \n") + "\n\n" + paragraph
}
