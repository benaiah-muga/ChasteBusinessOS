/**
 * Business paper kit: the built-in document templates are composed from a
 * small set of Tiptap-safe building blocks with a fixed anatomy:
 *
 *   letterhead grid  ->  ledger rule  ->  party blocks  ->  body sections
 *   ->  ruled data tables  ->  totals block  ->  signature lines
 *
 * The renderer (template-preview.tsx) recognises this anatomy structurally
 * and styles it, so preview, editor paper, and print all agree. Tables carry
 * header rows only when they are data tables; borderless grids are layout,
 * which is what keeps the two distinguishable in rendered HTML.
 */

export type DocumentTemplateType =
  | "quotation"
  | "receipt"
  | "sales_invoice"
  | "purchase_order"
  | "voucher"
  | "delivery_note"
  | "employment_contract"
  | "employment_agreement";

export type DocumentRecordType = "customer" | "supplier" | "employee" | "invoice" | "quote" | "purchase_order" | "sales_order";

export interface DocumentTemplateDefinition {
  type: DocumentTemplateType;
  name: string;
  description: string;
  recordType: DocumentRecordType;
  recordLabel: string;
  preview: { meta: string };
  contentJson: Record<string, unknown>;
  lineItemConfig?: DocumentLineItemConfig;
}

export interface DocumentLineItemColumn {
  key: string;
  label: string;
  input: "text" | "number";
  computed?: "amount";
}

export interface DocumentLineItemConfig {
  prefix: string;
  columns: DocumentLineItemColumn[];
}

type Node = Record<string, unknown>;

const txt = (value: string, marks?: Array<{ type: string }>) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const strong = (value: string) => txt(value, [{ type: "bold" }]);
const p = (value = ""): Node => ({ type: "paragraph", ...(value ? { content: [txt(value)] } : {}) });
const pr = (...nodes: Node[]): Node => ({ type: "paragraph", content: nodes });
const h = (level: 1 | 2 | 3, value: string): Node => ({ type: "heading", attrs: { level }, content: [txt(value)] });
const rule: Node = { type: "horizontalRule" };
const list = (items: string[]): Node => ({ type: "bulletList", content: items.map((item) => ({ type: "listItem", content: [p(item)] })) });
const doc = (...content: Node[]) => ({ type: "doc", content });

const cell = (...blocks: Node[]): Node => ({ type: "tableCell", content: blocks.length > 0 ? blocks : [p()] });
const gridRow = (...cells: Node[]): Node => ({ type: "tableRow", content: cells });
const grid = (...rows: Node[]): Node => ({ type: "table", content: rows });
const gridCell = (value: string): Node => cell(p(value));

const dataTable = (headers: string[], rows: string[][]): Node => ({
  type: "table",
  content: [
    gridRow(...headers.map((value) => ({ type: "tableHeader", content: [p(value)] }))),
    ...rows.map((values) => gridRow(...values.map((value) => gridCell(value)))),
  ],
});

const letterhead = (docType: string, metaLines: string[]): Node =>
  grid(gridRow(
    cell(pr(strong("{{sender.name}}")), p("{{sender.address}}"), p("{{sender.contacts}}")),
    cell(h(1, docType), ...metaLines.map((line) => p(line))),
  ));

const party = (heading: string, lines: string[]): Node => cell(pr(strong(heading)), ...lines.map((line) => p(line)));
const parties = (left: Node, right?: Node): Node => grid(gridRow(...(right ? [left, right] : [left])));

const totals = (rows: Array<[string, string]>): Node =>
  grid(...rows.map(([key, value], index) => {
    const last = index === rows.length - 1;
    return gridRow(cell(last ? pr(strong(key)) : p(key)), cell(last ? pr(strong(value)) : p(value)));
  }));

const signatureCell = (role: string, nameToken: string, titleToken?: string): Node =>
  cell(pr(strong(role)), rule, pr(strong(nameToken)), ...(titleToken ? [p(titleToken)] : []));
const signatures = (left: [string, string, string?], right: [string, string, string?]): Node =>
  grid(gridRow(signatureCell(...left), signatureCell(...right)));

const itemRows = (prefix: string): string[][] =>
  [1, 2, 3].map((n) => [
    `{{${prefix}.line${n}.description}}`, `{{${prefix}.line${n}.quantity}}`, `{{${prefix}.line${n}.rate}}`, `{{${prefix}.line${n}.amount}}`,
  ]);

/** The builders are exported so server-side built-ins (letters, notes) share the same kit. */
export const templateKit = { txt, strong, p, pr, h, rule, list, doc, cell, grid, gridRow, gridCell, dataTable, letterhead, party, parties, totals, signatures, itemRows };

const define = (value: DocumentTemplateDefinition) => value;

const DOCUMENT_TEMPLATE_CATALOG_BASE: DocumentTemplateDefinition[] = [
  // Quotations
  define({
    type: "quotation", name: "Quotation - Clean estimate",
    description: "A concise estimate with itemized pricing, validity, terms, and acceptance.",
    recordType: "quote", recordLabel: "Quote or customer", preview: { meta: "Itemized, 30-day validity" },
    contentJson: doc(
      letterhead("QUOTATION", ["No. {{quotation.number}}", "Date: {{document.date}}", "Valid until: {{quotation.validUntil}}"]),
      rule,
      parties(party("PREPARED FOR", ["{{customer.name}}", "{{customer.email}}"])),
      p("Thank you for the opportunity to quote. The pricing below holds until the validity date shown above."),
      dataTable(["Description", "Qty", "Rate", "Amount"], itemRows("quotation")),
      totals([["Subtotal", "{{quotation.subtotal}}"], ["Tax", "{{quotation.tax}}"], ["Total", "{{quotation.total}}"]]),
      h(2, "Terms"),
      p("{{quotation.terms}}"),
      signatures(["ISSUED BY", "{{sender.name}}", "{{sender.title}}"], ["ACCEPTED BY", "{{customer.name}}"]),
    ),
  }),
  define({
    type: "quotation", name: "Quotation - Detailed scope",
    description: "A proposal-style quotation with objectives, deliverables, milestones, exclusions, and fees.",
    recordType: "quote", recordLabel: "Quote or customer", preview: { meta: "Proposal with milestones" },
    contentJson: doc(
      letterhead("PROPOSAL AND QUOTATION", ["Ref. {{quotation.number}}", "Date: {{document.date}}"]),
      rule,
      parties(party("PREPARED FOR", ["{{customer.name}}", "{{customer.email}}"]), party("PREPARED BY", ["{{sender.name}}"])),
      h(2, "Business objective"),
      p("{{quotation.objective}}"),
      h(2, "Deliverables"),
      list(["{{quotation.deliverable1}}", "{{quotation.deliverable2}}", "{{quotation.deliverable3}}"]),
      h(2, "Delivery plan"),
      dataTable(["Milestone", "Target date", "Acceptance"], [
        ["{{quotation.milestone1}}", "{{quotation.date1}}", "{{quotation.acceptance1}}"],
        ["{{quotation.milestone2}}", "{{quotation.date2}}", "{{quotation.acceptance2}}"],
      ]),
      h(2, "Commercials"),
      dataTable(["Work package", "Fee", "Tax"], [
        ["{{quotation.package1}}", "{{quotation.fee1}}", "{{quotation.tax1}}"],
        ["{{quotation.package2}}", "{{quotation.fee2}}", "{{quotation.tax2}}"],
      ]),
      totals([["Proposal total", "{{quotation.total}}"]]),
      h(2, "Assumptions and exclusions"),
      p("{{quotation.exclusions}}"),
    ),
  }),
  define({
    type: "quotation", name: "Quotation - Retainer",
    description: "A recurring-services quotation with allowance, service levels, overage, and renewal controls.",
    recordType: "customer", recordLabel: "Customer", preview: { meta: "Monthly allowance and SLA" },
    contentJson: doc(
      letterhead("MONTHLY RETAINER", ["Offer {{quotation.number}}", "Date: {{document.date}}", "Starts: {{quotation.startDate}}"]),
      rule,
      parties(party("PREPARED FOR", ["{{customer.name}}", "{{customer.email}}"])),
      totals([["Monthly fee", "{{quotation.total}}"]]),
      h(2, "Service allowance"),
      dataTable(["Service", "Included", "Service level"], [
        ["{{quotation.service1}}", "{{quotation.allowance1}}", "{{quotation.sla1}}"],
        ["{{quotation.service2}}", "{{quotation.allowance2}}", "{{quotation.sla2}}"],
        ["{{quotation.service3}}", "{{quotation.allowance3}}", "{{quotation.sla3}}"],
      ]),
      h(2, "Working arrangement"),
      list([
        "Requests are logged through {{quotation.channel}}.",
        "Unused hours {{quotation.rollover}}.",
        "Additional work is billed at {{quotation.overageRate}}.",
      ]),
      h(2, "Term and renewal"),
      p("{{quotation.renewalTerms}}"),
      signatures(["SERVICE PROVIDER", "{{sender.name}}"], ["CLIENT ACCEPTANCE", "{{customer.name}}"]),
    ),
  }),

  // Receipts
  define({
    type: "receipt", name: "Receipt - Counter sale",
    description: "A compact paid receipt for a walk-in or point-of-sale transaction.",
    recordType: "invoice", recordLabel: "Invoice or customer", preview: { meta: "Counter sale, paid in full" },
    contentJson: doc(
      letterhead("OFFICIAL RECEIPT", ["No. {{receipt.number}}", "{{receipt.dateTime}}"]),
      rule,
      parties(party("RECEIVED FROM", ["{{customer.name}}"]), party("SERVED BY", ["{{receipt.cashier}}"])),
      dataTable(["Item", "Qty", "Price", "Amount"], itemRows("receipt")),
      totals([["Total paid", "{{receipt.total}}"]]),
      p("Paid by {{receipt.paymentMethod}} | Reference {{receipt.paymentReference}}"),
      p("Thank you for your business. Keep this receipt for any exchange or warranty claim."),
    ),
  }),
  define({
    type: "receipt", name: "Receipt - Service payment",
    description: "A formal acknowledgement linked to an invoice, service period, and remaining balance.",
    recordType: "invoice", recordLabel: "Sales invoice", preview: { meta: "Allocated to an invoice" },
    contentJson: doc(
      letterhead("PAYMENT RECEIPT", ["No. {{receipt.number}}", "Date: {{document.date}}"]),
      rule,
      parties(party("RECEIVED FROM", ["{{customer.name}}", "{{customer.email}}"]), party("RECEIVED BY", ["{{sender.name}}"])),
      dataTable(["Invoice", "Service period", "Method", "Amount received"], [
        ["{{invoice.number}}", "{{invoice.period}}", "{{receipt.paymentMethod}}", "{{receipt.total}}"],
      ]),
      totals([["Previous balance", "{{invoice.previousBalance}}"], ["Amount received", "{{receipt.total}}"], ["Balance remaining", "{{invoice.balance}}"]]),
      p("Transaction reference: {{receipt.paymentReference}}"),
      p("This receipt acknowledges funds received and is not a tax invoice."),
    ),
  }),
  define({
    type: "receipt", name: "Receipt - Deposit received",
    description: "A deposit acknowledgement with project value, percentage, use of funds, and balance.",
    recordType: "customer", recordLabel: "Customer", preview: { meta: "Project advance" },
    contentJson: doc(
      letterhead("DEPOSIT RECEIPT", ["No. {{receipt.number}}", "Date: {{document.date}}"]),
      rule,
      parties(party("RECEIVED FROM", ["{{customer.name}}"]), party("TOWARDS", ["{{receipt.purpose}}"])),
      dataTable(["Project value", "Deposit", "Amount received"], [
        ["{{receipt.projectValue}}", "{{receipt.depositPercent}}", "{{receipt.total}}"],
      ]),
      totals([["Balance after deposit", "{{receipt.balance}}"]]),
      h(2, "Application of funds"),
      p("{{receipt.depositTerms}}"),
      p("This receipt confirms funds received and is not a tax invoice."),
    ),
  }),

  // Sales invoices
  define({
    type: "sales_invoice", name: "Sales invoice - Standard",
    description: "A complete commercial invoice with buyer, line items, tax, due date, and remittance details.",
    recordType: "invoice", recordLabel: "Sales invoice", preview: { meta: "Remittance ready" },
    contentJson: doc(
      letterhead("TAX INVOICE", ["No. {{invoice.number}}", "Issued: {{invoice.issuedAt}}", "Due: {{invoice.dueAt}}"]),
      rule,
      parties(party("BILL TO", ["{{customer.name}}", "{{customer.email}}"]), party("PAY TO", ["{{sender.name}}", "{{sender.contacts}}"])),
      dataTable(["Description", "Qty", "Unit price", "Amount"], itemRows("invoice")),
      totals([["Subtotal", "{{invoice.subtotal}}"], ["Tax", "{{invoice.tax}}"], ["Total due", "{{invoice.total}}"]]),
      h(2, "Payment instructions"),
      p("{{invoice.paymentInstructions}}"),
      p("Use invoice {{invoice.number}} as the payment reference."),
    ),
  }),
  define({
    type: "sales_invoice", name: "Sales invoice - Milestone",
    description: "A project claim showing contract value, progress, prior billings, and accepted work.",
    recordType: "invoice", recordLabel: "Sales invoice", preview: { meta: "Progress claim" },
    contentJson: doc(
      letterhead("MILESTONE INVOICE", ["No. {{invoice.number}}", "Claim: {{invoice.claimNumber}}", "Due: {{invoice.dueAt}}"]),
      rule,
      parties(party("CLIENT", ["{{customer.name}}"]), party("PROJECT", ["{{invoice.projectName}}"])),
      h(2, "Contract summary"),
      dataTable(["Contract value", "Progress", "Previously billed", "This claim"], [
        ["{{invoice.contractValue}}", "{{invoice.progressPercent}}", "{{invoice.previouslyBilled}}", "{{invoice.total}}"],
      ]),
      h(2, "Accepted milestone"),
      p("{{invoice.milestone}}"),
      list(["Period ending {{invoice.periodEnd}}", "Approval reference {{invoice.approvalReference}}"]),
      h(2, "Claim detail"),
      dataTable(["Deliverable", "Completion", "Amount"], [
        ["{{invoice.deliverable1}}", "{{invoice.completion1}}", "{{invoice.amount1}}"],
        ["{{invoice.deliverable2}}", "{{invoice.completion2}}", "{{invoice.amount2}}"],
      ]),
      totals([["Amount payable", "{{invoice.total}}"]]),
    ),
  }),
  define({
    type: "sales_invoice", name: "Sales invoice - Tax summary",
    description: "A tax-forward invoice separating taxable, zero-rated, exempt, and tax totals.",
    recordType: "invoice", recordLabel: "Sales invoice", preview: { meta: "Tax breakdown" },
    contentJson: doc(
      letterhead("SALES INVOICE", ["No. {{invoice.number}}", "Tax reg: {{sender.taxNumber}}", "Tax point: {{invoice.taxPoint}}"]),
      rule,
      parties(party("BILL TO", ["{{customer.name}}", "{{customer.email}}"]), party("ISSUED BY", ["{{sender.name}}"])),
      dataTable(["Supply", "Net", "Tax rate", "Tax", "Gross"], [
        ["Taxable supplies", "{{invoice.taxableNet}}", "{{invoice.taxRate}}", "{{invoice.tax}}", "{{invoice.taxableGross}}"],
        ["Zero-rated supplies", "{{invoice.zeroRated}}", "0%", "{{invoice.zeroTax}}", "{{invoice.zeroRated}}"],
        ["Exempt supplies", "{{invoice.exempt}}", "Exempt", "-", "{{invoice.exempt}}"],
      ]),
      totals([["Net total", "{{invoice.subtotal}}"], ["Tax total", "{{invoice.tax}}"], ["Invoice total", "{{invoice.total}}"]]),
      p("Payment is due {{invoice.dueAt}}. Quote invoice {{invoice.number}} with your payment."),
    ),
  }),

  // Purchase orders
  define({
    type: "purchase_order", name: "Purchase order - Goods",
    description: "A supplier order with delivery address, item specifications, receiving rules, and terms.",
    recordType: "purchase_order", recordLabel: "Purchase order", preview: { meta: "Goods with delivery rules" },
    contentJson: doc(
      letterhead("PURCHASE ORDER", ["No. {{purchaseOrder.number}}", "Date: {{document.date}}", "Required by: {{purchaseOrder.deliveryDate}}"]),
      rule,
      parties(party("SUPPLIER", ["{{supplier.name}}", "{{supplier.email}}"]), party("DELIVER TO", ["{{purchaseOrder.deliveryAddress}}", "Contact: {{purchaseOrder.deliveryContact}}"])),
      dataTable(["SKU / description", "Qty", "Unit price", "Line total"], itemRows("purchaseOrder")),
      totals([["Order total", "{{purchaseOrder.total}}"]]),
      h(2, "Receiving instructions"),
      list([
        "Quote this PO number on all delivery documents.",
        "Part deliveries: {{purchaseOrder.partDelivery}}.",
        "Contact {{purchaseOrder.deliveryContact}} before arrival.",
      ]),
      p("Payment terms: {{purchaseOrder.paymentTerms}}"),
    ),
  }),
  define({
    type: "purchase_order", name: "Purchase order - Services",
    description: "A service order with statement of work, acceptance criteria, milestones, and fees.",
    recordType: "purchase_order", recordLabel: "Purchase order", preview: { meta: "Statement of work" },
    contentJson: doc(
      letterhead("SERVICE PURCHASE ORDER", ["No. {{purchaseOrder.number}}", "Date: {{document.date}}"]),
      rule,
      parties(party("SUPPLIER", ["{{supplier.name}}", "{{supplier.email}}"]), party("BUYER", ["{{sender.name}}"])),
      h(2, "Statement of work"),
      p("{{purchaseOrder.scope}}"),
      h(2, "Deliverables and acceptance"),
      dataTable(["Deliverable", "Due", "Acceptance criteria", "Fee"], [
        ["{{purchaseOrder.deliverable1}}", "{{purchaseOrder.date1}}", "{{purchaseOrder.acceptance1}}", "{{purchaseOrder.fee1}}"],
        ["{{purchaseOrder.deliverable2}}", "{{purchaseOrder.date2}}", "{{purchaseOrder.acceptance2}}", "{{purchaseOrder.fee2}}"],
      ]),
      totals([["Approved ceiling", "{{purchaseOrder.total}}"]]),
      h(2, "Commercial terms"),
      list([
        "Invoices require an accepted deliverable.",
        "Expenses: {{purchaseOrder.expenseTerms}}.",
        "Payment terms: {{purchaseOrder.paymentTerms}}.",
      ]),
      signatures(["AUTHORIZED BUYER", "{{sender.name}}", "{{sender.title}}"], ["SUPPLIER ACCEPTANCE", "{{supplier.name}}"]),
    ),
  }),
  define({
    type: "purchase_order", name: "Purchase order - Framework",
    description: "A repeat-order framework with a rate card, call-off controls, ceiling, and term.",
    recordType: "supplier", recordLabel: "Supplier", preview: { meta: "Annual call-off arrangement" },
    contentJson: doc(
      letterhead("FRAMEWORK PURCHASE ORDER", ["No. {{purchaseOrder.number}}", "Term: {{purchaseOrder.startDate}} to {{purchaseOrder.endDate}}"]),
      rule,
      parties(party("SUPPLIER", ["{{supplier.name}}", "{{supplier.email}}"]), party("BUYER", ["{{sender.name}}"])),
      totals([["Maximum commitment", "{{purchaseOrder.total}}"]]),
      h(2, "Approved rate card"),
      dataTable(["Service or item", "Unit", "Rate", "Lead time"], [
        ["{{purchaseOrder.item1}}", "{{purchaseOrder.unit1}}", "{{purchaseOrder.rate1}}", "{{purchaseOrder.lead1}}"],
        ["{{purchaseOrder.item2}}", "{{purchaseOrder.unit2}}", "{{purchaseOrder.rate2}}", "{{purchaseOrder.lead2}}"],
      ]),
      h(2, "Call-off control"),
      list([
        "Each request must quote this framework and a call-off number.",
        "Only {{purchaseOrder.authorizedRoles}} may issue call-offs.",
        "No minimum volume is guaranteed.",
      ]),
      h(2, "Review and termination"),
      p("{{purchaseOrder.reviewTerms}}"),
      signatures(["BUYER APPROVAL", "{{sender.name}}", "{{sender.title}}"], ["SUPPLIER ACCEPTANCE", "{{supplier.name}}"]),
    ),
  }),

  // Vouchers
  define({
    type: "voucher", name: "Voucher - Supplier payment",
    description: "A controlled payment voucher with payee, support, coding, and approval trail.",
    recordType: "supplier", recordLabel: "Supplier", preview: { meta: "Approval trail" },
    contentJson: doc(
      letterhead("PAYMENT VOUCHER", ["No. {{voucher.number}}", "Date: {{document.date}}"]),
      rule,
      parties(party("PAY TO", ["{{supplier.name}}"]), party("PAYMENT", ["{{voucher.paymentMethod}}", "Support: {{voucher.supportReference}}"])),
      dataTable(["Account", "Cost centre", "Debit", "Credit"], [
        ["{{voucher.account1}}", "{{voucher.costCentre1}}", "{{voucher.debit1}}", "{{voucher.credit1}}"],
        ["{{voucher.account2}}", "{{voucher.costCentre2}}", "{{voucher.debit2}}", "{{voucher.credit2}}"],
      ]),
      totals([["Amount to pay", "{{voucher.total}}"]]),
      p("Purpose: {{voucher.purpose}}"),
      p("Attachments checked: {{voucher.attachments}}"),
      signatures(["PREPARED AND CHECKED BY", "{{sender.name}}"], ["APPROVED AND PAID BY", "{{voucher.approvedBy}}"]),
    ),
  }),
  define({
    type: "voucher", name: "Voucher - Customer receipt",
    description: "A receipt voucher that allocates customer funds to documents and a deposit account.",
    recordType: "customer", recordLabel: "Customer", preview: { meta: "Collection allocation" },
    contentJson: doc(
      letterhead("RECEIPT VOUCHER", ["No. {{voucher.number}}", "Date: {{document.date}}"]),
      rule,
      parties(party("RECEIVED FROM", ["{{customer.name}}"]), party("BANKED TO", ["{{voucher.depositAccount}}", "Slip: {{voucher.depositReference}}"])),
      dataTable(["Document", "Description", "Applied", "Balance"], [
        ["{{voucher.document1}}", "{{voucher.description1}}", "{{voucher.applied1}}", "{{voucher.balance1}}"],
        ["{{voucher.document2}}", "{{voucher.description2}}", "{{voucher.applied2}}", "{{voucher.balance2}}"],
      ]),
      totals([["Total received", "{{voucher.total}}"]]),
      p("Payment reference {{voucher.paymentReference}} received by {{voucher.paymentMethod}}."),
      signatures(["RECEIVED BY", "{{sender.name}}"], ["REVIEWED BY", "{{voucher.reviewedBy}}"]),
    ),
  }),
  define({
    type: "voucher", name: "Voucher - Journal adjustment",
    description: "A balanced journal voucher with reason, evidence, period, and review control.",
    recordType: "invoice", recordLabel: "Related invoice", preview: { meta: "Balanced entry" },
    contentJson: doc(
      letterhead("JOURNAL VOUCHER", ["No. {{voucher.number}}", "Period: {{voucher.period}}", "Related record: {{invoice.number}}"]),
      rule,
      parties(party("PREPARED BY", ["{{sender.name}}"])),
      dataTable(["Account code", "Account name", "Debit", "Credit", "Narration"], [
        ["{{voucher.code1}}", "{{voucher.account1}}", "{{voucher.debit1}}", "{{voucher.credit1}}", "{{voucher.narration1}}"],
        ["{{voucher.code2}}", "{{voucher.account2}}", "{{voucher.debit2}}", "{{voucher.credit2}}", "{{voucher.narration2}}"],
      ]),
      totals([["Total debits", "{{voucher.totalDebit}}"], ["Total credits", "{{voucher.totalCredit}}"]]),
      h(2, "Reason and evidence"),
      p("{{voucher.reason}}"),
      p("Supporting evidence: {{voucher.attachments}}"),
      signatures(["PREPARED BY", "{{sender.name}}"], ["APPROVED BY", "{{voucher.approvedBy}}"]),
    ),
  }),

  // Delivery notes
  define({
    type: "delivery_note", name: "Delivery note - Standard",
    description: "A goods handover note linked to a sales order, with quantities and sign-off.",
    recordType: "sales_order", recordLabel: "Sales order", preview: { meta: "Against a sales order" },
    contentJson: doc(
      letterhead("DELIVERY NOTE", ["No. {{delivery.number}}", "Date: {{document.date}}", "Sales order: {{salesOrder.number}}"]),
      rule,
      parties(party("DELIVER TO", ["{{customer.name}}", "{{delivery.address}}"]), party("CARRIER", ["{{delivery.carrier}}", "Packages: {{delivery.packages}}"])),
      dataTable(["Item", "Ordered", "Delivered", "Condition"], [
        ["{{delivery.line1.description}}", "{{delivery.line1.ordered}}", "{{delivery.line1.delivered}}", "{{delivery.line1.condition}}"],
        ["{{delivery.line2.description}}", "{{delivery.line2.ordered}}", "{{delivery.line2.delivered}}", "{{delivery.line2.condition}}"],
        ["{{delivery.line3.description}}", "{{delivery.line3.ordered}}", "{{delivery.line3.delivered}}", "{{delivery.line3.condition}}"],
      ]),
      signatures(["DISPATCHED BY", "{{sender.name}}"], ["RECEIVED BY", "{{customer.name}}"]),
    ),
  }),
  define({
    type: "delivery_note", name: "Delivery note - Partial shipment",
    description: "A part-delivery note separating delivered, backordered, and rejected quantities.",
    recordType: "sales_order", recordLabel: "Sales order", preview: { meta: "Part shipment" },
    contentJson: doc(
      letterhead("PART DELIVERY NOTE", ["No. {{delivery.number}}", "Date: {{document.date}}", "Order: {{salesOrder.number}}"]),
      rule,
      parties(party("DELIVER TO", ["{{customer.name}}", "{{delivery.address}}"])),
      dataTable(["Item", "Ordered", "This delivery", "Previously delivered", "Outstanding"], [
        ["{{delivery.item1}}", "{{delivery.ordered1}}", "{{delivery.today1}}", "{{delivery.previous1}}", "{{delivery.outstanding1}}"],
        ["{{delivery.item2}}", "{{delivery.ordered2}}", "{{delivery.today2}}", "{{delivery.previous2}}", "{{delivery.outstanding2}}"],
      ]),
      h(2, "Backorder plan"),
      p("Next expected delivery: {{delivery.nextDate}}. {{delivery.backorderNote}}"),
      h(2, "Exceptions at handover"),
      p("{{delivery.exceptions}}"),
      signatures(["DRIVER / DISPATCH", "{{delivery.driver}}"], ["RECIPIENT", "{{customer.name}}"]),
    ),
  }),
  define({
    type: "delivery_note", name: "Delivery note - Signed handoff",
    description: "A proof of delivery with checklist, condition notes, serials, and signature.",
    recordType: "sales_order", recordLabel: "Sales order", preview: { meta: "Proof of delivery" },
    contentJson: doc(
      letterhead("PROOF OF DELIVERY", ["No. {{delivery.number}}", "Order: {{salesOrder.number}}", "Received at: {{delivery.receivedTime}}"]),
      rule,
      parties(party("RECIPIENT", ["{{customer.name}}"]), party("LOCATION", ["{{delivery.address}}"])),
      h(2, "Handover checklist"),
      list([
        "Package count checked: {{delivery.packageCheck}}",
        "Visible condition checked: {{delivery.conditionCheck}}",
        "Documents and accessories included: {{delivery.accessoryCheck}}",
      ]),
      h(2, "Delivered items"),
      dataTable(["Description", "Quantity", "Serial / batch", "Accepted"], [
        ["{{delivery.item1}}", "{{delivery.quantity1}}", "{{delivery.serial1}}", "{{delivery.accepted1}}"],
        ["{{delivery.item2}}", "{{delivery.quantity2}}", "{{delivery.serial2}}", "{{delivery.accepted2}}"],
      ]),
      h(2, "Recipient statement"),
      p("I confirm receipt of the items listed above at {{delivery.receivedTime}}, subject to: {{delivery.exceptions}}."),
      signatures(["DELIVERED BY", "{{sender.name}}"], ["RECEIVED BY", "{{customer.name}}"]),
    ),
  }),

  // Employment contracts
  define({
    type: "employment_contract", name: "Employment contract - Full-time",
    description: "A full contract covering role, pay, hours, leave, confidentiality, notice, and signatures.",
    recordType: "employee", recordLabel: "Employee", preview: { meta: "Indefinite term" },
    contentJson: doc(
      letterhead("EMPLOYMENT CONTRACT", ["Ref. {{employment.reference}}", "Effective: {{employment.startDate}}"]),
      rule,
      parties(party("THE EMPLOYER", ["{{employer.name}}"]), party("THE EMPLOYEE", ["{{employee.name}}", "{{employee.title}}"])),
      h(2, "1. Appointment and duties"),
      p("The Employee is appointed as {{employee.title}}, reporting to {{employment.manager}}, and will perform: {{employment.duties}}."),
      h(2, "2. Place and hours of work"),
      p("Primary location: {{employment.location}}. Normal hours: {{employment.hours}}."),
      h(2, "3. Compensation and benefits"),
      p("Gross monthly pay: {{employment.compensation}}. Benefits: {{employment.benefits}}."),
      h(2, "4. Leave"),
      p("Annual leave entitlement: {{employment.leaveDays}} days, subject to company policy."),
      h(2, "5. Confidentiality and property"),
      p("{{employment.confidentiality}}"),
      h(2, "6. Termination"),
      p("Either party may terminate on {{employment.noticePeriod}} written notice, subject to applicable law."),
      signatures(["FOR THE EMPLOYER", "{{employer.name}}", "{{sender.title}}"], ["THE EMPLOYEE", "{{employee.name}}"]),
    ),
  }),
  define({
    type: "employment_contract", name: "Employment contract - Fixed-term",
    description: "A fixed-term contract with dates, objectives, renewal review, benefits, and completion terms.",
    recordType: "employee", recordLabel: "Employee", preview: { meta: "Defined start and end" },
    contentJson: doc(
      letterhead("FIXED-TERM EMPLOYMENT CONTRACT", ["Ref. {{employment.reference}}", "{{employment.startDate}} to {{employment.endDate}}"]),
      rule,
      parties(party("THE EMPLOYER", ["{{employer.name}}"]), party("THE EMPLOYEE", ["{{employee.name}}", "{{employee.title}}"])),
      h(2, "Purpose and deliverables"),
      list(["{{employment.deliverable1}}", "{{employment.deliverable2}}", "{{employment.deliverable3}}"]),
      h(2, "Pay and working time"),
      p("Compensation is {{employment.compensation}} for {{employment.hours}}. Benefits: {{employment.benefits}}."),
      h(2, "Performance and renewal"),
      p("A completion review will occur on {{employment.reviewDate}}. Renewal is not automatic and must be agreed in writing."),
      h(2, "Early termination"),
      p("{{employment.terminationTerms}}"),
      signatures(["FOR THE EMPLOYER", "{{employer.name}}", "{{sender.title}}"], ["THE EMPLOYEE", "{{employee.name}}"]),
    ),
  }),
  define({
    type: "employment_contract", name: "Employment contract - Probation",
    description: "An appointment contract with measurable objectives, review dates, confirmation, and notice.",
    recordType: "employee", recordLabel: "Employee", preview: { meta: "Probation with checkpoints" },
    contentJson: doc(
      letterhead("EMPLOYMENT CONTRACT WITH PROBATION", ["Ref. {{employment.reference}}", "Starts: {{employment.startDate}}", "Probation ends: {{employment.probationEnd}}"]),
      rule,
      parties(party("THE EMPLOYER", ["{{employer.name}}"]), party("THE EMPLOYEE", ["{{employee.name}}", "{{employee.title}}"])),
      h(2, "Core terms"),
      dataTable(["Monthly pay", "Hours", "Location", "Manager"], [
        ["{{employment.compensation}}", "{{employment.hours}}", "{{employment.location}}", "{{employment.manager}}"],
      ]),
      h(2, "Probation objectives"),
      dataTable(["Objective", "Measure", "Review date"], [
        ["{{employment.objective1}}", "{{employment.measure1}}", "{{employment.review1}}"],
        ["{{employment.objective2}}", "{{employment.measure2}}", "{{employment.review2}}"],
      ]),
      h(2, "Confirmation process"),
      p("The Employer will communicate confirmation, extension, or termination in writing after the final review. During probation, notice is {{employment.probationNotice}}."),
      h(2, "Continuing obligations"),
      p("Confidentiality, conduct, leave, and company policies apply from the start date."),
      signatures(["FOR THE EMPLOYER", "{{employer.name}}", "{{sender.title}}"], ["THE EMPLOYEE", "{{employee.name}}"]),
    ),
  }),

  // Employment agreements
  define({
    type: "employment_agreement", name: "Employment agreement - Consultant",
    description: "A consultant agreement with scope, milestones, fees, ownership, and status protections.",
    recordType: "employee", recordLabel: "Employee or consultant", preview: { meta: "Consultant SOW" },
    contentJson: doc(
      letterhead("INDEPENDENT CONSULTANT AGREEMENT", ["Ref. {{agreement.reference}}", "Date: {{document.date}}"]),
      rule,
      parties(party("THE CLIENT", ["{{employer.name}}"]), party("THE CONSULTANT", ["{{employee.name}}"])),
      h(2, "Services and deliverables"),
      p("{{agreement.scope}}"),
      dataTable(["Milestone", "Due date", "Fee", "Acceptance"], [
        ["{{agreement.milestone1}}", "{{agreement.date1}}", "{{agreement.fee1}}", "{{agreement.acceptance1}}"],
        ["{{agreement.milestone2}}", "{{agreement.date2}}", "{{agreement.fee2}}", "{{agreement.acceptance2}}"],
      ]),
      h(2, "Expenses and invoicing"),
      p("{{agreement.expenseTerms}}"),
      h(2, "Independent status"),
      p("The Consultant controls the manner of work and is responsible for taxes and insurance. This agreement does not create employment."),
      h(2, "Ownership and confidentiality"),
      p("{{agreement.ownershipTerms}}"),
      h(2, "Term and termination"),
      p("{{agreement.terminationTerms}}"),
      signatures(["CLIENT", "{{employer.name}}"], ["CONSULTANT", "{{employee.name}}"]),
    ),
  }),
  define({
    type: "employment_agreement", name: "Employment agreement - Remote",
    description: "A remote-work addendum for location, availability, equipment, expenses, security, and review.",
    recordType: "employee", recordLabel: "Employee", preview: { meta: "Location addendum" },
    contentJson: doc(
      letterhead("REMOTE WORK AGREEMENT", ["Ref. {{agreement.reference}}", "Supplements the contract from {{employment.contractDate}}"]),
      rule,
      parties(party("THE EMPLOYER", ["{{employer.name}}"]), party("THE EMPLOYEE", ["{{employee.name}}", "{{employee.title}}"])),
      h(2, "Approved work arrangement"),
      dataTable(["Primary remote location", "Office days", "Availability window", "Review date"], [
        ["{{agreement.location}}", "{{agreement.officeDays}}", "{{agreement.availability}}", "{{agreement.reviewDate}}"],
      ]),
      h(2, "Equipment and expenses"),
      list([
        "Employer equipment: {{agreement.equipment}}",
        "Connectivity support: {{agreement.connectivity}}",
        "Reimbursable expenses: {{agreement.expenses}}",
      ]),
      h(2, "Security and confidentiality"),
      p("The Employee will use approved systems, protect devices, report incidents promptly, and follow {{agreement.securityPolicy}}."),
      h(2, "Health, safety, and changes"),
      p("{{agreement.safetyTerms}}"),
      signatures(["EMPLOYER APPROVAL", "{{employer.name}}", "{{sender.title}}"], ["EMPLOYEE ACCEPTANCE", "{{employee.name}}"]),
    ),
  }),
  define({
    type: "employment_agreement", name: "Employment agreement - Confidentiality",
    description: "A focused confidentiality agreement defining protected information, use, exceptions, and return duties.",
    recordType: "employee", recordLabel: "Employee", preview: { meta: "Mutual NDA" },
    contentJson: doc(
      letterhead("CONFIDENTIALITY AGREEMENT", ["Ref. {{agreement.reference}}", "Date: {{document.date}}"]),
      rule,
      parties(party("PARTY A", ["{{employer.name}}"]), party("PARTY B", ["{{employee.name}}"])),
      h(2, "Purpose"),
      p("Confidential information may be used only for {{agreement.purpose}}."),
      h(2, "Protected information"),
      list([
        "Business and financial records",
        "Customer, supplier, and employee information",
        "Product, technical, and security information",
        "Other information reasonably understood as confidential",
      ]),
      h(2, "Exclusions"),
      p("Information is excluded if lawfully known, independently developed, publicly available without breach, or received lawfully from a third party."),
      h(2, "Permitted disclosure"),
      p("{{agreement.disclosureTerms}}"),
      h(2, "Return, deletion, and survival"),
      p("On request or exit, information and copies must be returned or deleted. Obligations survive for {{agreement.survivalPeriod}}."),
      h(2, "Breach and governing terms"),
      p("{{agreement.remedies}} | Governing law: {{agreement.governingLaw}}."),
      signatures(["ORGANIZATION", "{{employer.name}}"], ["EMPLOYEE", "{{employee.name}}"]),
    ),
  }),
];

const refMoneyConfig = (prefix: string): DocumentLineItemConfig => ({
  prefix,
  columns: [
    { key: "description", label: "Item or service", input: "text" },
    { key: "details", label: "Description", input: "text" },
    { key: "quantity", label: "Qty", input: "number" },
    { key: "rate", label: "Unit price (UGX)", input: "number" },
    { key: "amount", label: "Amount (UGX)", input: "number", computed: "amount" },
  ],
});

const refDeliveryConfig: DocumentLineItemConfig = {
  prefix: "delivery",
  columns: [
    { key: "description", label: "Item", input: "text" },
    { key: "ordered", label: "Ordered", input: "number" },
    { key: "delivered", label: "Delivered", input: "number" },
    { key: "unit", label: "Unit", input: "text" },
  ],
};

const referenceTemplates: DocumentTemplateDefinition[] = [
  ...(["Standard"] as const).map((variant, index): DocumentTemplateDefinition => ({
    type: "sales_invoice",
    name: `Sales invoice - Chaste ${variant}`,
    description: [
      "The Chaste standard invoice with clear tax, due date, and remittance details.",
      "A fuller invoice for projects with customer references and payment notes.",
      "A service invoice with a compact billing summary and recurring terms.",
    ][index]!,
    recordType: "invoice", recordLabel: "Sales invoice", preview: { meta: "Chaste reference layout" },
    lineItemConfig: refMoneyConfig("invoice"),
    contentJson: doc(
      letterhead("INVOICE", ["Invoice No: {{invoice.number}}", "Issue Date: {{document.date}}", "Due Date: {{invoice.dueAt}}", "Issued By: {{sender.name}}"]),
      rule,
      parties(party("FROM", ["{{sender.name}}", "{{sender.address}}", "{{sender.contacts}}"]), party("BILL TO", ["{{customer.name}}", "{{customer.email}}", "{{customer.address}}"])),
      dataTable(["Item", "Description", "Qty", "Unit Price (UGX)", "Amount (UGX)"], [
        ["{{invoice.line1.description}}", "{{invoice.line1.details}}", "{{invoice.line1.quantity}}", "{{invoice.line1.rate}}", "{{invoice.line1.amount}}"],
      ]),
      totals([["Subtotal", "{{invoice.subtotal}}"], ["Discount", "{{invoice.discount}}"], ["Tax", "{{invoice.tax}}"], ["INVOICE TOTAL", "{{invoice.total}}"]]),
      h(2, index === 1 ? "Payment details and customer reference" : "Payment details"),
      p("{{invoice.paymentInstructions}}"),
      p(index === 2 ? "Billing period: {{invoice.period}}. Thank you for your business." : "Please quote invoice {{invoice.number}} with your payment."),
      signatures(["AUTHORIZED BY", "{{sender.name}}", "{{sender.title}}"], ["CUSTOMER ACKNOWLEDGEMENT", "{{customer.name}}"]),
    ),
  })),
  ...(["Standard"] as const).map((variant, index): DocumentTemplateDefinition => ({
    type: "quotation",
    name: `Quotation - Chaste ${variant}`,
    description: [
      "The Chaste quotation with an itemized estimate, validity, and acceptance block.",
      "A project quotation with a customer brief, scope note, and commercial summary.",
      "A recurring service quotation with billing period and service terms.",
    ][index]!,
    recordType: "quote", recordLabel: "Quote or customer", preview: { meta: "Chaste reference layout" },
    lineItemConfig: refMoneyConfig("quotation"),
    contentJson: doc(
      letterhead("QUOTATION", ["Quotation No: {{quotation.number}}", "Issue Date: {{document.date}}", "Valid Until: {{quotation.validUntil}}", "Prepared By: {{sender.name}}"]),
      rule,
      parties(party("FROM", ["{{sender.name}}", "{{sender.address}}", "{{sender.contacts}}"]), party("BILL TO", ["{{customer.name}}", "{{customer.email}}", "{{customer.address}}"])),
      index === 1 ? p("Project scope: {{quotation.scope}}") : index === 2 ? p("Service period: {{quotation.period}} | Payment terms: {{quotation.terms}}") : p("Thank you for the opportunity to quote. The pricing below is valid until the date shown above."),
      dataTable(["Item", "Description", "Qty", "Unit Price (UGX)", "Amount (UGX)"], [[
        "{{quotation.line1.description}}", "{{quotation.line1.details}}", "{{quotation.line1.quantity}}", "{{quotation.line1.rate}}", "{{quotation.line1.amount}}",
      ]]),
      totals([["Subtotal", "{{quotation.subtotal}}"], ["Discount", "{{quotation.discount}}"], ["Tax", "{{quotation.tax}}"], ["TOTAL", "{{quotation.total}}"]]),
      h(2, "Notes and terms"), p("{{quotation.terms}}"),
      signatures(["PREPARED BY", "{{sender.name}}", "{{sender.title}}"], ["CUSTOMER ACCEPTANCE", "{{customer.name}}"]),
    ),
  })),
  ...(["Standard"] as const).map((variant, index): DocumentTemplateDefinition => ({
    type: "receipt",
    name: `Receipt - Chaste ${variant}`,
    description: [
      "A polished receipt for any payment received, with an explicit paid status.",
      "A receipt allocated to an invoice, showing the remaining balance and reference.",
      "A deposit receipt for a project or order, with purpose and balance context.",
    ][index]!,
    recordType: index === 0 ? "customer" : "invoice", recordLabel: index === 0 ? "Customer" : "Invoice or customer", preview: { meta: "Chaste reference layout" },
    lineItemConfig: refMoneyConfig("receipt"),
    contentJson: doc(
      letterhead("RECEIPT", ["Receipt No: {{receipt.number}}", "Payment Date: {{document.date}}", "Invoice Reference: {{invoice.number}}", "Issued By: {{sender.name}}"]),
      rule,
      parties(party("RECEIVED BY", ["{{sender.name}}", "{{sender.contacts}}"]), party("RECEIVED FROM", ["{{customer.name}}", "{{customer.email}}"])),
      totals([["AMOUNT RECEIVED", "{{receipt.total}}"]]),
      dataTable(["Payment for", "Description", "Qty", "Amount (UGX)"], [[
        "{{receipt.line1.description}}", "{{receipt.line1.details}}", "{{receipt.line1.quantity}}", "{{receipt.line1.amount}}",
      ]]),
      p("Payment method: {{receipt.paymentMethod}} | Reference: {{receipt.paymentReference}}"),
      totals([["Invoice balance", "{{invoice.balance}}"], ["STATUS", "PAID"]]),
      p(index === 2 ? "Deposit purpose: {{receipt.purpose}}. {{receipt.memo}}" : index === 1 ? "This receipt acknowledges payment against the invoice reference above." : "Thank you for your business. Keep this receipt for your records."),
      signatures(["AUTHORIZED SIGNATURE", "{{sender.name}}", "{{sender.title}}"], ["RECEIVED BY", "{{customer.name}}"]),
    ),
  })),
  ...(["Standard"] as const).map((variant, index): DocumentTemplateDefinition => ({
    type: "delivery_note",
    name: `Delivery note - Chaste ${variant}`,
    description: [
      "A clear goods handover note with shipment context, quantities, and signatures.",
      "A dispatch note with carrier, tracking, and expected delivery details.",
      "A proof of delivery with handover notes and recipient acknowledgement.",
    ][index]!,
    recordType: "sales_order", recordLabel: "Sales order", preview: { meta: "Chaste reference layout" }, lineItemConfig: refDeliveryConfig,
    contentJson: doc(
      letterhead(index === 2 ? "PROOF OF DELIVERY" : "DELIVERY NOTE", ["Delivery Note No: {{delivery.number}}", "Delivery Date: {{document.date}}", "Order Reference: {{salesOrder.number}}", "Dispatched By: {{sender.name}}"]),
      rule,
      parties(party("FROM", ["{{sender.name}}", "{{sender.address}}", "{{sender.contacts}}"]), party("DELIVER TO", ["{{customer.name}}", "{{customer.address}}", "{{customer.phone}}"])),
      grid(gridRow(cell(strong("DELIVERY METHOD"), p("{{delivery.method}}")), cell(strong("DISPATCH LOCATION"), p("{{delivery.location}}")), cell(strong("EXPECTED DELIVERY"), p("{{delivery.expectedDate}}")), cell(strong("VEHICLE / TRACKING"), p("{{delivery.tracking}}")))),
      dataTable(["Item", "Description", "Ordered", "Delivered", "Unit"], [[
        "{{delivery.line1.description}}", "{{delivery.line1.details}}", "{{delivery.line1.ordered}}", "{{delivery.line1.delivered}}", "{{delivery.line1.unit}}",
      ]]),
      h(2, "Notes"), p("{{delivery.notes}}"),
      h(2, "Handover"), signatures(["DISPATCHED BY", "{{sender.name}}", "{{sender.title}}"], ["RECEIVED BY", "{{customer.name}}"]),
    ),
  })),
];

export const DOCUMENT_TEMPLATE_CATALOG: DocumentTemplateDefinition[] = [
  ...DOCUMENT_TEMPLATE_CATALOG_BASE.filter((template, index, catalog) => catalog.findIndex((candidate) => candidate.type === template.type) === index && !["quotation", "receipt", "sales_invoice", "delivery_note"].includes(template.type)),
  ...referenceTemplates,
];

export const DOCUMENT_TEMPLATE_TYPES: { id: DocumentTemplateType; label: string }[] = [
  { id: "quotation", label: "Quotations" },
  { id: "receipt", label: "Receipts" },
  { id: "sales_invoice", label: "Sales invoices" },
  { id: "purchase_order", label: "Purchase orders" },
  { id: "voucher", label: "Vouchers" },
  { id: "delivery_note", label: "Delivery notes" },
  { id: "employment_contract", label: "Employment contracts" },
  { id: "employment_agreement", label: "Employment agreements" },
];

/**
 * Design groups: money documents (quotations, invoices, receipts, vouchers,
 * purchase orders) print with the formal financial treatment - large title,
 * dark ruled table headers, banded total; goods paper keeps the light rules;
 * people paper keeps the modest gold title. Templates within a group are
 * layout variations, not different products.
 */
export type DocumentTemplateGroup = "financial" | "operations" | "people";

export const DOCUMENT_TEMPLATE_GROUPS: Record<DocumentTemplateType, DocumentTemplateGroup> = {
  quotation: "financial",
  receipt: "financial",
  sales_invoice: "financial",
  purchase_order: "financial",
  voucher: "financial",
  delivery_note: "operations",
  employment_contract: "people",
  employment_agreement: "people",
};

export const DOCUMENT_TEMPLATE_GROUP_LABELS: { id: DocumentTemplateGroup | "general"; label: string }[] = [
  { id: "financial", label: "Financial" },
  { id: "operations", label: "Operations" },
  { id: "people", label: "People" },
];

/**
 * Presentable sample values for template thumbnails and previews. Direct
 * matches come first; everything else falls back to suffix-shaped business
 * filler so a card never shows a raw token.
 */
const DEMO_VALUES: Record<string, string> = {
  "sender.name": "Bukoto Design Works",
  "sender.address": "Plot 14, Kira Road, Kampala",
  "sender.contacts": "hello@bukotodesign.ug | +256 700 112 233",
  "sender.email": "hello@bukotodesign.ug",
  "sender.phone": "+256 700 112 233",
  "sender.taxNumber": "TIN 100234567",
  "sender.title": "Managing Director",
  "employer.name": "Bukoto Design Works",
  "document.date": "12 Feb 2026",
  "customer.name": "Nakawa Traders Ltd",
  "customer.email": "accounts@nakawatraders.ug",
  "supplier.name": "Ridgeway Supplies Ltd",
  "supplier.email": "sales@ridgewaysupplies.ug",
  "employee.name": "Aisha Nakato",
  "employee.title": "Accounts Assistant",
  "employee.email": "aisha@bukotodesign.ug",
  "salesOrder.number": "SO-1042",
  "invoice.number": "INV-2026-014",
  "invoice.issuedAt": "12 Feb 2026",
  "invoice.dueAt": "28 Feb 2026",
  "invoice.taxPoint": "12 Feb 2026",
  "invoice.subtotal": "UGX 7,400,000",
  "invoice.tax": "UGX 1,332,000",
  "invoice.total": "UGX 8,732,000",
  "invoice.balance": "UGX 4,300,000",
  "invoice.previousBalance": "UGX 8,732,000",
  "invoice.paymentInstructions": "Stanbic Bank, Acct 9030012345, Bukoto Design Works Ltd",
  "invoice.period": "Jan to Feb 2026",
  "invoice.projectName": "Nakawa storefront rebuild",
  "invoice.claimNumber": "2 of 3",
  "invoice.contractValue": "UGX 47,000,000",
  "invoice.progressPercent": "62%",
  "invoice.previouslyBilled": "UGX 17,500,000",
  "invoice.taxableNet": "UGX 6,900,000",
  "invoice.taxRate": "18%",
  "invoice.taxableGross": "UGX 8,142,000",
  "invoice.zeroRated": "UGX 500,000",
  "invoice.zeroTax": "UGX 0",
  "invoice.exempt": "UGX 0",
  "quotation.number": "QT-2026-031",
  "quotation.validUntil": "14 Mar 2026",
  "quotation.subtotal": "UGX 4,110,000",
  "quotation.tax": "UGX 739,800",
  "quotation.total": "UGX 4,849,800",
  "quotation.startDate": "1 Mar 2026",
  "quotation.objective": "Rebuild the storefront and connect it to inventory so stock and prices stay current.",
  "quotation.terms": "50% deposit to start, balance on delivery. Prices hold until the validity date.",
  "quotation.exclusions": "Hosting fees, third-party licences, and hardware are billed separately.",
  "quotation.renewalTerms": "Renews monthly with 30 days notice from either side.",
  "quotation.channel": "the shared support board",
  "quotation.rollover": "carry over one month",
  "quotation.overageRate": "UGX 120,000 per hour",
  "receipt.number": "RCT-0912",
  "receipt.dateTime": "12 Feb 2026, 14:35",
  "receipt.total": "UGX 486,000",
  "receipt.paymentMethod": "Mobile money",
  "receipt.paymentReference": "MP-88213",
  "receipt.cashier": "Joan Kembabazi",
  "receipt.purpose": "storefront rebuild, phase one",
  "receipt.projectValue": "UGX 47,000,000",
  "receipt.depositPercent": "40%",
  "receipt.balance": "UGX 28,200,000",
  "receipt.depositTerms": "Funds are applied to materials and specialist labour for phase one.",
  "purchaseOrder.number": "PO-2026-007",
  "purchaseOrder.deliveryDate": "20 Feb 2026",
  "purchaseOrder.deliveryAddress": "Plot 14, Kira Road, Kampala",
  "purchaseOrder.deliveryContact": "Peter Ssentongo, +256 772 445 001",
  "purchaseOrder.total": "UGX 9,800,000",
  "purchaseOrder.partDelivery": "accepted with a revised schedule",
  "purchaseOrder.paymentTerms": "Net 30 from delivery",
  "purchaseOrder.scope": "Refit the sales floor: shelving, counter, and card terminals, installed out of hours.",
  "purchaseOrder.startDate": "1 Mar 2026",
  "purchaseOrder.endDate": "28 Feb 2027",
  "purchaseOrder.authorizedRoles": "the operations lead and finance manager",
  "purchaseOrder.reviewTerms": "Rates are reviewed each quarter with 30 days notice.",
  "purchaseOrder.expenseTerms": "pre-approved in writing, billed at cost",
  "voucher.number": "PV-0119",
  "voucher.period": "Feb 2026",
  "voucher.paymentMethod": "Bank transfer",
  "voucher.supportReference": "INV-2026-014",
  "voucher.total": "UGX 1,250,000",
  "voucher.totalDebit": "UGX 1,250,000",
  "voucher.totalCredit": "UGX 1,250,000",
  "voucher.purpose": "Settle the February cleaning contract.",
  "voucher.attachments": "invoice, delivery note, approval email",
  "voucher.approvedBy": "David Mugisha, Finance Manager",
  "voucher.reviewedBy": "Sarah Namutebi, Internal Audit",
  "voucher.depositAccount": "Stanbic current 9030012345",
  "voucher.depositReference": "SLP-00871",
  "voucher.document1": "INV-2026-014",
  "voucher.description1": "Storefront phase one",
  "voucher.applied1": "UGX 3,000,000",
  "voucher.balance1": "UGX 5,732,000",
  "voucher.document2": "INV-2026-009",
  "voucher.description2": "Consulting retainer",
  "voucher.applied2": "UGX 600,000",
  "voucher.balance2": "UGX 0",
  "delivery.number": "DN-0342",
  "delivery.address": "Nakawa Market, Stall 41, Kampala",
  "delivery.carrier": "Own fleet, UBA 214X",
  "delivery.packages": "6 cartons",
  "delivery.nextDate": "26 Feb 2026",
  "delivery.backorderNote": "Two cartons arrive with the supplier restock on 24 Feb.",
  "delivery.exceptions": "one carton dented, accepted with note",
  "delivery.receivedTime": "12 Feb 2026, 11:20",
  "delivery.packageCheck": "6 of 6 cartons",
  "delivery.conditionCheck": "no visible damage",
  "delivery.accessoryCheck": "manuals and cables included",
  "delivery.driver": "Ibrahim Kizza",
  "employment.reference": "HR-EC-2026-004",
  "employment.startDate": "1 Mar 2026",
  "employment.endDate": "28 Feb 2027",
  "employment.probationEnd": "30 May 2026",
  "employment.contractDate": "1 Mar 2026",
  "employment.manager": "David Mugisha",
  "employment.location": "Kira Road office, Kampala",
  "employment.hours": "8:30 to 17:30, Monday to Friday",
  "employment.compensation": "UGX 2,400,000 per month",
  "employment.benefits": "NSSF, medical cover, annual airtime allowance",
  "employment.leaveDays": "21",
  "employment.noticePeriod": "one month",
  "employment.probationNotice": "two weeks",
  "employment.duties": "day-to-day bookkeeping, invoicing, and monthly reconciliations",
  "employment.confidentiality": "Client data stays inside approved systems and is never shared outside the company.",
  "employment.reviewDate": "30 Nov 2026",
  "employment.terminationTerms": "Either party may end this contract with one month written notice.",
  "agreement.reference": "AG-2026-011",
  "agreement.location": "Remote within Uganda",
  "agreement.officeDays": "2 days per month",
  "agreement.availability": "09:00 to 17:00, Monday to Friday",
  "agreement.reviewDate": "1 Sep 2026",
  "agreement.equipment": "laptop and second monitor",
  "agreement.connectivity": "UGX 150,000 monthly data allowance",
  "agreement.expenses": "pre-approved travel, billed at cost",
  "agreement.securityPolicy": "the company device and data policy",
  "agreement.safetyTerms": "The Employee keeps a safe workstation and reports incidents within 24 hours.",
  "agreement.purpose": "the 2026 storefront project",
  "agreement.disclosureTerms": "to auditors and advisers under confidentiality",
  "agreement.survivalPeriod": "three years",
  "agreement.remedies": "Injunctive relief and recovery of damages are available to both parties",
  "agreement.governingLaw": "the laws of Uganda",
  "agreement.expenseTerms": "Pre-approved expenses are reimbursed within 14 days of a receipt.",
  "agreement.ownershipTerms": "Work products transfer to the Client on full payment; the Consultant keeps its tooling.",
  "agreement.terminationTerms": "Either party may end this agreement with 30 days written notice.",
};

const ITEM_NAMES = ["Storefront design and build", "Monthly maintenance retainer", "Staff training workshop"];
const DELIVERABLES = ["Signed-off design pack", "Live storefront", "Trained staff and handover"];
const MILESTONES = ["Discovery and wireframes", "Build and data migration"];
const SERVICES = ["Helpdesk support", "Monthly bookkeeping", "Quarterly VAT filing"];
const WORK_PACKAGES = ["Discovery workshop", "Build and migration"];
const RATES = ["UGX 3,700,000", "UGX 950,000", "UGX 1,200,000"];
const AMOUNTS = ["UGX 3,700,000", "UGX 1,900,000", "UGX 1,200,000"];
const COUNTS = ["1", "2", "1"];
const COUNTS_BY_TWO = ["6", "4", "2"];

function demoForSuffix(stem: string, index: number, token: string): string {
  const at = (names: string[]): string => names[Math.min(Math.max(index, 1), names.length) - 1]!;
  if (stem.endsWith(".description") || stem.endsWith(".item")) return at(ITEM_NAMES);
  if (stem.endsWith(".deliverable")) return at(DELIVERABLES);
  if (stem.endsWith(".milestone")) return at(MILESTONES);
  if (stem.endsWith(".service")) return at(SERVICES);
  if (stem.endsWith(".package")) return at(WORK_PACKAGES);
  if (stem.endsWith(".quantity")) return at(COUNTS);
  if (stem.endsWith(".rate") || stem.endsWith(".price") || stem.endsWith(".fee")) return at(RATES);
  if (stem.endsWith(".amount")) return at(AMOUNTS);
  if (stem.endsWith(".ordered") || stem.endsWith(".today") || stem.endsWith(".previous")) return at(COUNTS_BY_TWO);
  if (stem.endsWith(".delivered")) return at(["6", "2", "2"]);
  if (stem.endsWith(".outstanding")) return at(["0", "2", "0"]);
  if (stem.endsWith(".allowance")) return at(["20 hours a month", "12 hours a month", "8 hours a month"]);
  if (stem.endsWith(".sla")) return "response in 4 working hours";
  if (stem.endsWith(".serial") || stem.endsWith(".batch")) return `SN-44821${Math.max(index, 1)}`;
  if (stem.endsWith(".condition") || stem.endsWith(".accepted") || stem.endsWith(".check")) return "accepted in good order";
  if (stem.endsWith(".completion")) return "100%";
  if (stem.endsWith(".acceptance")) return "client sign-off on the demo";
  if (stem.endsWith(".measure")) return "sign-off recorded on the project board";
  if (stem.endsWith(".review")) return "30 Mar 2026";
  if (stem.endsWith(".narration")) return "Monthly cleaning service";
  if (stem.endsWith(".costCentre")) return "CC-02 Kampala";
  if (stem.endsWith(".code")) return "5010";
  if (stem.endsWith(".account")) return "Cleaning services";
  if (stem.endsWith(".debit") || stem.endsWith(".credit")) return "UGX 1,250,000";
  if (stem.endsWith(".balance") || stem.endsWith(".applied")) return "UGX 0";
  if (stem.endsWith(".unit")) return "month";
  if (stem.endsWith(".lead")) return "3 working days";
  if (stem.endsWith(".tax")) return "UGX 133,200";
  if (stem.endsWith(".date") || stem.endsWith(".date1") || stem.endsWith(".date2") || stem.endsWith(".At")) return "26 Feb 2026";
  if (stem.endsWith(".number")) return "0012";
  if (stem.endsWith(".name") || stem.endsWith(".by") || stem.endsWith(".cashier")) return "David Mugisha";
  if (stem.endsWith(".title")) return "Engagement Lead";
  if (stem.endsWith(".address")) return "Plot 14, Kira Road, Kampala";
  if (stem.endsWith(".email")) return "accounts@example.ug";
  if (stem.endsWith(".phone") || stem.endsWith(".contacts")) return "+256 700 112 233";
  if (stem.endsWith(".reference")) return "REF-2026-004";
  if (stem.endsWith(".period")) return "Feb 2026";
  if (stem.endsWith(".percent") || stem.endsWith(".progress")) return "40%";
  if (stem.endsWith(".objective")) return "Launch the rebuilt storefront with live stock before the end of the quarter.";
  if (stem.endsWith(".terms") || stem.endsWith(".note") || stem.endsWith(".policy")) return "Standard commercial terms apply.";
  return token.split(".").at(-1)?.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase()) ?? "Sample entry";
}

export function templateDemoValues(placeholders: string[]): Record<string, string> {
  return Object.fromEntries(placeholders.map((token) => {
    const direct = DEMO_VALUES[token];
    if (direct !== undefined) return [token, direct];
    // The index can sit mid-token (line2.rate) or at the end (deliverable1).
    const index = Number(/\d+/.exec(token)?.[0] ?? 0);
    const stem = token.replace(/\d+/, "");
    return [token, demoForSuffix(stem, index, token)];
  }));
}
