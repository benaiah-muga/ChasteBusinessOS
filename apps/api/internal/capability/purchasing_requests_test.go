package capability

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

func TestPurchasingRequestsParsersMirrorZodContracts(t *testing.T) {
	title200 := strings.Repeat("t", 200)
	justification10 := "Justified1"
	created, err := ParseCreatePurchaseRequestInput(json.RawMessage(`{"title":"Desk setup","justification":"We need desks for new hires","estimatedAmountMinor":420000,"unknown":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if created.Title != "Desk setup" || created.Justification != "We need desks for new hires" || created.EstimatedAmountMinor == nil || *created.EstimatedAmountMinor != 420000 {
		t.Fatalf("ParseCreatePurchaseRequestInput() = %+v, want full payload", created)
	}
	minimal, err := ParseCreatePurchaseRequestInput(json.RawMessage(`{"title":"abc","justification":"` + justification10 + `"}`))
	if err != nil || minimal.EstimatedAmountMinor != nil {
		t.Fatalf("minimal createPurchaseRequest input = %+v, %v, want absent estimate", minimal, err)
	}
	if _, err := ParseCreatePurchaseRequestInput(json.RawMessage(`{"title":"` + title200 + `","justification":"` + justification10 + `"}`)); err != nil {
		t.Fatalf("ParseCreatePurchaseRequestInput(200 chars) err = %v, want accepted", err)
	}
	for _, raw := range []string{
		`{}`,
		`[]`,
		`"request"`,
		`null`,
		`{"title":"ab","justification":"` + justification10 + `"}`,
		`{"title":"` + title200 + `x","justification":"` + justification10 + `"}`,
		`{"title":"Desk setup"}`,
		`{"title":null,"justification":"` + justification10 + `"}`,
		`{"title":5,"justification":"` + justification10 + `"}`,
		`{"title":"Desk setup","justification":"too short"}`,
		`{"title":"Desk setup","justification":"` + justification10 + `","estimatedAmountMinor":-1}`,
		`{"title":"Desk setup","justification":"` + justification10 + `","estimatedAmountMinor":1.5}`,
		`{"title":"Desk setup","justification":"` + justification10 + `","estimatedAmountMinor":null}`,
		`{"title":"Desk setup","justification":"` + justification10 + `"} {"x":1}`,
	} {
		if _, err := ParseCreatePurchaseRequestInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreatePurchaseRequestInput accepted %s", raw)
		}
	}

	decided, err := ParseDecidePurchaseRequestInput(json.RawMessage(`{"requestId":"req-1","decision":"approve","reason":"fits the budget"}`))
	if err != nil || decided.RequestID != "req-1" || decided.Decision != "approve" || decided.Reason == nil || *decided.Reason != "fits the budget" {
		t.Fatalf("ParseDecidePurchaseRequestInput() = %+v, %v", decided, err)
	}
	bare, err := ParseDecidePurchaseRequestInput(json.RawMessage(`{"requestId":"req-1","decision":"reject"}`))
	if err != nil || bare.Reason != nil {
		t.Fatalf("ParseDecidePurchaseRequestInput without reason = %+v, %v, want absent reason", bare, err)
	}
	if _, err := ParseDecidePurchaseRequestInput(json.RawMessage(`{"requestId":"req-1","decision":"approve","reason":"` + strings.Repeat("r", 1000) + `"}`)); err != nil {
		t.Fatalf("ParseDecidePurchaseRequestInput(1000 char reason) err = %v, want accepted", err)
	}
	for _, raw := range []string{
		`{}`,
		`{"decision":"approve"}`,
		`{"requestId":"req-1"}`,
		`{"requestId":"req-1","decision":"APPROVE"}`,
		`{"requestId":"req-1","decision":"maybe"}`,
		`{"requestId":"req-1","decision":null}`,
		`{"requestId":"req-1","decision":"approve","reason":"` + strings.Repeat("r", 1001) + `"}`,
		`{"requestId":"req-1","decision":"approve","reason":null}`,
	} {
		if _, err := ParseDecidePurchaseRequestInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseDecidePurchaseRequestInput accepted %s", raw)
		}
	}

	rfq, err := ParseCreateRfqInput(json.RawMessage(`{"requestId":"req-1","vendorIds":["v1","v2"],"unknown":1}`))
	if err != nil || rfq.RequestID != "req-1" || len(rfq.VendorIDs) != 2 || rfq.VendorIDs[0] != "v1" || rfq.VendorIDs[1] != "v2" {
		t.Fatalf("ParseCreateRfqInput() = %+v, %v", rfq, err)
	}
	tenVendors := `["` + strings.Join(fillerStrings(10, "vendor"), `","`) + `"]`
	if _, err := ParseCreateRfqInput(json.RawMessage(`{"requestId":"req-1","vendorIds":` + tenVendors + `}`)); err != nil {
		t.Fatalf("ParseCreateRfqInput(10 vendors) err = %v, want accepted", err)
	}
	if _, err := ParseCreateRfqInput(json.RawMessage(`{"requestId":"req-1","vendorIds":["v1","v1"]}`)); err != nil {
		t.Fatalf("ParseCreateRfqInput(duplicate vendors) err = %v, want accepted", err)
	}
	elevenVendors := `["` + strings.Join(fillerStrings(11, "vendor"), `","`) + `"]`
	for _, raw := range []string{
		`{}`,
		`{"requestId":"req-1"}`,
		`{"requestId":"req-1","vendorIds":[]}`,
		`{"requestId":"req-1","vendorIds":null}`,
		`{"requestId":"req-1","vendorIds":"v1"}`,
		`{"requestId":"req-1","vendorIds":[1]}`,
		`{"requestId":"req-1","vendorIds":` + elevenVendors + `}`,
	} {
		if _, err := ParseCreateRfqInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreateRfqInput accepted %s", raw)
		}
	}

	quoted, err := ParseRecordQuoteInput(json.RawMessage(`{"rfqId":"rfq-1","amountMinor":4400,"leadTimeDays":7,"notes":"includes freight"}`))
	if err != nil || quoted.RFQID != "rfq-1" || quoted.AmountMinor != 4400 || quoted.LeadTimeDays == nil || *quoted.LeadTimeDays != 7 || quoted.Notes == nil || *quoted.Notes != "includes freight" {
		t.Fatalf("ParseRecordQuoteInput() = %+v, %v", quoted, err)
	}
	zeroLead, err := ParseRecordQuoteInput(json.RawMessage(`{"rfqId":"rfq-1","amountMinor":1,"leadTimeDays":0}`))
	if err != nil || zeroLead.LeadTimeDays == nil || *zeroLead.LeadTimeDays != 0 {
		t.Fatalf("ParseRecordQuoteInput(0 lead days) = %+v, %v, want accepted", zeroLead, err)
	}
	if _, err := ParseRecordQuoteInput(json.RawMessage(`{"rfqId":"rfq-1","amountMinor":1,"notes":"` + strings.Repeat("n", 2000) + `"}`)); err != nil {
		t.Fatalf("ParseRecordQuoteInput(2000 char notes) err = %v, want accepted", err)
	}
	for _, raw := range []string{
		`{}`,
		`{"amountMinor":1}`,
		`{"rfqId":"rfq-1"}`,
		`{"rfqId":"rfq-1","amountMinor":0}`,
		`{"rfqId":"rfq-1","amountMinor":-5}`,
		`{"rfqId":"rfq-1","amountMinor":1.5}`,
		`{"rfqId":"rfq-1","amountMinor":null}`,
		`{"rfqId":"rfq-1","amountMinor":1,"leadTimeDays":-1}`,
		`{"rfqId":"rfq-1","amountMinor":1,"leadTimeDays":2.5}`,
		`{"rfqId":"rfq-1","amountMinor":1,"notes":"` + strings.Repeat("n", 2001) + `"}`,
		`{"rfqId":"rfq-1","amountMinor":1,"notes":null}`,
	} {
		if _, err := ParseRecordQuoteInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseRecordQuoteInput accepted %s", raw)
		}
	}

	winner, err := ParseSelectWinningQuoteInput(json.RawMessage(`{"rfqId":"rfq-1"}`))
	if err != nil || winner.RFQID != "rfq-1" {
		t.Fatalf("ParseSelectWinningQuoteInput() = %+v, %v", winner, err)
	}
	if _, err := ParseSelectWinningQuoteInput(json.RawMessage(`{}`)); err == nil {
		t.Error("ParseSelectWinningQuoteInput accepted {}")
	}

	if _, err := ParseListPurchaseWorkflowInput(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("ParseListPurchaseWorkflowInput({}) err = %v", err)
	}
	if _, err := ParseListPurchaseWorkflowInput(json.RawMessage(`{"unused":"stripped by zod"}`)); err != nil {
		t.Fatalf("ParseListPurchaseWorkflowInput(unknown keys) err = %v", err)
	}
	for _, raw := range []string{`[]`, `"list"`, `null`, `{"a":1} trailing`} {
		if _, err := ParseListPurchaseWorkflowInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseListPurchaseWorkflowInput accepted %s", raw)
		}
	}

	if _, err := parsePurchasingRequestInput("purchasing.unknown", json.RawMessage(`{}`)); err == nil || err.Error() != "unsupported purchasing request capability" {
		t.Fatalf("parsePurchasingRequestInput(unknown) err = %v, want dispatcher refusal", err)
	}
	for capabilityID, raw := range map[string]string{
		createPurchaseRequestCapabilityID: `{"title":"abc","justification":"` + justification10 + `"}`,
		decidePurchaseRequestCapabilityID: `{"requestId":"req-1","decision":"approve"}`,
		createRfqCapabilityID:             `{"requestId":"req-1","vendorIds":["v1"]}`,
		recordQuoteCapabilityID:           `{"rfqId":"rfq-1","amountMinor":1}`,
		selectWinningQuoteCapabilityID:    `{"rfqId":"rfq-1"}`,
		listPurchaseWorkflowCapabilityID:  `{}`,
	} {
		if _, err := parsePurchasingRequestInput(capabilityID, json.RawMessage(raw)); err != nil {
			t.Errorf("parsePurchasingRequestInput(%s) err = %v", capabilityID, err)
		}
	}
}

func fillerStrings(count int, prefix string) []string {
	values := make([]string, 0, count)
	for index := 0; index < count; index++ {
		values = append(values, fmt.Sprintf("%s-%d", prefix, index))
	}
	return values
}

func seedPurchasingRequest(t *testing.T, fx *executorFixture, orgID, requestedByUserID, title, justification, status string, estimatedAmountMinor *int64, createdAt time.Time) string {
	t.Helper()
	var requestID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO purchase_requests (org_id, title, justification, status, estimated_amount_minor, requested_by_user_id, created_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7)
		RETURNING id::text`, orgID, title, justification, status, estimatedAmountMinor, requestedByUserID, createdAt).Scan(&requestID); err != nil {
		t.Fatal(err)
	}
	return requestID
}

func seedPurchasingRFQ(t *testing.T, fx *executorFixture, orgID, requestID, vendorID, status string, quoteAmountMinor *int64, quoteLeadTimeDays *int64, quotedAt *time.Time) string {
	t.Helper()
	var rfqID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO rfqs (org_id, request_id, vendor_id, status, quote_amount_minor, quote_lead_time_days, quoted_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)
		RETURNING id::text`, orgID, requestID, vendorID, status, quoteAmountMinor, quoteLeadTimeDays, quotedAt).Scan(&rfqID); err != nil {
		t.Fatal(err)
	}
	return rfqID
}

func purchasingRequestsAgentClaims(fx *executorFixture) authbridge.CapabilityClaims {
	actorID := fx.userID
	return authbridge.CapabilityClaims{OrganizationID: fx.orgID, ActorType: "agent", ActorID: &actorID}
}

func cleanupPurchasingRequestsFixture(t *testing.T, fx *executorFixture) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := fx.owner.Begin(fx.ctx)
		if err != nil {
			t.Errorf("begin purchasing requests fixture cleanup: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(fx.ctx) }()
		for orgID := range map[string]struct{}{fx.orgID: {}, fx.otherOrgID: {}} {
			steps := []string{
				`DELETE FROM po_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE org_id = $1::uuid)`,
				`DELETE FROM purchase_orders WHERE org_id = $1::uuid`,
				`DELETE FROM rfqs WHERE org_id = $1::uuid`,
				`DELETE FROM purchase_requests WHERE org_id = $1::uuid`,
				`DELETE FROM doc_counters WHERE org_id = $1::uuid`,
				`DELETE FROM vendors WHERE org_id = $1::uuid`,
			}
			for _, step := range steps {
				if _, err := tx.Exec(fx.ctx, step, orgID); err != nil {
					t.Errorf("purchasing requests fixture cleanup step failed: %v", err)
					return
				}
			}
		}
		if err := tx.Commit(fx.ctx); err != nil {
			t.Errorf("commit purchasing requests fixture cleanup: %v", err)
		}
	})
}

func TestPurchasingRequestsCreateRequestPersistsAttribution(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingRequestsFixture(t, fx)
	claims := purchasingBillsClaims(fx)
	agentClaims := purchasingRequestsAgentClaims(fx)

	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreatePurchaseRequestOutput, error) {
		return createPurchaseRequest(fx.ctx, tx, claims, CreatePurchaseRequestInput{Title: "Desk setup", Justification: "We need desks for new hires"})
	})
	if err != nil {
		t.Fatalf("createPurchaseRequest: %v", err)
	}
	if !isUUID(created.RequestID) {
		t.Fatalf("createPurchaseRequest output = %+v, want a request id", created)
	}
	encoded, err := marshalJS(created)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != fmt.Sprintf(`{"requestId":%q}`, created.RequestID) {
		t.Fatalf("createPurchaseRequest output JSON = %s", encoded)
	}
	var title, justification, status string
	var estimatedAmountMinor *int64
	var requestedByUserID *string
	var decidedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT title, justification, status, estimated_amount_minor, requested_by_user_id::text, decided_at
		FROM purchase_requests WHERE id = $1::uuid AND org_id = $2::uuid`,
		created.RequestID, fx.orgID).Scan(&title, &justification, &status, &estimatedAmountMinor, &requestedByUserID, &decidedAt); err != nil {
		t.Fatal(err)
	}
	if title != "Desk setup" || justification != "We need desks for new hires" || status != "pending_review" || estimatedAmountMinor != nil {
		t.Fatalf("stored request = %q %q %q estimate=%v, want defaults", title, justification, status, estimatedAmountMinor)
	}
	if requestedByUserID == nil || *requestedByUserID != fx.userID {
		t.Fatalf("requested_by_user_id = %v, want the acting human %s", requestedByUserID, fx.userID)
	}
	if decidedAt != nil {
		t.Fatalf("decided_at = %v, want null on a pending request", decidedAt)
	}

	agentCreated, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreatePurchaseRequestOutput, error) {
		return createPurchaseRequest(fx.ctx, tx, agentClaims, CreatePurchaseRequestInput{
			Title: "Agent order", Justification: "Raised by the ops agent", EstimatedAmountMinor: crmInt64Pointer(420000),
		})
	})
	if err != nil {
		t.Fatalf("createPurchaseRequest as agent: %v", err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT requested_by_user_id::text, estimated_amount_minor
		FROM purchase_requests WHERE id = $1::uuid`, agentCreated.RequestID).Scan(&requestedByUserID, &estimatedAmountMinor); err != nil {
		t.Fatal(err)
	}
	if requestedByUserID == nil || *requestedByUserID != fx.userID {
		t.Fatalf("agent-created requested_by_user_id = %v, want the principal user %s", requestedByUserID, fx.userID)
	}
	if estimatedAmountMinor == nil || *estimatedAmountMinor != 420000 {
		t.Fatalf("estimated_amount_minor = %v, want 420000", estimatedAmountMinor)
	}
}

func TestPurchasingRequestsDecideGuardsApprovalStateMachine(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingRequestsFixture(t, fx)
	claims := purchasingBillsClaims(fx)
	agentClaims := purchasingRequestsAgentClaims(fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)

	pending := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Approvable request", "Awaiting the reviewer decision", "pending_review", nil, now.Add(-time.Hour))
	missingID := executorUUID(t)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (DecidePurchaseRequestOutput, error) {
		return decidePurchaseRequest(fx.ctx, tx, claims, DecidePurchaseRequestInput{RequestID: missingID, Decision: "approve"}, now)
	}); err == nil || err.Error() != "purchase request not found" {
		t.Fatalf("decidePurchaseRequest(missing) error = %v, want purchase request not found", err)
	}

	decided, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (DecidePurchaseRequestOutput, error) {
		return decidePurchaseRequest(fx.ctx, tx, claims, DecidePurchaseRequestInput{RequestID: pending, Decision: "approve", Reason: crmStringPointer("fits the budget")}, now)
	})
	if err != nil || decided.Status != "approved" {
		t.Fatalf("decidePurchaseRequest(approve) = %+v, %v, want approved", decided, err)
	}
	var status string
	var decidedByUserID *string
	var decisionReason *string
	var decidedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, decided_by_user_id::text, decision_reason, decided_at
		FROM purchase_requests WHERE id = $1::uuid`, pending).Scan(&status, &decidedByUserID, &decisionReason, &decidedAt); err != nil {
		t.Fatal(err)
	}
	if status != "approved" || decidedByUserID == nil || *decidedByUserID != fx.userID || decisionReason == nil || *decisionReason != "fits the budget" {
		t.Fatalf("stored decision = %q decided_by=%v reason=%v, want approval by the human reviewer", status, decidedByUserID, decisionReason)
	}
	if decidedAt == nil || !decidedAt.Equal(now) {
		t.Fatalf("decided_at = %v, want %v", decidedAt, now)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (DecidePurchaseRequestOutput, error) {
		return decidePurchaseRequest(fx.ctx, tx, claims, DecidePurchaseRequestInput{RequestID: pending, Decision: "reject"}, now)
	}); err == nil || err.Error() != "request is already approved" {
		t.Fatalf("decidePurchaseRequest(twice) error = %v, want request is already approved", err)
	}

	agentPending := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Agent decided", "The ops agent routed this one", "pending_review", nil, now.Add(-2*time.Hour))
	agentDecided, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (DecidePurchaseRequestOutput, error) {
		return decidePurchaseRequest(fx.ctx, tx, agentClaims, DecidePurchaseRequestInput{RequestID: agentPending, Decision: "reject"}, now)
	})
	if err != nil || agentDecided.Status != "rejected" {
		t.Fatalf("decidePurchaseRequest(agent reject) = %+v, %v, want rejected", agentDecided, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT decided_by_user_id::text FROM purchase_requests WHERE id = $1::uuid`, agentPending).Scan(&decidedByUserID); err != nil {
		t.Fatal(err)
	}
	if decidedByUserID != nil {
		t.Fatalf("agent decision decided_by = %v, want null", decidedByUserID)
	}
}

func TestPurchasingRequestsCreateRfqRequiresApprovedRequestAndKnownVendors(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingRequestsFixture(t, fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	vendorA := seedPurchasingVendor(t, fx, fx.orgID, nil)
	vendorB := seedPurchasingVendor(t, fx, fx.orgID, nil)
	foreignVendor := seedPurchasingVendor(t, fx, fx.otherOrgID, nil)

	pending := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Pending order", "Still waiting on review", "pending_review", nil, now.Add(-time.Hour))
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateRfqOutput, error) {
		return createRfq(fx.ctx, tx, fx.orgID, CreateRfqInput{RequestID: pending, VendorIDs: []string{vendorA}})
	}); err == nil || err.Error() != "only approved requests can go out as RFQs" {
		t.Fatalf("createRfq(pending request) error = %v, want only approved requests can go out as RFQs", err)
	}

	approved := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Approved order", "Approved for quoting", "approved", crmInt64Pointer(500000), now.Add(-2*time.Hour))
	missingID := executorUUID(t)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateRfqOutput, error) {
		return createRfq(fx.ctx, tx, fx.orgID, CreateRfqInput{RequestID: missingID, VendorIDs: []string{vendorA}})
	}); err == nil || err.Error() != "purchase request not found" {
		t.Fatalf("createRfq(missing request) error = %v, want purchase request not found", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateRfqOutput, error) {
		return createRfq(fx.ctx, tx, fx.orgID, CreateRfqInput{RequestID: approved, VendorIDs: []string{vendorA, foreignVendor}})
	}); err == nil || err.Error() != "unknown vendor id(s)" {
		t.Fatalf("createRfq(foreign vendor) error = %v, want unknown vendor id(s)", err)
	}
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateRfqOutput, error) {
		return createRfq(fx.ctx, tx, fx.orgID, CreateRfqInput{RequestID: approved, VendorIDs: []string{vendorA, "not-a-uuid"}})
	}); err == nil || err.Error() != "unknown vendor id(s)" {
		t.Fatalf("createRfq(non-uuid vendor) error = %v, want unknown vendor id(s)", err)
	}

	created, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (CreateRfqOutput, error) {
		return createRfq(fx.ctx, tx, fx.orgID, CreateRfqInput{RequestID: approved, VendorIDs: []string{vendorA, vendorB}})
	})
	if err != nil || len(created.RFQIDs) != 2 {
		t.Fatalf("createRfq() = %+v, %v, want two RFQ ids", created, err)
	}
	encoded, err := marshalJS(created)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"rfqIds":[` + fmt.Sprintf("%q,%q", created.RFQIDs[0], created.RFQIDs[1]) + `]}`
	if string(encoded) != want {
		t.Fatalf("createRfq output JSON = %s, want %s", encoded, want)
	}
	rows, err := fx.owner.Query(fx.ctx, `
		SELECT vendor_id::text, status FROM rfqs
		WHERE request_id = $1::uuid AND org_id = $2::uuid
		ORDER BY created_at, id`, approved, fx.orgID)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]string, 2)
	for rows.Next() {
		var rfqVendorID, rfqStatus string
		if err := rows.Scan(&rfqVendorID, &rfqStatus); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		seen[rfqVendorID] = rfqStatus
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	if len(seen) != 2 || seen[vendorA] != "sent" || seen[vendorB] != "sent" {
		t.Fatalf("stored RFQs = %v, want both vendors at status sent", seen)
	}
}

func TestPurchasingRequestsRecordQuoteStoresBidAndGuardsDecided(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingRequestsFixture(t, fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	vendor := seedPurchasingVendor(t, fx, fx.orgID, nil)
	requestID := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Quoted order", "Approved for quoting", "approved", nil, now.Add(-time.Hour))

	openRFQ := seedPurchasingRFQ(t, fx, fx.orgID, requestID, vendor, "sent", nil, nil, nil)
	wonRFQ := seedPurchasingRFQ(t, fx, fx.orgID, requestID, vendor, "won", crmInt64Pointer(4000), nil, &now)
	lostRFQ := seedPurchasingRFQ(t, fx, fx.orgID, requestID, vendor, "lost", nil, nil, nil)
	missingID := executorUUID(t)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordQuoteOutput, error) {
		return recordQuote(fx.ctx, tx, fx.orgID, RecordQuoteInput{RFQID: missingID, AmountMinor: 100}, now)
	}); err == nil || err.Error() != "RFQ not found" {
		t.Fatalf("recordQuote(missing) error = %v, want RFQ not found", err)
	}
	for _, rfqID := range []string{wonRFQ, lostRFQ} {
		if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordQuoteOutput, error) {
			return recordQuote(fx.ctx, tx, fx.orgID, RecordQuoteInput{RFQID: rfqID, AmountMinor: 100}, now)
		}); err == nil || err.Error() != "this RFQ is already decided" {
			t.Fatalf("recordQuote(decided %s) error = %v, want this RFQ is already decided", rfqID, err)
		}
	}

	quoted, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordQuoteOutput, error) {
		return recordQuote(fx.ctx, tx, fx.orgID, RecordQuoteInput{RFQID: openRFQ, AmountMinor: 4400, LeadTimeDays: crmInt64Pointer(7), Notes: crmStringPointer("includes freight")}, now)
	})
	if err != nil || quoted.Status != "quoted" {
		t.Fatalf("recordQuote() = %+v, %v, want quoted", quoted, err)
	}
	var status string
	var amountMinor, leadTimeDays *int64
	var notes *string
	var quotedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT status, quote_amount_minor, quote_lead_time_days, quote_notes, quoted_at
		FROM rfqs WHERE id = $1::uuid`, openRFQ).Scan(&status, &amountMinor, &leadTimeDays, &notes, &quotedAt); err != nil {
		t.Fatal(err)
	}
	if status != "quoted" || amountMinor == nil || *amountMinor != 4400 || leadTimeDays == nil || *leadTimeDays != 7 || notes == nil || *notes != "includes freight" {
		t.Fatalf("stored quote = %q amount=%v lead=%v notes=%v, want the recorded bid", status, amountMinor, leadTimeDays, notes)
	}
	if quotedAt == nil || !quotedAt.Equal(now) {
		t.Fatalf("quoted_at = %v, want %v", quotedAt, now)
	}

	updated, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (RecordQuoteOutput, error) {
		return recordQuote(fx.ctx, tx, fx.orgID, RecordQuoteInput{RFQID: openRFQ, AmountMinor: 4100}, now.Add(time.Hour))
	})
	if err != nil || updated.Status != "quoted" {
		t.Fatalf("recordQuote(requote) = %+v, %v, want requote allowed before the award", updated, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT quote_amount_minor, quote_lead_time_days, quote_notes FROM rfqs WHERE id = $1::uuid`, openRFQ).Scan(&amountMinor, &leadTimeDays, &notes); err != nil {
		t.Fatal(err)
	}
	if amountMinor == nil || *amountMinor != 4100 || leadTimeDays != nil || notes != nil {
		t.Fatalf("replaced quote = amount=%v lead=%v notes=%v, want overwritten optionals", amountMinor, leadTimeDays, notes)
	}
}

func TestPurchasingRequestsSelectWinnerRaisesPurchaseOrder(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingRequestsFixture(t, fx)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	vendorA := seedPurchasingVendor(t, fx, fx.orgID, nil)
	vendorB := seedPurchasingVendor(t, fx, fx.orgID, nil)
	requestID := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Shop shelving", "Approved for quoting", "approved", nil, now.Add(-3*time.Hour))

	missingID := executorUUID(t)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SelectWinningQuoteOutput, error) {
		return selectWinningQuote(fx.ctx, tx, fx.orgID, SelectWinningQuoteInput{RFQID: missingID}, now)
	}); err == nil || err.Error() != "RFQ not found" {
		t.Fatalf("selectWinningQuote(missing) error = %v, want RFQ not found", err)
	}

	unquotedRFQ := seedPurchasingRFQ(t, fx, fx.orgID, requestID, vendorB, "sent", nil, nil, nil)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SelectWinningQuoteOutput, error) {
		return selectWinningQuote(fx.ctx, tx, fx.orgID, SelectWinningQuoteInput{RFQID: unquotedRFQ}, now)
	}); err == nil || err.Error() != "record this vendor's quote before awarding" {
		t.Fatalf("selectWinningQuote(unquoted) error = %v, want record this vendor's quote before awarding", err)
	}

	winnerRFQ := seedPurchasingRFQ(t, fx, fx.orgID, requestID, vendorA, "quoted", crmInt64Pointer(4400), nil, &now)
	siblingRFQ := seedPurchasingRFQ(t, fx, fx.orgID, requestID, vendorB, "quoted", crmInt64Pointer(4100), nil, &now)
	won, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SelectWinningQuoteOutput, error) {
		return selectWinningQuote(fx.ctx, tx, fx.orgID, SelectWinningQuoteInput{RFQID: winnerRFQ}, now)
	})
	if err != nil {
		t.Fatalf("selectWinningQuote(): %v", err)
	}
	if won.PONumber != 1 || won.VendorID != vendorA || won.QuoteAmountMinor != 4400 {
		t.Fatalf("selectWinningQuote() = %+v, want PO 1 for vendor A at 4400", won)
	}
	var winnerStatus, siblingStatus, requestStatus string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM rfqs WHERE id = $1::uuid`, winnerRFQ).Scan(&winnerStatus); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM rfqs WHERE id = $1::uuid`, siblingRFQ).Scan(&siblingStatus); err != nil {
		t.Fatal(err)
	}
	if winnerStatus != "won" || siblingStatus != "lost" {
		t.Fatalf("RFQ statuses = winner %q sibling %q, want won and lost", winnerStatus, siblingStatus)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT status FROM purchase_requests WHERE id = $1::uuid`, requestID).Scan(&requestStatus); err != nil {
		t.Fatal(err)
	}
	if requestStatus != "converted" {
		t.Fatalf("request status = %q, want converted", requestStatus)
	}

	var poNumber int64
	var poStatus, poVendorID, poMemo string
	var orderedAt time.Time
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT number, status, vendor_id::text, memo, ordered_at
		FROM purchase_orders WHERE org_id = $1::uuid AND number = $2`, fx.orgID, won.PONumber).Scan(&poNumber, &poStatus, &poVendorID, &poMemo, &orderedAt); err != nil {
		t.Fatal(err)
	}
	if poStatus != "ordered" || poVendorID != vendorA || poMemo != "From RFQ award \u00b7 Shop shelving" || !orderedAt.Equal(now) {
		t.Fatalf("stored PO = %q vendor=%s memo=%q ordered_at=%v, want the award order", poStatus, poVendorID, poMemo, orderedAt)
	}
	var lineDescription string
	var lineQuantity, lineUnitPriceMinor, linePosition int64
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT description, quantity, unit_price_minor, position
		FROM po_lines WHERE po_id = (SELECT id FROM purchase_orders WHERE org_id = $1::uuid AND number = $2)`,
		fx.orgID, won.PONumber).Scan(&lineDescription, &lineQuantity, &lineUnitPriceMinor, &linePosition); err != nil {
		t.Fatal(err)
	}
	if lineDescription != "Shop shelving" || lineQuantity != 1000 || lineUnitPriceMinor != 4400 || linePosition != 1 {
		t.Fatalf("stored PO line = %q qty=%d price=%d pos=%d, want the converted request line", lineDescription, lineQuantity, lineUnitPriceMinor, linePosition)
	}
	if got := fx.count(`SELECT "next" FROM doc_counters WHERE org_id = $1::uuid AND kind = 'purchase_order'`, fx.orgID); got != 1 {
		t.Fatalf("purchase_order counter next = %d, want 1", got)
	}

	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SelectWinningQuoteOutput, error) {
		return selectWinningQuote(fx.ctx, tx, fx.orgID, SelectWinningQuoteInput{RFQID: siblingRFQ}, now)
	}); err == nil || err.Error() != "record this vendor's quote before awarding" {
		t.Fatalf("selectWinningQuote(lost sibling) error = %v, want record this vendor's quote before awarding", err)
	}

	awardedElsewhere := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Awarded elsewhere", "Approved for quoting", "converted", nil, now.Add(-2*time.Hour))
	staleRFQ := seedPurchasingRFQ(t, fx, fx.orgID, awardedElsewhere, vendorB, "quoted", crmInt64Pointer(3900), nil, &now)
	if _, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SelectWinningQuoteOutput, error) {
		return selectWinningQuote(fx.ctx, tx, fx.orgID, SelectWinningQuoteInput{RFQID: staleRFQ}, now)
	}); err == nil || err.Error() != "request is no longer approvable into an order" {
		t.Fatalf("selectWinningQuote(converted request) error = %v, want request is no longer approvable into an order", err)
	}

	secondRequest := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Second shelving", "Approved for quoting", "approved", nil, now.Add(-2*time.Hour))
	secondRFQ := seedPurchasingRFQ(t, fx, fx.orgID, secondRequest, vendorB, "quoted", crmInt64Pointer(4100), nil, &now)
	second, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (SelectWinningQuoteOutput, error) {
		return selectWinningQuote(fx.ctx, tx, fx.orgID, SelectWinningQuoteInput{RFQID: secondRFQ}, now)
	})
	if err != nil || second.PONumber != 2 || second.QuoteAmountMinor != 4100 {
		t.Fatalf("selectWinningQuote(second award) = %+v, %v, want PO 2 at 4100", second, err)
	}
	if got := fx.count(`SELECT "next" FROM doc_counters WHERE org_id = $1::uuid AND kind = 'purchase_order'`, fx.orgID); got != 2 {
		t.Fatalf("purchase_order counter next = %d, want 2", got)
	}
}

func TestPurchasingRequestsListReturnsWorkflow(t *testing.T) {
	fx := newExecutorFixture(t)
	cleanupPurchasingRequestsFixture(t, fx)

	empty, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListPurchaseWorkflowOutput, error) {
		return listPurchaseWorkflow(fx.ctx, tx, fx.orgID, ListPurchaseWorkflowInput{})
	})
	if err != nil || len(empty.Requests) != 0 {
		t.Fatalf("listPurchaseWorkflow(empty org) = %+v, %v, want no requests", empty, err)
	}
	encoded, err := marshalJS(empty)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"requests":[]}` {
		t.Fatalf("empty list JSON = %s, want {\"requests\":[]}", encoded)
	}

	vendorA := seedPurchasingVendor(t, fx, fx.orgID, nil)
	vendorB := seedPurchasingVendor(t, fx, fx.orgID, nil)
	firstCreatedAt := time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC)
	secondCreatedAt := time.Date(2026, 9, 26, 9, 30, 0, 0, time.UTC)
	firstRequest := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Shop shelving", "Approved for quoting", "approved", crmInt64Pointer(900000), firstCreatedAt)
	secondRequest := seedPurchasingRequest(t, fx, fx.orgID, fx.userID, "Second shelving", "Awaiting reviewer decision", "pending_review", nil, secondCreatedAt)
	seedPurchasingRequest(t, fx, fx.otherOrgID, fx.userID, "Foreign order", "Belongs to another org", "pending_review", nil, secondCreatedAt)
	wonRFQ := seedPurchasingRFQ(t, fx, fx.orgID, firstRequest, vendorA, "won", crmInt64Pointer(4400), crmInt64Pointer(7), &firstCreatedAt)
	seedPurchasingRFQ(t, fx, fx.orgID, firstRequest, vendorB, "lost", nil, nil, nil)

	listed, err := dbx.WithOrgTx(fx.ctx, fx.runtime, fx.orgID, func(tx pgx.Tx) (ListPurchaseWorkflowOutput, error) {
		return listPurchaseWorkflow(fx.ctx, tx, fx.orgID, ListPurchaseWorkflowInput{})
	})
	if err != nil {
		t.Fatalf("listPurchaseWorkflow(): %v", err)
	}
	if len(listed.Requests) != 2 {
		t.Fatalf("listPurchaseWorkflow() returned %d requests, want 2 without the foreign org", len(listed.Requests))
	}
	second, first := listed.Requests[0], listed.Requests[1]
	if second.ID != secondRequest || first.ID != firstRequest {
		t.Fatalf("list order = [%s %s], want newest first", second.ID, first.ID)
	}
	if second.Title != "Second shelving" || second.Status != "pending_review" || second.EstimatedAmountMinor != nil || second.CreatedAt != "2026-09-26T09:30:00.000Z" {
		t.Fatalf("second request item = %+v, want ISO createdAt and null estimate", second)
	}
	if len(second.RFQs) != 0 {
		t.Fatalf("second request rfqs = %+v, want empty list", second.RFQs)
	}
	if first.Title != "Shop shelving" || first.EstimatedAmountMinor == nil || *first.EstimatedAmountMinor != 900000 {
		t.Fatalf("first request item = %+v, want estimate 900000", first)
	}
	if len(first.RFQs) != 2 {
		t.Fatalf("first request rfqs = %+v, want both bids", first.RFQs)
	}
	var won PurchaseWorkflowRFQItem
	for _, rfq := range first.RFQs {
		if rfq.ID == wonRFQ {
			won = rfq
		} else if rfq.Status != "lost" || rfq.VendorID != vendorB {
			t.Fatalf("sibling RFQ item = %+v, want the lost bid for vendor B", rfq)
		}
	}
	if won.Status != "won" || won.VendorID != vendorA || won.QuoteAmountMinor == nil || *won.QuoteAmountMinor != 4400 || won.QuoteLeadTimeDays == nil || *won.QuoteLeadTimeDays != 7 {
		t.Fatalf("winning RFQ item = %+v, want the accepted bid details", won)
	}

	encoded, err = marshalJS(listed)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"createdAt":"2026-09-20T08:00:00.000Z"`) || !strings.Contains(string(encoded), `"rfqs":[]`) {
		t.Fatalf("list JSON = %s, want ISO timestamps and an empty rfqs array", encoded)
	}
}
