import { useCallback, useEffect, useMemo, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import {
  fetchInventoryValuationEntries,
  InventoryValuationApiError,
  readPendingInventoryValuationAction,
  submitInventoryValuationAction,
  type InventoryValuationAction,
  type InventoryValuationEntry,
  type InventoryValuationRetryScope,
} from "../api/inventory-valuation";

type Confirmation = { action: InventoryValuationAction; title: string; message: string } | null;

function formatMoney(minor: number, currency: string): string {
  const units = currencyMinorUnits(currency) ?? 2;
  return new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: units, maximumFractionDigits: units }).format(minor / (10 ** units));
}

function eligibleReversals(entries: InventoryValuationEntry[]): InventoryValuationEntry[] {
  const reversedIds = new Set(entries.flatMap((entry) => entry.reversalOfId ? [entry.reversalOfId] : []));
  return entries.filter((entry) => entry.sourceType === "inventory-valuation" && !reversedIds.has(entry.id));
}

export function InventoryValuationPanel({ currency, retryScope }: { currency: string; retryScope: InventoryValuationRetryScope }) {
  const actorId = retryScope.actorId;
  const organizationId = retryScope.organizationId;
  const [entries, setEntries] = useState<InventoryValuationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<InventoryValuationAction | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "pending" | "error"; text: string } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const scopeReady = Boolean(actorId?.trim() && organizationId?.trim());
  const scopeKey = `${actorId?.trim() ?? ""}:${organizationId?.trim() ?? ""}`;
  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!organizationId?.trim()) {
      setLoading(false);
      setHistoryError("Wait for the active organization to finish loading before viewing valuation history.");
      return;
    }
    setLoading(true);
    setHistoryError(null);
    try {
      const result = await fetchInventoryValuationEntries(organizationId, signal);
      if (!signal?.aborted) setEntries(result);
    } catch (error) {
      if (!signal?.aborted) {
        setHistoryError(error instanceof InventoryValuationApiError && error.status === 403
          ? "Valuation history requires accounting.read. You can still post a valuation with inventory.write, but reversing a prior summary requires access to Accounting history."
          : error instanceof Error ? error.message : "Could not load inventory valuation history.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void reload(controller.signal);
    if (scopeReady) {
      void readPendingInventoryValuationAction({ actorId, organizationId }).then((action) => {
        if (active) setPendingAction(action);
      }).catch((error: unknown) => {
        if (active) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not recover an unresolved inventory valuation action." });
      });
    } else {
      setPendingAction(null);
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [actorId, organizationId, reload, scopeKey, scopeReady]);

  const reversals = useMemo(() => eligibleReversals(entries), [entries]);

  const perform = useCallback(async (action: InventoryValuationAction) => {
    if (!scopeReady || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitInventoryValuationAction(action, { actorId, organizationId });
      if (result.kind === "pending") {
        setPendingAction(action);
        setNotice({ tone: "pending", text: `This valuation action is waiting for approval: ${result.reason} Approve it in the inbox, then retry the same action here to confirm the result.` });
        return;
      }
      setPendingAction(null);
      if ("posted" in result.data) {
        const posted = result.data;
        setNotice({ tone: "success", text: posted.posted
          ? `Valuation summary posted. Stock ledger ${formatMoney(posted.ledgerValueMinor, currency)}, GL ${formatMoney(posted.glBalanceMinor, currency)}, variance ${formatMoney(posted.varianceMinor, currency)}. Entry ${posted.entryId}.`
          : `Stock valuation already matches the General Ledger at ${formatMoney(posted.ledgerValueMinor, currency)}. No entry was posted.` });
      } else {
        setNotice({ tone: "success", text: `Valuation entry reversed. Reversal entry ${result.data.reversalEntryId}.` });
      }
      await reload();
    } catch (error) {
      if (error instanceof InventoryValuationApiError && error.requestMayHaveReachedServer) {
        setPendingAction(action);
        setNotice({ tone: "pending", text: `${error.message} The exact action is saved and can be retried safely.` });
      } else {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "The inventory valuation action failed." });
      }
    } finally {
      setBusy(false);
    }
  }, [actorId, busy, currency, organizationId, reload, scopeReady]);

  const post = () => setConfirmation({
    action: { action: "post", memo: "Inventory valuation summary - stock ledger to GL" },
    title: "Reconcile inventory value",
    message: "Compare the stock ledger value with the General Ledger and post a balanced adjustment if they differ. Workspace policy may require approval for this financial entry.",
  });

  return (
    <section className="inventory-valuation" aria-labelledby="inventory-valuation-title">
      <div className="inventory-valuation-heading">
        <div>
          <p className="inventory-eyebrow">Accounting control</p>
          <h2 id="inventory-valuation-title">Stock valuation</h2>
          <p>Reconcile the inventory stock ledger with the inventory asset account in the General Ledger.</p>
        </div>
        <button type="button" className="shell-button" disabled={!scopeReady || busy || pendingAction !== null} onClick={post}>
          Reconcile stock value
        </button>
      </div>

      {!scopeReady && <p role="status">Loading the active workspace before valuation actions are available.</p>}
      {notice && <p className={`inventory-valuation-notice is-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      {pendingAction && (
        <div className="inventory-valuation-pending" role="group" aria-label="Unresolved valuation action">
          <p>An inventory valuation action has an unresolved result. Retry the exact saved action or check the journal before continuing.</p>
          <button type="button" className="shell-button" disabled={busy || !scopeReady} onClick={() => void perform(pendingAction)}>Retry saved valuation action</button>
        </div>
      )}

      <div className="inventory-valuation-history">
        <h3>Recent valuation entries</h3>
        {loading ? <p role="status">Loading valuation history…</p>
          : historyError ? <p role="alert">{historyError}</p>
            : reversals.length === 0 ? <p>No unreversed valuation summaries in the recent journal entries.</p>
              : <ul>{reversals.map((entry) => (
                <li key={entry.id}>
                  <span><strong>{formatMoney(entry.amountMinor, entry.currency)}</strong> · {new Date(entry.postedAt).toLocaleString()} · {entry.memo}</span>
                  <button type="button" className="shell-button is-quiet" disabled={!scopeReady || busy || pendingAction !== null} onClick={() => setConfirmation({
                    action: { action: "reverse", entryId: entry.id },
                    title: "Reverse valuation summary",
                    message: `Post an exact reversing entry for valuation entry ${entry.id}? Workspace policy may require approval for this financial action.`,
                  })}>Reverse</button>
                </li>
              ))}</ul>}
      </div>

      {confirmation && (
        <div className="inventory-valuation-backdrop" role="presentation">
          <section className="inventory-valuation-dialog" role="dialog" aria-modal="true" aria-labelledby="inventory-valuation-confirm-title">
            <h3 id="inventory-valuation-confirm-title">{confirmation.title}</h3>
            <p>{confirmation.message}</p>
            <div>
              <button type="button" className="shell-button is-quiet" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
              <button type="button" className="shell-button" disabled={busy || !scopeReady || pendingAction !== null} onClick={() => {
                const action = confirmation.action;
                setConfirmation(null);
                void perform(action);
              }}>{busy ? "Submitting…" : "Confirm and submit"}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
