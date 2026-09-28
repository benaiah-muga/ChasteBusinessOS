package capability

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/crm"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/ledger"
	"github.com/jackc/pgx/v5"
)

const (
	createCustomerCapabilityID           = "crm.createCustomer"
	deactivateCustomerCapabilityID       = "crm.deactivateCustomer"
	mergeCustomersCapabilityID           = "crm.mergeCustomers"
	restoreCustomerMergeCapabilityID     = "crm.restoreCustomerMerge"
	importCustomersCapabilityID          = "crm.importCustomers"
	undoCustomerImportCapabilityID       = "crm.undoCustomerImport"
	restoreImportedCustomersCapabilityID = "crm.restoreImportedCustomers"
	updateCustomerProfilesCapabilityID   = "crm.updateCustomerProfiles"
	restoreCustomerProfilesCapabilityID  = "crm.restoreCustomerProfiles"
	reapplyCustomerProfilesCapabilityID  = "crm.reapplyCustomerProfiles"
	listCustomersCapabilityID            = "crm.listCustomers"
	pipelineReportCapabilityID           = "crm.pipelineReport"
	listTasksCapabilityID                = "crm.listTasks"
	customerTimelineCapabilityID         = "crm.customerTimeline"
	createInvoiceCapabilityID            = "accounting.createInvoice"
	recordFxRateCapabilityID             = "accounting.recordFxRate"
	recordPaymentCapabilityID            = "accounting.recordPayment"
	reversePaymentCapabilityID           = "accounting.reversePayment"
	trialBalanceCapabilityID             = "accounting.trialBalance"
	createProjectCapabilityID            = "projects.createProject"
	archiveProjectCapabilityID           = "projects.archiveProject"
	createProjectTaskCapabilityID        = "projects.createTask"
	moveProjectTaskCapabilityID          = "projects.moveTask"
	assignProjectTaskCapabilityID        = "projects.assignTask"
)
const approvalTTL = 7 * 24 * time.Hour

type capabilitySpec struct {
	module              string
	permission          string
	risk                string
	moneyThresholdMinor int64
}

var capabilitySpecs = map[string]capabilitySpec{
	createCustomerCapabilityID:            {module: "crm", permission: "crm.write", risk: "write"},
	deactivateCustomerCapabilityID:        {module: "crm", permission: "crm.write", risk: "write"},
	mergeCustomersCapabilityID:            {module: "crm", permission: "crm.write", risk: "write"},
	restoreCustomerMergeCapabilityID:      {module: "crm", permission: "crm.write", risk: "write"},
	importCustomersCapabilityID:           {module: "crm", permission: "crm.write", risk: "write"},
	undoCustomerImportCapabilityID:        {module: "crm", permission: "crm.write", risk: "write"},
	restoreImportedCustomersCapabilityID:  {module: "crm", permission: "crm.write", risk: "write"},
	updateCustomerProfilesCapabilityID:    {module: "crm", permission: "crm.write", risk: "write"},
	restoreCustomerProfilesCapabilityID:   {module: "crm", permission: "crm.write", risk: "write"},
	reapplyCustomerProfilesCapabilityID:   {module: "crm", permission: "crm.write", risk: "write"},
	listCustomersCapabilityID:             {module: "crm", permission: "crm.read", risk: "read"},
	pipelineReportCapabilityID:            {module: "crm", permission: "crm.read", risk: "read"},
	listTasksCapabilityID:                 {module: "crm", permission: "crm.read", risk: "read"},
	customerTimelineCapabilityID:          {module: "crm", permission: "crm.read", risk: "read"},
	createDealCapabilityID:                {module: "crm", permission: "crm.write", risk: "write"},
	moveDealStageCapabilityID:             {module: "crm", permission: "crm.write", risk: "write"},
	convertLeadCapabilityID:               {module: "crm", permission: "crm.write", risk: "write"},
	createTaskCapabilityID:                {module: "crm", permission: "crm.write", risk: "write"},
	completeTaskCapabilityID:              {module: "crm", permission: "crm.write", risk: "write"},
	updateTaskDetailsCapabilityID:         {module: "crm", permission: "crm.write", risk: "write"},
	restoreTaskDetailsCapabilityID:        {module: "crm", permission: "crm.write", risk: "write"},
	createQuoteCapabilityID:               {module: "accounting", permission: "accounting.write", risk: "write"},
	acceptQuoteCapabilityID:               {module: "accounting", permission: "accounting.write", risk: "write"},
	declineQuoteCapabilityID:              {module: "accounting", permission: "accounting.write", risk: "write"},
	expireQuoteCapabilityID:               {module: "accounting", permission: "accounting.write", risk: "write"},
	listQuotesCapabilityID:                {module: "accounting", permission: "accounting.read", risk: "read"},
	createRecurringTemplateCapabilityID:   {module: "accounting", permission: "accounting.write", risk: "write"},
	pauseRecurringTemplateCapabilityID:    {module: "accounting", permission: "accounting.write", risk: "write"},
	resumeRecurringTemplateCapabilityID:   {module: "accounting", permission: "accounting.write", risk: "write"},
	listRecurringTemplatesCapabilityID:    {module: "accounting", permission: "accounting.read", risk: "read"},
	hrHireEmployeeCapabilityID:            {module: "hr", permission: "hr.write", risk: "write"},
	hrDeactivateEmployeeCapabilityID:      {module: "hr", permission: "hr.write", risk: "write"},
	hrListEmployeesCapabilityID:           {module: "hr", permission: "hr.read", risk: "read"},
	hrUpdateEmployeeStructureCapabilityID: {module: "hr", permission: "hr.write", risk: "write"},
	salesCreateOrderCapabilityID:          {module: "sales", permission: "sales.write", risk: "write"},
	salesConfirmOrderCapabilityID:         {module: "sales", permission: "sales.write", risk: "write"},
	salesDeliverOrderCapabilityID:         {module: "sales", permission: "sales.write", risk: "write"},
	salesCancelOrderCapabilityID:          {module: "sales", permission: "sales.write", risk: "write"},
	salesListOrdersCapabilityID:           {module: "sales", permission: "sales.read", risk: "read"},
	createInvoiceCapabilityID:             {module: "accounting", permission: "accounting.write", risk: "write"},
	recordFxRateCapabilityID:              {module: "accounting", permission: "accounting.post", risk: "write"},
	recordPaymentCapabilityID:             {module: "accounting", permission: "accounting.post", risk: "money", moneyThresholdMinor: 50_000},
	reversePaymentCapabilityID:            {module: "accounting", permission: "accounting.post", risk: "money"},
	trialBalanceCapabilityID:              {module: "accounting", permission: "accounting.read", risk: "read"},
	createProjectCapabilityID:             {module: "projects", permission: "projects.write", risk: "write"},
	ProjectBoardReadCapabilityID:          {module: "projects", permission: "projects.read", risk: "read"},
	archiveProjectCapabilityID:            {module: "projects", permission: "projects.write", risk: "write"},
	createProjectTaskCapabilityID:         {module: "projects", permission: "projects.write", risk: "write"},
	moveProjectTaskCapabilityID:           {module: "projects", permission: "projects.write", risk: "write"},
	assignProjectTaskCapabilityID:         {module: "projects", permission: "projects.write", risk: "write"},
}

func supportedCapability(capabilityID string) bool {
	switch capabilityID {
	case createCustomerCapabilityID, deactivateCustomerCapabilityID,
		mergeCustomersCapabilityID, restoreCustomerMergeCapabilityID, importCustomersCapabilityID,
		undoCustomerImportCapabilityID, restoreImportedCustomersCapabilityID,
		updateCustomerProfilesCapabilityID, restoreCustomerProfilesCapabilityID, reapplyCustomerProfilesCapabilityID,
		listCustomersCapabilityID, pipelineReportCapabilityID, listTasksCapabilityID, customerTimelineCapabilityID,
		createDealCapabilityID, moveDealStageCapabilityID, convertLeadCapabilityID,
		createTaskCapabilityID, completeTaskCapabilityID, updateTaskDetailsCapabilityID, restoreTaskDetailsCapabilityID,
		createQuoteCapabilityID, acceptQuoteCapabilityID, declineQuoteCapabilityID, expireQuoteCapabilityID, listQuotesCapabilityID,
		createRecurringTemplateCapabilityID, pauseRecurringTemplateCapabilityID, resumeRecurringTemplateCapabilityID, listRecurringTemplatesCapabilityID,
		hrHireEmployeeCapabilityID, hrDeactivateEmployeeCapabilityID, hrListEmployeesCapabilityID, hrUpdateEmployeeStructureCapabilityID,
		salesCreateOrderCapabilityID, salesConfirmOrderCapabilityID, salesDeliverOrderCapabilityID, salesCancelOrderCapabilityID, salesListOrdersCapabilityID,
		createInvoiceCapabilityID, recordFxRateCapabilityID, recordPaymentCapabilityID, reversePaymentCapabilityID, trialBalanceCapabilityID,
		createProjectCapabilityID, ProjectBoardReadCapabilityID, archiveProjectCapabilityID, createProjectTaskCapabilityID, moveProjectTaskCapabilityID, assignProjectTaskCapabilityID:
		return true
	default:
		return false
	}
}

var (
	ErrSessionInvalid = errors.New("authenticated session is no longer valid")
	ErrNotMember      = errors.New("user is not a member of the requested organization")
	ErrScopeMismatch  = errors.New("capability assertion does not match the input")
)

type Result struct {
	OK                bool            `json:"ok"`
	Data              json.RawMessage `json:"data,omitempty"`
	Error             string          `json:"error,omitempty"`
	PendingApproval   bool            `json:"pendingApproval,omitempty"`
	ApprovalID        string          `json:"approvalId,omitempty"`
	ApprovalRationale string          `json:"approvalRationale,omitempty"`
	Replayed          bool            `json:"replayed,omitempty"`
}

// SystemClaims are accepted only by ExecuteSystem, which is an internal
// worker entrypoint and is not represented by an auth-bridge assertion.
type SystemClaims struct {
	OrganizationID     string
	CapabilityID       string
	Permission         string
	IntentID           string
	ApprovedApprovalID string
}

type Executor struct {
	pool       dbx.Beginner
	webhookURL string
	smtpHost   string
	smtpTo     string
}

func NewExecutor(pool dbx.Beginner, webhookURL, smtpHost, smtpTo string) *Executor {
	return &Executor{pool: pool, webhookURL: webhookURL, smtpHost: smtpHost, smtpTo: smtpTo}
}

func (e *Executor) Execute(
	ctx context.Context,
	claims authbridge.CapabilityClaims,
	capabilityID string,
	rawInput json.RawMessage,
) (Result, error) {
	return e.execute(ctx, claims, capabilityID, rawInput, false, "")
}

// ExecuteSystem runs a queued capability as the same least-privilege system
// actor used by the TypeScript worker. Actor identity is fixed here, never
// accepted from the caller. The job UUID is the stable receipt intent.
func (e *Executor) ExecuteSystem(ctx context.Context, request SystemClaims, rawInput json.RawMessage) (Result, error) {
	if e == nil || e.pool == nil {
		return Result{}, errors.New("capability executor is unavailable")
	}
	spec, supported := capabilitySpecs[request.CapabilityID]
	if !supportedCapability(request.CapabilityID) || !supported {
		return Result{OK: false, Error: "unknown capability: " + request.CapabilityID}, nil
	}
	if !isUUID(request.OrganizationID) || !isUUID(request.IntentID) {
		return Result{}, ErrScopeMismatch
	}
	if request.Permission != spec.permission {
		return Result{}, ErrSystemPermissionMismatch
	}
	if request.ApprovedApprovalID != "" && !isUUID(request.ApprovedApprovalID) {
		return Result{}, ErrScopeMismatch
	}
	digest, err := InputHash(rawInput)
	if err != nil {
		return Result{}, err
	}
	claims := authbridge.CapabilityClaims{
		Audience:       authbridge.CapabilityExecuteAudience,
		OrganizationID: request.OrganizationID,
		CapabilityID:   request.CapabilityID,
		InputSHA256:    digest,
		ActorType:      "system",
		Permissions:    []string{spec.permission},
		IntentID:       request.IntentID,
	}
	return e.execute(ctx, claims, request.CapabilityID, rawInput, true, request.ApprovedApprovalID)
}

var ErrSystemPermissionMismatch = errors.New("system capability permission does not match its declaration")

func (e *Executor) execute(
	ctx context.Context,
	claims authbridge.CapabilityClaims,
	capabilityID string,
	rawInput json.RawMessage,
	system bool,
	approvedApprovalID string,
) (Result, error) {
	if e == nil || e.pool == nil {
		return Result{}, errors.New("capability executor is unavailable")
	}
	spec, supported := capabilitySpecs[capabilityID]
	if !supportedCapability(capabilityID) || !supported || claims.CapabilityID != capabilityID {
		return Result{OK: false, Error: "unknown capability: " + capabilityID}, nil
	}
	inputDigest, err := InputHash(rawInput)
	if err != nil || inputDigest != claims.InputSHA256 {
		return Result{}, ErrScopeMismatch
	}
	if system {
		if claims.ActorType != "system" || claims.Subject != "" || claims.ActorID != nil || claims.AuthSessionID != "" || claims.AgentSessionID != "" {
			return Result{}, ErrSessionInvalid
		}
	} else if !isUUID(claims.Subject) || !isUUID(claims.OrganizationID) || claims.ActorID == nil || !isUUID(*claims.ActorID) || *claims.ActorID != claims.Subject {
		return Result{}, ErrSessionInvalid
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	return dbx.WithOrgTx(ctx, e.pool, claims.OrganizationID, func(tx pgx.Tx) (Result, error) {
		if !system {
			if err := verifyIdentity(ctx, tx, claims, now); err != nil {
				return Result{}, err
			}
		}
		if !isUUID(claims.OrganizationID) {
			return Result{}, ErrScopeMismatch
		}
		if system && claims.IntentID == "" {
			return Result{}, ErrScopeMismatch
		}

		enabled, err := isModuleEnabled(ctx, tx, claims.OrganizationID, spec.module)
		if err != nil {
			return Result{}, err
		}
		if !enabled {
			return Result{OK: false, Error: fmt.Sprintf("module %q is disabled for this organization", spec.module)}, nil
		}

		var input any
		switch capabilityID {
		case createCustomerCapabilityID:
			parsed, err := ParseCreateCustomerInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case listCustomersCapabilityID:
			parsed, err := ParseListCustomersInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case pipelineReportCapabilityID:
			parsed, err := ParsePipelineReportInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case listTasksCapabilityID:
			parsed, err := ParseListTasksInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case customerTimelineCapabilityID:
			parsed, err := ParseCustomerTimelineInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createDealCapabilityID, moveDealStageCapabilityID, convertLeadCapabilityID:
			parsed, err := parseCRMDealInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createTaskCapabilityID, completeTaskCapabilityID, updateTaskDetailsCapabilityID, restoreTaskDetailsCapabilityID:
			parsed, err := parseCRMTaskInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createQuoteCapabilityID, acceptQuoteCapabilityID, declineQuoteCapabilityID, expireQuoteCapabilityID, listQuotesCapabilityID:
			parsed, err := parseAccountingQuoteInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createRecurringTemplateCapabilityID, pauseRecurringTemplateCapabilityID, resumeRecurringTemplateCapabilityID, listRecurringTemplatesCapabilityID:
			parsed, err := parseAccountingRecurringInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case hrHireEmployeeCapabilityID, hrDeactivateEmployeeCapabilityID, hrListEmployeesCapabilityID, hrUpdateEmployeeStructureCapabilityID:
			parsed, err := parseHREmployeeInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case salesCreateOrderCapabilityID, salesConfirmOrderCapabilityID, salesDeliverOrderCapabilityID, salesCancelOrderCapabilityID, salesListOrdersCapabilityID:
			parsed, err := parseSalesInput(capabilityID, rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case deactivateCustomerCapabilityID:
			parsed, err := ParseDeactivateCustomerInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case mergeCustomersCapabilityID:
			parsed, err := ParseCustomerMergeInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case restoreCustomerMergeCapabilityID:
			parsed, err := ParseCustomerMergeSnapshotInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case importCustomersCapabilityID:
			parsed, err := ParseCustomerImportInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case undoCustomerImportCapabilityID, restoreImportedCustomersCapabilityID:
			parsed, err := ParseCustomerIDsInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case updateCustomerProfilesCapabilityID:
			parsed, err := ParseCustomerProfileUpdateInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case restoreCustomerProfilesCapabilityID, reapplyCustomerProfilesCapabilityID:
			parsed, err := ParseCustomerProfileSnapshotsInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createInvoiceCapabilityID:
			parsed, err := ParseCreateInvoiceInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case recordFxRateCapabilityID:
			parsed, err := ParseRecordFxRateInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case recordPaymentCapabilityID:
			parsed, err := ParseRecordPaymentInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case reversePaymentCapabilityID:
			parsed, err := ParseReversePaymentInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case trialBalanceCapabilityID:
			parsed, err := ParseTrialBalanceInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createProjectCapabilityID:
			parsed, err := ParseCreateProjectInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case ProjectBoardReadCapabilityID:
			parsed, err := ParseProjectBoardInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case archiveProjectCapabilityID:
			parsed, err := ParseArchiveProjectInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case createProjectTaskCapabilityID:
			parsed, err := ParseCreateProjectTaskInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case moveProjectTaskCapabilityID:
			parsed, err := ParseMoveProjectTaskInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		case assignProjectTaskCapabilityID:
			parsed, err := ParseAssignProjectTaskInput(rawInput)
			if err != nil {
				return Result{OK: false, Error: "invalid input: " + err.Error()}, nil
			}
			input = parsed
		}
		inputHash, err := canonicalInputHash(input)
		if err != nil {
			return Result{}, err
		}
		permissions := map[string]bool{}
		if system {
			permissions[spec.permission] = true
		} else {
			permissions, err = effectivePermissions(ctx, tx, claims)
			if err != nil {
				return Result{}, err
			}
		}
		if !permissions["*"] && !permissions[spec.permission] {
			return Result{OK: false, Error: "forbidden: missing permission: " + spec.permission}, nil
		}

		requiresApproval, rationale, err := requiresApproval(ctx, tx, claims, capabilityID, spec, input)
		if err != nil {
			return Result{}, err
		}
		if system && requiresApproval && approvedApprovalID != "" {
			valid, err := verifySystemApproval(ctx, tx, claims.OrganizationID, capabilityID, approvedApprovalID, inputHash, now)
			if err != nil {
				return Result{}, err
			}
			if !valid {
				return Result{OK: false, Error: approvalVerificationError}, nil
			}
		}
		if requiresApproval {
			if approvedApprovalID == "" {
				approvalID, err := e.requestApproval(ctx, tx, claims, capabilityID, spec.risk, input, rationale, now)
				if err != nil {
					return Result{}, err
				}
				return Result{OK: false, PendingApproval: true, ApprovalID: approvalID, ApprovalRationale: rationale, Error: "pending human approval"}, nil
			}
			payload, err := marshalJS(struct {
				CapabilityID string `json:"capabilityId"`
				ApprovalID   string `json:"approvalId"`
			}{CapabilityID: capabilityID, ApprovalID: approvedApprovalID})
			if err != nil {
				return Result{}, err
			}
			capID := capabilityID
			if _, _, err := ledger.AppendTx(ctx, tx, ledger.AppendEvent{
				OrgID: claims.OrganizationID, ActorType: claims.ActorType, ActorID: claims.ActorID,
				Kind: "approval.granted", CapabilityID: &capID, Payload: payload, OccurredAt: now,
			}); err != nil {
				return Result{}, err
			}
		}
		intentKey := ""
		if claims.IntentID != "" {
			intentKey = claims.OrganizationID + ":" + claims.IntentID
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, claims.OrganizationID, claims.IntentID); err != nil {
				return Result{}, err
			}
			prior, found, err := loadReceipt(ctx, tx, claims.OrganizationID, intentKey)
			if err != nil {
				return Result{}, err
			}
			if found {
				if prior.CapabilityID != capabilityID {
					return Result{OK: false, Error: "action intent conflict: key already used for " + prior.CapabilityID}, nil
				}
				if prior.InputHash != inputHash {
					return Result{OK: false, Error: "action intent conflict: same action key used with a different payload"}, nil
				}
				return Result{OK: prior.OK, Data: prior.Data, Error: prior.Error, Replayed: true}, nil
			}
		}

		var data json.RawMessage
		switch parsed := input.(type) {
		case CreateCustomerInput:
			output, err := createCustomer(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListCustomersInput:
			output, err := listCustomers(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PipelineReportInput:
			output, err := pipelineReport(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListTasksInput:
			output, err := listTasks(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CustomerTimelineInput:
			output, err := customerTimeline(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateDealInput:
			output, err := createDeal(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case MoveDealStageInput:
			output, err := moveDealStage(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ConvertLeadInput:
			output, err := convertLead(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateTaskInput:
			output, err := createTask(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CompleteTaskInput:
			output, err := completeTask(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case UpdateTaskDetailsInput:
			output, err := updateTaskDetails(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateQuoteInput:
			output, err := createQuote(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case AcceptQuoteInput:
			output, err := acceptQuote(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case DeclineQuoteInput:
			output, err := declineQuote(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ExpireQuoteInput:
			output, err := expireQuote(ctx, tx, claims.OrganizationID, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListQuotesInput:
			output, err := listQuotes(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateRecurringTemplateInput:
			output, err := createRecurringTemplate(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case PauseRecurringTemplateInput:
			output, err := pauseRecurringTemplate(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ResumeRecurringTemplateInput:
			output, err := resumeRecurringTemplate(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ListRecurringTemplatesInput:
			output, err := listRecurringTemplates(ctx, tx, claims.OrganizationID)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRHireEmployeeInput:
			output, err := hrHireEmployee(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRDeactivateEmployeeInput:
			output, err := hrDeactivateEmployee(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRListEmployeesInput:
			output, err := hrListEmployees(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case HRUpdateEmployeeStructureInput:
			output, err := hrUpdateEmployeeStructure(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesCreateOrderInput:
			output, err := salesCreateOrder(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesConfirmOrderInput:
			output, err := salesConfirmOrder(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesDeliverOrderInput:
			output, err := salesDeliverOrder(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesCancelOrderInput:
			output, err := salesCancelOrder(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case SalesListOrdersInput:
			output, err := salesListOrders(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case DeactivateCustomerInput:
			output, err := deactivateCustomer(ctx, tx, claims.OrganizationID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CustomerMergeInput, CustomerMergeSnapshotInput, CustomerImportInput, CustomerIDsInput:
			output, err := executeCustomerMergeCapability(ctx, tx, claims, capabilityID, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CustomerProfileUpdateInput:
			output, err := updateCustomerProfiles(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CustomerProfileSnapshotsInput:
			output, err := applyCustomerProfileSnapshots(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateInvoiceInput:
			output, err := createInvoice(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case RecordFxRateInput:
			output, err := recordFxRate(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case RecordPaymentInput:
			output, err := recordPayment(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ReversePaymentInput:
			output, err := reversePayment(ctx, tx, claims, parsed, now)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case TrialBalanceInput:
			output, err := trialBalance(ctx, tx, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateProjectInput:
			output, err := createProject(ctx, tx, claims, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ProjectBoardInput:
			output, err := listProjectBoard(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case ArchiveProjectInput:
			output, err := archiveProject(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case CreateProjectTaskInput:
			output, err := createProjectTask(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case MoveProjectTaskInput:
			output, err := moveProjectTask(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		case AssignProjectTaskInput:
			output, err := assignProjectTask(ctx, tx, claims.OrganizationID, parsed)
			if err != nil {
				return Result{}, err
			}
			data, err = marshalJS(output)
		default:
			return Result{}, errors.New("unsupported capability input")
		}
		if err != nil {
			return Result{}, err
		}
		payload, err := marshalJS(struct {
			Input any `json:"input"`
		}{Input: input})
		if err != nil {
			return Result{}, err
		}
		actorID := claims.ActorID
		capID := capabilityID
		var agentSessionID *string
		if claims.AgentSessionID != "" {
			agentSessionID = &claims.AgentSessionID
		}
		if _, _, err := ledger.AppendTx(ctx, tx, ledger.AppendEvent{
			OrgID:        claims.OrganizationID,
			ActorType:    claims.ActorType,
			ActorID:      actorID,
			Kind:         "capability.executed",
			CapabilityID: &capID,
			SessionID:    agentSessionID,
			Payload:      payload,
			OccurredAt:   now,
		}); err != nil {
			return Result{}, err
		}
		result := Result{OK: true, Data: data}
		if intentKey != "" {
			if err := insertReceipt(ctx, tx, claims.OrganizationID, intentKey, capabilityID, inputHash, result); err != nil {
				return Result{}, err
			}
		}
		return result, nil
	})
}

func canonicalInputHash(input any) (string, error) {
	switch parsed := input.(type) {
	case CreateCustomerInput:
		return CanonicalInputHash(parsed)
	case DeactivateCustomerInput:
		return CanonicalDeactivateCustomerInputHash(parsed)
	case CustomerMergeInput:
		return parsed.CanonicalHash()
	case CustomerMergeSnapshotInput:
		return parsed.CanonicalHash()
	case CustomerImportInput:
		return parsed.CanonicalHash()
	case CustomerIDsInput:
		return parsed.CanonicalHash()
	case CustomerProfileUpdateInput:
		return parsed.CanonicalHash()
	case CustomerProfileSnapshotsInput:
		return parsed.CanonicalHash()
	case ListCustomersInput, PipelineReportInput, ListTasksInput, CustomerTimelineInput,
		CreateDealInput, MoveDealStageInput, ConvertLeadInput,
		CreateTaskInput, CompleteTaskInput, UpdateTaskDetailsInput,
		CreateQuoteInput, AcceptQuoteInput, DeclineQuoteInput, ExpireQuoteInput, ListQuotesInput,
		CreateRecurringTemplateInput, PauseRecurringTemplateInput, ResumeRecurringTemplateInput, ListRecurringTemplatesInput,
		HRHireEmployeeInput, HRDeactivateEmployeeInput, HRListEmployeesInput, HRUpdateEmployeeStructureInput,
		SalesCreateOrderInput, SalesConfirmOrderInput, SalesDeliverOrderInput, SalesCancelOrderInput, SalesListOrdersInput,
		CreateInvoiceInput, RecordFxRateInput, RecordPaymentInput, ReversePaymentInput, TrialBalanceInput,
		CreateProjectInput, ProjectBoardInput, ArchiveProjectInput, CreateProjectTaskInput, MoveProjectTaskInput, AssignProjectTaskInput:
		return canonicalHash(parsed)
	default:
		return "", errors.New("unsupported capability input")
	}
}

func verifySystemApproval(
	ctx context.Context,
	tx pgx.Tx,
	orgID, capabilityID, approvalID, inputHash string,
	now time.Time,
) (bool, error) {
	var storedCapabilityID, status string
	var storedPayload []byte
	var unexpired bool
	err := tx.QueryRow(ctx, `
		SELECT capability_id, status, payload,
	       expires_at IS NULL OR expires_at > $3::timestamptz
		FROM approvals
		WHERE id = $1::uuid AND org_id = $2::uuid`, approvalID, orgID, now).
		Scan(&storedCapabilityID, &status, &storedPayload, &unexpired)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if storedCapabilityID != capabilityID || !unexpired || (status != "pending" && status != "executing") {
		return false, nil
	}
	digest, err := InputHash(storedPayload)
	if err != nil {
		return false, nil
	}
	return digest == inputHash, nil
}

func verifyIdentity(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, now time.Time) error {
	if claims.AuthSessionID == "" {
		return ErrSessionInvalid
	}
	var authEmail string
	var expiresAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT au.email, s.expires_at
		FROM auth_session s
		JOIN auth_user au ON au.id = s.user_id
		WHERE s.id = $1 AND au.email_verified = true AND s.expires_at > $2`, claims.AuthSessionID, now).Scan(&authEmail, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSessionInvalid
	}
	if err != nil {
		return err
	}
	if expiresAt.IsZero() || !expiresAt.After(now) {
		return ErrSessionInvalid
	}
	var member bool
	err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id = $1::uuid AND user_id = $2::uuid)`, claims.OrganizationID, claims.Subject).Scan(&member)
	if err != nil {
		return err
	}
	if !member {
		return ErrNotMember
	}
	var domainEmail string
	err = tx.QueryRow(ctx, `SELECT email FROM users WHERE id = $1::uuid`, claims.Subject).Scan(&domainEmail)
	if errors.Is(err, pgx.ErrNoRows) || normalizeIdentityEmail(authEmail) != normalizeIdentityEmail(domainEmail) {
		return ErrSessionInvalid
	}
	if err != nil {
		return err
	}
	if claims.ActorType == "agent" {
		if claims.AgentSessionID == "" || !isUUID(claims.AgentSessionID) {
			return ErrSessionInvalid
		}
		var agentSession bool
		err = tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM agent_sessions
				WHERE id = $1::uuid AND org_id = $2::uuid AND user_id = $3::uuid AND status = 'open'
			)`, claims.AgentSessionID, claims.OrganizationID, claims.Subject).Scan(&agentSession)
		if err != nil {
			return err
		}
		if !agentSession {
			return ErrSessionInvalid
		}
	} else if claims.AgentSessionID != "" {
		return ErrSessionInvalid
	}
	return nil
}

func normalizeIdentityEmail(value string) string {
	trimmed := strings.TrimFunc(value, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' })
	return cases.Lower(language.Und).String(trimmed)
}

func effectivePermissions(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims) (map[string]bool, error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT rp.permission_key
		FROM user_roles ur
		JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.org_id = ur.org_id
		WHERE ur.org_id = $1::uuid AND ur.user_id = $2::uuid`, claims.OrganizationID, claims.Subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	grants := make(map[string]bool)
	for rows.Next() {
		var permission string
		if err := rows.Scan(&permission); err != nil {
			return nil, err
		}
		grants[permission] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	effective := make(map[string]bool)
	for _, permission := range claims.Permissions {
		if permission == "*" && grants["*"] {
			effective["*"] = true
			continue
		}
		if permission == "*" {
			for grant := range grants {
				effective[grant] = true
			}
		} else if grants[permission] || grants["*"] {
			effective[permission] = true
		}
	}
	return effective, nil
}

func isModuleEnabled(ctx context.Context, tx pgx.Tx, orgID, moduleID string) (bool, error) {
	var enabledModules []byte
	err := tx.QueryRow(ctx, `SELECT enabled_modules FROM organizations WHERE id = $1::uuid`, orgID).Scan(&enabledModules)
	if err != nil {
		return false, err
	}
	if len(enabledModules) == 0 || string(enabledModules) == "null" {
		return true, nil
	}
	var modules []string
	if err := json.Unmarshal(enabledModules, &modules); err != nil {
		return false, nil
	}
	for _, enabled := range modules {
		if enabled == moduleID {
			return true, nil
		}
	}
	return false, nil
}

type policyRule struct {
	CapabilityPattern   string
	MaxRiskAutonomous   string
	MoneyThresholdMinor *int64
	RequiresApprovalFor []string
}

func requiresApproval(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, capabilityID string, spec capabilitySpec, input any) (bool, string, error) {
	rows, err := tx.Query(ctx, `
		SELECT capability_pattern, max_risk_autonomous, money_threshold_minor, requires_approval_for
		FROM policies WHERE org_id = $1::uuid`, claims.OrganizationID)
	if err != nil {
		return false, "", err
	}
	defer rows.Close()
	var matching []policyRule
	for rows.Next() {
		var rule policyRule
		var requiresRaw []byte
		if err := rows.Scan(&rule.CapabilityPattern, &rule.MaxRiskAutonomous, &rule.MoneyThresholdMinor, &requiresRaw); err != nil {
			return false, "", err
		}
		if json.Unmarshal(requiresRaw, &rule.RequiresApprovalFor) != nil {
			rule.RequiresApprovalFor = nil
		}
		if matchesCapability(rule.CapabilityPattern, capabilityID) {
			matching = append(matching, rule)
		}
	}
	if err := rows.Err(); err != nil {
		return false, "", err
	}
	rows.Close()
	if claims.ActorType != "human" && claims.ActorType != "agent" && claims.ActorType != "system" {
		return false, "within policy", nil
	}
	humanStrict := false
	for _, rule := range matching {
		for _, risk := range rule.RequiresApprovalFor {
			if risk == "*" || risk == spec.risk {
				humanStrict = true
				break
			}
		}
		if humanStrict {
			break
		}
	}
	sort.Slice(matching, func(i, j int) bool {
		if len(matching[i].CapabilityPattern) != len(matching[j].CapabilityPattern) {
			return len(matching[i].CapabilityPattern) > len(matching[j].CapabilityPattern)
		}
		return riskRank(matching[i].MaxRiskAutonomous) < riskRank(matching[j].MaxRiskAutonomous)
	})
	maxRisk := "write"
	threshold := spec.moneyThresholdMinor
	if len(matching) > 0 {
		maxRisk = matching[0].MaxRiskAutonomous
		if matching[0].MoneyThresholdMinor != nil {
			threshold = *matching[0].MoneyThresholdMinor
		}
	}
	if claims.ActorType == "human" && humanStrict {
		if spec.risk == "money" {
			amount, known := moneyAmount(input)
			if !known || amount == nil {
				return true, "amount is not knowable before execution; human approval required", nil
			}
			if *amount > threshold {
				return true, fmt.Sprintf("amount %d exceeds autonomous threshold %d", *amount, threshold), nil
			}
		} else {
			return true, fmt.Sprintf("risk class %q requires human approval by organization policy", spec.risk), nil
		}
	}
	if (claims.ActorType == "agent" || claims.ActorType == "system") && (spec.risk == "identity" || spec.risk == "destructive") {
		return true, fmt.Sprintf("risk class %q always requires human authority", spec.risk), nil
	}
	if claims.ActorType == "agent" && spec.risk == "money" {
		amount, known := moneyAmount(input)
		if !known || amount == nil {
			return true, "amount is not knowable before execution; human approval required", nil
		}
		if *amount > threshold {
			return true, fmt.Sprintf("amount %d exceeds autonomous threshold %d", *amount, threshold), nil
		}
		return false, "within policy", nil
	}
	if (claims.ActorType == "agent" || claims.ActorType == "system") && spec.risk != "money" && riskRank(spec.risk) > riskRank(maxRisk) {
		return true, fmt.Sprintf("org policy caps autonomy at %q", maxRisk), nil
	}
	return false, "within policy", nil
}

func moneyAmount(input any) (*int64, bool) {
	switch parsed := input.(type) {
	case RecordPaymentInput:
		return &parsed.AmountMinor, true
	case ReversePaymentInput:
		return nil, true
	default:
		return nil, false
	}
}

func matchesCapability(pattern, capabilityID string) bool {
	if pattern == "*" || pattern == "*.*" {
		return true
	}
	if strings.HasSuffix(pattern, ".*") {
		return strings.HasPrefix(capabilityID, strings.TrimSuffix(pattern, "*"))
	}
	return pattern == capabilityID
}

func riskRank(risk string) int {
	switch risk {
	case "read":
		return 0
	case "write":
		return 1
	case "money":
		return 2
	case "identity":
		return 3
	case "destructive":
		return 4
	case "secret":
		return 5
	default:
		return 0
	}
}

func (e *Executor) requestApproval(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, capabilityID, risk string, input any, rationale string, now time.Time) (string, error) {
	payload, err := marshalJS(input)
	if err != nil {
		return "", err
	}
	var agentSessionID *string
	if claims.AgentSessionID != "" {
		agentSessionID = &claims.AgentSessionID
	}
	var requestedByUserID any
	if claims.ActorType != "system" {
		requestedByUserID = claims.Subject
	}
	var approvalID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO approvals (org_id, session_id, requested_by_user_id, capability_id, risk_class, payload, rationale, status, expires_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, 'pending', $8)
		RETURNING id::text`, claims.OrganizationID, agentSessionID, requestedByUserID, capabilityID, risk, payload, rationale, now.Add(approvalTTL)).Scan(&approvalID); err != nil {
		return "", err
	}
	request := struct {
		CapabilityID string `json:"capabilityId"`
		RiskClass    string `json:"riskClass"`
		Payload      any    `json:"payload"`
		Rationale    string `json:"rationale"`
	}{CapabilityID: capabilityID, RiskClass: risk, Payload: input, Rationale: rationale}
	requestJSON, err := marshalJS(request)
	if err != nil {
		return "", err
	}
	actorID := claims.ActorID
	capID := capabilityID
	if err := e.enqueueApprovalNotifications(ctx, tx, claims.OrganizationID, request); err != nil {
		return "", err
	}
	if err := bestEffortApprovalFeed(ctx, tx, claims.OrganizationID, capabilityID, rationale); err != nil {
		return "", err
	}
	if _, _, err := ledger.AppendTx(ctx, tx, ledger.AppendEvent{
		OrgID:        claims.OrganizationID,
		ActorType:    claims.ActorType,
		ActorID:      actorID,
		Kind:         "approval.requested",
		CapabilityID: &capID,
		SessionID:    agentSessionID,
		Payload:      requestJSON,
		OccurredAt:   now,
	}); err != nil {
		return "", err
	}
	return approvalID, nil
}

func (e *Executor) enqueueApprovalNotifications(ctx context.Context, tx pgx.Tx, orgID string, request any) error {
	if e.webhookURL != "" {
		var body struct {
			Event        string `json:"event"`
			CapabilityID string `json:"capabilityId"`
			Risk         string `json:"risk"`
			Rationale    string `json:"rationale"`
		}
		encoded, err := json.Marshal(request)
		if err != nil {
			return err
		}
		var requestMap map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &requestMap); err != nil {
			return err
		}
		if err := json.Unmarshal(requestMap["capabilityId"], &body.CapabilityID); err != nil {
			return err
		}
		if err := json.Unmarshal(requestMap["riskClass"], &body.Risk); err != nil {
			return err
		}
		if err := json.Unmarshal(requestMap["rationale"], &body.Rationale); err != nil {
			return err
		}
		body.Event = "approval.requested"
		if err := e.insertOutbox(ctx, tx, orgID, "webhook", "approval.webhook", map[string]any{"req": request, "orgId": orgID}, map[string]any{"url": e.webhookURL, "body": body}); err != nil {
			return err
		}
	}
	if e.smtpHost != "" && e.smtpTo != "" {
		var requestMap map[string]json.RawMessage
		encoded, err := json.Marshal(request)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(encoded, &requestMap); err != nil {
			return err
		}
		var capabilityID, risk, rationale string
		if err := json.Unmarshal(requestMap["capabilityId"], &capabilityID); err != nil {
			return err
		}
		if err := json.Unmarshal(requestMap["riskClass"], &risk); err != nil {
			return err
		}
		if err := json.Unmarshal(requestMap["rationale"], &rationale); err != nil {
			return err
		}
		text := "An action is waiting for human approval.\n\nCapability: " + capabilityID + "\nRisk class: " + risk + "\nRationale: " + rationale + "\n\nOpen the Approvals inbox to decide."
		payload := map[string]any{"to": e.smtpTo, "subject": "[Chaste] Approval needed: " + capabilityID, "text": text}
		if err := e.insertOutbox(ctx, tx, orgID, "email", "approval.email", map[string]any{"req": request, "orgId": orgID}, payload); err != nil {
			return err
		}
	}
	return nil
}

func (e *Executor) insertOutbox(ctx context.Context, tx pgx.Tx, orgID, kind, keyKind string, keyValue, payload any) error {
	keyRaw, err := marshalJS(keyValue)
	if err != nil {
		return err
	}
	keyObject, err := decodeJSON(keyRaw)
	if err != nil {
		return err
	}
	keyBytes, err := marshalJS(keyObject)
	if err != nil {
		return err
	}
	keyHash := sha256.Sum256(keyBytes)
	dedupeKey := "notification:" + keyKind + ":" + hex.EncodeToString(keyHash[:])
	payloadJSON, err := marshalJS(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO outbox_messages (org_id, kind, dedupe_key, provider_operation_id, payload)
		VALUES ($1::uuid, $2, $3, gen_random_uuid(), $4::jsonb)
		ON CONFLICT (org_id, dedupe_key) DO NOTHING`, orgID, kind, dedupeKey, payloadJSON)
	return err
}

func bestEffortApprovalFeed(ctx context.Context, tx pgx.Tx, orgID, capabilityID, rationale string) error {
	if _, err := tx.Exec(ctx, `SAVEPOINT approval_feed`); err != nil {
		return err
	}
	title := (capabilityID + " needs approval - " + rationale)
	if len(title) > 200 {
		title = title[:200]
	}
	_, insertErr := tx.Exec(ctx, `
		INSERT INTO notifications (org_id, user_id, kind, title, href)
		VALUES ($1::uuid, NULL, 'approval.requested', $2, '/approvals')`, orgID, title)
	if insertErr != nil {
		if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT approval_feed`); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `RELEASE SAVEPOINT approval_feed`)
	return err
}

type actionReceipt struct {
	CapabilityID string
	InputHash    string
	OK           bool
	Data         json.RawMessage
	Error        string
	Outcome      string
	Replayed     bool
}

func loadReceipt(ctx context.Context, tx pgx.Tx, orgID, intentKey string) (actionReceipt, bool, error) {
	var receipt actionReceipt
	var data []byte
	err := tx.QueryRow(ctx, `
		SELECT capability_id, input_hash, ok, data, COALESCE(error, ''), outcome
		FROM action_receipts WHERE org_id = $1::uuid AND intent_key = $2`, orgID, intentKey).
		Scan(&receipt.CapabilityID, &receipt.InputHash, &receipt.OK, &data, &receipt.Error, &receipt.Outcome)
	if errors.Is(err, pgx.ErrNoRows) {
		return actionReceipt{}, false, nil
	}
	if err != nil {
		return actionReceipt{}, false, err
	}
	receipt.Data = append(json.RawMessage(nil), data...)
	return receipt, true, nil
}

func insertReceipt(ctx context.Context, tx pgx.Tx, orgID, intentKey, capabilityID, inputHash string, result Result) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO action_receipts (org_id, intent_key, capability_id, input_hash, ok, outcome, data, error)
		VALUES ($1::uuid, $2, $3, $4, $5, 'known', $6::jsonb, NULL)`, orgID, intentKey, capabilityID, inputHash, result.OK, result.Data)
	return err
}

func createCustomer(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input CreateCustomerInput) (CreateCustomerOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT name, email, phone FROM customers
		WHERE org_id = $1::uuid AND merged_into_customer_id IS NULL
		LIMIT 500`, claims.OrganizationID)
	if err != nil {
		return CreateCustomerOutput{}, err
	}
	existing := make([]crm.CustomerFingerprint, 0, 500)
	for rows.Next() {
		var fingerprint crm.CustomerFingerprint
		if err := rows.Scan(&fingerprint.Name, &fingerprint.Email, &fingerprint.Phone); err != nil {
			rows.Close()
			return CreateCustomerOutput{}, err
		}
		existing = append(existing, fingerprint)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return CreateCustomerOutput{}, err
	}
	rows.Close()
	verdict := crm.FindDuplicate(existing, crm.CustomerFingerprint{Name: input.Name, Email: input.Email, Phone: input.Phone})
	var updatedByUserID *string
	if claims.ActorType == "human" {
		updatedByUserID = claims.ActorID
	}
	var customerID string
	err = tx.QueryRow(ctx, `
		INSERT INTO customers (org_id, name, email, phone, preferred_contact_method, do_not_contact, updated_by_user_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
		RETURNING id::text`, claims.OrganizationID, input.Name, input.Email, input.Phone, input.PreferredContactMethod, input.DoNotContact, updatedByUserID).Scan(&customerID)
	if err != nil {
		return CreateCustomerOutput{}, err
	}
	var warning *string
	if verdict.Duplicate && verdict.ExistingName != nil && verdict.Reason != nil {
		value := `Looks like existing customer "` + *verdict.ExistingName + `" (matched by ` + string(*verdict.Reason) + `). Merge or deactivate one of them.`
		warning = &value
	}
	return CreateCustomerOutput{CustomerID: customerID, DuplicateWarning: warning}, nil
}

func deactivateCustomer(ctx context.Context, tx pgx.Tx, orgID string, input DeactivateCustomerInput, now time.Time) (DeactivateCustomerOutput, error) {
	_, err := tx.Exec(ctx, `
		UPDATE customers SET deactivated_at = $1
		WHERE org_id = $2::uuid AND id = $3::uuid`, now, orgID, input.CustomerID)
	if err != nil {
		return DeactivateCustomerOutput{}, err
	}
	return DeactivateCustomerOutput{Deactivated: true}, nil
}
