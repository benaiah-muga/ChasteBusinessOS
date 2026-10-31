import { useEffect, useState } from "react";
import { Loader2, Plus, UserPlus } from "lucide-react";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../ui/dialog";
import { useToast } from "../../ui/toast";
import {
  createSupportCustomer,
  fetchSupportCustomerOptions,
  type SupportCustomerOption,
} from "../../api/support";
import { useSupportDesk } from "./SupportDeskContext";

export function NewConversationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    actorId,
    organizationId,
    createConversation,
    busy,
    actionError,
    clearActionError,
    pending,
    pendingReason,
  } = useSupportDesk();
  const { toast } = useToast();
  const [options, setOptions] = useState<SupportCustomerOption[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [subject, setSubject] = useState("");
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickEmail, setQuickEmail] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    clearActionError();
    setLocalError(null);
    setNotice(null);
    setQuickOpen(false);
    setQuickName("");
    setQuickEmail("");
    setSubject("");
    const restored =
      pending?.capabilityId === "support.startConversation"
        ? pending.input
        : null;
    setCustomerId(restored ? String(restored.customerId ?? "") : "");
    if (restored) setSubject(String(restored.subject ?? ""));
    setLoading(true);
    const controller = new AbortController();
    void fetchSupportCustomerOptions(controller.signal)
      .then((customers) => {
        if (controller.signal.aborted) return;
        setOptions(customers);
        setCustomerId((current) => current || customers[0]?.id || "");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLocalError(
            error instanceof Error
              ? error.message
              : "Could not load customers.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [clearActionError, open, pending]);

  async function createCustomerHere() {
    const name = quickName.trim();
    if (!name || !actorId || !organizationId) return;
    setQuickBusy(true);
    setLocalError(null);
    setNotice(null);
    try {
      const outcome = await createSupportCustomer(
        { name, ...(quickEmail.trim() ? { email: quickEmail.trim() } : {}) },
        { actorId, organizationId },
      );
      if (outcome.kind === "pending") {
        setNotice(outcome.reason);
        return;
      }
      const created: SupportCustomerOption = {
        id: outcome.data.customerId,
        name,
        email: quickEmail.trim() || null,
      };
      setOptions((current) => [...current, created]);
      setCustomerId(created.id);
      setQuickOpen(false);
      setQuickName("");
      setQuickEmail("");
      setNotice(
        outcome.data.duplicateWarning ??
          "Customer created. They can receive a conversation now.",
      );
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : "Could not create the customer.",
      );
    } finally {
      setQuickBusy(false);
    }
  }

  async function submit() {
    if (!customerId || subject.trim().length === 0) return;
    setLocalError(null);
    setNotice(null);
    const conversationId = await createConversation(customerId, subject.trim());
    if (!conversationId) return;
    toast({
      title: "Conversation opened",
      description: "It is bound to the customer and ready for a reply.",
      tone: "success",
    });
    onOpenChange(false);
  }

  const submitting = busy === "create";
  const error = localError ?? actionError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="support-dialog">
        <DialogTitle>New conversation</DialogTitle>
        <DialogDescription>
          Bind the inquiry to one customer so every draft, handoff, and reply
          stays on their record.
        </DialogDescription>
        {error && (
          <p className="support-dialog-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="support-dialog-notice" role="status">
            {notice}
          </p>
        )}
        {pending?.capabilityId === "support.startConversation" &&
          pendingReason && (
            <p className="support-dialog-notice" role="status">
              A previous conversation is waiting on approval: {pendingReason}.
              Saving these exact details again will recover its status.
            </p>
          )}
        <label className="support-field">
          <span>Customer</span>
          <select
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
            disabled={loading || submitting}
          >
            {loading && <option value="">Loading customers...</option>}
            {!loading && options.length === 0 && (
              <option value="">No customers yet</option>
            )}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
                {option.email ? ` (${option.email})` : ""}
              </option>
            ))}
          </select>
        </label>
        {!quickOpen ? (
          <button
            type="button"
            className="support-text-button"
            onClick={() => setQuickOpen(true)}
            disabled={loading || submitting}
          >
            <UserPlus size={13} aria-hidden="true" /> New customer
          </button>
        ) : (
          <div className="support-quick-customer">
            <div className="support-field-row">
              <label className="support-field">
                <span>Customer name</span>
                <input
                  value={quickName}
                  onChange={(event) => setQuickName(event.target.value)}
                  aria-label="New customer name"
                  autoFocus
                />
              </label>
              <label className="support-field">
                <span>Email (optional)</span>
                <input
                  value={quickEmail}
                  onChange={(event) => setQuickEmail(event.target.value)}
                  aria-label="New customer email"
                  type="email"
                />
              </label>
            </div>
            <div className="support-dialog-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setQuickOpen(false)}
                disabled={quickBusy}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void createCustomerHere()}
                disabled={quickBusy || !quickName.trim()}
              >
                {quickBusy ? (
                  <Loader2
                    size={13}
                    className="support-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Plus size={13} aria-hidden="true" />
                )}
                {quickBusy ? "Saving..." : "Save and use"}
              </Button>
            </div>
          </div>
        )}
        <label className="support-field">
          <span>What is this about?</span>
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Invoice question, refund request, delivery follow-up..."
            maxLength={200}
            disabled={submitting}
          />
        </label>
        <div className="support-dialog-actions">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              submitting ||
              loading ||
              !customerId ||
              subject.trim().length === 0
            }
          >
            {submitting ? (
              <Loader2 size={14} className="support-spin" aria-hidden="true" />
            ) : null}
            {submitting ? "Opening..." : "Open conversation"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
