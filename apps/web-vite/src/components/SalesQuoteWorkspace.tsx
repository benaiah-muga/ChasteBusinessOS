import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { acceptSalesQuote, createSalesQuote, fetchSalesQuoteCustomers, fetchSalesQuoteDeals, fetchSalesQuotes, SALES_QUOTE_DATABASE_INTEGER_MAX, SalesQuoteApiError, type SalesQuote, type SalesQuoteCustomer, type SalesQuoteDeal } from "../api/sales-quotes";
import "./sales-page.css";

type QuoteTab = "quotes" | "customers" | "deals";
type DraftLine = { description: string; quantity: string; unitPrice: string; tax: string };
const emptyLine = (): DraftLine => ({ description: "", quantity: "1", unitPrice: "", tax: "0" });
const today = () => new Date().toISOString().slice(0, 10);

function parseMoney(value: string, digits: number): number | null {
  const input = value.trim();
  if (!/^\d+(?:\.\d*)?$/.test(input)) return null;
  const [whole = "", fraction = ""] = input.split(".");
  if (fraction.length > digits) return null;
  const amount = Number(whole) * (10 ** digits) + Number(fraction.padEnd(digits, "0") || "0");
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function parseQuantity(value: string): number | null {
  const input = value.trim();
  if (!/^\d+(?:\.\d{0,3})?$/.test(input)) return null;
  const [whole = "", fraction = ""] = input.split(".");
  const quantity = Number(whole) * 1000 + Number(fraction.padEnd(3, "0") || "0");
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

function quoteTotal(lines: DraftLine[], digits: number): number | null {
  let total = 0n;
  for (const line of lines) {
    const quantity = parseQuantity(line.quantity);
    const price = parseMoney(line.unitPrice, digits);
    const tax = parseMoney(line.tax, digits);
    if (quantity === null || price === null || tax === null || quantity > SALES_QUOTE_DATABASE_INTEGER_MAX || price > SALES_QUOTE_DATABASE_INTEGER_MAX || tax > SALES_QUOTE_DATABASE_INTEGER_MAX) return null;
    const subtotal = (BigInt(quantity) * BigInt(price) + 500n) / 1000n;
    total += subtotal + BigInt(tax);
    if (total > BigInt(SALES_QUOTE_DATABASE_INTEGER_MAX)) return null;
  }
  return Number(total);
}

function formatMoney(minor: number, currency: string, digits: number): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / (10 ** digits));
  } catch {
    return `${currency} ${(minor / (10 ** digits)).toFixed(digits)}`;
  }
}

export function SalesQuoteWorkspace({ actorId, organizationId, baseCurrency }: { actorId: string | null; organizationId: string | null; baseCurrency: string | null }) {
  const scope = useMemo(() => ({ actorId, organizationId }), [actorId, organizationId]);
  const [tab, setTab] = useState<QuoteTab>("quotes");
  const [quotes, setQuotes] = useState<SalesQuote[]>([]);
  const [customers, setCustomers] = useState<SalesQuoteCustomer[]>([]);
  const [deals, setDeals] = useState<SalesQuoteDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [memo, setMemo] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quoteFilter, setQuoteFilter] = useState("all");
  const [dealQuery, setDealQuery] = useState("");
  const currency = (baseCurrency?.trim().toUpperCase() || "USD");
  const digits = currencyMinorUnits(currency) ?? 2;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextQuotes, nextCustomers, nextDeals] = await Promise.all([
        fetchSalesQuotes(signal), fetchSalesQuoteCustomers(signal), fetchSalesQuoteDeals(signal),
      ]);
      if (signal?.aborted) return;
      setQuotes(nextQuotes);
      setCustomers(nextCustomers);
      setDeals(nextDeals);
    } catch (error) {
      if (signal?.aborted) return;
      setLoadError(error instanceof SalesQuoteApiError ? error.message : "Could not load Sales from Go. Try again.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const filteredQuotes = quotes.filter((quote) => quoteFilter === "all" || quote.status === quoteFilter);
  const filteredDeals = deals.filter((deal) => `${deal.title} ${deal.customerName ?? ""} ${deal.stage}`.toLowerCase().includes(dealQuery.toLowerCase()));
  const customerNames = useMemo(() => new Map(customers.map((customer) => [customer.id, customer.name])), [customers]);
  const total = quoteTotal(lines, digits);

  function setLine(index: number, key: keyof DraftLine, value: string) {
    setLines((current) => current.map((line, row) => row === index ? { ...line, [key]: value } : line));
  }

  async function submitQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setNotice(null);
    if (!actorId?.trim() || !organizationId) { setActionError("The active actor and workspace are required to create a quote."); return; }
    if (total === null || total <= 0) { setActionError("Enter valid quantities, prices, and tax amounts. Each amount and the total must fit the database limit, and the total must be greater than zero."); return; }
    const payload = {
      customerId,
      ...(memo.trim() ? { memo: memo.trim() } : {}),
      ...(expiresAt ? { expiresAt: `${expiresAt}T23:59:59.000Z` } : {}),
      lines: lines.map((line) => ({
        description: line.description.trim(),
        quantity: parseQuantity(line.quantity)!,
        unitPriceMinor: parseMoney(line.unitPrice, digits)!,
        taxMinor: parseMoney(line.tax, digits)!,
      })),
    };
    setBusy(true);
    try {
      const result = await createSalesQuote(payload, scope);
      if (result.kind === "pending") {
        setNotice(`Quote creation is waiting for approval. Retry this exact draft to check approval: ${result.reason}`);
        return;
      }
      setNotice(`Quote #${result.data.quoteNumber} created and sent.`);
      setFormOpen(false);
      setMemo("");
      setExpiresAt("");
      setLines([emptyLine()]);
      await load();
    } catch (error) {
      setActionError(error instanceof SalesQuoteApiError ? error.message : "The quote could not be created.");
    } finally { setBusy(false); }
  }

  async function accept(quote: SalesQuote) {
    if (!actorId || !organizationId) { setActionError("The active actor and workspace are required to accept a quote."); return; }
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await acceptSalesQuote(quote.id, scope);
      if (result.kind === "pending") {
        setNotice(`Quote #${quote.number} is waiting for approval. Retry the same action to check approval: ${result.reason}`);
        return;
      }
      setNotice(`Quote #${quote.number} accepted. Invoice #${result.data.invoiceNumber} was created.`);
      await load();
    } catch (error) {
      setActionError(error instanceof SalesQuoteApiError ? error.message : "The quote could not be accepted.");
    } finally { setBusy(false); }
  }

  return (
    <section className="sales-quotes-workspace" aria-labelledby="sales-workspace-title">
      <div className="sales-quotes-heading">
        <div><p className="sales-eyebrow">Go workspace</p><h2 id="sales-workspace-title">Quotes and relationships</h2></div>
        <button type="button" className="sales-new-order" onClick={() => { setFormOpen((open) => !open); setActionError(null); }} aria-expanded={formOpen}>{formOpen ? "Close quote form" : "Create quote"}</button>
      </div>
      <nav className="sales-quotes-tabs" aria-label="Sales workspace">
        {(["quotes", "customers", "deals"] as const).map((value) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{value[0]!.toUpperCase()}{value.slice(1)}</button>)}
      </nav>
      {actionError && <p className="sales-action-notice sales-action-notice-error" role="alert">{actionError}</p>}
      {notice && <p className="sales-action-notice sales-action-notice-success" role="status">{notice}</p>}
      {loading && <p role="status">Loading quotes and customer relationships from Go…</p>}
      {loadError && <section className="sales-error" role="alert"><div><h3>Sales workspace unavailable</h3><p>{loadError}</p></div><button type="button" onClick={() => void load()}>Try again</button></section>}

      {formOpen && tab === "quotes" && <form className="sales-quote-form" onSubmit={(event) => void submitQuote(event)}>
        <h3>Create and send quote</h3>
        <div className="sales-quote-fields">
          <label>Customer<select required value={customerId} onChange={(event) => setCustomerId(event.currentTarget.value)}><option value="">Choose customer</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
          <label>Expiry date<input type="date" min={today()} value={expiresAt} onChange={(event) => setExpiresAt(event.currentTarget.value)} /></label>
          <label className="sales-quote-memo">Memo<textarea maxLength={4000} value={memo} onChange={(event) => setMemo(event.currentTarget.value)} /></label>
        </div>
        <div className="sales-quote-lines"><h4>Line items</h4>{lines.map((line, index) => <div className="sales-quote-line" key={index}>
          <label>Description<input required maxLength={500} value={line.description} onChange={(event) => setLine(index, "description", event.currentTarget.value)} /></label>
          <label>Quantity<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{0,3})?" value={line.quantity} onChange={(event) => setLine(index, "quantity", event.currentTarget.value)} /></label>
          <label>Unit price<input required inputMode="decimal" value={line.unitPrice} onChange={(event) => setLine(index, "unitPrice", event.currentTarget.value)} /></label>
          <label>Tax<input required inputMode="decimal" value={line.tax} onChange={(event) => setLine(index, "tax", event.currentTarget.value)} /></label>
          {lines.length > 1 && <button type="button" className="sales-write-remove" aria-label={`Remove line ${index + 1}`} onClick={() => setLines((current) => current.filter((_, row) => row !== index))}>Remove</button>}
        </div>)}
          <button type="button" className="sales-write-secondary" disabled={lines.length >= 100} onClick={() => setLines((current) => [...current, emptyLine()])}>Add line</button>
        </div>
        <div className="sales-write-actions"><strong>Quote total: {total === null ? "Check line values" : formatMoney(total, currency, digits)}</strong><button type="submit" className="sales-write-primary" disabled={busy || customers.length === 0}>{busy ? "Sending…" : "Create and send quote"}</button></div>
        <p className="sales-quote-help">Quotes are created with sent status and can be accepted into an invoice.</p>
      </form>}

      {!loading && !loadError && tab === "quotes" && <div className="sales-quote-list">
        <div className="sales-quote-list-heading"><h3>Quotes</h3><label>Filter<select value={quoteFilter} onChange={(event) => setQuoteFilter(event.currentTarget.value)}><option value="all">All statuses</option>{["sent", "accepted", "declined", "expired", "draft"].map((status) => <option key={status}>{status}</option>)}</select></label></div>
        {filteredQuotes.length === 0 ? <p className="sales-quote-empty">No quotes in this view.</p> : <div className="sales-table-scroll"><table className="sales-table"><thead><tr><th>Quote</th><th>Customer</th><th>Status</th><th>Expires</th><th>Total</th><th>Actions</th></tr></thead><tbody>{filteredQuotes.map((quote) => <tr key={quote.id}>
          <th scope="row">#{quote.number}</th><td>{customerNames.get(quote.customerId) ?? "Unknown customer"}</td><td><span className="sales-status">{quote.status}</span></td><td>{quote.expiresAt ? new Date(quote.expiresAt).toLocaleDateString() : "No expiry"}</td><td className="sales-total">{formatMoney(quote.totalMinor, currency, digits)}</td><td>{quote.status === "sent" && <button type="button" disabled={busy} onClick={() => void accept(quote)}>Accept and create invoice</button>}{quote.invoiceId && <a href="/accounting/invoices">Open invoices</a>}</td>
        </tr>)}</tbody></table></div>}
      </div>}

      {!loading && !loadError && tab === "customers" && <div className="sales-relationship-list"><h3>Customers</h3>{customers.length === 0 ? <p>No active customers found.</p> : <ul>{customers.map((customer) => <li key={customer.id}><div><strong>{customer.name}</strong><span>{customer.email ?? "No email recorded"}</span></div><a href="/crm">Open CRM</a></li>)}</ul>}</div>}
      {!loading && !loadError && tab === "deals" && <div className="sales-relationship-list"><div className="sales-quote-list-heading"><h3>Deals</h3><label>Search<input type="search" value={dealQuery} onChange={(event) => setDealQuery(event.currentTarget.value)} /></label></div>{filteredDeals.length === 0 ? <p>No deals match this search.</p> : <ul>{filteredDeals.map((deal: SalesQuoteDeal) => <li key={deal.id}><div><strong>{deal.title}</strong><span>{deal.customerName ?? "Unlinked customer"} · {deal.stage} · {formatMoney(deal.valueMinor, currency, digits)}</span></div><a href="/crm">Open CRM</a></li>)}</ul>}</div>}
    </section>
  );
}
