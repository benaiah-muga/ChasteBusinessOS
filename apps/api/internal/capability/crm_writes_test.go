package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
)

func crmWriteClaims(fx *executorFixture, capabilityID string, input json.RawMessage, actorType, agentSession, intent string) authbridge.CapabilityClaims {
	claims := fx.claims(input, actorType, agentSession, intent)
	claims.CapabilityID = capabilityID
	return claims
}

func executeCRMWrite(t *testing.T, fx *executorFixture, capabilityID string, input json.RawMessage, intent string) Result {
	t.Helper()
	result, err := fx.executor.Execute(fx.ctx, crmWriteClaims(fx, capabilityID, input, "human", "", intent), capabilityID, input)
	if err != nil {
		t.Fatalf("execute %s: %v", capabilityID, err)
	}
	return result
}

type mergeCustomerSeed struct {
	Name                   string
	Email                  *string
	Phone                  *string
	PreferredContactMethod string
	DoNotContact           bool
	ReminderOptOut         bool
	MarketingOptOut        bool
	OwnerUserID            *string
	Tags                   []string
	Notes                  *string
	CreditLimitMinor       *int64
	PaymentTermDays        *int64
	DeactivatedAt          *time.Time
	MergedIntoCustomerID   *string
	MergedAt               *time.Time
}

func seedMergeCustomer(t *testing.T, fx *executorFixture, orgID string, seed mergeCustomerSeed) string {
	t.Helper()
	if seed.Tags == nil {
		seed.Tags = []string{}
	}
	var customerID string
	err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO customers (
			org_id, name, email, phone, preferred_contact_method, do_not_contact,
			reminder_opt_out, marketing_opt_out, owner_user_id, tags, notes,
			credit_limit_minor, payment_term_days, deactivated_at, merged_into_customer_id, merged_at
		)
		VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10::text[],$11,$12::integer,$13::integer,$14,$15::uuid,$16)
		RETURNING id::text`, orgID, seed.Name, seed.Email, seed.Phone, seed.PreferredContactMethod,
		seed.DoNotContact, seed.ReminderOptOut, seed.MarketingOptOut, seed.OwnerUserID,
		seed.Tags, seed.Notes, seed.CreditLimitMinor, seed.PaymentTermDays, seed.DeactivatedAt,
		seed.MergedIntoCustomerID, seed.MergedAt).Scan(&customerID)
	if err != nil {
		t.Fatal(err)
	}
	return customerID
}

func TestGoCustomerMergeMatchesLegacyAndPreservesHistory(t *testing.T) {
	fx := newExecutorFixture(t)
	survivor := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{
		Name: "Northwind Works", Email: crmStringPointer("northwind@example.test"),
		PreferredContactMethod: "email", Tags: []string{"VIP", "Same", "ΟΣ"}, Notes: crmStringPointer("survivor notes"),
		CreditLimitMinor: crmInt64Pointer(50000),
	})
	duplicate := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{
		Name: "Northwind Work", Email: crmStringPointer("duplicate@example.test"), Phone: crmStringPointer("+256 772 222 111"),
		PreferredContactMethod: "phone", DoNotContact: true, ReminderOptOut: true, MarketingOptOut: true,
		OwnerUserID: crmStringPointer(fx.userID), Tags: []string{"same", " Wholesale ", "ος"},
		Notes: crmStringPointer("duplicate notes"), PaymentTermDays: crmInt64Pointer(30),
	})
	child := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{
		Name: "Earlier duplicate", PreferredContactMethod: "other", Tags: []string{"child"},
		MergedIntoCustomerID: crmStringPointer(duplicate),
	})

	var invoiceID, quoteID, dealID, taskID, documentID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor)
		VALUES ($1::uuid,$2::uuid,70001,'sent',2000,0,2000) RETURNING id::text`, fx.orgID, duplicate).Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO quotes (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor, created_by_actor_type)
		VALUES ($1::uuid,$2::uuid,70001,'sent',1800,0,1800,'human') RETURNING id::text`, fx.orgID, duplicate).Scan(&quoteID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO deals (org_id, customer_id, title, value_minor)
		VALUES ($1::uuid,$2::uuid,'Northwind renewal',7500) RETURNING id::text`, fx.orgID, duplicate).Scan(&dealID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO tasks (org_id, title, ref_type, ref_id, created_by_actor_type)
		VALUES ($1::uuid,'Check renewal','customer',$2::uuid,'human') RETURNING id::text`, fx.orgID, duplicate).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO documents (org_id, title, source_type, raw_text, status, created_by_actor_type, ref_type, ref_id)
		VALUES ($1::uuid,'Northwind agreement','text','Agreement notes','parsed','human','customer',$2::uuid) RETURNING id::text`, fx.orgID, duplicate).Scan(&documentID); err != nil {
		t.Fatal(err)
	}

	input := json.RawMessage(fmt.Sprintf(`{"survivorCustomerId":%q,"duplicateCustomerId":%q}`, survivor, duplicate))
	result := executeCRMWrite(t, fx, mergeCustomersCapabilityID, input, "4bfe97c6-e210-4a99-839f-e7da4b677c20")
	if !result.OK || result.PendingApproval {
		t.Fatalf("merge result=%+v, want direct human success", result)
	}
	var output CustomerMergeOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	if output.SurvivorCustomerID != survivor || output.DuplicateCustomerID != duplicate || len(output.Previous) != 3 {
		t.Fatalf("merge output=%+v, want both principals and their existing merged child", output)
	}
	previous := make(map[string]CustomerMergeSnapshot, len(output.Previous))
	for _, snapshot := range output.Previous {
		previous[snapshot.CustomerID] = snapshot
	}
	if previous[survivor].Notes == nil || *previous[survivor].Notes != "survivor notes" || previous[duplicate].Notes == nil || *previous[duplicate].Notes != "duplicate notes" {
		t.Fatalf("merge snapshot lost notes: %+v", output.Previous)
	}
	var merged struct {
		Email                  *string
		Phone                  *string
		PreferredContactMethod string
		DoNotContact           bool
		ReminderOptOut         bool
		MarketingOptOut        bool
		OwnerUserID            *string
		Tags                   []string
		CreditLimitMinor       *int64
		PaymentTermDays        *int64
		UpdatedByUserID        *string
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT email, phone, preferred_contact_method, do_not_contact, reminder_opt_out, marketing_opt_out,
			owner_user_id::text, tags, credit_limit_minor::bigint, payment_term_days::bigint, updated_by_user_id::text
		FROM customers WHERE org_id = $1::uuid AND id = $2::uuid`, fx.orgID, survivor).
		Scan(&merged.Email, &merged.Phone, &merged.PreferredContactMethod, &merged.DoNotContact,
			&merged.ReminderOptOut, &merged.MarketingOptOut, &merged.OwnerUserID, &merged.Tags,
			&merged.CreditLimitMinor, &merged.PaymentTermDays, &merged.UpdatedByUserID); err != nil {
		t.Fatal(err)
	}
	if merged.Email == nil || *merged.Email != "northwind@example.test" || merged.Phone == nil || *merged.Phone != "+256 772 222 111" || merged.PreferredContactMethod != "email" || !merged.DoNotContact || !merged.ReminderOptOut || !merged.MarketingOptOut || merged.OwnerUserID == nil || *merged.OwnerUserID != fx.userID || merged.CreditLimitMinor == nil || *merged.CreditLimitMinor != 50000 || merged.PaymentTermDays == nil || *merged.PaymentTermDays != 30 || merged.UpdatedByUserID == nil || *merged.UpdatedByUserID != fx.userID {
		t.Fatalf("survivor fields=%+v, want legacy merge field selection and human attribution", merged)
	}
	if !reflect.DeepEqual(merged.Tags, []string{"VIP", "Same", "ΟΣ", " Wholesale "}) {
		t.Fatalf("merged tags=%q, want survivor-first ECMAScript lowercase deduplication", merged.Tags)
	}
	for _, id := range []string{duplicate, child} {
		var mergedInto, updatedBy *string
		var deactivatedAt, mergedAt *time.Time
		if err := fx.owner.QueryRow(fx.ctx, `
			SELECT merged_into_customer_id::text, deactivated_at, merged_at, updated_by_user_id::text
			FROM customers WHERE org_id = $1::uuid AND id = $2::uuid`, fx.orgID, id).
			Scan(&mergedInto, &deactivatedAt, &mergedAt, &updatedBy); err != nil {
			t.Fatal(err)
		}
		if mergedInto == nil || *mergedInto != survivor || deactivatedAt == nil || mergedAt == nil || updatedBy == nil || *updatedBy != fx.userID {
			t.Fatalf("merged child id=%s mergedInto=%v deactivated=%v mergedAt=%v updatedBy=%v", id, mergedInto, deactivatedAt, mergedAt, updatedBy)
		}
	}
	var historyRefs int
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT
			(SELECT count(*) FROM invoices WHERE org_id = $1::uuid AND id = $2::uuid AND customer_id = $3::uuid) +
			(SELECT count(*) FROM quotes WHERE org_id = $1::uuid AND id = $4::uuid AND customer_id = $3::uuid) +
			(SELECT count(*) FROM deals WHERE org_id = $1::uuid AND id = $5::uuid AND customer_id = $3::uuid) +
			(SELECT count(*) FROM tasks WHERE org_id = $1::uuid AND id = $6::uuid AND ref_id = $3::uuid) +
			(SELECT count(*) FROM documents WHERE org_id = $1::uuid AND id = $7::uuid AND ref_id = $3::uuid)`,
		fx.orgID, invoiceID, duplicate, quoteID, dealID, taskID, documentID).Scan(&historyRefs); err != nil {
		t.Fatal(err)
	}
	if historyRefs != 5 {
		t.Fatalf("linked business history references=%d, want five rows still linked to duplicate", historyRefs)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id = $1::uuid AND kind = 'capability.executed' AND capability_id = $2`, fx.orgID, mergeCustomersCapabilityID); got != 1 {
		t.Fatalf("merge audit events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id = $1::uuid AND intent_key = $2`, fx.orgID, fx.orgID+":4bfe97c6-e210-4a99-839f-e7da4b677c20"); got != 1 {
		t.Fatalf("merge receipts=%d, want one", got)
	}
}

func TestGoCustomerMergeRestorePreservesLegacySnapshotSemantics(t *testing.T) {
	fx := newExecutorFixture(t)
	survivor := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{
		Name: "Current survivor name", Email: crmStringPointer("survivor@example.test"),
		PreferredContactMethod: "email", Tags: []string{"survivor"}, Notes: crmStringPointer("survivor original notes"),
	})
	duplicate := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{
		Name: "Current duplicate name", Phone: crmStringPointer("+256 700 111 222"),
		PreferredContactMethod: "phone", Tags: []string{"duplicate"}, Notes: crmStringPointer("duplicate original notes"),
	})
	mergeInput := json.RawMessage(fmt.Sprintf(`{"survivorCustomerId":%q,"duplicateCustomerId":%q}`, survivor, duplicate))
	mergeIntentID := "9b1de39a-1ec1-4c9e-92ef-8e15e5dd9580"
	merged := executeCRMWrite(t, fx, mergeCustomersCapabilityID, mergeInput, mergeIntentID)
	if !merged.OK {
		t.Fatalf("merge result=%+v", merged)
	}
	var mergeOutput CustomerMergeOutput
	if err := json.Unmarshal(merged.Data, &mergeOutput); err != nil {
		t.Fatal(err)
	}
	restoreInput, err := json.Marshal(CustomerMergeSnapshotInput{
		SurvivorCustomerID: mergeOutput.SurvivorCustomerID, DuplicateCustomerID: mergeOutput.DuplicateCustomerID, MergeIntentID: mergeIntentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	restored := executeCRMWrite(t, fx, restoreCustomerMergeCapabilityID, restoreInput, "restore-after-merge")
	if !restored.OK {
		t.Fatalf("restore result=%+v", restored)
	}
	var restoreOutput CustomerMergeOutput
	if err := json.Unmarshal(restored.Data, &restoreOutput); err != nil {
		t.Fatal(err)
	}
	if restoreOutput.SurvivorCustomerID != survivor || restoreOutput.DuplicateCustomerID != duplicate || len(restoreOutput.Previous) != 2 {
		t.Fatalf("restore inverse output=%+v, want pre-restore merged snapshots", restoreOutput)
	}
	var survivorName, duplicateName, survivorNotes, duplicateNotes string
	var duplicateMergedInto *string
	var duplicateDeactivatedAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT name, notes FROM customers WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, survivor).Scan(&survivorName, &survivorNotes); err != nil {
		t.Fatal(err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT name, notes, merged_into_customer_id::text, deactivated_at FROM customers WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, duplicate).Scan(&duplicateName, &duplicateNotes, &duplicateMergedInto, &duplicateDeactivatedAt); err != nil {
		t.Fatal(err)
	}
	if survivorName != "Current survivor name" || duplicateName != "Current duplicate name" || survivorNotes != "survivor original notes" || duplicateNotes != "duplicate original notes" || duplicateMergedInto != nil || duplicateDeactivatedAt != nil {
		t.Fatalf("legacy restore state survivor=(%q,%q) duplicate=(%q,%q,%v,%v)", survivorName, survivorNotes, duplicateName, duplicateNotes, duplicateMergedInto, duplicateDeactivatedAt)
	}

	mergeIntentID = "16ae9aa0-2368-4113-bf65-7087bbdf6103"
	mergedAgain := executeCRMWrite(t, fx, mergeCustomersCapabilityID, mergeInput, mergeIntentID)
	if !mergedAgain.OK {
		t.Fatalf("second merge result=%+v", mergedAgain)
	}
	var secondOutput CustomerMergeOutput
	if err := json.Unmarshal(mergedAgain.Data, &secondOutput); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE customers SET notes='edited after merge' WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, survivor); err != nil {
		t.Fatal(err)
	}
	conflictedRestore, err := json.Marshal(CustomerMergeSnapshotInput{
		SurvivorCustomerID: secondOutput.SurvivorCustomerID, DuplicateCustomerID: secondOutput.DuplicateCustomerID, MergeIntentID: mergeIntentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, conflictErr := fx.executor.Execute(fx.ctx, crmWriteClaims(fx, restoreCustomerMergeCapabilityID, conflictedRestore, "human", "", "3be9487d-5d27-4604-a4dc-f042e302cda7"), restoreCustomerMergeCapabilityID, conflictedRestore)
	if conflictErr == nil || !strings.Contains(conflictErr.Error(), "changed after the merge") {
		t.Fatalf("restore after profile edit error=%v, want conflict refusal", conflictErr)
	}
	var survivorAfterMerge *string
	for _, snapshot := range secondOutput.Merged {
		if snapshot.CustomerID == survivor {
			survivorAfterMerge = snapshot.Notes
		}
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE customers SET notes=$1 WHERE org_id=$2::uuid AND id=$3::uuid`, survivorAfterMerge, fx.orgID, survivor); err != nil {
		t.Fatal(err)
	}
	callerSnapshotNote := "caller supplied restore snapshot"
	forgedPrevious := append([]CustomerMergeSnapshot(nil), secondOutput.Previous...)
	for index := range forgedPrevious {
		if forgedPrevious[index].CustomerID == survivor {
			forgedPrevious[index].Notes = &callerSnapshotNote
		}
		if forgedPrevious[index].CustomerID == duplicate {
			forgedPrevious[index].CustomerID = fx.otherOrgID
		}
	}
	forgedRestore, err := json.Marshal(map[string]any{
		"survivorCustomerId":  secondOutput.SurvivorCustomerID,
		"duplicateCustomerId": secondOutput.DuplicateCustomerID,
		"mergeIntentId":       mergeIntentID,
		"previous":            forgedPrevious,
	})
	if err != nil {
		t.Fatal(err)
	}
	forgedResult := executeCRMWrite(t, fx, restoreCustomerMergeCapabilityID, forgedRestore, "c4c90137-2055-4bfb-9c7e-11b6d28eae83")
	if forgedResult.OK || !strings.Contains(forgedResult.Error, "server controlled") {
		t.Fatalf("forged caller snapshot result=%+v, want rejection", forgedResult)
	}
	wrongIDs, err := json.Marshal(CustomerMergeSnapshotInput{
		SurvivorCustomerID: fx.otherOrgID, DuplicateCustomerID: duplicate, MergeIntentID: mergeIntentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, wrongIDsErr := fx.executor.Execute(fx.ctx, crmWriteClaims(fx, restoreCustomerMergeCapabilityID, wrongIDs, "human", "", "a64c901a-7db5-49f6-a0e7-f6a804e7a6fc"), restoreCustomerMergeCapabilityID, wrongIDs)
	if wrongIDsErr == nil || !strings.Contains(wrongIDsErr.Error(), "does not match") {
		t.Fatalf("forged merge IDs error=%v, want rejection", wrongIDsErr)
	}
	validRestore, err := json.Marshal(CustomerMergeSnapshotInput{
		SurvivorCustomerID: secondOutput.SurvivorCustomerID, DuplicateCustomerID: secondOutput.DuplicateCustomerID, MergeIntentID: mergeIntentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	validResult := executeCRMWrite(t, fx, restoreCustomerMergeCapabilityID, validRestore, "6c18e83a-3862-4ce0-a40c-36af24053be5")
	if !validResult.OK {
		t.Fatalf("server receipt restore result=%+v", validResult)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT notes FROM customers WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, survivor).Scan(&survivorNotes); err != nil {
		t.Fatal(err)
	}
	if survivorNotes != "survivor original notes" {
		t.Fatalf("restored notes=%q, want server-recorded original value", survivorNotes)
	}
}

func TestGoCustomerMergeLocksChildrenBeforeCapturingUndoSnapshot(t *testing.T) {
	fx := newExecutorFixture(t)
	survivor := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{Name: "Survivor", PreferredContactMethod: "email", Tags: []string{}})
	duplicate := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{Name: "Duplicate", PreferredContactMethod: "phone", Tags: []string{}})
	child := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{Name: "Previously merged child", PreferredContactMethod: "other", Tags: []string{}, MergedIntoCustomerID: crmStringPointer(duplicate)})

	lockTx, err := fx.owner.Begin(fx.ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lockTx.Rollback(fx.ctx) })
	var lockPID int32
	if err := lockTx.QueryRow(fx.ctx, `SELECT pg_backend_pid()`).Scan(&lockPID); err != nil {
		t.Fatal(err)
	}
	var lockedChildID string
	if err := lockTx.QueryRow(fx.ctx, `SELECT id::text FROM customers WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE`, fx.orgID, child).Scan(&lockedChildID); err != nil {
		t.Fatal(err)
	}
	if lockedChildID != child {
		t.Fatalf("locked child=%q, want %q", lockedChildID, child)
	}

	mergeIntentID := executorUUID(t)
	mergeInput := json.RawMessage(fmt.Sprintf(`{"survivorCustomerId":%q,"duplicateCustomerId":%q}`, survivor, duplicate))
	claims := crmWriteClaims(fx, mergeCustomersCapabilityID, mergeInput, "human", "", mergeIntentID)
	type mergeResult struct {
		result Result
		err    error
	}
	completed := make(chan mergeResult, 1)
	go func() {
		result, err := fx.executor.Execute(fx.ctx, claims, mergeCustomersCapabilityID, mergeInput)
		completed <- mergeResult{result: result, err: err}
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		var waitingOnChild bool
		if err := fx.owner.QueryRow(fx.ctx, `
			SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity
				WHERE $1::integer = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'
			)`, lockPID).Scan(&waitingOnChild); err != nil {
			t.Fatal(err)
		}
		if waitingOnChild {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("merge did not wait for the locked child row")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := lockTx.Exec(fx.ctx, `UPDATE customers SET notes='edit committed while merge waited' WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, child); err != nil {
		t.Fatal(err)
	}
	if err := lockTx.Commit(fx.ctx); err != nil {
		t.Fatal(err)
	}

	var merged mergeResult
	select {
	case merged = <-completed:
	case <-time.After(5 * time.Second):
		t.Fatal("merge did not finish after the child edit committed")
	}
	if merged.err != nil || !merged.result.OK {
		t.Fatalf("concurrent merge result=%+v err=%v", merged.result, merged.err)
	}
	var mergeOutput CustomerMergeOutput
	if err := json.Unmarshal(merged.result.Data, &mergeOutput); err != nil {
		t.Fatal(err)
	}
	for _, snapshots := range [][]CustomerMergeSnapshot{mergeOutput.Previous, mergeOutput.Merged} {
		found := false
		for _, snapshot := range snapshots {
			if snapshot.CustomerID == child {
				found = snapshot.Notes != nil && *snapshot.Notes == "edit committed while merge waited"
			}
		}
		if !found {
			t.Fatalf("merge snapshots did not preserve the committed child edit: %+v", snapshots)
		}
	}

	restoreInput, err := json.Marshal(CustomerMergeSnapshotInput{
		SurvivorCustomerID: survivor, DuplicateCustomerID: duplicate, MergeIntentID: mergeIntentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result := executeCRMWrite(t, fx, restoreCustomerMergeCapabilityID, restoreInput, executorUUID(t)); !result.OK {
		t.Fatalf("restore after concurrent child edit result=%+v", result)
	}
	var childNotes string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT notes FROM customers WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, child).Scan(&childNotes); err != nil {
		t.Fatal(err)
	}
	if childNotes != "edit committed while merge waited" {
		t.Fatalf("restored child notes=%q, want committed concurrent edit", childNotes)
	}
}

func TestGoCustomerImportsAndInversesMatchLegacy(t *testing.T) {
	fx := newExecutorFixture(t)
	activeDuplicate := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{
		Name: "Phone Match Company", Phone: crmStringPointer("+256 772 123 456"), PreferredContactMethod: "phone",
	})
	deactivatedAt := time.Now().UTC().Add(-time.Hour)
	seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{
		Name: "Inactive historical company", PreferredContactMethod: "other", DeactivatedAt: &deactivatedAt,
	})
	foreignCustomer := seedCustomer(t, fx, fx.otherOrgID, "Foreign retained customer")
	rows := []CustomerImportRow{
		{RowNumber: 2, Name: "Phone match candidate", Phone: crmStringPointer("0772-123-456"), PhoneSet: true},
		{RowNumber: 3, Name: "  Fresh customer  ", Email: crmStringPointer("fresh@example.test"), EmailSet: true, Phone: crmStringPointer("  +256 700 123  "), PhoneSet: true, CreditLimitMinor: crmInt64Pointer(120000), CreditLimitMinorSet: true, PaymentTermDays: crmInt64Pointer(21), PaymentTermDaysSet: true},
		{RowNumber: 4, Name: "Fresh duplicate", Email: crmStringPointer("fresh@example.test"), EmailSet: true},
		{RowNumber: 5, Name: "Phone Match Company", Email: crmStringPointer("forced@example.test"), EmailSet: true, AllowDuplicate: true},
		{RowNumber: 6, Name: "Second accepted-row duplicate", Email: crmStringPointer("forced@example.test"), EmailSet: true},
		{RowNumber: 7, Name: "Inactive historical company"},
	}
	for index := 0; index < 499; index++ {
		rows = append(rows, CustomerImportRow{RowNumber: 8 + index, Name: "Batch customer " + executorUUID(t)})
	}
	input, err := json.Marshal(CustomerImportInput{Rows: rows})
	if err != nil {
		t.Fatal(err)
	}
	result := executeCRMWrite(t, fx, importCustomersCapabilityID, input, "import-batch")
	if !result.OK {
		t.Fatalf("customer import result=%+v", result)
	}
	var imported CustomerImportOutput
	if err := json.Unmarshal(result.Data, &imported); err != nil {
		t.Fatal(err)
	}
	if imported.Imported != 502 || len(imported.CreatedIDs) != 502 || !reflect.DeepEqual(imported.SkippedDuplicateRows, []int{2, 4, 6}) {
		t.Fatalf("import output imported=%d ids=%d skipped=%v, want 502 imports and rows [2 4 6] skipped", imported.Imported, len(imported.CreatedIDs), imported.SkippedDuplicateRows)
	}
	var freshName, freshMethod, freshPhone string
	var freshCredit, freshTerms int64
	var freshUpdatedBy *string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT name, preferred_contact_method, phone, credit_limit_minor::bigint, payment_term_days::bigint, updated_by_user_id::text
		FROM customers WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, imported.CreatedIDs[0]).
		Scan(&freshName, &freshMethod, &freshPhone, &freshCredit, &freshTerms, &freshUpdatedBy); err != nil {
		t.Fatal(err)
	}
	if freshName != "Fresh customer" || freshMethod != "email" || freshPhone != "+256 700 123" || freshCredit != 120000 || freshTerms != 21 || freshUpdatedBy == nil || *freshUpdatedBy != fx.userID {
		t.Fatalf("fresh imported row name=%q method=%q phone=%q credit=%d terms=%d updatedBy=%v", freshName, freshMethod, freshPhone, freshCredit, freshTerms, freshUpdatedBy)
	}
	var noEmailMethod string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT preferred_contact_method FROM customers WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, imported.CreatedIDs[2]).Scan(&noEmailMethod); err != nil {
		t.Fatal(err)
	}
	if noEmailMethod != "phone" {
		t.Fatalf("import without email preferredContactMethod=%q, want phone", noEmailMethod)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id=$1::uuid AND id=ANY($2::uuid[])`, fx.orgID, imported.CreatedIDs); got != 502 {
		t.Fatalf("inserted import batch rows=%d, want 502", got)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id=$1::uuid AND id=$2::uuid`, fx.otherOrgID, foreignCustomer); got != 1 {
		t.Fatalf("foreign customer changed by import flow, count=%d", got)
	}
	var invoiceID string
	if err := fx.owner.QueryRow(fx.ctx, `
		INSERT INTO invoices (org_id, customer_id, number, status, subtotal_minor, tax_minor, total_minor)
		VALUES ($1::uuid,$2::uuid,70002,'sent',1000,0,1000) RETURNING id::text`, fx.orgID, imported.CreatedIDs[0]).Scan(&invoiceID); err != nil {
		t.Fatal(err)
	}
	undoIDs := append(append([]string(nil), imported.CreatedIDs...), imported.CreatedIDs[0], foreignCustomer)
	undoInput, err := json.Marshal(CustomerIDsInput{CustomerIDs: undoIDs})
	if err != nil {
		t.Fatal(err)
	}
	undoneResult := executeCRMWrite(t, fx, undoCustomerImportCapabilityID, undoInput, "undo-import")
	if !undoneResult.OK {
		t.Fatalf("undo import result=%+v", undoneResult)
	}
	var undone CustomerUndoImportOutput
	if err := json.Unmarshal(undoneResult.Data, &undone); err != nil {
		t.Fatal(err)
	}
	if undone.Deactivated != 502 || len(undone.CustomerIDs) != 502 || !sameStringSet(undone.CustomerIDs, imported.CreatedIDs) {
		t.Fatalf("undo output deactivated=%d ids=%d, want each active same-org row once", undone.Deactivated, len(undone.CustomerIDs))
	}
	var stillLinkedCustomer string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT customer_id::text FROM invoices WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, invoiceID).Scan(&stillLinkedCustomer); err != nil {
		t.Fatal(err)
	}
	if stillLinkedCustomer != imported.CreatedIDs[0] {
		t.Fatalf("undo import rewrote linked invoice customer to %q", stillLinkedCustomer)
	}
	restoreIDs := append(append([]string(nil), undone.CustomerIDs...), undone.CustomerIDs[0], foreignCustomer)
	restoreInput, err := json.Marshal(CustomerIDsInput{CustomerIDs: restoreIDs})
	if err != nil {
		t.Fatal(err)
	}
	restoredResult := executeCRMWrite(t, fx, restoreImportedCustomersCapabilityID, restoreInput, "restore-import")
	if !restoredResult.OK {
		t.Fatalf("restore imported customers result=%+v", restoredResult)
	}
	var restored CustomerRestoreImportOutput
	if err := json.Unmarshal(restoredResult.Data, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Restored != 502 || !sameStringSet(restored.CustomerIDs, imported.CreatedIDs) {
		t.Fatalf("restore output restored=%d ids=%d, want each inactive same-org row once", restored.Restored, len(restored.CustomerIDs))
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id=$1::uuid AND id=ANY($2::uuid[]) AND deactivated_at IS NULL`, fx.orgID, imported.CreatedIDs); got != 502 {
		t.Fatalf("restored imported active rows=%d, want 502", got)
	}
	for _, capabilityID := range []string{importCustomersCapabilityID, undoCustomerImportCapabilityID, restoreImportedCustomersCapabilityID} {
		if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, capabilityID); got != 1 {
			t.Fatalf("%s audit events=%d, want one", capabilityID, got)
		}
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key IN ($2,$3,$4)`, fx.orgID, fx.orgID+":import-batch", fx.orgID+":undo-import", fx.orgID+":restore-import"); got != 3 {
		t.Fatalf("import inverse receipts=%d, want three", got)
	}
	var activeDuplicateAt *time.Time
	if err := fx.owner.QueryRow(fx.ctx, `SELECT deactivated_at FROM customers WHERE org_id=$1::uuid AND id=$2::uuid`, fx.orgID, activeDuplicate).Scan(&activeDuplicateAt); err != nil {
		t.Fatal(err)
	}
	if activeDuplicateAt != nil {
		t.Fatalf("existing active duplicate was changed at %s", activeDuplicateAt)
	}
}

func TestGoCustomerMergeAndImportEnforceScopeApprovalAndAudit(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	fx.addPolicy("crm.*", "read", nil)
	survivor := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{Name: "Scope survivor", PreferredContactMethod: "email", Tags: []string{}})
	foreign := seedMergeCustomer(t, fx, fx.otherOrgID, mergeCustomerSeed{Name: "Foreign duplicate", PreferredContactMethod: "email", Tags: []string{}})
	localDuplicate := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{Name: "Scope duplicate", PreferredContactMethod: "phone", Tags: []string{}})
	mergeInput := json.RawMessage(fmt.Sprintf(`{"survivorCustomerId":%q,"duplicateCustomerId":%q}`, survivor, localDuplicate))
	deniedClaims := crmWriteClaims(fx, mergeCustomersCapabilityID, mergeInput, "human", "", "")
	deniedClaims.Permissions = []string{"crm.read"}
	denied, err := fx.executor.Execute(fx.ctx, deniedClaims, mergeCustomersCapabilityID, mergeInput)
	if err != nil || denied.OK || denied.Error != "forbidden: missing permission: crm.write" {
		t.Fatalf("merge permission result=%+v err=%v, want crm.write refusal", denied, err)
	}
	foreignMerge := json.RawMessage(fmt.Sprintf(`{"survivorCustomerId":%q,"duplicateCustomerId":%q}`, survivor, foreign))
	if _, err := fx.executor.Execute(fx.ctx, crmWriteClaims(fx, mergeCustomersCapabilityID, foreignMerge, "human", "", ""), mergeCustomersCapabilityID, foreignMerge); err == nil || !strings.Contains(err.Error(), "both customers must belong") {
		t.Fatalf("cross-org merge error=%v, want organization-scoped row refusal", err)
	}
	nonmember := crmWriteClaims(fx, mergeCustomersCapabilityID, mergeInput, "human", "", "")
	nonmember.OrganizationID = fx.otherOrgID
	if _, err := fx.executor.Execute(fx.ctx, nonmember, mergeCustomersCapabilityID, mergeInput); !errors.Is(err, ErrNotMember) {
		t.Fatalf("nonmember merge error=%v, want ErrNotMember", err)
	}
	importInput := json.RawMessage(`{"rows":[{"rowNumber":1,"name":"Scope denied import","allowDuplicate":false}]}`)
	deniedImportClaims := crmWriteClaims(fx, importCustomersCapabilityID, importInput, "human", "", "")
	deniedImportClaims.Permissions = []string{"crm.read"}
	deniedImport, err := fx.executor.Execute(fx.ctx, deniedImportClaims, importCustomersCapabilityID, importInput)
	if err != nil || deniedImport.OK || deniedImport.Error != "forbidden: missing permission: crm.write" {
		t.Fatalf("import permission result=%+v err=%v, want crm.write refusal", deniedImport, err)
	}
	nonmemberImport := crmWriteClaims(fx, importCustomersCapabilityID, importInput, "human", "", "")
	nonmemberImport.OrganizationID = fx.otherOrgID
	if _, err := fx.executor.Execute(fx.ctx, nonmemberImport, importCustomersCapabilityID, importInput); !errors.Is(err, ErrNotMember) {
		t.Fatalf("nonmember import error=%v, want ErrNotMember", err)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id=$1::uuid AND name='Scope denied import'`, fx.orgID); got != 0 {
		t.Fatalf("denied import created %d rows", got)
	}

	functionName := "go_crm_merge_import_fail_ledger_" + strings.ReplaceAll(fx.orgID, "-", "")
	triggerName := functionName + "_trigger"
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE FUNCTION public.%s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'fixture CRM merge/import audit failure'; END
		$$`, functionName)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON ledger_events`, triggerName)); err != nil {
			t.Errorf("drop CRM fixture trigger: %v", err)
		}
		if _, err := fx.owner.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS public.%s()`, functionName)); err != nil {
			t.Errorf("drop CRM fixture function: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`
		CREATE TRIGGER %s BEFORE INSERT ON ledger_events FOR EACH ROW
		WHEN (NEW.org_id = '%s'::uuid AND NEW.kind = 'capability.executed' AND NEW.capability_id IN ('%s','%s'))
		EXECUTE FUNCTION public.%s()`, triggerName, fx.orgID, mergeCustomersCapabilityID, importCustomersCapabilityID, functionName)); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.executor.Execute(fx.ctx, crmWriteClaims(fx, mergeCustomersCapabilityID, mergeInput, "human", "", "be81198c-6a82-48b8-ae63-a3a5eb588b3d"), mergeCustomersCapabilityID, mergeInput); err == nil {
		t.Fatal("merge succeeded despite its audit append failure")
	}
	if _, err := fx.executor.Execute(fx.ctx, crmWriteClaims(fx, importCustomersCapabilityID, importInput, "human", "", "rollback-import"), importCustomersCapabilityID, importInput); err == nil {
		t.Fatal("import succeeded despite its audit append failure")
	}
	var mergeState int
	if err := fx.owner.QueryRow(fx.ctx, `SELECT count(*) FROM customers WHERE org_id=$1::uuid AND id=ANY($2::uuid[]) AND (merged_into_customer_id IS NOT NULL OR deactivated_at IS NOT NULL)`, fx.orgID, []string{survivor, localDuplicate}).Scan(&mergeState); err != nil {
		t.Fatal(err)
	}
	if mergeState != 0 {
		t.Fatalf("failed merge left %d changed rows", mergeState)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE org_id=$1::uuid AND name='Scope denied import'`, fx.orgID); got != 0 {
		t.Fatalf("failed audited import left %d customer rows", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid`, fx.orgID); got != 0 {
		t.Fatalf("failed CRM actions left %d receipts", got)
	}
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON ledger_events`, triggerName)); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, fmt.Sprintf(`DROP FUNCTION IF EXISTS public.%s()`, functionName)); err != nil {
		t.Fatal(err)
	}

	approvedSurvivor := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{Name: "Approved survivor", PreferredContactMethod: "email", Tags: []string{}})
	approvedDuplicate := seedMergeCustomer(t, fx, fx.orgID, mergeCustomerSeed{Name: "Approved duplicate", PreferredContactMethod: "phone", Tags: []string{}})
	approvedMergeInput := json.RawMessage(fmt.Sprintf(`{"survivorCustomerId":%q,"duplicateCustomerId":%q}`, approvedSurvivor, approvedDuplicate))
	approvedMergeIntentID := "88f268d6-a885-4216-8cdf-c0b65e15d0f2"
	mergeResult := executeCRMWriteWithActorApproval(t, fx, mergeCustomersCapabilityID, approvedMergeInput, approvedMergeIntentID)
	var mergeOutput CustomerMergeOutput
	if err := json.Unmarshal(mergeResult.Data, &mergeOutput); err != nil {
		t.Fatal(err)
	}
	restoreInput, err := json.Marshal(CustomerMergeSnapshotInput{SurvivorCustomerID: mergeOutput.SurvivorCustomerID, DuplicateCustomerID: mergeOutput.DuplicateCustomerID, MergeIntentID: approvedMergeIntentID})
	if err != nil {
		t.Fatal(err)
	}
	restoredMergeResult := executeCRMWriteWithActorApproval(t, fx, restoreCustomerMergeCapabilityID, restoreInput)
	if !restoredMergeResult.OK {
		t.Fatalf("approved merge restore result=%+v", restoredMergeResult)
	}

	importApprovedInput := json.RawMessage(`{"rows":[{"rowNumber":1,"name":"Approved import customer","allowDuplicate":false}]}`)
	importResult := executeCRMWriteWithActorApproval(t, fx, importCustomersCapabilityID, importApprovedInput)
	var importOutput CustomerImportOutput
	if err := json.Unmarshal(importResult.Data, &importOutput); err != nil {
		t.Fatal(err)
	}
	idsInput, err := json.Marshal(CustomerIDsInput{CustomerIDs: importOutput.CreatedIDs})
	if err != nil {
		t.Fatal(err)
	}
	undoResult := executeCRMWriteWithActorApproval(t, fx, undoCustomerImportCapabilityID, idsInput)
	var undoOutput CustomerUndoImportOutput
	if err := json.Unmarshal(undoResult.Data, &undoOutput); err != nil {
		t.Fatal(err)
	}
	restoreIDsInput, err := json.Marshal(CustomerIDsInput{CustomerIDs: undoOutput.CustomerIDs})
	if err != nil {
		t.Fatal(err)
	}
	restoreResult := executeCRMWriteWithActorApproval(t, fx, restoreImportedCustomersCapabilityID, restoreIDsInput)
	if !restoreResult.OK {
		t.Fatalf("approved imported-customer restore result=%+v", restoreResult)
	}
}

func TestParseCustomerImportInputMatchesLegacyNormalization(t *testing.T) {
	input, err := ParseCustomerImportInput(json.RawMessage(`{"rows":[{"rowNumber":3,"name":"  Imported 😀  ","email":null,"phone":"  +256 700  ","creditLimitMinor":null,"extra":"stripped"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(input.Rows) != 1 {
		t.Fatalf("parsed rows=%d, want one", len(input.Rows))
	}
	row := input.Rows[0]
	if row.RowNumber != 3 || row.Name != "Imported 😀" || !row.EmailSet || row.Email != nil || !row.PhoneSet || row.Phone == nil || *row.Phone != "+256 700" || row.CreditLimitMinor != nil || row.AllowDuplicate || !row.CreditLimitMinorSet {
		t.Fatalf("normalized import row=%+v, want trimmed name/phone, explicit null and default false", row)
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var normalized map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		t.Fatal(err)
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(normalized["rows"], &rows); err != nil || len(rows) != 1 {
		t.Fatalf("normalized rows=%s err=%v", normalized["rows"], err)
	}
	if string(rows[0]["email"]) != "null" || string(rows[0]["creditLimitMinor"]) != "null" || string(rows[0]["allowDuplicate"]) != "false" {
		t.Fatalf("normalized optional/default fields email=%s creditLimitMinor=%s allowDuplicate=%s", rows[0]["email"], rows[0]["creditLimitMinor"], rows[0]["allowDuplicate"])
	}
	if _, exists := rows[0]["extra"]; exists {
		t.Fatal("unknown import field survived legacy-style object parsing")
	}
}

func executeCRMWriteWithActorApproval(t *testing.T, fx *executorFixture, capabilityID string, input json.RawMessage, intents ...string) Result {
	t.Helper()
	intentID := ""
	if len(intents) > 0 {
		intentID = intents[0]
	}
	claims := crmWriteClaims(fx, capabilityID, input, "agent", fx.agentSession, intentID)
	pending, err := fx.executor.Execute(fx.ctx, claims, capabilityID, input)
	if err != nil || pending.OK || !pending.PendingApproval {
		t.Fatalf("agent %s result=%+v err=%v, want pending approval", capabilityID, pending, err)
	}
	var approvalID string
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT id::text FROM approvals WHERE org_id=$1::uuid AND capability_id=$2 AND status='pending' ORDER BY created_at DESC LIMIT 1`, fx.orgID, capabilityID).Scan(&approvalID); err != nil {
		t.Fatal(err)
	}
	decider := NewApprovalDecider(fx.runtime, fx.executor)
	approved, err := decider.Decide(fx.ctx, crmWriteClaims(fx, capabilityID, input, "human", "", intentID), ApprovalDecisionInput{ApprovalID: approvalID, Decision: "approve"})
	if err != nil || !approved.OK || approved.Status != "executed" || approved.Result == nil || !approved.Result.OK || approved.Result.PendingApproval {
		t.Fatalf("approval %s result=%+v err=%v, want one completed execution", capabilityID, approved, err)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND capability_id=$2`, fx.orgID, capabilityID); got != 1 {
		t.Fatalf("%s approvals=%d, want exactly one", capabilityID, got)
	}
	if got := fx.count(`SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND capability_id=$2 AND status='pending'`, fx.orgID, capabilityID); got != 0 {
		t.Fatalf("%s pending approvals=%d, want none after execution", capabilityID, got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, capabilityID); got != 1 {
		t.Fatalf("%s human execution audit events=%d, want one", capabilityID, got)
	}
	return *approved.Result
}

func crmStringPointer(value string) *string { return &value }

func crmInt64Pointer(value int64) *int64 { return &value }

func sameStringSet(left, right []string) bool {
	leftCopy := append([]string(nil), left...)
	rightCopy := append([]string(nil), right...)
	sort.Strings(leftCopy)
	sort.Strings(rightCopy)
	return reflect.DeepEqual(leftCopy, rightCopy)
}
