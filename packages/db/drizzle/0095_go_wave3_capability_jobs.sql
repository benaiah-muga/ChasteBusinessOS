-- Add the wave 3 capability jobs to the worker allowlist.
DROP POLICY jobs_go_worker_supported_capabilities ON public.jobs;
--> statement-breakpoint
CREATE POLICY jobs_go_worker_supported_capabilities
ON public.jobs
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (
  current_user <> 'chaste_jobs_worker'
  OR type IN (
    'crm.createCustomer', 'crm.deactivateCustomer', 'crm.mergeCustomers',
    'crm.restoreCustomerMerge', 'crm.importCustomers', 'crm.undoCustomerImport',
    'crm.restoreImportedCustomers', 'crm.updateCustomerProfiles', 'crm.restoreCustomerProfiles',
    'crm.reapplyCustomerProfiles', 'crm.listCustomers', 'crm.pipelineReport',
    'crm.listTasks', 'crm.customerTimeline', 'crm.createDeal',
    'crm.moveDealStage', 'crm.convertLead', 'crm.createTask',
    'crm.completeTask', 'crm.updateTaskDetails', 'crm.restoreTaskDetails',
    'accounting.createInvoice', 'accounting.recordFxRate', 'accounting.recordPayment',
    'accounting.reversePayment', 'accounting.trialBalance', 'hr.hireEmployee',
    'hr.deactivateEmployee', 'hr.listEmployees', 'hr.updateEmployeeStructure',
    'accounting.createQuote', 'accounting.acceptQuote', 'accounting.declineQuote',
    'accounting.expireQuote', 'accounting.listQuotes', 'accounting.createRecurringTemplate',
    'accounting.pauseRecurringTemplate', 'accounting.resumeRecurringTemplate', 'accounting.listRecurringTemplates',
    'sales.createOrder', 'sales.confirmOrder', 'sales.deliverOrder',
    'sales.cancelOrder', 'sales.listOrders',
    'accounting.submitExpenseClaim', 'accounting.decideExpenseClaim', 'accounting.payExpenseClaim', 'accounting.listExpenseClaims',
    'purchasing.createVendor', 'purchasing.createPurchaseOrder', 'purchasing.receiveGoods', 'purchasing.createBill', 'purchasing.payBill', 'purchasing.reverseVendorPayment',
    'inventory.adjustStock', 'inventory.createTransfer', 'inventory.confirmTransfer',
    'inventory.cancelTransfer', 'inventory.reverseTransfer', 'inventory.listTransfers',
    'inventory.createCycleCount', 'inventory.recordCycleCounts',
    'inventory.postCycleCount', 'inventory.cancelCycleCount',
    'pos.openSession', 'pos.completeSale', 'pos.closeSession', 'pos.returnSale', 'pos.shiftSummary',
    'accounting.creditNote', 'accounting.shareInvoice', 'accounting.generateDueInvoices', 'accounting.reverseEntry',
    'accounting.addBankAccount', 'accounting.importBankFeed', 'accounting.deleteBankTransaction', 'accounting.matchBankTransaction',
    'accounting.unmatchBankTransaction', 'accounting.bankReconciliation', 'accounting.excludeBankTransaction',
    'accounting.unexcludeBankTransaction', 'accounting.bankSummary',
    'purchasing.createPurchaseRequest', 'purchasing.decidePurchaseRequest', 'purchasing.createRfq', 'purchasing.recordQuote',
    'purchasing.selectWinningQuote', 'purchasing.listPurchaseWorkflow',
    'inventory.createItem', 'inventory.updateItem', 'inventory.restoreItem', 'inventory.archiveItem',
    'inventory.createLocation', 'inventory.listLocations', 'inventory.lookupByBarcode'
  )
)
WITH CHECK (
  current_user <> 'chaste_jobs_worker'
  OR type IN (
    'crm.createCustomer', 'crm.deactivateCustomer', 'crm.mergeCustomers',
    'crm.restoreCustomerMerge', 'crm.importCustomers', 'crm.undoCustomerImport',
    'crm.restoreImportedCustomers', 'crm.updateCustomerProfiles', 'crm.restoreCustomerProfiles',
    'crm.reapplyCustomerProfiles', 'crm.listCustomers', 'crm.pipelineReport',
    'crm.listTasks', 'crm.customerTimeline', 'crm.createDeal',
    'crm.moveDealStage', 'crm.convertLead', 'crm.createTask',
    'crm.completeTask', 'crm.updateTaskDetails', 'crm.restoreTaskDetails',
    'accounting.createInvoice', 'accounting.recordFxRate', 'accounting.recordPayment',
    'accounting.reversePayment', 'accounting.trialBalance', 'hr.hireEmployee',
    'hr.deactivateEmployee', 'hr.listEmployees', 'hr.updateEmployeeStructure',
    'accounting.createQuote', 'accounting.acceptQuote', 'accounting.declineQuote',
    'accounting.expireQuote', 'accounting.listQuotes', 'accounting.createRecurringTemplate',
    'accounting.pauseRecurringTemplate', 'accounting.resumeRecurringTemplate', 'accounting.listRecurringTemplates',
    'sales.createOrder', 'sales.confirmOrder', 'sales.deliverOrder',
    'sales.cancelOrder', 'sales.listOrders',
    'accounting.submitExpenseClaim', 'accounting.decideExpenseClaim', 'accounting.payExpenseClaim', 'accounting.listExpenseClaims',
    'purchasing.createVendor', 'purchasing.createPurchaseOrder', 'purchasing.receiveGoods', 'purchasing.createBill', 'purchasing.payBill', 'purchasing.reverseVendorPayment',
    'inventory.adjustStock', 'inventory.createTransfer', 'inventory.confirmTransfer',
    'inventory.cancelTransfer', 'inventory.reverseTransfer', 'inventory.listTransfers',
    'inventory.createCycleCount', 'inventory.recordCycleCounts',
    'inventory.postCycleCount', 'inventory.cancelCycleCount',
    'pos.openSession', 'pos.completeSale', 'pos.closeSession', 'pos.returnSale', 'pos.shiftSummary',
    'accounting.creditNote', 'accounting.shareInvoice', 'accounting.generateDueInvoices', 'accounting.reverseEntry',
    'accounting.addBankAccount', 'accounting.importBankFeed', 'accounting.deleteBankTransaction', 'accounting.matchBankTransaction',
    'accounting.unmatchBankTransaction', 'accounting.bankReconciliation', 'accounting.excludeBankTransaction',
    'accounting.unexcludeBankTransaction', 'accounting.bankSummary',
    'purchasing.createPurchaseRequest', 'purchasing.decidePurchaseRequest', 'purchasing.createRfq', 'purchasing.recordQuote',
    'purchasing.selectWinningQuote', 'purchasing.listPurchaseWorkflow',
    'inventory.createItem', 'inventory.updateItem', 'inventory.restoreItem', 'inventory.archiveItem',
    'inventory.createLocation', 'inventory.listLocations', 'inventory.lookupByBarcode'
  )
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION jobs_worker.claim_capability_job(
  p_worker_id text,
  p_lease_ms integer
)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  type text,
  attempts integer,
  max_attempts integer,
  fencing_token integer,
  lease_owner text,
  lease_expires_at timestamptz,
  run_id uuid,
  run_step_index integer,
  approved_approval_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  claim_time timestamptz := clock_timestamp();
BEGIN
  IF p_worker_id IS NULL OR p_worker_id !~ '[^[:space:]]' OR length(p_worker_id) > 128 THEN
    RAISE EXCEPTION 'invalid capability jobs worker id' USING ERRCODE = '22023';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
    RAISE EXCEPTION 'capability jobs lease must be between 1000 and 300000 milliseconds' USING ERRCODE = '22023';
  END IF;

  -- The legacy tenant policy casts app.org_id even when this claim-owner
  -- policy authorizes global metadata access. A valid sentinel avoids an
  -- empty-setting cast; the claim-owner policy remains the global grant.
  PERFORM set_config('app.org_id', '00000000-0000-4000-8000-000000000000', true);

  UPDATE public.jobs AS expired
  SET status = 'failed',
      last_error = 'job lease expired after maximum attempts',
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = claim_time
  WHERE expired.type IN (
    'crm.createCustomer', 'crm.deactivateCustomer', 'crm.mergeCustomers',
    'crm.restoreCustomerMerge', 'crm.importCustomers', 'crm.undoCustomerImport',
    'crm.restoreImportedCustomers', 'crm.updateCustomerProfiles', 'crm.restoreCustomerProfiles',
    'crm.reapplyCustomerProfiles', 'crm.listCustomers', 'crm.pipelineReport',
    'crm.listTasks', 'crm.customerTimeline', 'crm.createDeal',
    'crm.moveDealStage', 'crm.convertLead', 'crm.createTask',
    'crm.completeTask', 'crm.updateTaskDetails', 'crm.restoreTaskDetails',
    'accounting.createInvoice', 'accounting.recordFxRate', 'accounting.recordPayment',
    'accounting.reversePayment', 'accounting.trialBalance', 'hr.hireEmployee',
    'hr.deactivateEmployee', 'hr.listEmployees', 'hr.updateEmployeeStructure',
    'accounting.createQuote', 'accounting.acceptQuote', 'accounting.declineQuote',
    'accounting.expireQuote', 'accounting.listQuotes', 'accounting.createRecurringTemplate',
    'accounting.pauseRecurringTemplate', 'accounting.resumeRecurringTemplate', 'accounting.listRecurringTemplates',
    'sales.createOrder', 'sales.confirmOrder', 'sales.deliverOrder',
    'sales.cancelOrder', 'sales.listOrders',
    'accounting.submitExpenseClaim', 'accounting.decideExpenseClaim', 'accounting.payExpenseClaim', 'accounting.listExpenseClaims',
    'purchasing.createVendor', 'purchasing.createPurchaseOrder', 'purchasing.receiveGoods', 'purchasing.createBill', 'purchasing.payBill', 'purchasing.reverseVendorPayment',
    'inventory.adjustStock', 'inventory.createTransfer', 'inventory.confirmTransfer',
    'inventory.cancelTransfer', 'inventory.reverseTransfer', 'inventory.listTransfers',
    'inventory.createCycleCount', 'inventory.recordCycleCounts',
    'inventory.postCycleCount', 'inventory.cancelCycleCount',
    'pos.openSession', 'pos.completeSale', 'pos.closeSession', 'pos.returnSale', 'pos.shiftSummary',
    'accounting.creditNote', 'accounting.shareInvoice', 'accounting.generateDueInvoices', 'accounting.reverseEntry',
    'accounting.addBankAccount', 'accounting.importBankFeed', 'accounting.deleteBankTransaction', 'accounting.matchBankTransaction',
    'accounting.unmatchBankTransaction', 'accounting.bankReconciliation', 'accounting.excludeBankTransaction',
    'accounting.unexcludeBankTransaction', 'accounting.bankSummary',
    'purchasing.createPurchaseRequest', 'purchasing.decidePurchaseRequest', 'purchasing.createRfq', 'purchasing.recordQuote',
    'purchasing.selectWinningQuote', 'purchasing.listPurchaseWorkflow',
    'inventory.createItem', 'inventory.updateItem', 'inventory.restoreItem', 'inventory.archiveItem',
    'inventory.createLocation', 'inventory.listLocations', 'inventory.lookupByBarcode'
  )
    AND expired.status = 'processing'
    AND expired.lease_expires_at <= claim_time
    AND expired.attempts >= expired.max_attempts;

  RETURN QUERY
  WITH candidate AS (
    SELECT pending.id
    FROM public.jobs AS pending
    WHERE pending.type IN (
    'crm.createCustomer', 'crm.deactivateCustomer', 'crm.mergeCustomers',
    'crm.restoreCustomerMerge', 'crm.importCustomers', 'crm.undoCustomerImport',
    'crm.restoreImportedCustomers', 'crm.updateCustomerProfiles', 'crm.restoreCustomerProfiles',
    'crm.reapplyCustomerProfiles', 'crm.listCustomers', 'crm.pipelineReport',
    'crm.listTasks', 'crm.customerTimeline', 'crm.createDeal',
    'crm.moveDealStage', 'crm.convertLead', 'crm.createTask',
    'crm.completeTask', 'crm.updateTaskDetails', 'crm.restoreTaskDetails',
    'accounting.createInvoice', 'accounting.recordFxRate', 'accounting.recordPayment',
    'accounting.reversePayment', 'accounting.trialBalance', 'hr.hireEmployee',
    'hr.deactivateEmployee', 'hr.listEmployees', 'hr.updateEmployeeStructure',
    'accounting.createQuote', 'accounting.acceptQuote', 'accounting.declineQuote',
    'accounting.expireQuote', 'accounting.listQuotes', 'accounting.createRecurringTemplate',
    'accounting.pauseRecurringTemplate', 'accounting.resumeRecurringTemplate', 'accounting.listRecurringTemplates',
    'sales.createOrder', 'sales.confirmOrder', 'sales.deliverOrder',
    'sales.cancelOrder', 'sales.listOrders',
    'accounting.submitExpenseClaim', 'accounting.decideExpenseClaim', 'accounting.payExpenseClaim', 'accounting.listExpenseClaims',
    'purchasing.createVendor', 'purchasing.createPurchaseOrder', 'purchasing.receiveGoods', 'purchasing.createBill', 'purchasing.payBill', 'purchasing.reverseVendorPayment',
    'inventory.adjustStock', 'inventory.createTransfer', 'inventory.confirmTransfer',
    'inventory.cancelTransfer', 'inventory.reverseTransfer', 'inventory.listTransfers',
    'inventory.createCycleCount', 'inventory.recordCycleCounts',
    'inventory.postCycleCount', 'inventory.cancelCycleCount',
    'pos.openSession', 'pos.completeSale', 'pos.closeSession', 'pos.returnSale', 'pos.shiftSummary',
    'accounting.creditNote', 'accounting.shareInvoice', 'accounting.generateDueInvoices', 'accounting.reverseEntry',
    'accounting.addBankAccount', 'accounting.importBankFeed', 'accounting.deleteBankTransaction', 'accounting.matchBankTransaction',
    'accounting.unmatchBankTransaction', 'accounting.bankReconciliation', 'accounting.excludeBankTransaction',
    'accounting.unexcludeBankTransaction', 'accounting.bankSummary',
    'purchasing.createPurchaseRequest', 'purchasing.decidePurchaseRequest', 'purchasing.createRfq', 'purchasing.recordQuote',
    'purchasing.selectWinningQuote', 'purchasing.listPurchaseWorkflow',
    'inventory.createItem', 'inventory.updateItem', 'inventory.restoreItem', 'inventory.archiveItem',
    'inventory.createLocation', 'inventory.listLocations', 'inventory.lookupByBarcode'
  )
      AND (
        (pending.status = 'pending' AND pending.attempts < pending.max_attempts AND pending.available_at <= claim_time)
        OR (pending.status = 'processing' AND pending.lease_expires_at <= claim_time AND pending.attempts < pending.max_attempts)
      )
    ORDER BY pending.available_at, pending.created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.jobs AS claimed
  SET status = 'processing',
      attempts = claimed.attempts + 1,
      lease_owner = p_worker_id,
      lease_expires_at = claim_time + (p_lease_ms * interval '1 millisecond'),
      fencing_token = claimed.fencing_token + 1,
      updated_at = claim_time
  FROM candidate
  WHERE claimed.id = candidate.id
  RETURNING claimed.id,
            claimed.org_id,
            claimed.type,
            claimed.attempts,
            claimed.max_attempts,
            claimed.fencing_token,
            claimed.lease_owner,
            claimed.lease_expires_at,
            claimed.run_id,
            claimed.run_step_index,
            claimed.approved_approval_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_worker.claim_capability_job(text, integer) FROM PUBLIC;
