package capability

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestGoCRMDealsCapabilityContractsDispatchAndOutputs(t *testing.T) {
	ownerID := "11111111-1111-4111-8111-111111111111"
	dealID := "22222222-2222-4222-8222-222222222222"
	cases := []struct {
		id         string
		raw        string
		permission string
		want       any
		output     any
		outputJSON string
	}{
		{
			id: createDealCapabilityID, raw: `{"title":"New opportunity","valueMinor":0,"ownerUserId":"` + ownerID + `","unknown":true}`,
			permission: "crm.write", want: CreateDealInput{Title: "New opportunity", ValueMinor: 0, OwnerUserID: &ownerID},
			output: CreateDealOutput{DealID: dealID}, outputJSON: `{"dealId":"` + dealID + `"}`,
		},
		{
			id: moveDealStageCapabilityID, raw: `{"dealId":"` + dealID + `","stage":"lost","lostReason":"  budget paused  "}`,
			permission: "crm.write", want: MoveDealStageInput{DealID: dealID, Stage: "lost", LostReason: crmStringPointer("budget paused")},
			output: MoveDealStageOutput{Moved: true, Stage: "lost"}, outputJSON: `{"moved":true,"stage":"lost"}`,
		},
		{
			id: convertLeadCapabilityID, raw: `{"dealId":"` + dealID + `","customerId":"` + ownerID + `"}`,
			permission: "crm.write", want: ConvertLeadInput{DealID: dealID, CustomerID: &ownerID},
			output:     ConvertLeadOutput{DealID: dealID, CustomerID: ownerID, ConversionIntentID: "conversion-intent", Stage: "qualified"},
			outputJSON: `{"dealId":"` + dealID + `","customerId":"` + ownerID + `","conversionIntentId":"conversion-intent","stage":"qualified"}`,
		},
	}
	undoInput, err := ParseUndoLeadConversionInput(json.RawMessage(`{"conversionIntentId":"conversion-intent"}`))
	if err != nil || undoInput.ConversionIntentID != "conversion-intent" {
		t.Fatalf("ParseUndoLeadConversionInput() = %+v, %v", undoInput, err)
	}
	if spec := capabilitySpecs[convertLeadCapabilityID]; spec.inverseCapabilityID != undoLeadConversionCapabilityID || spec.inverseInputSource != "output" || len(spec.inverseFields) != 1 || spec.inverseFields[0] != "conversionIntentId" {
		t.Fatalf("convertLead inverse declaration = %+v", spec)
	}
	if spec := capabilitySpecs[undoLeadConversionCapabilityID]; spec.risk != "destructive" || spec.inverseCapabilityID != reapplyLeadConversionCapabilityID || spec.inverseInputSource != "output" || len(spec.inverseFields) != 1 || spec.inverseFields[0] != "undoIntentId" {
		t.Fatalf("undoLeadConversion inverse declaration = %+v", spec)
	}
	if spec := capabilitySpecs[reapplyLeadConversionCapabilityID]; spec.inverseCapabilityID != undoLeadConversionCapabilityID || spec.inverseInputSource != "output" || len(spec.inverseFields) != 1 || spec.inverseFields[0] != "conversionIntentId" {
		t.Fatalf("reapplyLeadConversion inverse declaration = %+v", spec)
	}
	for _, test := range cases {
		t.Run(test.id, func(t *testing.T) {
			spec, exists := capabilitySpecs[test.id]
			if !supportedCapability(test.id) || !exists || spec.module != "crm" || spec.permission != test.permission || spec.risk != "write" {
				t.Fatalf("capability %q has spec %+v, supported=%t", test.id, spec, supportedCapability(test.id))
			}
			parsed, err := parseCRMDealInput(test.id, json.RawMessage(test.raw))
			if err != nil {
				t.Fatal(err)
			}
			got, err := marshalJS(parsed)
			if err != nil {
				t.Fatal(err)
			}
			want, err := marshalJS(test.want)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != string(want) {
				t.Fatalf("parseCRMDealInput() = %s, want %s", got, want)
			}
			hash, err := canonicalInputHash(parsed)
			if err != nil || hash == "" {
				t.Fatalf("canonicalInputHash() = %q, %v", hash, err)
			}
			encodedOutput, err := marshalJS(test.output)
			if err != nil {
				t.Fatal(err)
			}
			if string(encodedOutput) != test.outputJSON {
				t.Fatalf("capability output = %s, want %s", encodedOutput, test.outputJSON)
			}
		})
	}
	if permission, ok := permissionForCapability(createDealCapabilityID); !ok || permission != "crm.write" {
		t.Fatalf("approval permission for createDeal = %q, %t", permission, ok)
	}
	if permission, ok := permissionForCapability(moveDealStageCapabilityID); !ok || permission != "crm.write" {
		t.Fatalf("approval permission for moveDealStage = %q, %t", permission, ok)
	}
	if permission, ok := permissionForCapability(convertLeadCapabilityID); !ok || permission != "crm.write" {
		t.Fatalf("approval permission for convertLead = %q, %t", permission, ok)
	}
	if permission, ok := permissionForCapability(undoLeadConversionCapabilityID); !ok || permission != "crm.write" {
		t.Fatalf("approval permission for undoLeadConversion = %q, %t", permission, ok)
	}
	if permission, ok := permissionForCapability(reapplyLeadConversionCapabilityID); !ok || permission != "crm.write" {
		t.Fatalf("approval permission for reapplyLeadConversion = %q, %t", permission, ok)
	}
}

func TestGoCRMConvertLeadParserRequiresExclusiveInputModes(t *testing.T) {
	dealID := "11111111-1111-4111-8111-111111111111"
	customerID := "22222222-2222-4222-8222-222222222222"
	for _, raw := range []string{
		`{"dealId":"` + dealID + `","customerId":"` + customerID + `"}`,
		`{"dealId":"` + dealID + `","createCustomer":true,"customerName":"New customer"}`,
	} {
		if _, err := ParseConvertLeadInput(json.RawMessage(raw)); err != nil {
			t.Errorf("valid conversion mode was rejected: %s: %v", raw, err)
		}
	}
	for _, raw := range []string{
		`{"dealId":"` + dealID + `","customerId":"` + customerID + `","createCustomer":true,"customerName":"Mixed modes"}`,
		`{"dealId":"` + dealID + `","createCustomer":false,"customerName":"False create flag"}`,
		`{"dealId":"` + dealID + `","createCustomer":true}`,
		`{"dealId":"` + dealID + `","customerName":"Missing create flag"}`,
	} {
		if _, err := ParseConvertLeadInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ambiguous conversion mode was accepted: %s", raw)
		}
	}
}

func TestGoCRMConversionManifestMatchesGoContracts(t *testing.T) {
	manifestBytes, err := os.ReadFile("../../../../docs/migration/capabilities.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Capabilities []struct {
			ID          string          `json:"id"`
			Risk        string          `json:"risk"`
			Inverse     string          `json:"inverseCapabilityId"`
			InputSchema json.RawMessage `json:"inputSchema"`
			Output      struct {
				Required []string `json:"required"`
			} `json:"outputSchema"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	entries := make(map[string]struct {
		Risk        string
		Inverse     string
		InputSchema json.RawMessage
		Output      []string
	}, len(manifest.Capabilities))
	for _, entry := range manifest.Capabilities {
		entries[entry.ID] = struct {
			Risk        string
			Inverse     string
			InputSchema json.RawMessage
			Output      []string
		}{entry.Risk, entry.Inverse, entry.InputSchema, entry.Output.Required}
	}
	for id, expected := range map[string]struct {
		risk, inverse string
	}{
		convertLeadCapabilityID:           {"write", undoLeadConversionCapabilityID},
		undoLeadConversionCapabilityID:    {"destructive", reapplyLeadConversionCapabilityID},
		reapplyLeadConversionCapabilityID: {"write", undoLeadConversionCapabilityID},
	} {
		entry, ok := entries[id]
		if !ok || entry.Risk != expected.risk || entry.Inverse != expected.inverse {
			t.Errorf("manifest contract for %s = %+v (exists=%t), want risk %q inverse %q", id, entry, ok, expected.risk, expected.inverse)
		}
	}
	var convertInput struct {
		OneOf []struct {
			Required []string `json:"required"`
		} `json:"oneOf"`
	}
	if err := json.Unmarshal(entries[convertLeadCapabilityID].InputSchema, &convertInput); err != nil {
		t.Fatal(err)
	}
	if len(convertInput.OneOf) != 2 || strings.Join(convertInput.OneOf[0].Required, ",") != "dealId,customerId" || strings.Join(convertInput.OneOf[1].Required, ",") != "dealId,createCustomer,customerName" {
		t.Fatalf("convertLead manifest input modes=%+v, want exclusive attach/create modes", convertInput.OneOf)
	}
	if got := strings.Join(entries[convertLeadCapabilityID].Output, ","); got != "dealId,customerId,conversionIntentId,stage" {
		t.Fatalf("convertLead manifest output fields=%s", got)
	}
}

func TestGoCRMDealsParsersMatchCRMContracts(t *testing.T) {
	validID := "11111111-1111-4111-8111-111111111111"
	input, err := ParseCreateDealInput(json.RawMessage(`{"title":"  First deal  ","customerId":"` + validID + `","source":"` + strings.Repeat("s", 200) + `","note":"` + strings.Repeat("n", 2000) + `","unknown":true}`))
	if err != nil || input.Title != "  First deal  " || input.ValueMinor != 0 || input.CustomerID == nil || *input.CustomerID != validID || len(*input.Source) != 200 || len(*input.Note) != 2000 {
		t.Fatalf("create deal input=%+v err=%v", input, err)
	}
	if _, err := ParseCreateDealInput(json.RawMessage(`{"title":""}`)); err == nil {
		t.Fatal("empty title was accepted")
	}
	if input, err := ParseCreateDealInput(json.RawMessage(`{"title":"` + strings.Repeat("d", 120) + `"}`)); err != nil || len(input.Title) != 120 {
		t.Fatalf("120-character title input=%+v err=%v, want accepted", input, err)
	}
	for _, raw := range []string{
		`{"title":"` + strings.Repeat("d", 121) + `"}`,
		`{"title":"Deal","valueMinor":-1}`,
		`{"title":"Deal","valueMinor":1.5}`,
		`{"title":"Deal","valueMinor":9007199254740992}`,
		`{"title":"Deal","source":"` + strings.Repeat("s", 201) + `"}`,
		`{"title":"Deal","note":"` + strings.Repeat("n", 2001) + `"}`,
		`{"title":"Deal","ownerUserId":"not-a-uuid"}`,
		`{"title":"Deal","ownerUserId":"11111111-1111-0111-8111-111111111111"}`,
		`{"title":"Deal","ownerUserId":"11111111-1111-4111-7111-111111111111"}`,
		`{"title":"Deal","customerId":null}`,
		`{"title":"Deal","customerId":"not-a-uuid"}`,
	} {
		if _, err := ParseCreateDealInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseCreateDealInput accepted %s", raw)
		}
	}

	for _, raw := range []string{
		`{"dealId":null,"stage":"lead"}`,
		`{"dealId":"not-a-uuid","stage":"lead"}`,
		`{"dealId":"` + validID + `","stage":null}`,
		`{"dealId":"` + validID + `","stage":"unknown"}`,
		`{"dealId":"` + validID + `","stage":"lost"}`,
		`{"dealId":"` + validID + `","stage":"proposal","lostReason":"  "}`,
		`{"dealId":"` + validID + `","stage":"proposal","lostReason":"ab"}`,
		`{"dealId":"` + validID + `","stage":"lost","lostReason":"` + strings.Repeat("r", 501) + `"}`,
	} {
		if _, err := ParseMoveDealStageInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseMoveDealStageInput accepted %s", raw)
		}
	}
	move, err := ParseMoveDealStageInput(json.RawMessage(`{"dealId":"` + validID + `","stage":"proposal","lostReason":"  closed  "}`))
	if err != nil || move.LostReason == nil || *move.LostReason != "closed" {
		t.Fatalf("move deal input=%+v err=%v", move, err)
	}

	if _, err := ParseConvertLeadInput(json.RawMessage(`{"dealId":"` + validID + `","createCustomer":null}`)); err == nil {
		t.Fatal("null createCustomer was accepted")
	}
	if _, err := ParseConvertLeadInput(json.RawMessage(`{"dealId":null}`)); err == nil {
		t.Fatal("null dealId was accepted")
	}
	if _, err := ParseConvertLeadInput(json.RawMessage(`{"dealId":"` + validID + `","customerName":""}`)); err == nil {
		t.Fatal("empty customerName was accepted")
	}
	converted, err := ParseConvertLeadInput(json.RawMessage(`{"dealId":"` + validID + `","createCustomer":true,"customerName":"  Buyer  ","unknown":true}`))
	if err != nil || converted.CreateCustomer == nil || !*converted.CreateCustomer || converted.CustomerName == nil || *converted.CustomerName != "Buyer" {
		t.Fatalf("convert lead input=%+v err=%v", converted, err)
	}
	for _, raw := range []string{
		`{"dealId":"` + validID + `","customerId":"` + validID + `","createCustomer":true,"customerName":"Buyer"}`,
		`{"dealId":"` + validID + `","createCustomer":false,"customerName":"Buyer"}`,
		`{"dealId":"` + validID + `","createCustomer":true}`,
		`{"dealId":"` + validID + `","customerId":"not-a-uuid"}`,
		`{"dealId":"not-a-uuid","customerId":"` + validID + `"}`,
	} {
		if _, err := ParseConvertLeadInput(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseConvertLeadInput accepted conflicting or incomplete mode %s", raw)
		}
	}
}

func TestGoCRMListDealsCapabilityIsReadScopedTenantSafeAndLimited(t *testing.T) {
	if err := capabilitySpecForCRMListDeals(t); err != nil {
		t.Fatal(err)
	}
	fx := newExecutorFixture(t)
	input := json.RawMessage(`{}`)
	claims := fx.claims(input, "human", "", "")
	claims.CapabilityID = listDealsCapabilityID
	claims.Permissions = []string{"crm.read"}
	denied, err := fx.executor.Execute(fx.ctx, claims, listDealsCapabilityID, input)
	if err != nil || denied.OK || !strings.Contains(denied.Error, "forbidden: missing permission: crm.read") {
		t.Fatalf("listDeals without crm.read result=%+v err=%v", denied, err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO role_permissions (role_id, permission_key, org_id) VALUES ($1::uuid, 'crm.read', $2::uuid)`, fx.roleID, fx.orgID); err != nil {
		t.Fatal(err)
	}
	customerID := seedCRMDealCustomer(t, fx, fx.orgID, "Deal list customer")
	localDealID := seedCRMDeal(t, fx, fx.orgID, "Deal list with customer", "qualified", &customerID)
	nullCustomerDealID := seedCRMDeal(t, fx, fx.orgID, "Deal list without customer", "lead", nil)
	nonMemberOwnerID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Nonmember owner')`, nonMemberOwnerID, "deal-nonmember-"+nonMemberOwnerID[:8]+"@fixture.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), `UPDATE deals SET owner_user_id=NULL WHERE owner_user_id=$1::uuid`, nonMemberOwnerID); err != nil {
			t.Errorf("clear nonmember deal owner fixture: %v", err)
		}
		if _, err := fx.owner.Exec(context.Background(), `DELETE FROM users WHERE id=$1::uuid`, nonMemberOwnerID); err != nil {
			t.Errorf("delete nonmember deal owner fixture: %v", err)
		}
	})
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE deals SET owner_user_id=$2::uuid WHERE id=$1::uuid`, nullCustomerDealID, nonMemberOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE deals SET note='follow-up', value_minor=12345 WHERE id=$1::uuid`, localDealID); err != nil {
		t.Fatal(err)
	}
	dealOwnerID := fx.userID
	if _, err := fx.owner.Exec(fx.ctx, `UPDATE deals SET source='website', owner_user_id=$2::uuid WHERE id=$1::uuid`, localDealID, dealOwnerID); err != nil {
		t.Fatal(err)
	}
	seedCRMDeal(t, fx, fx.otherOrgID, "Other organization deal", "won", nil)
	result, err := fx.executor.Execute(fx.ctx, claims, listDealsCapabilityID, input)
	if err != nil || !result.OK {
		t.Fatalf("listDeals result=%+v err=%v", result, err)
	}
	var output ListDealsOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		t.Fatal(err)
	}
	var localWithCustomer, localWithoutCustomer bool
	for _, deal := range output.Deals {
		if deal.ID == localDealID {
			localWithCustomer = deal.Title == "Deal list with customer" && deal.Stage == "qualified" && deal.ValueMinor == 12345 &&
				deal.Note != nil && *deal.Note == "follow-up" && deal.CustomerID != nil && *deal.CustomerID == customerID &&
				deal.Source != nil && *deal.Source == "website" && deal.OwnerUserID != nil && *deal.OwnerUserID == dealOwnerID &&
				deal.OwnerName != nil && *deal.OwnerName == "Go capability user" &&
				deal.CustomerName != nil && *deal.CustomerName == "Deal list customer" && deal.CreatedAt != "" && deal.UpdatedAt != ""
		}
		if deal.ID == nullCustomerDealID {
			localWithoutCustomer = deal.CustomerID == nil && deal.CustomerName == nil && deal.Note == nil && deal.Source == nil && deal.OwnerUserID == nil && deal.OwnerName == nil
		}
	}
	if !localWithCustomer || !localWithoutCustomer {
		t.Fatalf("listDeals did not preserve joined and nullable fields: withCustomer=%t withoutCustomer=%t", localWithCustomer, localWithoutCustomer)
	}
	for i := 0; i < 205; i++ {
		seedCRMDeal(t, fx, fx.orgID, fmt.Sprintf("Limited deal %03d", i), "lead", nil)
	}
	limited, err := fx.executor.Execute(fx.ctx, claims, listDealsCapabilityID, input)
	if err != nil || !limited.OK {
		t.Fatalf("listDeals limit result=%+v err=%v", limited, err)
	}
	if err := json.Unmarshal(limited.Data, &output); err != nil {
		t.Fatal(err)
	}
	if len(output.Deals) != 200 {
		t.Fatalf("listDeals returned %d rows, want the legacy maximum of 200", len(output.Deals))
	}
	for _, deal := range output.Deals {
		if deal.Title == "Other organization deal" {
			t.Fatal("listDeals leaked a deal from another organization")
		}
	}
}

func capabilitySpecForCRMListDeals(t *testing.T) error {
	t.Helper()
	spec, exists := capabilitySpecs[listDealsCapabilityID]
	if !supportedCapability(listDealsCapabilityID) || !exists || spec.module != "crm" || spec.permission != "crm.read" || spec.risk != "read" {
		return fmt.Errorf("crm.listDeals spec=%+v supported=%t, want crm.read read capability", spec, supportedCapability(listDealsCapabilityID))
	}
	if _, err := ParseListDealsInput(json.RawMessage(`{}`)); err != nil {
		return fmt.Errorf("parse crm.listDeals input: %w", err)
	}
	if _, err := ParseListDealsInput(json.RawMessage(`[]`)); err == nil {
		return fmt.Errorf("crm.listDeals accepted a non-object input")
	}
	return nil
}

func TestGoCRMDealsEnforceTenancyConversionAuditsAndReceiptReplay(t *testing.T) {
	fx := newExecutorFixture(t)
	localCustomerID := seedCRMDealCustomer(t, fx, fx.orgID, "Local buyer")
	foreignCustomerID := seedCRMDealCustomer(t, fx, fx.otherOrgID, "Foreign buyer")
	foreignOwnerID := executorUUID(t)
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO users (id, email, name) VALUES ($1::uuid, $2, 'Other organization member')`, foreignOwnerID, "deal-owner-"+foreignOwnerID[:8]+"@fixture.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.owner.Exec(fx.ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid)`, fx.otherOrgID, foreignOwnerID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fx.owner.Exec(context.Background(), `DELETE FROM users WHERE id = $1::uuid`, foreignOwnerID); err != nil {
			t.Errorf("delete foreign deal owner fixture: %v", err)
		}
	})
	dealPayload := json.RawMessage(fmt.Sprintf(`{"title":"Local opportunity","customerId":%q,"valueMinor":52500,"source":"referral","ownerUserId":%q,"note":"first call"}`, localCustomerID, fx.userID))
	first := executeCRMDeal(t, fx, createDealCapabilityID, dealPayload, "crm-deal-receipt-create")
	if !first.OK || first.Replayed {
		t.Fatalf("createDeal result=%+v, want first success", first)
	}
	var created CreateDealOutput
	if err := json.Unmarshal(first.Data, &created); err != nil {
		t.Fatal(err)
	}
	if !isUUID(created.DealID) {
		t.Fatalf("createDeal output=%+v, want UUID dealId", created)
	}
	foreignOwnerPayload := json.RawMessage(fmt.Sprintf(`{"title":"Foreign owner deal","ownerUserId":%q}`, foreignOwnerID))
	if _, err := executeCRMDealWithError(fx, createDealCapabilityID, foreignOwnerPayload, "crm-deal-foreign-owner"); err == nil || !strings.Contains(err.Error(), "deal owner not found in this organization") {
		t.Fatalf("createDeal with foreign owner error=%v, want same-organization membership refusal", err)
	}
	replay := executeCRMDeal(t, fx, createDealCapabilityID, dealPayload, "crm-deal-receipt-create")
	var replayed CreateDealOutput
	if err := json.Unmarshal(replay.Data, &replayed); err != nil {
		t.Fatal(err)
	}
	if !replay.OK || !replay.Replayed || replayed != created {
		t.Fatalf("createDeal replay=%+v, want original result", replay)
	}
	var stored struct {
		OrgID       string
		Title       string
		CustomerID  *string
		ValueMinor  int64
		Source      *string
		OwnerUserID *string
		Note        *string
		CreatedBy   *string
	}
	if err := fx.owner.QueryRow(fx.ctx, `
		SELECT org_id::text,title,customer_id::text,value_minor,source,owner_user_id::text,note,created_by_user_id::text
		FROM deals WHERE id=$1::uuid`, created.DealID).
		Scan(&stored.OrgID, &stored.Title, &stored.CustomerID, &stored.ValueMinor, &stored.Source, &stored.OwnerUserID, &stored.Note, &stored.CreatedBy); err != nil {
		t.Fatal(err)
	}
	if stored.OrgID != fx.orgID || stored.Title != "Local opportunity" || stored.CustomerID == nil || *stored.CustomerID != localCustomerID || stored.ValueMinor != 52500 || stored.Source == nil || *stored.Source != "referral" || stored.OwnerUserID == nil || *stored.OwnerUserID != fx.userID || stored.Note == nil || *stored.Note != "first call" || stored.CreatedBy == nil || *stored.CreatedBy != fx.userID {
		t.Fatalf("stored deal=%+v, want normalized fields and human attribution", stored)
	}
	if got := fx.count(`SELECT count(*) FROM deals WHERE org_id=$1::uuid AND title='Local opportunity'`, fx.orgID); got != 1 {
		t.Fatalf("receipt replay inserted %d deals, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":crm-deal-receipt-create"); got != 1 {
		t.Fatalf("action receipts=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, createDealCapabilityID); got != 1 {
		t.Fatalf("createDeal audit events=%d, want one", got)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_id=$3::uuid`, fx.orgID, createDealCapabilityID, fx.userID); got != 1 {
		t.Fatalf("createDeal actor attribution events=%d, want one", got)
	}

	foreignCreate := json.RawMessage(fmt.Sprintf(`{"title":"Cross tenant link","customerId":%q}`, foreignCustomerID))
	if _, err := executeCRMDealWithError(fx, createDealCapabilityID, foreignCreate, "crm-deal-foreign-customer"); err == nil || !strings.Contains(err.Error(), "customer not found in this organization") {
		t.Fatalf("createDeal with foreign customer error=%v", err)
	}
	if got := fx.count(`SELECT count(*) FROM deals WHERE org_id=$1::uuid AND title='Cross tenant link'`, fx.orgID); got != 0 {
		t.Fatalf("cross-tenant create inserted %d deals", got)
	}

	var foreignDealID string
	if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO deals (org_id,title,stage) VALUES ($1::uuid,'Foreign deal','lead') RETURNING id::text`, fx.otherOrgID).Scan(&foreignDealID); err != nil {
		t.Fatal(err)
	}
	movePayload := json.RawMessage(fmt.Sprintf(`{"dealId":%q,"stage":"won"}`, foreignDealID))
	if _, err := executeCRMDealWithError(fx, moveDealStageCapabilityID, movePayload, "crm-deal-foreign-move"); err == nil || err.Error() != "deal not found" {
		t.Fatalf("foreign move error=%v, want deal not found", err)
	}
	missingDealPayload := json.RawMessage(fmt.Sprintf(`{"dealId":%q,"stage":"won"}`, "99999999-9999-4999-8999-999999999999"))
	if _, err := executeCRMDealWithError(fx, moveDealStageCapabilityID, missingDealPayload, "crm-deal-missing-move"); err == nil || err.Error() != "deal not found" {
		t.Fatalf("missing deal move error=%v, want deal not found", err)
	}
	var foreignStage string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT stage FROM deals WHERE id=$1::uuid AND org_id=$2::uuid`, foreignDealID, fx.otherOrgID).Scan(&foreignStage); err != nil {
		t.Fatal(err)
	}
	if foreignStage != "lead" {
		t.Fatalf("foreign deal stage=%q, want unchanged lead", foreignStage)
	}

	localDealID := seedCRMDeal(t, fx, fx.orgID, "Conversion prospect", "lead", nil)
	foreignConversionPayload := json.RawMessage(fmt.Sprintf(`{"dealId":%q,"customerId":%q}`, localDealID, foreignCustomerID))
	if _, err := executeCRMDealWithError(fx, convertLeadCapabilityID, foreignConversionPayload, "crm-deal-convert-foreign-customer"); err == nil || !strings.Contains(err.Error(), "customer not found in this organization") {
		t.Fatalf("convertLead with foreign customer error=%v", err)
	}
	noCustomer := json.RawMessage(fmt.Sprintf(`{"dealId":%q}`, localDealID))
	noCustomerResult, noCustomerErr := executeCRMDealWithError(fx, convertLeadCapabilityID, noCustomer, "crm-deal-convert-without-customer")
	if noCustomerErr != nil || noCustomerResult.OK || !strings.Contains(noCustomerResult.Error, "choose either customerId or createCustomer with customerName") {
		t.Fatalf("convertLead without a customer result=%+v error=%v", noCustomerResult, noCustomerErr)
	}
	converted := executeCRMDeal(t, fx, convertLeadCapabilityID, json.RawMessage(fmt.Sprintf(`{"dealId":%q,"createCustomer":true,"customerName":"Conversion prospect"}`, localDealID)), "crm-deal-convert-create-customer")
	var convertOutput ConvertLeadOutput
	if err := json.Unmarshal(converted.Data, &convertOutput); err != nil || !converted.OK || convertOutput.DealID != localDealID || !isUUID(convertOutput.CustomerID) || convertOutput.Stage != "qualified" {
		t.Fatalf("convertLead result=%+v output=%+v err=%v", converted, convertOutput, err)
	}
	var customerName, convertedStage string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT c.name,d.stage FROM customers c JOIN deals d ON d.customer_id=c.id WHERE c.id=$1::uuid AND d.org_id=$2::uuid`, convertOutput.CustomerID, fx.orgID).Scan(&customerName, &convertedStage); err != nil {
		t.Fatal(err)
	}
	if customerName != "Conversion prospect" || convertedStage != "qualified" {
		t.Fatalf("converted customer/deal=%q/%q, want title-derived customer and qualified deal", customerName, convertedStage)
	}

	existingCustomerDealID := seedCRMDeal(t, fx, fx.orgID, "Existing buyer conversion", "lead", nil)
	existingCustomerResult := executeCRMDeal(t, fx, convertLeadCapabilityID, json.RawMessage(fmt.Sprintf(`{"dealId":%q,"customerId":%q}`, existingCustomerDealID, localCustomerID)), "crm-deal-convert-existing-customer")
	var existingCustomerOutput ConvertLeadOutput
	if err := json.Unmarshal(existingCustomerResult.Data, &existingCustomerOutput); err != nil || !existingCustomerResult.OK || existingCustomerOutput.CustomerID != localCustomerID || existingCustomerOutput.Stage != "qualified" {
		t.Fatalf("convertLead existing customer result=%+v output=%+v err=%v", existingCustomerResult, existingCustomerOutput, err)
	}

	namedCustomerDealID := seedCRMDeal(t, fx, fx.orgID, "Named buyer conversion", "lead", nil)
	namedCustomerResult := executeCRMDeal(t, fx, convertLeadCapabilityID, json.RawMessage(fmt.Sprintf(`{"dealId":%q,"createCustomer":true,"customerName":"Converted buyer"}`, namedCustomerDealID)), "crm-deal-convert-named-customer")
	var namedCustomerOutput ConvertLeadOutput
	if err := json.Unmarshal(namedCustomerResult.Data, &namedCustomerOutput); err != nil || !namedCustomerResult.OK || namedCustomerOutput.Stage != "qualified" {
		t.Fatalf("convertLead named customer result=%+v output=%+v err=%v", namedCustomerResult, namedCustomerOutput, err)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT name FROM customers WHERE id=$1::uuid AND org_id=$2::uuid`, namedCustomerOutput.CustomerID, fx.orgID).Scan(&customerName); err != nil {
		t.Fatal(err)
	}
	if customerName != "Converted buyer" {
		t.Fatalf("customerName-created customer=%q, want Converted buyer", customerName)
	}

	proposalID := seedCRMDeal(t, fx, fx.orgID, "Already qualified", "proposal", nil)
	if _, err := executeCRMDealWithError(fx, convertLeadCapabilityID, json.RawMessage(fmt.Sprintf(`{"dealId":%q,"customerId":%q}`, proposalID, localCustomerID)), "crm-deal-convert-nonlead"); err == nil || !strings.Contains(err.Error(), "only lead-stage deals convert") {
		t.Fatalf("convertLead from proposal error=%v", err)
	}
	if _, err := executeCRMDealWithError(fx, convertLeadCapabilityID, json.RawMessage(fmt.Sprintf(`{"dealId":%q,"createCustomer":true,"customerName":"Prospect"}`, foreignDealID)), "crm-deal-convert-foreign-deal"); err == nil || err.Error() != "deal not found" {
		t.Fatalf("convertLead foreign deal error=%v, want deal not found", err)
	}

	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2 AND actor_type='human'`, fx.orgID, convertLeadCapabilityID); got != 3 {
		t.Fatalf("successful convertLead audit events=%d, want three", got)
	}
}

func TestGoCRMDealsLostReasonClearsWhenLeavingLostStage(t *testing.T) {
	fx := newExecutorFixture(t)
	dealID := seedCRMDeal(t, fx, fx.orgID, "At risk", "lead", nil)
	lostPayload := json.RawMessage(fmt.Sprintf(`{"dealId":%q,"stage":"lost","lostReason":"  budget freeze  "}`, dealID))
	first := executeCRMDeal(t, fx, moveDealStageCapabilityID, lostPayload, "crm-deal-lost-reason")
	if !first.OK || first.Replayed {
		t.Fatalf("first move result=%+v, want a newly completed move", first)
	}
	replay := executeCRMDeal(t, fx, moveDealStageCapabilityID, lostPayload, "crm-deal-lost-reason")
	var firstOutput, replayOutput MoveDealStageOutput
	if !replay.OK || !replay.Replayed || json.Unmarshal(first.Data, &firstOutput) != nil || json.Unmarshal(replay.Data, &replayOutput) != nil || replayOutput != firstOutput {
		t.Fatalf("exact stage retry result=%+v, want the original output as a replay", replay)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id=$2`, fx.orgID, moveDealStageCapabilityID); got != 1 {
		t.Fatalf("stage move audit events=%d, want one after exact retry", got)
	}
	var stage string
	var lostReason *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT stage,lost_reason FROM deals WHERE id=$1::uuid AND org_id=$2::uuid`, dealID, fx.orgID).Scan(&stage, &lostReason); err != nil {
		t.Fatal(err)
	}
	if stage != "lost" || lostReason == nil || *lostReason != "budget freeze" {
		t.Fatalf("lost deal state=%q/%v, want trimmed lost reason", stage, lostReason)
	}
	proposalPayload := json.RawMessage(fmt.Sprintf(`{"dealId":%q,"stage":"proposal","lostReason":"ignored reason"}`, dealID))
	if result := executeCRMDeal(t, fx, moveDealStageCapabilityID, proposalPayload, "crm-deal-leave-lost"); !result.OK {
		t.Fatalf("move from lost result=%+v", result)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT stage,lost_reason FROM deals WHERE id=$1::uuid AND org_id=$2::uuid`, dealID, fx.orgID).Scan(&stage, &lostReason); err != nil {
		t.Fatal(err)
	}
	if stage != "proposal" || lostReason != nil {
		t.Fatalf("reopened deal state=%q/%v, want cleared loss reason", stage, lostReason)
	}
}

func TestGoCRMDealsAgentWritesUseExistingApprovalPipeline(t *testing.T) {
	fx := newExecutorFixture(t)
	fx.addAgentSession()
	fx.addPolicy(createDealCapabilityID, "read", nil)
	fx.addPolicy(moveDealStageCapabilityID, "read", nil)
	fx.addPolicy(convertLeadCapabilityID, "read", nil)
	input := json.RawMessage(`{"title":"Approval-gated opportunity","valueMinor":0}`)
	result := executeCRMWriteWithActorApproval(t, fx, createDealCapabilityID, input)
	var output CreateDealOutput
	if err := json.Unmarshal(result.Data, &output); err != nil || !result.OK || !isUUID(output.DealID) {
		t.Fatalf("approved createDeal result=%+v output=%+v err=%v", result, output, err)
	}
	convertInput := json.RawMessage(fmt.Sprintf(`{"dealId":%q,"createCustomer":true,"customerName":"Approval customer"}`, output.DealID))
	convertResult := executeCRMWriteWithActorApproval(t, fx, convertLeadCapabilityID, convertInput, executorUUID(t))
	if !convertResult.OK {
		t.Fatalf("approved convertLead result=%+v", convertResult)
	}
	moveInput := json.RawMessage(fmt.Sprintf(`{"dealId":%q,"stage":"proposal"}`, output.DealID))
	moveResult := executeCRMWriteWithActorApproval(t, fx, moveDealStageCapabilityID, moveInput)
	if !moveResult.OK {
		t.Fatalf("approved moveDealStage result=%+v", moveResult)
	}
	for _, capabilityID := range []string{createDealCapabilityID, moveDealStageCapabilityID, convertLeadCapabilityID} {
		if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.requested' AND capability_id=$2`, fx.orgID, capabilityID); got != 1 {
			t.Errorf("%s approval request events=%d, want one", capabilityID, got)
		}
		if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='approval.granted' AND capability_id=$2`, fx.orgID, capabilityID); got != 0 {
			t.Errorf("%s approval grant events=%d, want legacy human re-execution behavior of zero", capabilityID, got)
		}
	}
}

func TestGoCRMLeadConversionUndoIsReceiptBoundSafeAndReversible(t *testing.T) {
	fx := newExecutorFixture(t)

	createdDealID := seedCRMDeal(t, fx, fx.orgID, "Undo created customer", "lead", nil)
	conversionIntent := "crm-lead-convert-created-undo"
	converted := executeCRMDeal(t, fx, convertLeadCapabilityID, json.RawMessage(fmt.Sprintf(`{"dealId":%q,"createCustomer":true,"customerName":"Undo created customer"}`, createdDealID)), conversionIntent)
	var convertedOutput ConvertLeadOutput
	if err := json.Unmarshal(converted.Data, &convertedOutput); err != nil || !converted.OK || convertedOutput.DealID != createdDealID || convertedOutput.Stage != "qualified" {
		t.Fatalf("created conversion result=%+v output=%+v err=%v", converted, convertedOutput, err)
	}
	if string(converted.Data) != fmt.Sprintf(`{"dealId":%q,"customerId":%q,"conversionIntentId":%q,"stage":"qualified"}`, createdDealID, convertedOutput.CustomerID, conversionIntent) {
		t.Fatalf("convertLead success DTO changed: %s", converted.Data)
	}
	var receiptEnvelope struct {
		Version int             `json:"version"`
		Result  json.RawMessage `json:"result"`
		Inverse json.RawMessage `json:"inverse"`
	}
	var receiptData []byte
	var receiptResult ConvertLeadOutput
	if err := fx.owner.QueryRow(fx.ctx, `SELECT data FROM action_receipts WHERE org_id=$1::uuid AND intent_key=$2`, fx.orgID, fx.orgID+":"+conversionIntent).Scan(&receiptData); err != nil || json.Unmarshal(receiptData, &receiptEnvelope) != nil || json.Unmarshal(receiptEnvelope.Result, &receiptResult) != nil || receiptEnvelope.Version != 1 || len(receiptEnvelope.Inverse) == 0 || receiptResult != convertedOutput {
		t.Fatalf("conversion receipt envelope=%+v err=%v", receiptEnvelope, err)
	}
	undoPayload := json.RawMessage(fmt.Sprintf(`{"conversionIntentId":%q}`, conversionIntent))
	undone := executeCRMDeal(t, fx, undoLeadConversionCapabilityID, undoPayload, "crm-lead-undo-created-customer")
	var undoOutput UndoLeadConversionOutput
	if err := json.Unmarshal(undone.Data, &undoOutput); err != nil || !undone.OK || !undoOutput.Undone || undoOutput.DealID != createdDealID || !undoOutput.CustomerDeleted {
		t.Fatalf("created conversion undo=%+v output=%+v err=%v", undone, undoOutput, err)
	}
	undoReplay := executeCRMDeal(t, fx, undoLeadConversionCapabilityID, undoPayload, "crm-lead-undo-created-customer")
	var replayedUndoOutput UndoLeadConversionOutput
	if err := json.Unmarshal(undoReplay.Data, &replayedUndoOutput); err != nil || !undoReplay.OK || !undoReplay.Replayed || replayedUndoOutput != undoOutput {
		t.Fatalf("undo replay=%+v, want exact output receipt", undoReplay)
	}
	var stage string
	var restoredCustomerID *string
	if err := fx.owner.QueryRow(fx.ctx, `SELECT stage,customer_id::text FROM deals WHERE id=$1::uuid AND org_id=$2::uuid`, createdDealID, fx.orgID).Scan(&stage, &restoredCustomerID); err != nil || stage != "lead" || restoredCustomerID != nil {
		t.Fatalf("restored deal=%q/%v err=%v, want lead with no customer", stage, restoredCustomerID, err)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE id=$1::uuid AND org_id=$2::uuid`, convertedOutput.CustomerID, fx.orgID); got != 0 {
		t.Fatalf("undo left %d newly created customers", got)
	}
	reapplied := executeCRMDeal(t, fx, reapplyLeadConversionCapabilityID, json.RawMessage(`{"undoIntentId":"crm-lead-undo-created-customer"}`), "crm-lead-reapply-created-customer")
	var reapplyOutput ReapplyLeadConversionOutput
	if err := json.Unmarshal(reapplied.Data, &reapplyOutput); err != nil || !reapplied.OK || !reapplyOutput.Reapplied || reapplyOutput.DealID != createdDealID || reapplyOutput.CustomerID != convertedOutput.CustomerID || reapplyOutput.ConversionIntentID != conversionIntent {
		t.Fatalf("created conversion reapply=%+v output=%+v err=%v", reapplied, reapplyOutput, err)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE id=$1::uuid AND org_id=$2::uuid`, convertedOutput.CustomerID, fx.orgID); got != 1 {
		t.Fatalf("reapply did not restore created customer, rows=%d", got)
	}
	if result := executeCRMDeal(t, fx, undoLeadConversionCapabilityID, undoPayload, "crm-lead-undo-after-reapply"); !result.OK {
		t.Fatalf("conversion after reapply could not be undone: %+v", result)
	}

	previousCustomerID := seedCRMDealCustomer(t, fx, fx.orgID, "Previous account")
	attachedCustomerID := seedCRMDealCustomer(t, fx, fx.orgID, "Attached account")
	attachDealID := seedCRMDeal(t, fx, fx.orgID, "Undo attached customer", "lead", &previousCustomerID)
	attachIntent := "crm-lead-convert-attach-undo"
	if result := executeCRMDeal(t, fx, convertLeadCapabilityID, json.RawMessage(fmt.Sprintf(`{"dealId":%q,"customerId":%q}`, attachDealID, attachedCustomerID)), attachIntent); !result.OK {
		t.Fatalf("attach-existing conversion=%+v", result)
	}
	attachUndo := executeCRMDeal(t, fx, undoLeadConversionCapabilityID, json.RawMessage(fmt.Sprintf(`{"conversionIntentId":%q}`, attachIntent)), "crm-lead-undo-attached-customer")
	if !attachUndo.OK {
		t.Fatalf("attach-existing undo=%+v", attachUndo)
	}
	if err := fx.owner.QueryRow(fx.ctx, `SELECT stage,customer_id::text FROM deals WHERE id=$1::uuid AND org_id=$2::uuid`, attachDealID, fx.orgID).Scan(&stage, &restoredCustomerID); err != nil || stage != "lead" || restoredCustomerID == nil || *restoredCustomerID != previousCustomerID {
		t.Fatalf("attach-existing restored deal=%q/%v err=%v", stage, restoredCustomerID, err)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE id=$1::uuid AND org_id=$2::uuid`, attachedCustomerID, fx.orgID); got != 1 {
		t.Fatalf("undo deleted pre-existing attached customer, remaining=%d", got)
	}

	changedDealID := seedCRMDeal(t, fx, fx.orgID, "Changed conversion", "lead", nil)
	changedIntent := "crm-lead-convert-stale-undo"
	changed := executeCRMDeal(t, fx, convertLeadCapabilityID, json.RawMessage(fmt.Sprintf(`{"dealId":%q,"createCustomer":true,"customerName":"Changed conversion"}`, changedDealID)), changedIntent)
	var changedOutput ConvertLeadOutput
	if err := json.Unmarshal(changed.Data, &changedOutput); err != nil {
		t.Fatal(err)
	}
	if result := executeCRMDeal(t, fx, moveDealStageCapabilityID, json.RawMessage(fmt.Sprintf(`{"dealId":%q,"stage":"proposal"}`, changedDealID)), "crm-lead-stage-after-convert"); !result.OK {
		t.Fatalf("move converted deal=%+v", result)
	}
	if _, err := executeCRMDealWithError(fx, undoLeadConversionCapabilityID, json.RawMessage(fmt.Sprintf(`{"conversionIntentId":%q}`, changedIntent)), "crm-lead-undo-stale"); err == nil || !strings.Contains(err.Error(), "changed since conversion") {
		t.Fatalf("stale undo error=%v, want fail closed", err)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE id=$1::uuid AND org_id=$2::uuid`, changedOutput.CustomerID, fx.orgID); got != 1 {
		t.Fatalf("stale undo deleted customer, remaining=%d", got)
	}

	referencedDealID := seedCRMDeal(t, fx, fx.orgID, "Referenced conversion", "lead", nil)
	referenceIntent := "crm-lead-convert-referenced-undo"
	referenced := executeCRMDeal(t, fx, convertLeadCapabilityID, json.RawMessage(fmt.Sprintf(`{"dealId":%q,"createCustomer":true,"customerName":"Referenced conversion"}`, referencedDealID)), referenceIntent)
	var referencedOutput ConvertLeadOutput
	if err := json.Unmarshal(referenced.Data, &referencedOutput); err != nil {
		t.Fatal(err)
	}
	seedCRMDeal(t, fx, fx.orgID, "Second use of created customer", "lead", &referencedOutput.CustomerID)
	if _, err := executeCRMDealWithError(fx, undoLeadConversionCapabilityID, json.RawMessage(fmt.Sprintf(`{"conversionIntentId":%q}`, referenceIntent)), "crm-lead-undo-referenced"); err == nil || !strings.Contains(err.Error(), "acquired references") {
		t.Fatalf("referenced customer undo error=%v, want fail closed", err)
	}
	if got := fx.count(`SELECT count(*) FROM customers WHERE id=$1::uuid AND org_id=$2::uuid`, referencedOutput.CustomerID, fx.orgID); got != 1 {
		t.Fatalf("referenced undo deleted customer, remaining=%d", got)
	}
	if got := fx.count(`SELECT count(*) FROM deals WHERE id=$1::uuid AND org_id=$2::uuid AND stage='qualified' AND customer_id=$3::uuid`, referencedDealID, fx.orgID, referencedOutput.CustomerID); got != 1 {
		t.Fatalf("failed referenced undo did not roll back deal conversion, rows=%d", got)
	}

	foreignUndo := json.RawMessage(fmt.Sprintf(`{"conversionIntentId":%q}`, referenceIntent))
	claims := crmWriteClaims(fx, undoLeadConversionCapabilityID, foreignUndo, "human", "", "crm-lead-undo-cross-org")
	claims.OrganizationID = fx.otherOrgID
	if result, err := fx.executor.Execute(fx.ctx, claims, undoLeadConversionCapabilityID, foreignUndo); err == nil && result.OK {
		t.Fatalf("cross-organization undo unexpectedly succeeded: %+v", result)
	}
	if got := fx.count(`SELECT count(*) FROM ledger_events WHERE org_id=$1::uuid AND kind='capability.executed' AND capability_id IN ($2,$3,$4)`, fx.orgID, convertLeadCapabilityID, undoLeadConversionCapabilityID, reapplyLeadConversionCapabilityID); got < 8 {
		t.Fatalf("successful conversion, undo, and reapply audit events=%d, want at least eight", got)
	}
}

func executeCRMDeal(t *testing.T, fx *executorFixture, capabilityID string, raw json.RawMessage, intent string) Result {
	t.Helper()
	result, err := executeCRMDealWithError(fx, capabilityID, raw, intent)
	if err != nil {
		t.Fatalf("execute %s: %v", capabilityID, err)
	}
	return result
}

func executeCRMDealWithError(fx *executorFixture, capabilityID string, raw json.RawMessage, intent string) (Result, error) {
	claims := crmWriteClaims(fx, capabilityID, raw, "human", "", intent)
	return fx.executor.Execute(fx.ctx, claims, capabilityID, raw)
}

func seedCRMDealCustomer(t *testing.T, fx *executorFixture, orgID, name string) string {
	t.Helper()
	var customerID string
	if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO customers (org_id,name) VALUES ($1::uuid,$2) RETURNING id::text`, orgID, name).Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	return customerID
}

func seedCRMDeal(t *testing.T, fx *executorFixture, orgID, title, stage string, customerID *string) string {
	t.Helper()
	var dealID string
	if err := fx.owner.QueryRow(fx.ctx, `INSERT INTO deals (org_id,title,stage,customer_id) VALUES ($1::uuid,$2,$3,$4::uuid) RETURNING id::text`, orgID, title, stage, customerID).Scan(&dealID); err != nil {
		t.Fatal(err)
	}
	return dealID
}

func boolPointer(value bool) *bool { return &value }
