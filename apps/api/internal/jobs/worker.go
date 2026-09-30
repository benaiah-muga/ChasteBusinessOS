package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

const (
	DefaultLeaseDuration = 60 * time.Second
	DefaultPollInterval  = 2 * time.Second
	maxBackoff           = 5 * time.Minute
)

var ErrUnsafeJobsWorkerRole = errors.New("unsafe Go capability jobs worker role")

type QueryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

type SystemCapabilityExecutor interface {
	ExecuteSystem(context.Context, capability.SystemClaims, json.RawMessage) (capability.Result, error)
}

type RoutineJobRunner interface {
	Run(context.Context, string, string, json.RawMessage) error
}

type ClaimedJob struct {
	ID                 string
	OrgID              string
	Type               string
	Attempts           int
	MaxAttempts        int
	WorkerID           string
	FencingToken       int
	LeaseExpiresAt     time.Time
	RunID              *string
	RunStepIndex       *int
	ApprovedApprovalID *string
	Payload            json.RawMessage
}

type Options struct {
	WorkerID           string
	LeaseDuration      time.Duration
	PollInterval       time.Duration
	Now                func() time.Time
	Logger             *slog.Logger
	RoutineRunner      RoutineJobRunner
	RoutineAgentRunner bool
	RoutineScheduler   bool
}

type Worker struct {
	queueDB            dbx.Beginner
	claimDB            QueryRower
	effectDB           dbx.Beginner
	executor           SystemCapabilityExecutor
	workerID           string
	lease              time.Duration
	poll               time.Duration
	now                func() time.Time
	logger             *slog.Logger
	routines           RoutineJobRunner
	routineAgentRunner bool
	routineScheduler   bool
}

// GoCapabilityPermissions is the explicit bridge between SQL claim ownership
// and capabilities with an established Go executor implementation. Keep the
// migration's claim list in sync with these IDs. Document processing remains
// with the legacy worker; routine agent jobs use RoutineJobRunner because they
// contain a model/tool loop and are not single-capability executions.
var GoCapabilityPermissions = map[string]string{
	"documents.listDocs":                       "documents.read",
	"documents.listDocVersions":                "documents.read",
	"documents.getDocVersion":                  "documents.read",
	"crm.createCustomer":                       "crm.write",
	"crm.deactivateCustomer":                   "crm.write",
	"crm.mergeCustomers":                       "crm.write",
	"crm.restoreCustomerMerge":                 "crm.write",
	"crm.importCustomers":                      "crm.write",
	"crm.undoCustomerImport":                   "crm.write",
	"crm.restoreImportedCustomers":             "crm.write",
	"crm.updateCustomerProfiles":               "crm.write",
	"crm.restoreCustomerProfiles":              "crm.write",
	"crm.reapplyCustomerProfiles":              "crm.write",
	"crm.listCustomers":                        "crm.read",
	"crm.listCustomerViews":                    "crm.read",
	"crm.pipelineReport":                       "crm.read",
	"crm.listTasks":                            "crm.read",
	"crm.customerTimeline":                     "crm.read",
	"crm.createDeal":                           "crm.write",
	"crm.moveDealStage":                        "crm.write",
	"crm.convertLead":                          "crm.write",
	"crm.createTask":                           "crm.write",
	"crm.completeTask":                         "crm.write",
	"crm.updateTaskDetails":                    "crm.write",
	"crm.restoreTaskDetails":                   "crm.write",
	"accounting.createQuote":                   "accounting.write",
	"accounting.acceptQuote":                   "accounting.write",
	"accounting.declineQuote":                  "accounting.write",
	"accounting.expireQuote":                   "accounting.write",
	"accounting.listQuotes":                    "accounting.read",
	"accounting.createRecurringTemplate":       "accounting.write",
	"accounting.pauseRecurringTemplate":        "accounting.write",
	"accounting.resumeRecurringTemplate":       "accounting.write",
	"accounting.listRecurringTemplates":        "accounting.read",
	"hr.hireEmployee":                          "hr.write",
	"hr.deactivateEmployee":                    "hr.write",
	"hr.listEmployees":                         "hr.read",
	"hr.updateEmployeeStructure":               "hr.write",
	"sales.createOrder":                        "sales.write",
	"sales.confirmOrder":                       "sales.write",
	"sales.deliverOrder":                       "sales.write",
	"sales.cancelOrder":                        "sales.write",
	"sales.listOrders":                         "sales.read",
	"accounting.createInvoice":                 "accounting.write",
	"accounting.recordFxRate":                  "accounting.post",
	"accounting.recordPayment":                 "accounting.post",
	"accounting.reversePayment":                "accounting.post",
	"accounting.trialBalance":                  "accounting.read",
	"accounting.decideExpenseClaim":            "expenses.decide",
	"accounting.payExpenseClaim":               "accounting.post",
	"accounting.listExpenseClaims":             "expenses.decide",
	"accounting.listExpensePolicies":           "expenses.decide",
	"accounting.setExpensePolicy":              "expenses.decide",
	"purchasing.createVendor":                  "purchasing.write",
	"purchasing.createPurchaseOrder":           "purchasing.write",
	"purchasing.receiveGoods":                  "purchasing.write",
	"purchasing.returnGoods":                   "purchasing.write",
	"purchasing.createBill":                    "purchasing.write",
	"purchasing.payBill":                       "purchasing.post",
	"purchasing.reverseVendorPayment":          "purchasing.post",
	"inventory.adjustStock":                    "inventory.write",
	"inventory.createTransfer":                 "inventory.write",
	"inventory.confirmTransfer":                "inventory.write",
	"inventory.cancelTransfer":                 "inventory.write",
	"inventory.reverseTransfer":                "inventory.write",
	"inventory.listTransfers":                  "inventory.read",
	"inventory.createCycleCount":               "inventory.write",
	"inventory.recordCycleCounts":              "inventory.write",
	"inventory.postCycleCount":                 "inventory.write",
	"inventory.cancelCycleCount":               "inventory.write",
	"pos.openSession":                          "pos.write",
	"pos.completeSale":                         "pos.sell",
	"pos.closeSession":                         "pos.write",
	"pos.returnSale":                           "pos.sell",
	"pos.shiftSummary":                         "pos.read",
	"accounting.creditNote":                    "accounting.post",
	"accounting.shareInvoice":                  "accounting.write",
	"accounting.generateDueInvoices":           "accounting.write",
	"accounting.reverseEntry":                  "accounting.post",
	"accounting.addBankAccount":                "accounting.write",
	"accounting.importBankFeed":                "accounting.write",
	"accounting.deleteBankTransaction":         "accounting.write",
	"accounting.matchBankTransaction":          "accounting.write",
	"accounting.unmatchBankTransaction":        "accounting.write",
	"accounting.bankReconciliation":            "accounting.read",
	"accounting.excludeBankTransaction":        "accounting.write",
	"accounting.unexcludeBankTransaction":      "accounting.write",
	"accounting.bankSummary":                   "accounting.read",
	"purchasing.createPurchaseRequest":         "purchasing.write",
	"purchasing.decidePurchaseRequest":         "purchasing.write",
	"purchasing.createRfq":                     "purchasing.write",
	"purchasing.recordQuote":                   "purchasing.write",
	"purchasing.selectWinningQuote":            "purchasing.write",
	"purchasing.listPurchaseWorkflow":          "purchasing.read",
	"inventory.createItem":                     "inventory.write",
	"inventory.updateItem":                     "inventory.write",
	"inventory.restoreItem":                    "inventory.write",
	"inventory.archiveItem":                    "inventory.write",
	"inventory.createLocation":                 "inventory.write",
	"inventory.listLocations":                  "inventory.read",
	"inventory.lookupByBarcode":                "inventory.read",
	"inventory.importItems":                    "inventory.write",
	"inventory.undoItemImport":                 "inventory.write",
	"inventory.restoreItemImport":              "inventory.write",
	"inventory.reserveStock":                   "inventory.write",
	"inventory.releaseReservation":             "inventory.write",
	"inventory.listReservations":               "inventory.read",
	"purchasing.createPaymentRun":              "purchasing.write",
	"purchasing.cancelPaymentRunDraft":         "purchasing.write",
	"purchasing.restorePaymentRunDraft":        "purchasing.write",
	"purchasing.instructPaymentRun":            "purchasing.post",
	"purchasing.reversePaymentRun":             "purchasing.post",
	"purchasing.listPaymentRuns":               "purchasing.read",
	"accounting.periodCloseWorkbench":          "accounting.read",
	"accounting.updatePeriodCloseCheck":        "accounting.write",
	"accounting.restorePeriodCloseCheck":       "accounting.write",
	"accounting.closePeriod":                   "accounting.admin",
	"accounting.reopenPeriod":                  "accounting.admin",
	"accounting.closeYear":                     "accounting.admin",
	"accounting.saveBudgetScenario":            "accounting.write",
	"accounting.undoBudgetScenarioVersion":     "accounting.write",
	"accounting.restoreBudgetScenarioVersion":  "accounting.write",
	"accounting.listBudgetScenarios":           "accounting.read",
	"accounting.budgetActualVsPlan":            "accounting.read",
	"accounting.createTaxProfile":              "accounting.admin",
	"accounting.removeTaxProfile":              "accounting.admin",
	"accounting.createTaxCode":                 "accounting.admin",
	"accounting.archiveTaxCode":                "accounting.admin",
	"accounting.activateTaxCode":               "accounting.admin",
	"accounting.createTaxReturn":               "accounting.write",
	"accounting.cancelTaxReturnDraft":          "accounting.write",
	"accounting.restoreTaxReturnDraft":         "accounting.write",
	"accounting.recordTaxReturnSubmission":     "accounting.post",
	"accounting.createTaxReturnAmendment":      "accounting.write",
	"accounting.recordTaxReturnAcknowledgment": "accounting.admin",
	"accounting.fileSalesTaxReturn":            "accounting.post",
	"hr.requestLeave":                          "hr.write",
	"hr.cancelLeave":                           "hr.write",
	"hr.decideLeave":                           "hr.write",
	"hr.logTime":                               "hr.write",
	"hr.decideTimeEntry":                       "hr.write",
	"hr.clockIn":                               "hr.write",
	"hr.clockOut":                              "hr.write",
	"hr.leaveBalance":                          "hr.read",
	"hr.leaveCalendar":                         "hr.read",
	"hr.timeReport":                            "hr.read",
	"hr.createPayrollRun":                      "hr.write",
	"hr.executePayrollRun":                     "hr.write",
	"hr.voidPayrollRun":                        "hr.write",
	"hr.reversePayrollPosting":                 "hr.write",
	"hr.addApplicant":                          "hr.write",
	"hr.moveApplicant":                         "hr.write",
	"hr.hireApplicant":                         "hr.write",
	"hr.listApplicants":                        "hr.read",
	"purchasing.billCreditNote":                "purchasing.write",
	"purchasing.closePurchaseOrder":            "purchasing.write",
	"purchasing.listReceipts":                  "purchasing.read",
	"purchasing.apAging":                       "purchasing.read",
	"accounting.buildReminders":                "accounting.read",
	"manufacturing.createWorkOrder":            "manufacturing.write",
	"manufacturing.releaseWorkOrder":           "manufacturing.write",
	"manufacturing.completeWorkOrder":          "manufacturing.write",
	"manufacturing.cancelWorkOrder":            "manufacturing.write",
	"manufacturing.reverseProductionRun":       "manufacturing.write",
	"manufacturing.checkProductionFeasibility": "manufacturing.read",
	"manufacturing.workOrdersList":             "manufacturing.read",
	"manufacturing.produceFromBom":             "manufacturing.write",
	"manufacturing.defineBom":                  "manufacturing.write",
	"manufacturing.deleteBom":                  "manufacturing.write",
	"manufacturing.bomTree":                    "manufacturing.read",
	"manufacturing.bomReport":                  "manufacturing.read",
	"manufacturing.costPreview":                "manufacturing.read",
	"manufacturing.lotTrace":                   "manufacturing.read",
	"manufacturing.productionRuns":             "manufacturing.read",
	"marketing.createSegment":                  "marketing.write",
	"marketing.createCampaign":                 "marketing.write",
	"marketing.sendCampaign":                   "marketing.write",
	"marketing.campaignAnalytics":              "marketing.read",
	"hr.createOpening":                         "hr.write",
	"hr.closeOpening":                          "hr.write",
	"iam.setModules":                           "iam.admin",
	"iam.restoreModules":                       "iam.admin",
	"iam.setModuleConfig":                      "iam.admin",
	"iam.setOrgPolicy":                         "iam.admin",
	"iam.setOrgBranding":                       "iam.admin",
	"purchasing.supplierPerformance":           "purchasing.read",
	"purchasing.priceHistory":                  "purchasing.read",
	"purchasing.supplierStatement":             "purchasing.read",
	"signals.list":                             "signals.read",
	"skills.find":                              "documents.read",
	"skills.load":                              "documents.read",
	"routines.create":                          "routines.write",
	"routines.list":                            "routines.read",
	"routines.update":                          "routines.write",
	"routines.delete":                          "routines.write",
	"routines.runNow":                          "routines.write",
	"analytics.renderReport":                   "analytics.report",
	"analytics.pipelineByStage":                "crm.read",
	"analytics.revenueByMonth":                 "accounting.read",
	"analytics.invoiceAging":                   "accounting.read",
	"analytics.salesByCustomer":                "accounting.read",
	"analytics.stockLevels":                    "inventory.read",
	"analytics.explainChange":                  "analytics.report",
	"analytics.askYourBusiness":                "analytics.report",
	"support.startConversation":                "support.write",
	"support.postMessage":                      "support.write",
	"support.listConversations":                "support.read",
	"support.readConversation":                 "support.read",
	"support.lookupOrderStatus":                "support.read",
	"support.searchKnowledge":                  "support.read",
	"support.escalateConversation":             "support.write",
	"support.resolveConversation":              "support.write",
	"support.reopenConversation":               "support.write",
	"support.createTicket":                     "support.write",
	"support.updateTicket":                     "support.write",
	"support.suggestCategory":                  "support.read",
	"support.createCannedResponse":             "support.write",
	"support.createKbArticle":                  "support.write",
	"inventory.postValuationSummary":           "inventory.write",
	"inventory.reverseValuationSummary":        "inventory.write",
	"inventory.stockReport":                    "inventory.read",
	"inventory.itemHistory":                    "inventory.read",
	"inventory.listLots":                       "inventory.read",
	"inventory.listCycleCounts":                "inventory.read",
	"inventory.rebuildStockProjections":        "inventory.admin",
	"accounting.incomeStatement":               "accounting.read",
	"accounting.balanceSheet":                  "accounting.read",
	"accounting.listInvoices":                  "accounting.read",
	"accounting.arAging":                       "accounting.read",
	"accounting.cashBasisReport":               "accounting.read",
	"accounting.customerStatement":             "accounting.read",
	"accounting.salesTaxReport":                "accounting.read",
	"accounting.cashFlow":                      "accounting.read",
	"accounting.cashForecast":                  "accounting.read",
	"accounting.unrealizedFxExposure":          "accounting.read",
	"accounting.revalueForeignReceivables":     "accounting.post",
	"accounting.reversePeriodFxRevaluation":    "accounting.post",
}

func NewWorker(queueDB dbx.Beginner, claimDB QueryRower, effectDB dbx.Beginner, executor SystemCapabilityExecutor, options Options) (*Worker, error) {
	if queueDB == nil || claimDB == nil || effectDB == nil || executor == nil {
		return nil, errors.New("capability jobs worker requires queue, effect, and executor dependencies")
	}
	workerID := options.WorkerID
	if strings.TrimSpace(workerID) == "" {
		return nil, errors.New("capability jobs worker id is required")
	}
	if len(workerID) > 128 {
		return nil, errors.New("capability jobs worker id must not exceed 128 characters")
	}
	lease := options.LeaseDuration
	if lease == 0 {
		lease = DefaultLeaseDuration
	}
	if lease < time.Second || lease > 5*time.Minute {
		return nil, errors.New("capability jobs lease must be between 1 second and 5 minutes")
	}
	poll := options.PollInterval
	if poll == 0 {
		poll = DefaultPollInterval
	}
	if poll <= 0 || poll > time.Minute {
		return nil, errors.New("capability jobs poll interval must be between zero and one minute")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	routineRunner := options.RoutineRunner
	if routineRunner == nil {
		routineRunner = newRoutineAgent(effectDB, executor)
	}
	return &Worker{
		queueDB: queueDB, claimDB: claimDB, effectDB: effectDB, executor: executor,
		workerID: workerID, lease: lease, poll: poll, now: now, logger: logger,
		routines: routineRunner, routineAgentRunner: options.RoutineAgentRunner,
		routineScheduler: options.RoutineScheduler,
	}, nil
}

// VerifyRole refuses to start unless the queue connection is the dedicated,
// non-escalating, NOBYPASSRLS jobs worker login.
func VerifyRole(ctx context.Context, db QueryRower) error {
	var roleName string
	var canLogin, isSuperuser, canCreateDB, canCreateRole, canReplicate, bypassesRLS, inherits, hasMemberships bool
	err := db.QueryRow(ctx, `
		SELECT role.rolname, role.rolcanlogin, role.rolsuper, role.rolcreatedb,
		       role.rolcreaterole, role.rolreplication, role.rolbypassrls, role.rolinherit,
		       EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member = role.oid)
		FROM pg_roles role WHERE role.rolname = current_user`).Scan(
		&roleName, &canLogin, &isSuperuser, &canCreateDB, &canCreateRole,
		&canReplicate, &bypassesRLS, &inherits, &hasMemberships,
	)
	if err != nil {
		return err
	}
	if roleName != "chaste_jobs_worker" || !canLogin || isSuperuser || canCreateDB || canCreateRole || canReplicate || bypassesRLS || inherits || hasMemberships {
		return ErrUnsafeJobsWorkerRole
	}
	return nil
}

func (w *Worker) ClaimOne(ctx context.Context) (*ClaimedJob, error) {
	var job ClaimedJob
	var runID, approvalID *string
	var runStepIndex *int
	tx, err := w.queueDB.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.go_routine_agent_runner', $1, true)`, map[bool]string{true: "1", false: "0"}[w.routineAgentRunner]); err != nil {
		return nil, err
	}
	err = tx.QueryRow(ctx, `
		SELECT id, org_id, type, attempts, max_attempts, fencing_token,
		       lease_owner, lease_expires_at, run_id, run_step_index, approved_approval_id
		FROM jobs_worker.claim_capability_job($1, $2)`, w.workerID, w.lease.Milliseconds()).Scan(
		&job.ID, &job.OrgID, &job.Type, &job.Attempts, &job.MaxAttempts,
		&job.FencingToken, &job.WorkerID, &job.LeaseExpiresAt,
		&runID, &runStepIndex, &approvalID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if job.ID == "" || job.OrgID == "" || job.WorkerID != w.workerID || job.FencingToken < 1 || job.Attempts < 1 || job.MaxAttempts < job.Attempts {
		return nil, errors.New("capability jobs claim returned invalid lease metadata")
	}
	if _, ok := GoCapabilityPermissions[job.Type]; !ok && job.Type != routineJobType {
		return nil, fmt.Errorf("claim function returned unsupported Go job type %q", job.Type)
	}
	job.RunID = runID
	job.RunStepIndex = runStepIndex
	job.ApprovedApprovalID = approvalID
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &job, nil
}

func (w *Worker) loadPayload(ctx context.Context, job *ClaimedJob) error {
	_, err := dbx.WithOrgTx(ctx, w.queueDB, job.OrgID, func(tx pgx.Tx) (struct{}, error) {
		if err := w.setRoutineRunnerGate(ctx, tx, job); err != nil {
			return struct{}{}, err
		}
		var payload []byte
		err := tx.QueryRow(ctx, `
			SELECT payload
			FROM public.jobs
			WHERE id = $1::uuid AND org_id = $2::uuid
			  AND status = 'processing' AND lease_owner = $3 AND fencing_token = $4`,
			job.ID, job.OrgID, job.WorkerID, job.FencingToken,
		).Scan(&payload)
		if err != nil {
			return struct{}{}, err
		}
		if !json.Valid(payload) {
			return struct{}{}, errors.New("job payload is not valid JSON")
		}
		job.Payload = append(job.Payload[:0], payload...)
		return struct{}{}, nil
	})
	return err
}

func (w *Worker) renewLease(ctx context.Context, job *ClaimedJob) (bool, error) {
	now := w.now().UTC()
	var updated string
	_, err := dbx.WithOrgTx(ctx, w.queueDB, job.OrgID, func(tx pgx.Tx) (struct{}, error) {
		if err := w.setRoutineRunnerGate(ctx, tx, job); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, tx.QueryRow(ctx, `
			UPDATE public.jobs
			SET lease_expires_at = $5::timestamptz, updated_at = $5::timestamptz
			WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'processing'
			  AND lease_owner = $3 AND fencing_token = $4
			RETURNING id::text`, job.ID, job.OrgID, job.WorkerID, job.FencingToken,
			now.Add(w.lease)).Scan(&updated)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return updated != "", nil
}

func (w *Worker) finalize(ctx context.Context, job *ClaimedJob, status, lastError string, availableAt *time.Time) (bool, error) {
	if status != "done" && status != "failed" && status != "pending" {
		return false, errors.New("invalid capability job final status")
	}
	now := w.now().UTC()
	var updated string
	_, err := dbx.WithOrgTx(ctx, w.queueDB, job.OrgID, func(tx pgx.Tx) (struct{}, error) {
		if err := w.setRoutineRunnerGate(ctx, tx, job); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, tx.QueryRow(ctx, `
			UPDATE public.jobs
			SET status = $5,
			    last_error = $6,
			    available_at = COALESCE($7::timestamptz, available_at),
			    lease_owner = NULL,
			    lease_expires_at = NULL,
			    updated_at = $8::timestamptz
			WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'processing'
			  AND lease_owner = $3 AND fencing_token = $4
			RETURNING id::text`, job.ID, job.OrgID, job.WorkerID, job.FencingToken,
			status, nullableError(lastError), availableAt, now).Scan(&updated)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return updated != "", nil
}

func (w *Worker) setRoutineRunnerGate(ctx context.Context, tx pgx.Tx, job *ClaimedJob) error {
	if job.Type != routineJobType {
		return nil
	}
	value := "0"
	if w.routineAgentRunner {
		value = "1"
	}
	_, err := tx.Exec(ctx, `SELECT set_config('app.go_routine_agent_runner', $1, true)`, value)
	return err
}

func (w *Worker) ProcessOne(ctx context.Context) (bool, error) {
	if _, err := w.scheduleDueRoutines(ctx, w.now()); err != nil {
		return false, err
	}
	job, err := w.ClaimOne(ctx)
	if err != nil || job == nil {
		return job != nil, err
	}
	log := w.logger.With("job_id", job.ID, "capability_id", job.Type, "org_id", job.OrgID)
	var leaseLost atomic.Bool
	stopHeartbeat := make(chan struct{})
	var heartbeatDone = make(chan struct{})
	heartbeatInterval := w.lease / 3
	if heartbeatInterval < 100*time.Millisecond {
		heartbeatInterval = 100 * time.Millisecond
	}
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stopHeartbeat:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				owned, renewErr := w.renewLease(ctx, job)
				if renewErr == nil && !owned {
					leaseLost.Store(true)
				}
			}
		}
	}()
	defer func() {
		close(stopHeartbeat)
		<-heartbeatDone
	}()

	stepIndex, durable := durableStep(job)
	if durable {
		if err := w.transitionRun(ctx, job, "running", stepIndex, ""); err != nil {
			return true, err
		}
		if err := w.transitionStep(ctx, job, stepIndex, "running", nil, "", nil, job.ApprovedApprovalID); err != nil {
			return true, err
		}
	}

	processErr := w.loadPayload(ctx, job)
	if processErr == nil {
		if job.Type == routineJobType {
			if w.routines == nil {
				processErr = errors.New("Go routine agent runner is unavailable")
			} else {
				processErr = w.routines.Run(ctx, job.OrgID, job.ID, job.Payload)
				if processErr == nil {
					if !leaseLost.Load() {
						finalized, err := w.finalize(ctx, job, "done", "", nil)
						if err != nil {
							return true, err
						}
						if !finalized {
							log.Warn("routine completed after lease was lost; acknowledgement fenced")
						}
					}
					log.Info("routine job done", "attempts", job.Attempts)
					return true, nil
				}
			}
		} else if permission, ok := GoCapabilityPermissions[job.Type]; !ok {
			processErr = fmt.Errorf("unknown job capability: %s", job.Type)
		} else {
			result, executeErr := w.executor.ExecuteSystem(ctx, capability.SystemClaims{
				OrganizationID: job.OrgID, CapabilityID: job.Type, Permission: permission,
				IntentID: job.ID, ApprovedApprovalID: optionalValue(job.ApprovedApprovalID),
			}, job.Payload)
			if executeErr != nil {
				processErr = executeErr
			} else if !result.OK {
				message := result.Error
				if message == "" {
					message = "capability failed"
				}
				processErr = errors.New(message)
			} else {
				if job.ApprovedApprovalID != nil {
					if err := w.finishApproval(ctx, job.OrgID, *job.ApprovedApprovalID); err != nil {
						return true, err
					}
				}
				if durable {
					receiptID, err := w.findReceiptID(ctx, job.OrgID, job.ID)
					if err != nil {
						return true, err
					}
					if err := w.transitionStep(ctx, job, stepIndex, "committed", result.Data, "", receiptID, job.ApprovedApprovalID); err != nil {
						return true, err
					}
				}
				if !leaseLost.Load() {
					finalized, err := w.finalize(ctx, job, "done", "", nil)
					if err != nil {
						return true, err
					}
					if !finalized {
						log.Warn("job completed after lease was lost; acknowledgement fenced")
					}
				}
				log.Info("job done", "attempts", job.Attempts, "receipt_replayed", result.Replayed)
				return true, nil
			}
		}
	}

	message := processErr.Error()
	exhausted := job.Attempts >= job.MaxAttempts || strings.HasPrefix(message, "unknown job capability:")
	if durable && exhausted {
		if err := w.transitionStep(ctx, job, stepIndex, "failed", nil, message, nil, job.ApprovedApprovalID); err != nil {
			return true, err
		}
		if err := w.transitionRun(ctx, job, "failed", stepIndex, message); err != nil {
			return true, err
		}
	}
	if !leaseLost.Load() {
		status := "pending"
		var availableAt *time.Time
		if exhausted {
			status = "failed"
		} else {
			next := w.now().Add(retryDelay(job.Attempts))
			availableAt = &next
		}
		finalized, err := w.finalize(ctx, job, status, message, availableAt)
		if err != nil {
			return true, err
		}
		if !finalized {
			log.Warn("job failure after lease was lost; acknowledgement fenced", "error", message)
		}
	}
	log.Warn("job attempt failed", "attempts", job.Attempts, "exhausted", exhausted, "error", message)
	return true, nil
}

func (w *Worker) Run(ctx context.Context) error {
	for ctx.Err() == nil {
		worked, err := w.ProcessOne(context.WithoutCancel(ctx))
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			w.logger.Error("capability jobs worker loop error", "error", err.Error())
			if !sleepContext(ctx, w.poll) {
				return nil
			}
			continue
		}
		if !worked && !sleepContext(ctx, w.poll) {
			return nil
		}
	}
	return nil
}

func (w *Worker) transitionRun(ctx context.Context, job *ClaimedJob, status string, currentStep int, message string) error {
	terminal := status == "failed" || status == "cancelled" || status == "completed"
	_, err := dbx.WithOrgTx(ctx, w.effectDB, job.OrgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `
			UPDATE public.agent_runs
			SET status = $3, current_step = $4, last_error = $5,
			    started_at = CASE WHEN $3 = 'running' THEN clock_timestamp() ELSE started_at END,
			    finished_at = CASE WHEN $6 THEN clock_timestamp() ELSE finished_at END,
			    updated_at = clock_timestamp()
			WHERE id = $1::uuid AND org_id = $2::uuid`,
			*job.RunID, job.OrgID, status, currentStep, nullableError(message), terminal)
		return struct{}{}, err
	})
	return err
}

func (w *Worker) transitionStep(ctx context.Context, job *ClaimedJob, index int, status string, output json.RawMessage, message string, receiptID *string, approvalID *string) error {
	terminal := status == "failed" || status == "cancelled" || status == "committed"
	var outputValue any
	if len(output) > 0 {
		outputValue = []byte(output)
	}
	var receiptValue any
	if receiptID != nil {
		receiptValue = *receiptID
	}
	var approvalValue any
	if approvalID != nil {
		approvalValue = *approvalID
	}
	_, err := dbx.WithOrgTx(ctx, w.effectDB, job.OrgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `
			UPDATE public.agent_run_steps
			SET status = $4, output = COALESCE($5::jsonb, output), error = $6,
			    receipt_id = CASE WHEN $4 = 'committed' THEN $7::uuid ELSE receipt_id END,
			    approval_id = $8::uuid,
			    started_at = CASE WHEN $4 = 'running' THEN clock_timestamp() ELSE started_at END,
			    finished_at = CASE WHEN $9 THEN clock_timestamp() ELSE finished_at END
			WHERE org_id = $1::uuid AND run_id = $2::uuid AND step_index = $3`,
			job.OrgID, *job.RunID, index, status, outputValue, nullableError(message), receiptValue, approvalValue, terminal)
		return struct{}{}, err
	})
	return err
}

func (w *Worker) findReceiptID(ctx context.Context, orgID, intentID string) (*string, error) {
	var receiptID *string
	_, err := dbx.WithOrgTx(ctx, w.effectDB, orgID, func(tx pgx.Tx) (struct{}, error) {
		var id string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM public.action_receipts
			WHERE org_id = $1::uuid AND intent_key = $2`, orgID, orgID+":"+intentID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return struct{}{}, nil
		}
		if err != nil {
			return struct{}{}, err
		}
		receiptID = &id
		return struct{}{}, nil
	})
	return receiptID, err
}

func (w *Worker) finishApproval(ctx context.Context, orgID, approvalID string) error {
	_, err := dbx.WithOrgTx(ctx, w.effectDB, orgID, func(tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `
			UPDATE public.approvals SET status = 'executed', decided_at = clock_timestamp()
			WHERE id = $1::uuid AND org_id = $2::uuid AND status = 'executing'`, approvalID, orgID)
		return struct{}{}, err
	})
	return err
}

func durableStep(job *ClaimedJob) (int, bool) {
	if job.RunID == nil || job.RunStepIndex == nil {
		return 0, false
	}
	return *job.RunStepIndex, true
}

func retryDelay(attempts int) time.Duration {
	if attempts <= 1 {
		return time.Second
	}
	shift := attempts - 1
	if shift >= 9 {
		return maxBackoff
	}
	delay := time.Second * time.Duration(1<<shift)
	if delay > maxBackoff {
		return maxBackoff
	}
	return delay
}

func nullableError(message string) any {
	if message == "" {
		return nil
	}
	return message
}

func optionalValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func sleepContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
