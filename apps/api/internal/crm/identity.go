package crm

import (
	"sort"
	"strings"
)

// matchScoreReason is the order of evidence a resolver prefers, highest first.
const (
	MatchOnEmail        = "email"
	MatchOnPhone        = "phone"
	MatchOnExactName    = "exact name"
	MatchOnNameTokens   = "name tokens"
	MatchOnPartialName  = "partial name"
	MatchOnSimilarName  = "similar name"
	maxNameTokens       = 5
	minTokenRunes       = 2
	minPartialQueryRune = 3
)

// MatchCandidate is one row the database offered as a possible match. Canonical
// fields are set when the row was merged into a surviving record: the resolver
// returns the survivor, never the tombstone. Detail is an optional presentation
// string, such as an employee's email and title.
type MatchCandidate struct {
	ID                   string
	Name                 string
	Email                string
	Phone                string
	Detail               string
	Deactivated          bool
	CanonicalID          string
	CanonicalName        string
	CanonicalDeactivated bool
}

// Match is a ranked identity. MatchedRecordID is only set when the evidence
// came from a merged record, so the caller can say why.
type Match struct {
	ID                string
	Name              string
	Detail            string
	MatchedOn         string
	Score             int
	MatchedRecordID   string
	MatchedRecordName string
	Deactivated       bool
}

// Query is one search text decomposed into the signals a resolver can compare.
// The database uses Phone and Tokens to widen the candidate set; the ranker
// uses all of them to order it. Person keeps person names out of the company
// suffix rules.
type Query struct {
	Email  string
	Phone  string
	Name   string
	Tokens []string
	Person bool
}

// ParseCompanyQuery normalizes a company or customer search text.
func ParseCompanyQuery(text string) Query {
	name := NormalizeCustomerName(text)
	return Query{
		Email:  normalizedQueryEmail(text),
		Phone:  normalizedQueryPhone(text),
		Name:   name,
		Tokens: nameTokens(name),
	}
}

// ParsePersonQuery normalizes a person's search text. A surname that happens to
// look like a company suffix is part of the name.
func ParsePersonQuery(text string) Query {
	name := NormalizePersonName(text)
	return Query{
		Email:  normalizedQueryEmail(text),
		Phone:  normalizedQueryPhone(text),
		Name:   name,
		Tokens: nameTokens(name),
		Person: true,
	}
}

// RankMatches orders candidates by how strongly they identify the queried
// record, collapses several rows that resolve to the same surviving record, and
// never returns a merged record as the id to act on.
func RankMatches(query Query, candidates []MatchCandidate, limit int) []Match {
	if limit < 1 {
		limit = 5
	}
	if limit > 10 {
		limit = 10
	}
	ranked := make([]Match, 0, len(candidates))
	for _, candidate := range candidates {
		score, reason := scoreMatch(query, candidate)
		if score == 0 {
			continue
		}
		match := Match{
			ID:          candidate.ID,
			Name:        candidate.Name,
			Detail:      matchDetail(candidate),
			MatchedOn:   reason,
			Score:       score,
			Deactivated: candidate.Deactivated,
		}
		if candidate.CanonicalID != "" {
			match.Deactivated = candidate.CanonicalDeactivated
			if candidate.CanonicalID != candidate.ID {
				match.ID = candidate.CanonicalID
				match.Name = candidate.CanonicalName
				match.MatchedRecordID = candidate.ID
				match.MatchedRecordName = candidate.Name
			}
		}
		ranked = append(ranked, match)
	}

	collapsed := make(map[string]Match, len(ranked))
	order := make([]string, 0, len(ranked))
	for _, match := range ranked {
		existing, seen := collapsed[match.ID]
		if !seen {
			collapsed[match.ID] = match
			order = append(order, match.ID)
			continue
		}
		if betterMatch(match, existing) {
			collapsed[match.ID] = match
		}
	}
	out := make([]Match, 0, len(order))
	for _, id := range order {
		out = append(out, collapsed[id])
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func betterMatch(candidate, existing Match) bool {
	if candidate.Score != existing.Score {
		return candidate.Score > existing.Score
	}
	// A direct hit explains itself better than a merge trail.
	if (candidate.MatchedRecordID == "") != (existing.MatchedRecordID == "") {
		return candidate.MatchedRecordID == ""
	}
	return false
}

func scoreMatch(query Query, candidate MatchCandidate) (int, string) {
	if query.Email != "" && normalizedCandidateEmail(candidate.Email) == query.Email {
		return 100, MatchOnEmail
	}
	if query.Phone != "" {
		if candidatePhone := NormalizePhone(&candidate.Phone); candidatePhone != nil && *candidatePhone == query.Phone {
			return 95, MatchOnPhone
		}
	}

	candidateName := NormalizeCustomerName(candidate.Name)
	if query.Person {
		candidateName = NormalizePersonName(candidate.Name)
	}
	if query.Name == "" || candidateName == "" {
		return 0, ""
	}
	if query.Name == candidateName {
		return 90, MatchOnExactName
	}
	if len(query.Tokens) > 0 && containsEveryToken(candidateName, query.Tokens) {
		return 75, MatchOnNameTokens
	}
	if len([]rune(query.Name)) >= minPartialQueryRune &&
		(strings.Contains(candidateName, query.Name) || strings.Contains(query.Name, candidateName)) {
		return 60, MatchOnPartialName
	}
	if similarName(query.Name, candidateName) {
		return 50, MatchOnSimilarName
	}
	return 0, ""
}

func normalizedQueryEmail(query string) string {
	if !strings.Contains(query, "@") {
		return ""
	}
	return derefString(NormalizeEmail(&query))
}

func normalizedQueryPhone(query string) string {
	digits := 0
	letters := 0
	for _, char := range query {
		switch {
		case char >= '0' && char <= '9':
			digits++
		case char == ' ' || char == '-' || char == '(' || char == ')' || char == '+':
		default:
			letters++
		}
	}
	if digits < 7 || digits < letters*2 {
		return ""
	}
	return derefString(NormalizePhone(&query))
}

func normalizedCandidateEmail(email string) string {
	return derefString(NormalizeEmail(&email))
}

func matchDetail(candidate MatchCandidate) string {
	if detail := strings.TrimSpace(candidate.Detail); detail != "" {
		return detail
	}
	if email := strings.TrimSpace(candidate.Email); email != "" {
		return email
	}
	return strings.TrimSpace(candidate.Phone)
}

func nameTokens(normalized string) []string {
	fields := strings.Fields(normalized)
	tokens := make([]string, 0, len(fields))
	for _, field := range fields {
		if len([]rune(field)) < minTokenRunes {
			continue
		}
		tokens = append(tokens, field)
		if len(tokens) >= maxNameTokens {
			break
		}
	}
	return tokens
}

func containsEveryToken(name string, tokens []string) bool {
	for _, token := range tokens {
		if !strings.Contains(name, token) {
			return false
		}
	}
	return true
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
