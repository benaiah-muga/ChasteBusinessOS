"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Button, Dialog, Notice } from "@/components/ui";
import { IconPlus } from "@/components/icons";
import { cn } from "@/lib/format";
import { postApi } from "@/lib/api";
import { toMinor } from "@/lib/format";
import { useModuleEnabled } from "./_shell/module-context";

/**
 * Quick create: Odoo-style inline creation from anywhere. A trigger ("+"
 * next to a picker, or a command-palette entry) opens a compact modal for
 * one entity; "Create" closes, "Create & new" resets for the next one.
 * Every submit rides the same governed capability route the module's own
 * page uses, so quick-created records are identical to page-created ones.
 */

export type QuickCreateEntityId = "customer" | "product" | "vendor";

export interface QuickCreateResult {
  /** Primary id of the created record (customerId, vendorId, or the sku). */
  id: string;
  label: string;
}

type SubmitOutcome =
  | { ok: true; result: QuickCreateResult }
  | { ok: false; error: string; pending?: boolean };

interface QuickCreateFormProps {
  submitRef: RefObject<(() => Promise<SubmitOutcome>) | null>;
  resetRef: RefObject<(() => void) | null>;
}

const fieldCls =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 shadow-xs transition-colors duration-150 outline-none placeholder:text-stone-400 focus:border-gold-600 focus:ring-[3px] focus:ring-gold-600/15";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-stone-700">{label}</span>
      {children}
    </label>
  );
}

/* ------------------------------------------------------------- forms ------ */

function CustomerForm({ submitRef, resetRef }: QuickCreateFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [duplicate, setDuplicate] = useState<string | null>(null);

  resetRef.current = () => {
    setName("");
    setEmail("");
    setDuplicate(null);
  };
  submitRef.current = async () => {
    if (!name.trim()) return { ok: false, error: "Give the customer a name." };
    const res = await postApi<{ customerId: string; duplicateWarning?: string | null }>("/api/customers", {
      action: "create",
      name: name.trim(),
      ...(email.trim() ? { email: email.trim() } : {}),
    });
    if (res.status === 202) return { ok: false, error: "Creation was gated by policy and now waits in the Approvals inbox.", pending: true };
    if (!res.ok || !res.data?.customerId) {
      return { ok: false, error: res.error ? `${res.error.title}${res.error.hint ? ` - ${res.error.hint}` : ""}` : "Couldn't create the customer." };
    }
    return { ok: true, result: { id: res.data.customerId, label: name.trim() } };
  };

  return (
    <div className="space-y-3">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Interiors" className={fieldCls} autoFocus />
      </Field>
      <Field label="Email (optional)">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="accounts@acme.test" className={fieldCls} />
      </Field>
      {duplicate && <Notice tone="info">{duplicate}</Notice>}
    </div>
  );
}

function ProductForm({ submitRef, resetRef }: QuickCreateFormProps) {
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [isService, setIsService] = useState(false);

  resetRef.current = () => {
    setSku("");
    setName("");
    setPrice("");
    setIsService(false);
  };
  submitRef.current = async () => {
    if (!sku.trim() || !name.trim()) return { ok: false, error: "SKU and name are required." };
    const res = await postApi<{ itemId: string }>("/api/inventory", {
      action: "createItem",
      sku: sku.trim(),
      name: name.trim(),
      kind: isService ? "service" : "goods",
      unitLabel: isService ? "service" : "unit",
      salePriceMinor: toMinor(price),
    });
    if (res.status === 202) return { ok: false, error: "Creation was gated by policy and now waits in the Approvals inbox.", pending: true };
    if (!res.ok || !res.data?.itemId) {
      return { ok: false, error: res.error ? `${res.error.title}${res.error.hint ? ` - ${res.error.hint}` : ""}` : "Couldn't create the product." };
    }
    return { ok: true, result: { id: sku.trim(), label: `${name.trim()} (${sku.trim()})` } };
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="SKU">
          <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="MUG-01" className={cn(fieldCls, "font-mono")} autoFocus />
        </Field>
        <Field label="Sale price">
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0.00" className={fieldCls} />
        </Field>
      </div>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Enamel mug" className={fieldCls} />
      </Field>
      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-stone-700">
        <input type="checkbox" checked={isService} onChange={(e) => setIsService(e.target.checked)} className="accent-gold-700" />
        Service (no stock tracking)
      </label>
      <p className="text-xs leading-relaxed text-stone-400">
        {isService
          ? "Services never carry stock: they invoice directly wherever the SKU is sold."
          : "Stocked later through receiving or a stock adjustment; price is optional."}
      </p>
    </div>
  );
}

function VendorForm({ submitRef, resetRef }: QuickCreateFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  resetRef.current = () => {
    setName("");
    setEmail("");
  };
  submitRef.current = async () => {
    if (!name.trim()) return { ok: false, error: "Give the vendor a name." };
    const res = await postApi<{ vendorId: string }>("/api/purchasing", {
      action: "createVendor",
      name: name.trim(),
      email: email.trim() || undefined,
    });
    if (res.status === 202) return { ok: false, error: "Creation was gated by policy and now waits in the Approvals inbox.", pending: true };
    if (!res.ok || !res.data?.vendorId) {
      return { ok: false, error: res.error ? `${res.error.title}${res.error.hint ? ` - ${res.error.hint}` : ""}` : "Couldn't create the vendor." };
    }
    return { ok: true, result: { id: res.data.vendorId, label: name.trim() } };
  };

  return (
    <div className="space-y-3">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Kampala Hardware Ltd" className={fieldCls} autoFocus />
      </Field>
      <Field label="Email (optional)">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sales@vendor.test" className={fieldCls} />
      </Field>
    </div>
  );
}

/* ---------------------------------------------------------- definitions --- */

interface EntityDef {
  title: string;
  moduleId: string;
  Form: (props: QuickCreateFormProps) => ReactNode;
}

const DEFINITIONS: Record<QuickCreateEntityId, EntityDef> = {
  customer: { title: "New customer", moduleId: "crm", Form: CustomerForm },
  product: { title: "New product", moduleId: "inventory", Form: ProductForm },
  vendor: { title: "New vendor", moduleId: "purchasing", Form: VendorForm },
};

/* ---------------------------------------------------------------- modal --- */

function QuickCreateModal({
  entity,
  onClose,
  onCreated,
}: {
  entity: QuickCreateEntityId;
  onClose: () => void;
  onCreated: (result: QuickCreateResult) => void;
}) {
  const def = DEFINITIONS[entity];
  const moduleEnabled = useModuleEnabled(def.moduleId);
  const submitRef = useRef<(() => Promise<SubmitOutcome>) | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(again: boolean) {
    if (!submitRef.current) return;
    setBusy(true);
    setError(null);
    setPending(false);
    const outcome = await submitRef.current();
    setBusy(false);
    if (outcome.ok) {
      onCreated(outcome.result);
      if (again) resetRef.current?.();
      else onClose();
      return;
    }
    setError(outcome.error);
    setPending(Boolean(outcome.pending));
  }

  if (!moduleEnabled) {
    return (
      <Dialog open onClose={onClose} title={def.title}>
        <Notice tone="info">The {def.moduleId} module is switched off for this organization.</Notice>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={def.title}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="secondary" loading={busy} onClick={() => void run(true)}>
            Create &amp; new
          </Button>
          <Button loading={busy} onClick={() => void run(false)}>
            Create
          </Button>
        </div>
      }
    >
      {pending && <Notice tone="pending">Sent to the Approvals inbox. It applies once approved.</Notice>}
      {error && !pending && <Notice tone="error">{error}</Notice>}
      <div className="pt-1">
        <def.Form submitRef={submitRef} resetRef={resetRef} />
      </div>
    </Dialog>
  );
}

/* -------------------------------------------------------------- context --- */

interface QuickCreateApi {
  open: (entity: QuickCreateEntityId, onCreated?: (result: QuickCreateResult) => void) => void;
}

const QuickCreateCtx = createContext<QuickCreateApi | null>(null);

export function QuickCreateProvider({ children }: { children: ReactNode }) {
  const [entity, setEntity] = useState<QuickCreateEntityId | null>(null);
  const onCreatedRef = useRef<((result: QuickCreateResult) => void) | undefined>(undefined);

  const open = useCallback((next: QuickCreateEntityId, onCreated?: (result: QuickCreateResult) => void) => {
    onCreatedRef.current = onCreated;
    setEntity(next);
  }, []);
  const api = useMemo(() => ({ open }), [open]);

  return (
    <QuickCreateCtx.Provider value={api}>
      {children}
      {entity && (
        <QuickCreateModal
          entity={entity}
          onClose={() => setEntity(null)}
          onCreated={(result) => onCreatedRef.current?.(result)}
        />
      )}
    </QuickCreateCtx.Provider>
  );
}

export function useQuickCreate(): QuickCreateApi {
  const ctx = useContext(QuickCreateCtx);
  if (!ctx) throw new Error("useQuickCreate must be used inside QuickCreateProvider");
  return ctx;
}

/** Small "+" trigger to place right next to entity pickers. */
export function QuickCreateButton({
  entity,
  onCreated,
  className,
  title,
}: {
  entity: QuickCreateEntityId;
  onCreated?: (result: QuickCreateResult) => void;
  className?: string;
  title?: string;
}) {
  const { open } = useQuickCreate();
  const label = DEFINITIONS[entity].title;
  return (
    <button
      type="button"
      aria-label={title ?? label}
      title={title ?? `${label} without leaving this page`}
      onClick={(e) => {
        e.preventDefault();
        open(entity, onCreated);
      }}
      className={cn(
        "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-500 shadow-xs transition-colors duration-150 hover:border-gold-500 hover:text-gold-800",
        className,
      )}
    >
      <IconPlus className="size-4" />
    </button>
  );
}
