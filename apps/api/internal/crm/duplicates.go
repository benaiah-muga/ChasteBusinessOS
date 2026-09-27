package crm

import (
	"strings"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

type CustomerFingerprint struct {
	Name  string  `json:"name"`
	Email *string `json:"email,omitempty"`
	Phone *string `json:"phone,omitempty"`
}

type DuplicateReason string

const (
	DuplicateReasonName        DuplicateReason = "name"
	DuplicateReasonEmail       DuplicateReason = "email"
	DuplicateReasonPhone       DuplicateReason = "phone"
	DuplicateReasonSimilarName DuplicateReason = "similar name"
)

type DuplicateVerdict struct {
	Duplicate    bool             `json:"duplicate"`
	Reason       *DuplicateReason `json:"reason"`
	ExistingName *string          `json:"existingName"`
}

var nameSuffixes = [...]string{
	"llc", "ltd", "limited", "inc", "incorporated", "co", "corp", "corporation", "gmbh", "bv", "plc",
}

func NormalizeCustomerName(name string) string {
	lower := cases.Lower(language.Und).String(name)
	var normalized strings.Builder
	lastWasSpace := true
	for _, r := range lower {
		if isASCIIAlphaNumeric(r) {
			normalized.WriteRune(r)
			lastWasSpace = false
		} else if !lastWasSpace {
			normalized.WriteByte(' ')
			lastWasSpace = true
		}
	}
	key := strings.TrimSpace(normalized.String())
	for {
		changed := false
		for _, suffix := range nameSuffixes {
			if key == suffix {
				return ""
			}
			if strings.HasSuffix(key, " "+suffix) {
				key = strings.TrimSpace(key[:len(key)-len(suffix)-1])
				changed = true
			}
		}
		if !changed {
			return key
		}
	}
}

func NormalizeEmail(email *string) *string {
	if email == nil {
		return nil
	}
	trimmed := strings.TrimFunc(*email, isECMAScriptWhitespace)
	if trimmed == "" {
		return nil
	}
	lowered := cases.Lower(language.Und).String(trimmed)
	return &lowered
}

func NormalizePhone(phone *string) *string {
	if phone == nil {
		return nil
	}
	var digits strings.Builder
	for _, r := range *phone {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}
	value := digits.String()
	if len(value) < 7 {
		return nil
	}
	if len(value) > 9 {
		value = value[len(value)-9:]
	}
	return &value
}

func FindDuplicate(existing []CustomerFingerprint, candidate CustomerFingerprint) DuplicateVerdict {
	candidateEmail := NormalizeEmail(candidate.Email)
	candidatePhone := NormalizePhone(candidate.Phone)
	candidateName := NormalizeCustomerName(candidate.Name)
	for _, row := range existing {
		if candidateEmail != nil && sameString(NormalizeEmail(row.Email), candidateEmail) {
			return duplicateVerdict(DuplicateReasonEmail, row.Name)
		}
		if candidatePhone != nil && sameString(NormalizePhone(row.Phone), candidatePhone) {
			return duplicateVerdict(DuplicateReasonPhone, row.Name)
		}
		rowName := NormalizeCustomerName(row.Name)
		if candidateName != "" && rowName == candidateName {
			return duplicateVerdict(DuplicateReasonName, row.Name)
		}
		if candidateName != "" && rowName != "" && similarName(candidateName, rowName) {
			return duplicateVerdict(DuplicateReasonSimilarName, row.Name)
		}
	}
	return DuplicateVerdict{Duplicate: false, Reason: nil, ExistingName: nil}
}

func isASCIIAlphaNumeric(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= '0' && r <= '9'
}

func isECMAScriptWhitespace(r rune) bool {
	switch r {
	case '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\ufeff', '\u2028', '\u2029':
		return true
	case '\u1680', '\u202f', '\u205f', '\u3000':
		return true
	default:
		return r >= '\u2000' && r <= '\u200a' || unicode.Is(unicode.Zs, r)
	}
}

func sameString(left, right *string) bool {
	return left != nil && right != nil && *left == *right
}

func duplicateVerdict(reason DuplicateReason, existingName string) DuplicateVerdict {
	name := existingName
	matchReason := reason
	return DuplicateVerdict{Duplicate: true, Reason: &matchReason, ExistingName: &name}
}

func similarName(a, b string) bool {
	shorter, longer := len(a), len(b)
	if shorter > longer {
		shorter, longer = longer, shorter
	}
	if shorter < 8 || longer-shorter > int(float64(longer)*0.12) {
		return false
	}
	return 1-float64(editDistance(a, b))/float64(longer) >= 0.92
}

func editDistance(a, b string) int {
	previous := make([]int, len(b)+1)
	for j := range previous {
		previous[j] = j
	}
	for i := 1; i <= len(a); i++ {
		diagonal := previous[0]
		previous[0] = i
		for j := 1; j <= len(b); j++ {
			above := previous[j]
			substitutionCost := 0
			if a[i-1] != b[j-1] {
				substitutionCost = 1
			}
			previous[j] = min(previous[j]+1, previous[j-1]+1, diagonal+substitutionCost)
			diagonal = above
		}
	}
	return previous[len(b)]
}
