package crm

import "testing"

func TestRankCustomerMatches(t *testing.T) {
	survivor := CustomerMatchCandidate{ID: "survivor", Name: "Acme Supplies Ltd", Email: "billing@acme.test", Phone: "0772 123 456"}

	t.Run("email is the strongest evidence", func(t *testing.T) {
		matches := RankCustomerMatches("BILLING@ACME.TEST", []CustomerMatchCandidate{
			survivor,
			{ID: "other", Name: "Beta Trading", Email: "sales@beta.test"},
		}, 5)
		if len(matches) != 1 || matches[0].ID != "survivor" || matches[0].Score != 100 || matches[0].MatchedOn != MatchOnEmail {
			t.Fatalf("matches=%+v", matches)
		}
		if matches[0].Detail != "billing@acme.test" {
			t.Fatalf("detail=%q", matches[0].Detail)
		}
	})

	t.Run("phone formats compare on the subscriber digits", func(t *testing.T) {
		matches := RankCustomerMatches("+256 772 123 456", []CustomerMatchCandidate{survivor}, 5)
		if len(matches) != 1 || matches[0].MatchedOn != MatchOnPhone || matches[0].Score != 95 {
			t.Fatalf("matches=%+v", matches)
		}
	})

	t.Run("names match in any token order", func(t *testing.T) {
		person := CustomerMatchCandidate{ID: "harper", Name: "Harper Clark"}
		matches := RankCustomerMatches("Clark Harper", []CustomerMatchCandidate{person}, 5)
		if len(matches) != 1 || matches[0].MatchedOn != MatchOnNameTokens || matches[0].Score != 75 {
			t.Fatalf("matches=%+v", matches)
		}
	})

	t.Run("a company suffix is not part of the identity", func(t *testing.T) {
		matches := RankCustomerMatches("Acme Supplies", []CustomerMatchCandidate{survivor}, 5)
		if len(matches) != 1 || matches[0].MatchedOn != MatchOnExactName || matches[0].Score != 90 {
			t.Fatalf("matches=%+v", matches)
		}
	})

	t.Run("partial and similar names are weaker evidence", func(t *testing.T) {
		partial := RankCustomerMatches("Acme Supplies International", []CustomerMatchCandidate{survivor}, 5)
		if len(partial) != 1 || partial[0].Score != 60 {
			t.Fatalf("partial=%+v", partial)
		}
		typo := RankCustomerMatches("Acme Suplies", []CustomerMatchCandidate{survivor}, 5)
		if len(typo) != 1 || typo[0].Score != 50 || typo[0].MatchedOn != MatchOnSimilarName {
			t.Fatalf("typo=%+v", typo)
		}
	})

	t.Run("a merged record resolves to the survivor", func(t *testing.T) {
		merged := CustomerMatchCandidate{
			ID: "tombstone", Name: "Acme Supply", Email: "old@acme.test",
			Deactivated: true, CanonicalID: "survivor", CanonicalName: "Acme Supplies Ltd",
		}
		matches := RankCustomerMatches("Acme Supply", []CustomerMatchCandidate{merged}, 5)
		if len(matches) != 1 {
			t.Fatalf("matches=%+v", matches)
		}
		match := matches[0]
		if match.ID != "survivor" || match.Name != "Acme Supplies Ltd" {
			t.Fatalf("a merged record must return the canonical id, got %+v", match)
		}
		if match.MatchedRecordID != "tombstone" || match.MatchedRecordName != "Acme Supply" {
			t.Fatalf("provenance=%+v", match)
		}
		if match.Deactivated {
			t.Fatal("the survivor is active; the tombstone's flag must not leak")
		}
	})

	t.Run("rows that resolve to one record collapse", func(t *testing.T) {
		merged := CustomerMatchCandidate{
			ID: "tombstone", Name: "Acme Supply", Deactivated: true,
			CanonicalID: "survivor", CanonicalName: "Acme Supplies Ltd",
		}
		matches := RankCustomerMatches("Acme", []CustomerMatchCandidate{survivor, merged}, 5)
		if len(matches) != 1 || matches[0].ID != "survivor" {
			t.Fatalf("matches=%+v", matches)
		}
		if matches[0].MatchedRecordID != "" {
			t.Fatalf("the direct row should explain the match, got %+v", matches[0])
		}
	})

	t.Run("a canonical link to itself is not a merge", func(t *testing.T) {
		direct := CustomerMatchCandidate{
			ID: "survivor", Name: "Acme Supplies Ltd", CanonicalID: "survivor",
			CanonicalName: "Acme Supplies Ltd", CanonicalDeactivated: true,
		}
		matches := RankCustomerMatches("Acme Supplies", []CustomerMatchCandidate{direct}, 5)
		if len(matches) != 1 || matches[0].MatchedRecordID != "" || !matches[0].Deactivated {
			t.Fatalf("matches=%+v", matches)
		}
	})

	t.Run("deactivation is reported on the survivor", func(t *testing.T) {
		merged := CustomerMatchCandidate{
			ID: "tombstone", Name: "Acme Supply", Deactivated: true,
			CanonicalID: "survivor", CanonicalName: "Acme Supplies Ltd", CanonicalDeactivated: true,
		}
		matches := RankCustomerMatches("Acme Supply", []CustomerMatchCandidate{merged}, 5)
		if len(matches) != 1 || !matches[0].Deactivated {
			t.Fatalf("matches=%+v", matches)
		}
	})

	t.Run("no evidence means no match", func(t *testing.T) {
		if matches := RankCustomerMatches("Completely Elsewhere", []CustomerMatchCandidate{survivor}, 5); len(matches) != 0 {
			t.Fatalf("matches=%+v", matches)
		}
		if matches := RankCustomerMatches("", []CustomerMatchCandidate{survivor}, 5); len(matches) != 0 {
			t.Fatalf("matches=%+v", matches)
		}
	})

	t.Run("ranking is deterministic and bounded", func(t *testing.T) {
		candidates := []CustomerMatchCandidate{
			{ID: "c", Name: "Acme Gamma"},
			{ID: "a", Name: "Acme Alpha"},
			{ID: "b", Name: "Acme Beta"},
		}
		first := RankCustomerMatches("Acme", candidates, 2)
		second := RankCustomerMatches("Acme", candidates, 2)
		if len(first) != 2 || len(second) != 2 || first[0].ID != second[0].ID || first[1].ID != second[1].ID {
			t.Fatalf("first=%+v second=%+v", first, second)
		}
		if first[0].ID != "a" || first[1].ID != "b" {
			t.Fatalf("ties should sort by name, got %+v", first)
		}
	})
}
